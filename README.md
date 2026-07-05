# Shade Streams — Private Nanopayments for Agents on Arc

> **Pay by the fraction. Settle the net. Reveal nothing.**
>
> An AI agent consumes a paid service and pays **per request** — value as small
> as a fraction of a cent — by signing tiny **vouchers off-chain**. Only the
> **private net** settles on-chain, in **USDC on Arc**, funded **cross-chain via
> Circle CCTP**. Built on a zero-knowledge shielded pool, so the individual
> payments are invisible and only an auditable receipt is revealed.

<p align="center">
  <b>Nanopayments</b> &nbsp;•&nbsp; <b>Per-call streaming</b> &nbsp;•&nbsp; <b>ZK-private</b> &nbsp;•&nbsp; <b>Agent-native (x402)</b> &nbsp;•&nbsp; <b>Cross-chain USDC (CCTP)</b>
</p>

<p align="center">
  <code>Arc (Circle L1)</code> · <code>USDC-native gas</code> · <code>Groth16 / BN254</code> · <code>EdDSA vouchers</code> · <code>Circle CCTP v2</code> · <code>x402</code> · <code>TypeScript + Solidity + Circom</code>
</p>

<p align="center">
  Built for the <b>Lepton Agents Hackathon</b> · Canteen × Circle × Arc
</p>

---

## The 60-second version

For as long as a payment couldn't be smaller than ~30¢ after fees, you couldn't
sell a one-cent play or charge an agent per API call — you had to bundle a month
and charge $10. **Nanopayments remove the floor.** But a transparent per-call
loop leaks every payment. Shade Streams gives you both: **sub-cent, per-call
payments that are also private**, settled on Arc in USDC.

```
OPEN     agent locks a spending cap into a channel (1 ZK proof, private amount)
STREAM   agent signs a voucher per request — 0 gas, 0 chain writes, per call
SETTLE   service submits the highest voucher — only the NET hits chain (1 ZK proof)
RECLAIM  if never settled, the agent reclaims the full cap after a timeout
```

The USDC backing the channel is bridged in from another chain (Base / Arbitrum)
via **Circle CCTP** — so an agent pays for an Arc service with funds from
anywhere.

---

## It runs live on Arc testnet

Not a mock — deployed and settled on **real Arc testnet** (chainId 5042002),
with both ZK proofs verified on-chain by **Arc's BN254 pairing precompiles**:

