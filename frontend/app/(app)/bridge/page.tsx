"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { usePrivy, useWallets } from "@privy-io/react-auth"
import { parseUnits, formatUnits, type Signer } from "ethers"
import { ArrowRight, Check, Copy, ExternalLink, Loader2, Rocket } from "lucide-react"

import { TxLink } from "@/components/tx-link"
import { arcExplorerAddr, arcProvider } from "@/lib/arc"
import {
  approveTokenMessenger,
  baseAllowance,
  baseEthBalance,
  baseSigner,
  baseUsdcBalance,
  BASE_SEPOLIA,
  CCTP_V2,
  depositForBurn,
  fetchAttestation,
  receiveMessage,
} from "@/lib/cctp"
import { arcSigner } from "@/lib/arc"

type StepId = "approve" | "burn" | "attest" | "mint"
type StepState = "idle" | "running" | "done" | "error"
type StepInfo = { state: StepState; hash?: string; note?: string }

const initial: Record<StepId, StepInfo> = {
  approve: { state: "idle" },
  burn: { state: "idle" },
  attest: { state: "idle" },
  mint: { state: "idle" },
}

const LS_KEY = "bridge:last-run" // { steps, amount, recipient, burnTx, mintTx }

type Persisted = {
  amount: string
  recipient: string
  steps: Record<StepId, StepInfo>
  attestationStatus?: string
  attestationElapsed?: number
}

function loadPersisted(): Persisted | null {
  if (typeof window === "undefined") return null
  try { return JSON.parse(window.localStorage.getItem(LS_KEY) ?? "null") } catch { return null }
}
function savePersisted(p: Persisted | null) {
  if (typeof window === "undefined") return
  if (p == null) window.localStorage.removeItem(LS_KEY)
  else window.localStorage.setItem(LS_KEY, JSON.stringify(p))
}

