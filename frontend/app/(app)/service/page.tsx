"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { usePrivy } from "@privy-io/react-auth"
import { AlertTriangle, ArrowRight, ExternalLink, ShieldCheck, Terminal, Zap } from "lucide-react"

import { TxLink } from "@/components/tx-link"
import { ARC_CHAIN, arcExplorerAddr } from "@/lib/arc"

// Historical evidence from the recorded live run — used only for "look, this
// really works on Arc." The design doc's anti-goal is explicit:
// > no mocked tx hashes in the UI.
// So these are pinned as "last real run · not this session" and only render
// as an evidence panel, never as something the page produced this visit.
const HISTORICAL = {
  when: "2026-06 · Arc testnet · chainId 5042002",
  contracts: {
    shieldedPool: "0x4650000000000000000000000000000000000A0F5",   // display-only short form in the docs
    streamEscrow: "0xee1B00000000000000000000000000000000d29b",   // display-only short form in the docs
    // display-only — no attempt to resolve on-chain; matches the doc snapshot.
    // For canonical addresses see docs/testnet-transactions.md and the
    // 2026-06 arcscan links below.
  },
  openTxShort: "0x6e87f408",
  settleTxShort: "0xec66753c",
  openBlock: 50_297_330,
  settleBlock: 50_297_357,
  requests: 100,
} as const

const PROMPTS = [
  "analyze market sentiment for USDC",
  "is this contract safe to call?",
  "summarize the latest block",
  "rate this transaction risk",
  "should the agent top up the channel?",
]

type Voucher = { seq: number; cumulative: number; prompt: string; response: string }

// Deterministic fake response (matches agent-service-demo.ts's runInference feel:
// a hash-derived sentiment score, so the response clearly depends on prompt).
function fakeInference(prompt: string, seq: number): { sentiment: string; score: number } {
  let h = 0
  const s = `${seq}:${prompt}`
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  const score = ((h & 0xff) / 255)
  return { sentiment: score > 0.5 ? "positive" : "negative", score: Math.round(score * 100) / 100 }
}

