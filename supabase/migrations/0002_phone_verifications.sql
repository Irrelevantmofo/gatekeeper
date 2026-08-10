-- ============================================================================
-- Phone OTP verification — backend-owned codes (docs/otp-access-plan.md).
-- We generate/store/verify the OTP ourselves and send it via GHL's SMS API
-- (LC Phone, existing A2P registration). Codes are stored HASHED, never plain.
-- ============================================================================

create table if not exists public.phone_verifications (
  id            uuid primary key default gen_random_uuid(),
  phone         text not null,            -- E.164
  code_hash     text not null,            -- HMAC/sha256 of the code, never plaintext
  expires_at    timestamptz not null,
  attempts      int not null default 0,
  max_attempts  int not null default 5,
  verified_at   timestamptz,
  contact_ref   text,                     -- GHL contact id / phone
  ip            inet,
  created_at    timestamptz not null default now()
);

-- verify looks up the latest unverified code for a phone.
create index if not exists phone_verifications_phone_idx on public.phone_verifications (phone, created_at desc);

-- RLS on, no anon/authenticated policies => service-role only (matches other tables).
alter table public.phone_verifications enable row level security;
