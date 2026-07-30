"use client"

import type React from "react"

import { useState } from "react"
import { Button } from "@/components/ui/button"

type GateStatus = "no_contact" | "gate_closed" | "gate_open"

interface GateResult {
  status?: GateStatus
  message?: string
  error?: string
}

const STATUS_STYLES: Record<GateStatus, string> = {
  no_contact: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  gate_closed: "border-red-500/40 bg-red-500/10 text-red-300",
  gate_open: "border-amber-500/40 bg-amber-500/10 text-amber-300",
}

export default function Page() {
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<GateResult | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setResult(null)

    try {
      const res = await fetch("/api/check-contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, phone }),
      })
      const data = (await res.json()) as GateResult
      setResult(data)
    } catch {
      setResult({ error: "Request failed. Please try again." })
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-balance">Business Analyzer Gate Check</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Check a GoHighLevel contact by email or phone to see if they can access the analyzer.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
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

        <div className="flex flex-col gap-2">
          <label htmlFor="phone" className="text-sm font-medium">
            Phone
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

        <Button type="submit" disabled={loading || (!email && !phone)}>
          {loading ? "Checking..." : "Check contact"}
        </Button>
      </form>

      {result?.message && result.status && (
        <div className={`rounded-md border px-4 py-3 text-sm leading-relaxed ${STATUS_STYLES[result.status]}`}>
          {result.message}
        </div>
      )}

      {result?.error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm leading-relaxed text-red-300">
          {result.error}
        </div>
      )}
    </main>
  )
}
