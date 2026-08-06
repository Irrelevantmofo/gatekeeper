-- ============================================================================
-- Credit Analyzer — initial schema
-- Plan reference: gatekeeper/docs/credit-analyzer-plan.md §6.2, §6.3, §14.5, §17
--
-- Scope: these tables serve the CREDIT ANALYZER tool only. The Business
-- Analyzer Tool (BAT) is stateless (GoHighLevel only) and uses no database, so
-- nothing here affects it.
--
-- Security posture (plan §6.3): this is a public tool with GHL-based identity
-- and NO Supabase Auth. All DB + Storage access is server-side via the
-- service-role key (the Vercel function is the trust boundary). We therefore
-- ENABLE RLS on every table and add NO permissive policies for the anon /
-- authenticated roles — that denies them by default. The service role bypasses
-- RLS, so the backend still has full access.
--
-- Idempotent: safe to re-run (create ... if not exists / on conflict do nothing).
-- ============================================================================

-- gen_random_uuid() lives in pgcrypto. Supabase usually has it enabled; guard anyway.
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- consents — captured BEFORE any report touches our systems (plan §4 step 1, §9.2)
-- ----------------------------------------------------------------------------
create table if not exists public.consents (
  id               uuid primary key default gen_random_uuid(),
  contact_ref      text,                        -- GHL contact id / email if known
  consent_version  text not null,               -- which legal copy they agreed to (versioned)
  agreed_at        timestamptz not null default now(),
  ip               inet,
  user_agent       text
);

-- ----------------------------------------------------------------------------
-- reports — one row per uploaded report; tracks lifecycle + retention
-- ----------------------------------------------------------------------------
create table if not exists public.reports (
  id              uuid primary key default gen_random_uuid(),
  consent_id      uuid not null references public.consents(id),
  contact_ref     text,
  storage_path    text,                          -- tmp/{id}.pdf; NULLed once the PDF is deleted
  status          text not null default 'awaiting_upload',
  error           text,
  created_at      timestamptz not null default now(),
  uploaded_at     timestamptz,
  analyzed_at     timestamptz,
  pdf_deleted_at  timestamptz,                   -- set at step 6 (happy path deletes immediately)
  sweep_after     timestamptz,                   -- TTL for orphaned/incomplete uploads (safety net)
  constraint reports_status_check check (
    status in ('awaiting_upload', 'processing', 'analyzed', 'failed', 'deleted')
  )
);

-- Cron sweep scans by status + sweep_after; analyze/status filter by status.
create index if not exists reports_status_idx      on public.reports (status);
create index if not exists reports_sweep_after_idx  on public.reports (sweep_after);
create index if not exists reports_consent_id_idx   on public.reports (consent_id);

-- ----------------------------------------------------------------------------
-- rate_limits — coarse IP rate limiting + global cost cap (plan §4.1)
-- bucket_key examples: 'ip:1.2.3.4:2026-08-06', 'global:2026-08-06'
-- ----------------------------------------------------------------------------
create table if not exists public.rate_limits (
  bucket_key    text primary key,
  count         int not null default 0,
  window_start  timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- report_analysis — the ONLY persisted sensitive asset. The raw PDF is deleted
-- after extraction (plan §6.1 / §9.3); we keep only the structured extraction.
--
--   extracted        : tri-bureau structured facts (plan §17.2) — scores per
--                      bureau, per-bureau account values, reason codes, inquiries.
--   recommendations  : backend-curated suggested scenarios (plan §14.5 / §14.6).
--   token_usage      : OpenAI usage for cost monitoring (plan §7.6).
-- ----------------------------------------------------------------------------
create table if not exists public.report_analysis (
  report_id        uuid primary key references public.reports(id) on delete cascade,
  model            text not null,               -- e.g. the OPENAI_MODEL used for extraction
  extracted        jsonb not null,
  recommendations  jsonb,
  token_usage      jsonb,
  created_at       timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- RLS: enable on every table; NO anon/authenticated policies => deny-all to them.
-- Service role (used by the Vercel backend) bypasses RLS entirely.
-- ----------------------------------------------------------------------------
alter table public.consents        enable row level security;
alter table public.reports         enable row level security;
alter table public.rate_limits     enable row level security;
alter table public.report_analysis enable row level security;

-- ----------------------------------------------------------------------------
-- Storage: private bucket for transient PDFs (plan §6.1).
-- private (public = false), PDF-only, 10 MB cap (matches the frontend contract).
-- All access is via short-TTL signed upload URLs + service-role download.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('credit-reports', 'credit-reports', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;
