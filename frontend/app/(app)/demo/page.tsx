"use client"

import Link from "next/link"
import { ArrowRight, Zap, ShieldCheck, ArrowDownToLine } from "lucide-react"

export default function DemoPage() {
  return (
    <div className="space-y-10">
      <header>
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-foreground/70">
          Shade Streams · real nanopayments on Arc
        </p>
        <h1 className="mt-4 font-sans text-5xl font-light tracking-tight md:text-6xl" style={{ color: "#EDEAE3" }}>
          Pay by the fraction.
          <br />
          <span className="text-muted-foreground">Settle the net. Reveal nothing.</span>
        </h1>
        <p className="mt-6 max-w-2xl font-mono text-sm leading-relaxed text-foreground/70">
          Two rails, one story. The base rail streams <span className="text-foreground">real native USDC</span> per
          second on Arc. The privacy layer batches per-request vouchers and settles the private net through a single
          zero-knowledge proof. Pick a rail to run it against real Arc testnet.
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        <RailCard
          badge="Rail A · Base"
          title="StreamPay"
          icon={<Zap className="h-5 w-5 text-[#2563eb]" />}
          tagline="Real per-second USDC"
          bullets={[
            "$0.0001 / second — sub-cent nanopayment rate",
            "on-chain meter you can read every 500ms",
            "pause · resume · mid-stream withdraw · stop-with-refund",
            "value-conservation invariant asserted from events",
          ]}
          seam={null}
          href="/stream"
          cta="Run the stream demo"
        />

        <RailCard
          badge="Rail B · Privacy"
          title="Shielded settle"
          icon={<ShieldCheck className="h-5 w-5 text-[#2563eb]" />}
          tagline="ZK-batched, per-request"
          bullets={[
            "100+ requests, off-chain EdDSA vouchers, 0 gas per call",
            "ONE settle transaction — one Groth16 proof for the whole batch",
            "amounts hidden — only the net is revealed on-chain",
            "the payee earns a shielded note it alone can spend",
          ]}
          seam="Currently uses a mock USDC inside the pool — asset-binding to real Arc USDC is a documented seam (docs/E2E_REAL_WORKFLOW.md §2B)."
          href="/service"
          cta="Run the service demo"
        />
      </div>

      <div className="rounded-xl border border-[#2563eb]/30 bg-[#2563eb]/5 p-6">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div>
            <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-[#2563eb]">
              <ArrowDownToLine className="h-4 w-4" />
              need Arc USDC first?
            </p>
            <p className="mt-2 font-mono text-sm text-foreground/85">
              Bridge USDC from Base Sepolia to Arc via Circle CCTP — real burn, Iris attestation, real mint. Fund the
              streaming demos.
            </p>
          </div>
          <Link
            href="/bridge"
            className="inline-flex items-center gap-2 rounded-full border border-[#2563eb]/40 bg-[#2563eb]/10 px-5 py-2 font-mono text-xs uppercase tracking-wider text-foreground hover:bg-[#2563eb]/20"
          >
            Bridge from Base Sepolia
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-black/30 p-6 backdrop-blur-sm">
        <p className="mb-4 font-mono text-xs uppercase tracking-wider text-foreground/75">Where the money moves</p>
        <div className="grid gap-4 md:grid-cols-3">
          <PartyCard role="Payer (agent)" tone="agent" description="Funds the stream cap. Signs open / pause / resume / stop." />
          <PartyCard role="Escrow" tone="escrow" description="On-chain contract holding the deposit. Meters the accrual." />
          <PartyCard role="Payee (service)" tone="payee" description="Distinct address. Receives streamed USDC — either by pulling withdraw or via stop's push." />
        </div>
        <p className="mt-6 font-mono text-xs leading-relaxed text-foreground/60">
          The payee is a <span className="text-foreground">distinct address</span> across all demos — a fresh keypair
          generated per run so the balance delta on arcscan attributes 100% to the stream. See{" "}
          <a href="/receipts" className="text-[#2563eb] hover:underline">
            Receipts
          </a>{" "}
          for the persisted run history and the exact hashes.
        </p>
      </div>
    </div>
  )
}

function RailCard({
  badge,
  title,
  icon,
  tagline,
  bullets,
  seam,
  href,
  cta,
}: {
  badge: string
  title: string
  icon: React.ReactNode
  tagline: string
  bullets: string[]
  seam: string | null
  href: string
  cta: string
}) {
  return (
    <div className="flex flex-col rounded-xl border border-border bg-black/30 p-6 backdrop-blur-sm transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-[#2563eb]/40 hover:shadow-[0_10px_30px_-12px_rgba(37,99,235,0.35)]">
      <div className="flex items-center justify-between">
        <span className="rounded-full border border-border px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-foreground/75">
          {badge}
        </span>
        {icon}
      </div>
      <h2 className="mt-6 font-sans text-3xl font-light tracking-tight" style={{ color: "#EDEAE3" }}>
        {title}
      </h2>
      <p className="mt-1 font-mono text-xs uppercase tracking-wider text-foreground/70">{tagline}</p>
      <ul className="mt-6 space-y-2">
        {bullets.map((b) => (
          <li key={b} className="flex items-start gap-2 font-mono text-xs leading-relaxed text-foreground/85">
            <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-[#2563eb]" />
            {b}
          </li>
        ))}
      </ul>
      {seam && (
        <p className="mt-6 rounded border border-amber-500/20 bg-amber-500/5 p-3 font-mono text-[11px] leading-relaxed text-amber-200/80">
          {seam}
        </p>
      )}
      <div className="mt-auto pt-8">
        <Link
          href={href}
          className="group inline-flex w-full items-center justify-between rounded border border-border px-4 py-3 font-mono text-xs uppercase tracking-wider text-foreground transition-colors hover:border-[#2563eb]/50 hover:bg-[#2563eb]/10"
        >
          {cta}
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    </div>
  )
}

function PartyCard({ role, tone, description }: { role: string; tone: "agent" | "escrow" | "payee"; description: string }) {
  const accent = tone === "agent" ? "text-emerald-400" : tone === "escrow" ? "text-[#2563eb]" : "text-amber-300"
  return (
    <div className="rounded-lg border border-border bg-black/40 p-4">
      <p className={`font-mono text-xs uppercase tracking-wider ${accent}`}>{role}</p>
      <p className="mt-2 font-mono text-xs leading-relaxed text-foreground/75">{description}</p>
    </div>
  )
}