export default function ServicePage() {
  const router = useRouter()
  const { ready, authenticated } = usePrivy()
  useEffect(() => { if (ready && !authenticated) router.replace("/") }, [ready, authenticated, router])

  const [cap] = useState<number>(100)
  const [vouchers, setVouchers] = useState<Voucher[]>([])
  const highest = vouchers[vouchers.length - 1]

  const sendOne = () => {
    setVouchers((prev) => {
      if (prev.length >= cap) return prev
      const seq = prev.length + 1
      const prompt = PROMPTS[seq % PROMPTS.length]
      const inf = fakeInference(prompt, seq)
      return [...prev, { seq, cumulative: seq, prompt, response: `${inf.sentiment} (${inf.score})` }]
    })
  }
  const sendMany = (n: number) => {
    setVouchers((prev) => {
      const room = Math.max(0, cap - prev.length)
      const take = Math.min(n, room)
      const rows = [...prev]
      for (let i = 0; i < take; i++) {
        const seq = rows.length + 1
        const prompt = PROMPTS[seq % PROMPTS.length]
        const inf = fakeInference(prompt, seq)
        rows.push({ seq, cumulative: seq, prompt, response: `${inf.sentiment} (${inf.score})` })
      }
      return rows
    })
  }
  const reset = () => setVouchers([])

  const displayed = useMemo(() => vouchers.slice(-6).reverse(), [vouchers])
  const filled = vouchers.length / cap

  return (
    <div className="space-y-8">
      <header>
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-foreground/70">
          Rail B · Privacy layer · agent-service
        </p>
        <h1 className="mt-3 flex items-center gap-3 font-sans text-4xl font-light tracking-tight" style={{ color: "#EDEAE3" }}>
          <ShieldCheck className="h-8 w-8 text-[#2563eb]" />
          100 metered requests, one shielded settle
        </h1>
        <p className="mt-3 max-w-2xl font-mono text-sm leading-relaxed text-foreground/70">
          Per-call payments as off-chain EdDSA vouchers, zero gas per request. When the session ends the payee submits
          <b> ONE</b> settle transaction with a Groth16 proof — the payer's voucher signature is verified in-circuit and
          the payee earns a shielded note whose amount is hidden on-chain.
        </p>
      </header>

      <SeamBanner />

      {/* Interactive mechanic — the visualisation of what a voucher session feels like */}
      <section className="rounded-xl border border-border bg-black/30 p-6 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <p className="font-mono text-xs uppercase tracking-wider text-foreground/85">Mechanic · visualise a session</p>
          <span className="rounded-full border border-[#2563eb]/30 bg-[#2563eb]/5 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-[#2563eb]">
            local · no chain writes
          </span>
        </div>

        {/* Channel state header */}
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <MeterField label="channel status" value={vouchers.length === 0 ? "closed" : "open"} tone={vouchers.length === 0 ? "muted" : "blue"} />
          <MeterField label="cap" value={`${cap} units`} tone="muted" />
          <MeterField label="signed so far" value={`${vouchers.length} · ${(filled * 100).toFixed(0)}%`} tone="amber" />
        </div>

        {/* Cap bar */}
        <div className="mt-4">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/60">
            <div className="h-full bg-[#2563eb] transition-all" style={{ width: `${Math.min(100, filled * 100)}%` }} />
          </div>
          <p className="mt-1 font-mono text-[10px] text-foreground/50">
            each request signs one more voucher — no chain, no gas. the settle proof enforces cumulative ≤ cap.
          </p>
        </div>

        {/* Action row */}
        <div className="mt-6 flex flex-wrap gap-2">
          <ActionBtn onClick={sendOne} disabled={vouchers.length >= cap}>Send 1 request</ActionBtn>
          <ActionBtn onClick={() => sendMany(10)} disabled={vouchers.length >= cap}>×10</ActionBtn>
          <ActionBtn onClick={() => sendMany(100)} disabled={vouchers.length >= cap}>×100</ActionBtn>
          <ActionBtn onClick={reset} disabled={vouchers.length === 0} variant="ghost">Reset</ActionBtn>
        </div>

        {/* Live log */}
        {vouchers.length > 0 && (
          <div className="mt-6 rounded border border-border/70 bg-black/40 p-3">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-foreground/60">
              latest vouchers (showing last {displayed.length} of {vouchers.length})
            </p>
            <ol className="divide-y divide-border/50">
              {displayed.map((v) => (
                <li key={v.seq} className="grid grid-cols-[3rem_1fr_5rem_9rem] items-center gap-3 py-1 font-mono text-xs">
                  <span className="text-foreground/60">#{v.seq}</span>
                  <span className="truncate text-foreground/80">{v.prompt}</span>
                  <span className="text-right text-foreground/70">paid {v.cumulative}</span>
                  <span className="text-right text-foreground/80">→ {v.response}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Settle CTA (informational only) */}
        {highest && (
          <div className="mt-6 rounded border border-amber-500/30 bg-amber-500/5 p-4 font-mono text-xs leading-relaxed text-amber-200/80">
            <p className="uppercase tracking-wider text-amber-300">next step in the real flow</p>
            <p className="mt-2">
              The payee submits <b>one</b> settle tx carrying a Groth16 proof over the highest voucher
              (<code>cumulative = {highest.cumulative}</code>). The circuit verifies the payer's EdDSA signature and bounds
              <code> cumulative ≤ cap</code>. Two shielded notes are minted: the payee's earnings and the payer's refund.
            </p>
            <p className="mt-2">
              Proof building runs in <code>apps/api</code>; this page doesn't submit that tx yet — see the CLI card below to
              run the whole thing end-to-end against real Arc testnet.
            </p>
          </div>
        )}
      </section>

      {/* Historical evidence — real recorded hashes from a real live run */}
      <section className="rounded-xl border border-border bg-black/30 p-6 backdrop-blur-sm">
        <div className="mb-4 flex items-center justify-between">
          <p className="font-mono text-xs uppercase tracking-wider text-foreground/85">
            <span className="text-emerald-300">Real</span> · last recorded live run
          </p>
          <span className="font-mono text-[10px] uppercase tracking-wider text-foreground/50">
            {HISTORICAL.when}
          </span>
        </div>
        <p className="font-mono text-xs leading-relaxed text-foreground/70">
          A previous run of <code>agent-service-demo:arc</code> — {HISTORICAL.requests} metered requests, one settle tx —
          verified on-chain by Arc's BN254 pairing precompiles. Not this session; historical evidence that the mechanic
          works end-to-end on real Arc.
        </p>
        <div className="mt-4 space-y-2">
          <HistoryLine
            label="Open a payment channel (1 ZK proof)"
            hashShort={HISTORICAL.openTxShort}
            block={HISTORICAL.openBlock}
          />
          <HistoryLine
            label={`Settle ${HISTORICAL.requests} requests' net (1 ZK proof)`}
            hashShort={HISTORICAL.settleTxShort}
            block={HISTORICAL.settleBlock}
          />
        </div>
        <p className="mt-4 font-mono text-[10px] text-foreground/50">
          Contract addresses in <code>docs/testnet-transactions.md</code>. Full run log there.
        </p>
      </section>

      {/* Real-thing runbook */}
      <section className="rounded-xl border border-border bg-black/30 p-6 backdrop-blur-sm">
        <div className="mb-3 flex items-center gap-2">
          <Terminal className="h-4 w-4 text-[#2563eb]" />
          <p className="font-mono text-xs uppercase tracking-wider text-foreground/85">Run the real thing (CLI)</p>
        </div>
        <p className="font-mono text-xs leading-relaxed text-foreground/70">
          The full lifecycle — deploy pool + escrow + verifiers on Arc, open a channel with a Groth16 proof, stream N off-chain
          vouchers, settle the private net — runs today from the CLI. Uses the exact same code paths this page will call once
          the backend proof endpoint is wired.
        </p>
        <div className="mt-4 space-y-2 rounded border border-border bg-black/50 p-3 font-mono text-xs text-foreground/85">
          <div><span className="text-muted-foreground">$</span> npm run agent-service-demo <span className="text-foreground/50"># local anvil</span></div>
          <div><span className="text-muted-foreground">$</span> npm run agent-service-demo:arc <span className="text-foreground/50"># REAL Arc testnet</span></div>
          <div><span className="text-muted-foreground">$</span> REQUESTS=1000 npm run agent-service-demo:arc</div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 font-mono text-xs">
          <a
            href="/receipts"
            className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 uppercase tracking-wider text-foreground/85 hover:text-foreground"
          >
            <Zap className="h-3.5 w-3.5" />
            View persisted receipts <ArrowRight className="h-3 w-3" />
          </a>
          <a
            href="/stream"
            className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 uppercase tracking-wider text-foreground/85 hover:text-foreground"
          >
            Or try the base rail <ArrowRight className="h-3 w-3" />
          </a>
        </div>
      </section>
    </div>
  )
}

// -----------------------------------------------------------------------------

function SeamBanner() {
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-amber-300">
        <AlertTriangle className="h-4 w-4" /> honest scope
      </p>
      <p className="mt-2 font-mono text-xs leading-relaxed text-amber-200/85">
        The privacy layer's pool currently holds a <code>MockERC20</code> — binding the shielded settle to the
        <b> real</b> CCTP-minted Arc USDC (like the base rail does) is a documented seam (see
        <a href={`${ARC_CHAIN.explorer}`} className="ml-1 underline">arcscan</a> for chain state,
        <code> docs/E2E_REAL_WORKFLOW.md §2B</code> for the plan). And this page ships as a visualisation
        while the browser-side ZK proof endpoint is not yet wired — run the CLI card below to get real settle
        transactions on Arc today.
      </p>
    </div>
  )
}

function MeterField({ label, value, tone }: { label: string; value: string; tone: "muted" | "blue" | "amber" }) {
  const cls = tone === "blue" ? "text-[#2563eb]" : tone === "amber" ? "text-amber-300" : "text-muted-foreground"
  return (
    <div className="rounded border border-border bg-black/40 p-3">
      <p className={`font-mono text-[10px] uppercase tracking-wider ${cls}`}>{label}</p>
      <p className="mt-1 font-sans text-xl font-light tracking-tight" style={{ color: "#EDEAE3" }}>{value}</p>
    </div>
  )
}

function ActionBtn({
  children, onClick, disabled, variant,
}: { children: React.ReactNode; onClick: () => void; disabled?: boolean; variant?: "primary" | "ghost" }) {
  const base = "inline-flex items-center gap-2 rounded border px-4 py-2 font-mono text-xs uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40"
  const style = variant === "ghost"
    ? "border-border text-muted-foreground hover:text-foreground"
    : "border-[#2563eb]/40 bg-[#2563eb]/10 text-foreground hover:bg-[#2563eb]/20"
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${style}`}>{children}</button>
  )
}

function HistoryLine({ label, hashShort, block }: { label: string; hashShort: string; block: number }) {
  // No real hash available at build time — we render a display-only pointer to
  // arcscan's search rather than a fake link. Users can copy the block number
  // and scan for the tx if they want the raw evidence.
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-border/70 bg-black/40 p-3 font-mono text-xs">
      <div>
        <p className="text-foreground/85">{label}</p>
        <p className="mt-0.5 text-foreground/55">tx {hashShort}… · block {block.toLocaleString()}</p>
      </div>
      <a
        href={`${ARC_CHAIN.explorer}/block/${block}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-[#2563eb] hover:underline"
      >
        arcscan block <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  )
}
