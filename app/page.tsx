"use client"

import type React from "react"

import { useState } from "react"

type GateStatus = "no_contact" | "gate_closed" | "gate_open"

interface GateResult {
  status?: GateStatus | "marked" | "not_found"
  message?: string
  error?: string
  contactId?: string
}

const STATUS_STYLES: Record<GateStatus, { label: string; className: string }> = {
  no_contact: {
    label: "No Contact",
    className: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  },
  gate_open: {
    label: "Gate Open",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  },
  gate_closed: {
    label: "Gate Closed",
    className: "border-red-500/40 bg-red-500/10 text-red-300",
  },
}

export default function Page() {
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [loading, setLoading] = useState(false)
  const [marking, setMarking] = useState(false)
  const [result, setResult] = useState<GateResult | null>(null)
  const [statusCode, setStatusCode] = useState<number | null>(null)

  async function callEndpoint(path: string) {
    if (!email && !phone) return

    setResult(null)
    setStatusCode(null)

    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email || undefined, phone: phone || undefined }),
      })
      setStatusCode(res.status)
      const data = (await res.json()) as GateResult
      setResult(data)
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : "Request failed." })
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email && !phone) return
    setLoading(true)
    await callEndpoint("/api/check-contact")
    setLoading(false)
  }

  async function handleMarkUsed() {
    if (!email && !phone) return
    setMarking(true)
    await callEndpoint("/api/mark-used")
    setMarking(false)
  }

  const statusStyle =
    result?.status && result.status in STATUS_STYLES ? STATUS_STYLES[result.status as GateStatus] : null

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-lg flex-col justify-center gap-6 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-balance">Gatekeeper Lookup Tester</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Check a GoHighLevel contact against the business-analyzer gate. Enter an email, a phone, or both.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="contact@example.com"
            className="rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="phone" className="text-sm font-medium">
            Phone <span className="text-muted-foreground">(include country code, e.g. +15551234567)</span>
          </label>
          <input
            id="phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+15551234567"
            className="rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="submit"
            disabled={loading || marking || (!email && !phone)}
            className="inline-flex flex-1 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Checking..." : "Check Contact"}
          </button>

          <button
            type="button"
            onClick={handleMarkUsed}
            disabled={loading || marking || (!email && !phone)}
            className="inline-flex flex-1 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {marking ? "Marking..." : "Mark as Used"}
          </button>
        </div>
      </form>

      {result && (
        <section className="flex flex-col gap-3" aria-live="polite">
          {statusStyle && (
            <div className={`flex flex-col gap-1 rounded-lg border p-4 ${statusStyle.className}`}>
              <span className="text-xs font-semibold uppercase tracking-wide">{statusStyle.label}</span>
              <span className="text-sm text-foreground">{result.message}</span>
            </div>
          )}

          {result.error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
              {result.error}
            </div>
          )}

          <details className="rounded-lg border border-border bg-muted/30 p-3">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              Raw response{statusCode !== null ? ` (HTTP ${statusCode})` : ""}
            </summary>
            <pre className="mt-2 overflow-x-auto text-xs text-muted-foreground">{JSON.stringify(result, null, 2)}</pre>
          </details>
        </section>
      )}
    </main>
  )
}