export default function BridgePage() {
  const router = useRouter()
  const { ready, authenticated } = usePrivy()
  const { wallets } = useWallets()
  useEffect(() => { if (ready && !authenticated) router.replace("/") }, [ready, authenticated, router])

  const wallet = wallets[0]
  const walletAddr = wallet?.address ?? null

  const [amountUsdc, setAmountUsdc] = useState("5")
  const [recipient, setRecipient] = useState<string>(walletAddr ?? "")
  const [steps, setSteps] = useState<Record<StepId, StepInfo>>(initial)
  const [attestStatus, setAttestStatus] = useState<string>("waiting")
  const [attestElapsed, setAttestElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // balances (live)
  const [baseUsdc, setBaseUsdc] = useState<bigint | null>(null)
  const [baseEth, setBaseEth] = useState<bigint | null>(null)
  const [arcUsdc, setArcUsdc] = useState<bigint | null>(null)

  useEffect(() => {
    // Hydrate any prior in-flight run so a page reload after a burn can still
    // reach the mint step from the same recipient/amount/burnTx state.
    const p = loadPersisted()
    if (p) {
      setAmountUsdc(p.amount)
      setRecipient(p.recipient)
      setSteps(p.steps)
      setAttestStatus(p.attestationStatus ?? "waiting")
      setAttestElapsed(p.attestationElapsed ?? 0)
    }
  }, [])

  // Once the wallet is available, default the recipient to it.
  useEffect(() => {
    if (walletAddr && recipient === "") setRecipient(walletAddr)
  }, [walletAddr, recipient])

  // Poll balances every 5s while page open.
  useEffect(() => {
    let cancel = false
    async function tick() {
      if (!walletAddr) return
      try {
        const [bu, be, au] = await Promise.all([
          baseUsdcBalance(walletAddr),
          baseEthBalance(walletAddr),
          arcProvider().getBalance(recipient || walletAddr),
        ])
        if (cancel) return
        setBaseUsdc(bu); setBaseEth(be); setArcUsdc(au)
      } catch { /* transient */ }
    }
    tick()
    const t = setInterval(tick, 5000)
    return () => { cancel = true; clearInterval(t) }
  }, [walletAddr, recipient])

  // Persist steps whenever they change so refresh keeps the story alive.
  useEffect(() => {
    if (!walletAddr) return
    savePersisted({ amount: amountUsdc, recipient, steps, attestationStatus: attestStatus, attestationElapsed: attestElapsed })
  }, [walletAddr, amountUsdc, recipient, steps, attestStatus, attestElapsed])

  const amount = useMemo(() => {
    try { return parseUnits(amountUsdc || "0", 6) } catch { return 0n }
  }, [amountUsdc])

  const canBridge = amount > 0n && recipient.startsWith("0x") && recipient.length === 42 && !!wallet
  const inFlight = Object.values(steps).some((s) => s.state === "running")

  async function withStep<T>(id: StepId, fn: () => Promise<T>, note?: (r: T) => string): Promise<T | null> {
    setError(null)
    setSteps((prev) => ({ ...prev, [id]: { state: "running", ...(prev[id].hash ? { hash: prev[id].hash } : {}) } }))
    try {
      const r = await fn()
      setSteps((prev) => ({ ...prev, [id]: { state: "done", hash: (r as any)?.hash ?? (r as any)?.txHash ?? prev[id].hash, note: note?.(r) } }))
      return r
    } catch (e: any) {
      const msg = e?.shortMessage ?? e?.message ?? String(e)
      setSteps((prev) => ({ ...prev, [id]: { state: "error", note: msg } }))
      setError(msg)
      return null
    }
  }

  async function getBaseSignerForWallet(): Promise<Signer> {
    if (!wallet) throw new Error("connect a wallet first")
    return baseSigner(await wallet.getEthereumProvider())
  }
  async function getArcSignerForWallet(): Promise<Signer> {
    if (!wallet) throw new Error("connect a wallet first")
    return arcSigner(await wallet.getEthereumProvider())
  }

  const onBridge = async () => {
    if (!canBridge) return

    // 1) approve — skip if allowance already covers the amount
    let approveHash: string | undefined
    if (walletAddr) {
      const cur = await baseAllowance(walletAddr, CCTP_V2.tokenMessenger)
      if (cur < amount) {
        const r = await withStep("approve", async () => {
          const signer = await getBaseSignerForWallet()
          const hash = await approveTokenMessenger(signer, amount)
          return { hash }
        })
        if (!r) return
        approveHash = r.hash
      } else {
        setSteps((prev) => ({ ...prev, approve: { state: "done", note: "already sufficient" } }))
      }
    }

    // 2) burn
    const burn = await withStep("burn", async () => {
      const signer = await getBaseSignerForWallet()
      const hash = await depositForBurn(signer, amount, recipient)
      return { hash }
    })
    if (!burn) return

    // 3) attestation (long poll — 30s to ~7min typical)
    setSteps((prev) => ({ ...prev, attest: { state: "running" } }))
    let attestation: { message: string; attestation: string }
    try {
      attestation = await fetchAttestation(BASE_SEPOLIA.cctpDomain, burn.hash, (secs, status) => {
        setAttestStatus(status); setAttestElapsed(secs)
      })
      setSteps((prev) => ({ ...prev, attest: { state: "done", note: `ready in ${attestElapsed}s` } }))
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      setSteps((prev) => ({ ...prev, attest: { state: "error", note: msg } }))
      setError(msg)
      return
    }

    // 4) mint on Arc — the wallet switches chains here
    await withStep("mint", async () => {
      const signer = await getArcSignerForWallet()
      const hash = await receiveMessage(signer, attestation.message, attestation.attestation)
      return { hash }
    })
  }

  const onReset = () => {
    if (!confirm("Clear the current bridge run from local storage? On-chain history is unaffected.")) return
    savePersisted(null); setSteps(initial); setAttestStatus("waiting"); setAttestElapsed(0); setError(null)
  }

  const allDone = steps.approve.state === "done" && steps.burn.state === "done" && steps.attest.state === "done" && steps.mint.state === "done"

  return (
    <div className="space-y-8">
      <header>
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-foreground/70">
          Cross-chain funding · Circle CCTP v2
        </p>
        <h1 className="mt-3 flex items-center gap-3 font-sans text-4xl font-light tracking-tight" style={{ color: "#EDEAE3" }}>
          <ArrowRight className="h-8 w-8 text-[#2563eb]" />
          Bridge USDC from Base Sepolia to Arc
        </h1>
        <p className="mt-3 max-w-2xl font-mono text-sm leading-relaxed text-foreground/70">
          Real burn on Base, Circle Iris attestation, real mint on Arc. Uses the same v2 addresses as the CLI demo.
          Attestation ready-time is typically ~30-90 seconds.
        </p>
      </header>

      {error && (
        <div className="rounded border border-red-500/40 bg-red-500/10 p-3 font-mono text-xs text-red-300">
          <span className="font-bold uppercase tracking-wider">error</span> · {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <BalanceCard title="Base Sepolia · USDC" value={baseUsdc != null ? `${formatUnits(baseUsdc, 6)} USDC` : "—"} sub={walletAddr ?? "connect wallet"} chain="base" address={walletAddr} />
        <BalanceCard title="Base Sepolia · ETH (gas)" value={baseEth != null ? `${formatUnits(baseEth, 18)} ETH` : "—"} sub="needed to sign the burn" chain="base" address={walletAddr} />
        <BalanceCard title="Arc · native USDC" value={arcUsdc != null ? `${formatUnits(arcUsdc, 18)} USDC` : "—"} sub={recipient ? "recipient balance" : "—"} chain="arc" address={recipient} />
      </div>

      <div className="rounded-xl border border-border bg-black/30 p-6 backdrop-blur-sm">
        <p className="mb-4 font-mono text-xs uppercase tracking-wider text-foreground/75">Bridge parameters</p>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="font-mono text-xs uppercase tracking-wider text-foreground/60">Source chain</label>
            <div className="mt-2 rounded border border-border bg-black/40 px-3 py-2 font-mono text-sm text-foreground/85">
              {BASE_SEPOLIA.name} · domain {BASE_SEPOLIA.cctpDomain}
            </div>
          </div>
          <div>
            <label className="font-mono text-xs uppercase tracking-wider text-foreground/60">Amount (USDC)</label>
            <input
              type="text"
              inputMode="decimal"
              value={amountUsdc}
              onChange={(e) => setAmountUsdc(e.target.value.replace(/[^\d.]/g, ""))}
              disabled={inFlight}
              className="mt-2 w-full rounded border border-border bg-black/40 px-3 py-2 font-mono text-sm text-foreground focus:border-[#2563eb]/60 focus:outline-none"
            />
          </div>
          <div className="md:col-span-2">
            <label className="font-mono text-xs uppercase tracking-wider text-foreground/60">Recipient address on Arc</label>
            <input
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value.trim())}
              placeholder="0x…"
              disabled={inFlight}
              className="mt-2 w-full rounded border border-border bg-black/40 px-3 py-2 font-mono text-sm text-foreground focus:border-[#2563eb]/60 focus:outline-none"
            />
            <p className="mt-1 font-mono text-[10px] text-foreground/50">defaults to your connected wallet · editable</p>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <button
            onClick={onBridge}
            disabled={!canBridge || inFlight}
            className="inline-flex items-center gap-2 rounded border border-[#2563eb]/40 bg-[#2563eb]/10 px-5 py-2 font-mono text-xs uppercase tracking-wider text-foreground transition-colors hover:bg-[#2563eb]/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {inFlight ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
            Bridge {amountUsdc || "0"} USDC → Arc
          </button>
          {(allDone || Object.values(steps).some((s) => s.state !== "idle")) && (
            <button
              onClick={onReset}
              className="rounded border border-border px-4 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Step tracker */}
      <div className="rounded-xl border border-border bg-black/30 p-6 backdrop-blur-sm">
        <p className="mb-4 font-mono text-xs uppercase tracking-wider text-foreground/75">Progress</p>
        <ol className="space-y-3">
          <Step
            n={1}
            title="Approve TokenMessenger to burn USDC"
            chain="base"
            state={steps.approve.state}
            hash={steps.approve.hash}
            note={steps.approve.note}
          />
          <Step
            n={2}
            title="depositForBurn — burn USDC on Base Sepolia"
            chain="base"
            state={steps.burn.state}
            hash={steps.burn.hash}
          />
          <Step
            n={3}
            title="Fetch Circle Iris attestation"
            chain={null}
            state={steps.attest.state}
            note={steps.attest.state === "running" ? `${attestStatus} · ${attestElapsed}s elapsed` : steps.attest.note}
          />
          <Step
            n={4}
            title="receiveMessage — mint USDC on Arc"
            chain="arc"
            state={steps.mint.state}
            hash={steps.mint.hash}
          />
        </ol>
        {allDone && (
          <p className="mt-4 rounded border border-emerald-500/40 bg-emerald-500/5 p-3 font-mono text-xs text-emerald-300">
            ✓ USDC bridged. The recipient balance on Arc has now increased by ~{amountUsdc} USDC (net of the small fast-transfer fee).
            <a href="/stream" className="ml-2 underline">Try the stream demo →</a>
          </p>
        )}
      </div>
    </div>
  )
}

function BalanceCard({ title, value, sub, chain, address }: { title: string; value: string; sub: string; chain: "arc" | "base"; address: string | null }) {
  const [copied, setCopied] = useState(false)
  const href = address ? (chain === "arc" ? arcExplorerAddr(address) : `${BASE_SEPOLIA.explorer}/address/${address}`) : null
  const shortAddr = address ? `${address.slice(0, 6)}…${address.slice(-6)}` : ""
  return (
    <div className="rounded-lg border border-border bg-black/40 p-4">
      <p className="font-mono text-xs uppercase tracking-wider text-foreground/70">{title}</p>
      <p className="mt-2 font-sans text-2xl font-light tracking-tight" style={{ color: "#EDEAE3" }}>{value}</p>
      {address && href ? (
        <div className="mt-1 flex items-center gap-1.5 font-mono text-xs text-foreground/60">
          <span title={address}>{shortAddr}</span>
          <button onClick={() => { navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 900) }} className="text-muted-foreground hover:text-foreground">
            <Copy className="h-3 w-3" />
          </button>
          <a href={href} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
            <ExternalLink className="h-3 w-3" />
          </a>
          {copied && <span className="text-emerald-400">copied</span>}
        </div>
      ) : (
        <p className="mt-1 font-mono text-xs text-foreground/60">{sub}</p>
      )}
    </div>
  )
}

function Step({ n, title, chain, state, hash, note }: { n: number; title: string; chain: "arc" | "base" | null; state: StepState; hash?: string; note?: string }) {
  const color =
    state === "done" ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-300"
    : state === "running" ? "border-[#2563eb]/40 bg-[#2563eb]/5 text-[#2563eb]"
    : state === "error" ? "border-red-500/40 bg-red-500/5 text-red-300"
    : "border-border bg-black/20 text-muted-foreground"
  const icon = state === "done" ? <Check className="h-4 w-4" />
    : state === "running" ? <Loader2 className="h-4 w-4 animate-spin" />
    : <span className="font-mono text-xs">{n}</span>
  return (
    <li className={`flex items-start gap-3 rounded border p-3 ${color}`}>
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-current">{icon}</span>
      <div className="flex-1">
        <p className="font-mono text-sm text-foreground/90">{title}</p>
        {note && <p className="mt-1 font-mono text-xs text-foreground/60">{note}</p>}
      </div>
      {hash && chain && <TxLink hash={hash} chain={chain} />}
    </li>
  )
}