| What | Transaction (on [arcscan](https://testnet.arcscan.app)) |
|------|------|
| Open a payment channel (ZK proof) | `0x6e87f408…` — block 50,297,330 |
| Settle 100 requests' net (ZK proof) | `0xec66753c…` — block 50,297,357 |

And a **real cross-chain USDC transfer** via Circle CCTP:

| What | Chain | Transaction |
|------|-------|------|
| Burn 5 USDC | Base Sepolia | [`0x1d8cb919…`](https://sepolia.basescan.org/tx/0x1d8cb9197aaca35e446e5662948a6dbf730ec9312f6e6ad90ba848732c1103e0) |
| Mint ~4.995 USDC | Arc testnet | [`0x8b7af5e6…`](https://testnet.arcscan.app/tx/0x8b7af5e6dce891ba8a6aaf571b589b525fb49a17858e51921bf8806c2c7e8857) |

---

## See it yourself

```bash
npm install
cd contracts/arc && forge build && cd ../..
npm run circuits:build:arc && npx tsx scripts/sync-arc-verifiers.ts

# an AI agent buys a service across 100 metered requests, then settles the net.
# runs on a local anvil EVM (no funds needed) — shows each request + payment:
npm run agent-service-demo

# the same, live on real Arc testnet (needs a faucet-funded key):
npm run agent-service-demo:arc
REQUESTS=1000 npm run agent-service-demo:arc     # scale to 1000 requests

# the literal cross-chain leg: burn USDC on Base Sepolia, mint on Arc via CCTP:
BASE_SEPOLIA_PRIVATE_KEY=0x…  npm run cctp-bridge:arc
```

`agent-service-demo` prints exactly what you'd want to see — per request, the
**prompt** the agent sent, the **payment** it authorized, and the **service's
response** — then one on-chain settlement for the whole session.

---

## How it works

A **unidirectional payment channel anchored to a shielded note**:

- **Vouchers are just signatures.** Each per-call payment is an EdDSA-Poseidon
  signature over `{channelId, cumulative, seq}`. The agent signs, the service
  verifies — no chain, no gas. Millions of ticks cost nothing.
- **The settle proof verifies the voucher in-circuit.** `stream_settle` runs
  circomlib's `EdDSAPoseidonVerifier` on the payer's signature and bounds
  `cumulative ≤ cap`, so the service can never settle more than the agent
  signed, and value is conserved (`payee + refund == cap`).
- **Notes live in a shared shielded pool.** Open/settle/reclaim mint ordinary
  shielded notes into `ShieldedPool`'s O(log n) Merkle tree; recipients spend
  them later through the normal withdraw/transfer paths.
- **The channel is consumed exactly once** — either settle or reclaim, never
  both — and the agent's input note nullifier is burned so it can't be reused.

The **8 named safety invariants** (cap bound, forged-voucher rejection, value
conservation, spend-once, timeout-reclaim, ASP-eligibility, receipt integrity)
are each covered by a specific test — see `docs/SHADE_STREAMS_STATUS.md`.

---

## Architecture

| Layer | Where | Role |
|-------|-------|------|
| BN254 circuits | `circuits/*_bn254/`, `circuits/lib_bn254/` | commitment + Merkle membership, in-circuit EdDSA voucher, value conservation |
| Proving library | `packages/proving/src/bn254/` | TS-native witness + Groth16 proof → native `uint256[]` calldata (no Rust, no byte-packer) |
| Contracts | `contracts/arc/src/` | `ShieldedPool`, `StreamEscrow`, `NullifierRegistry`, `IncrementalMerkleTree`, 7 verifiers |
| Voucher SDK + agents | `packages/sdk/src/{streams,agents,receipts}.ts` | sign/verify vouchers, `PayerAgent`/`PayeeAgent`, receipts |
| Chain client + CCTP | `packages/arc-actions/` | ethers calls, CCTP config + real bridge |
| x402 + relayer | `apps/api/src/x402.ts`, `apps/relayer/src/stream-relayer.ts` | service gating + batched settlement |

Everything security-critical is **on-chain**: proof verification (BN254
precompiles), nullifier spend-once, value conservation, Merkle append. The
backend never sees a note secret or a private key.

---

## Circle & Arc stack used

| Need | Primitive | Status |
|------|-----------|--------|
| Settlement chain, USDC gas | **Arc** (chainId 5042002) | ✅ deployed + settled live |
| Per-request payment trigger | **x402** | ✅ `apps/api/src/x402.ts` |
| Cross-chain USDC funding | **Circle CCTP v2** | ✅ real burn→attest→mint executed |
| Batched settlement | on-Arc `settleBatch` | ✅ (Circle **Gateway** gasless variant: documented seam) |
| Agent wallets / identity | EdDSA voucher keys + EVM wallets | ✅ |

---

## Repository layout

```
circuits/              Circom circuits — *_bn254 (Arc) + originals (Stellar)
contracts/arc/         Solidity: ShieldedPool, StreamEscrow, verifiers + Foundry tests
packages/
  proving/src/bn254/   TS-native BN254 proving (Poseidon, Merkle, coins, proofs)
  sdk/src/             voucher SDK, agents, receipts (browser-safe)
  arc-actions/         ethers chain client + CCTP config/bridge + demos
apps/
  api/src/x402.ts      x402 voucher-gated service middleware
  relayer/src/         streaming relayer (batched channel closes)
docs/                  SHADE_STREAMS.md (full overview), status + design docs
```

---

## Documentation

- **[docs/SHADE_STREAMS.md](docs/SHADE_STREAMS.md)** — the comprehensive overview: what it is, how it was built (6 phases), architecture, and the full demo workflow with live tx hashes. **Start here.**
- [docs/SHADE_STREAMS_STATUS.md](docs/SHADE_STREAMS_STATUS.md) — the streaming layer, the 8 invariants, and their tests.
- [docs/ARC_PORT_STATUS.md](docs/ARC_PORT_STATUS.md) — the Stellar → Arc port (all settlement flows).
- [docs/arc-zk-proof-system.md](docs/arc-zk-proof-system.md) — the BN254 ZK layer, proven on-chain.
- [docs/GATEWAY_SPIKE.md](docs/GATEWAY_SPIKE.md) · [docs/COMPLIANCE_MODEL.md](docs/COMPLIANCE_MODEL.md) — honest seams + decisions.

---

## Honest status

**Real & verified on-chain:** the BN254 ZK layer, every settlement path
(deposit/withdraw/transfer/MPC/RFQ/CCTP-exit), the streaming payment channel
(open/stream/settle/reclaim/batch), x402 gating, the agent layer, receipts,
deployment on real Arc testnet, and a real cross-chain CCTP transfer.
**210+ automated checks pass.**

**Documented seams (external infra, not code gaps):** Circle Gateway gasless
batching (needs Gateway endpoints), using the actual CCTP-minted Arc USDC in the
pool (a config change vs. the demo's mock token), and deny-set compliance (needs
the exclusion circuit). Each is called out where it lives.

> **Testnet only. Not audited. Do not use with real funds.** This is a
> hackathon build demonstrating a working private-nanopayments stack on Arc.
