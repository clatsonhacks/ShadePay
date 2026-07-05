# Shade Streams — Private Nanopayments for Agents on Arc

> **Pay by the fraction. Settle the net. Reveal nothing.**
>
> Millions of per-call / per-second micropayments stream off-chain between an
> agent and a service; only a **private net** settles on-chain, in **USDC on
> Arc**, funded **cross-chain via Circle CCTP**. Built on a zero-knowledge
> shielded pool — so the individual payments are invisible and only an
> auditable receipt is revealed.

Built for the **Lepton Agents Hackathon** (Canteen · Circle · Arc). This
document covers three things: **what** it is, **how** it was built, and the
**real demo workflow** (with live Arc-testnet transaction hashes).

---

## 1. What it is

An AI agent consumes a paid service (an API, a data feed, an inference
endpoint) and pays **per request** — amounts as small as a fraction of a cent —
without a transaction per call. The mechanic:

1. **OPEN** — the agent locks a spending cap into a payment channel on Arc (one
   ZK proof). The channel is anchored to a **shielded note**, so the amount is
   private.
2. **STREAM** — for each request, the agent signs a tiny **voucher** off-chain
   (`{channelId, cumulative, seq}`, EdDSA). The service verifies it and serves
   the response. **Zero on-chain writes, zero gas, per call.** This is the
   "millions of ticks" property — a per-call payment is just a signature.
3. **SETTLE** — when the session ends, the service submits the single highest
   voucher (one ZK proof). Only the **net** hits the chain, as a private USDC
   note. The agent is refunded the unused remainder.
4. **RECLAIM** — if the service never settles, the agent reclaims the full cap
   after a timeout. No funds can be stranded.

The USDC backing the channel is **bridged cross-chain** (e.g. Base Sepolia →
Arc) via Circle CCTP, so an agent can pay for an Arc service with funds that
live on another chain.

### Why it's the right shape for this hackathon
The theme — "value too small to have been worth moving before… settled instantly
on Arc in USDC" — is exactly a payment channel over a shielded pool:
- **Per-call / per-second / per-article payments** → off-chain vouchers.
- **Agents that earn and spend thousands of times an hour** → the agent layer
  makes each per-tick decision.
- **Sub-cent economics** → Arc's native-USDC gas + off-chain streaming means the
  marginal cost of a payment is a signature, not a transaction.
- **Differentiator no transparent x402 loop has:** the individual payments are
  **private**, with selective-disclosure receipts.

---

## 2. How it was built (the idea → execution)

The project started from **Shade**, a working private cross-chain USDC
settlement protocol on **Stellar/Soroban** (a Groth16/BLS12-381 shielded pool).
The insight was that the same shielded-pool machinery — commitments, nullifiers,
Merkle tree, on-chain proof verification — is exactly what you need to make
streaming nanopayments *private*, which no plain x402 loop can do. So the work
was: **retarget Shade to Arc, then build the streaming product on top.**

It was executed in six phases, each ending in a runnable **test gate** (the
repo's convention: standalone `*-test.ts` scripts + Foundry tests). Total
automated coverage today: **210+ checks, all passing.**

### Phase 1 — BN254 derisking spike
The Stellar side is **BLS12-381** (chosen for Soroban's pairing host functions).
Arc is a standard EVM chain whose pairing precompiles (`ecAdd`/`ecMul`/
`ecPairing` at `0x06/0x07/0x08`) are **BN254-only**. So the first, isolated step
was to prove a real BN254 Groth16 proof verifies on-chain on EVM:
- New BN254 circuit lib (`circuits/lib_bn254/`) on circomlib's audited Poseidon.
- A **TS-native witness builder** (`packages/proving/src/bn254/`, circomlibjs
  Poseidon) that replaces the patched Rust `stellar-coinutils` binary *and* the
  `circom2soroban` byte-packer entirely — snarkjs exports native `uint256[]`
  calldata straight into the Solidity verifier.
- **Result:** a real proof verifies TRUE on-chain; tampered signals FALSE.

### Phase 2 — Full protocol port to Arc/Solidity
Every settlement path ported to Solidity, nothing dropped:
- `ShieldedPool.sol`, `NullifierRegistry.sol`, `IncrementalMerkleTree.sol`
  (upgraded from Soroban's O(n)-per-insert rebuild to an **O(log n)** frontier
  tree), `CommitteeRegistry` (MPC threshold), and all 5 circuit verifiers.
- All settlement paths: deposit, withdraw, private transfer, **MPC same-asset +
  priced cross-asset**, **RFQ**, **CCTP exit**.
- `@shade/arc-actions` (ethers-based) replaces the Soroban `sorobanInvoke`/XDR
  tooling.
- **Proven end-to-end:** a real proof settles through the real pool, and the
  on-chain Merkle root exactly matches the circuit's computed root.

### Phase 3 — Streaming primitives (Shade Streams)
- `stream_open` + `stream_settle` circuits. The settle circuit verifies the
  payer's **EdDSA-Poseidon voucher signature in-circuit** (circomlib's
  `EdDSAPoseidonVerifier`), so the payee can never settle more than the payer
  signed.
- `StreamEscrow.sol` (open/settle/reclaim) + a `streamInsert` hook so channel
  notes live in the shared pool tree.
- `@shade/sdk` voucher module (sign/verify/highest).

### Phase 4 — Full lifecycle + the 8 named invariants
A real ZK payment channel driven end-to-end on a real chain: open → sign
vouchers → settle, and open → timeout → reclaim, with every design invariant
asserted on-chain (double-settle rejected, reclaim-blocks-settle, receipt gross
== signed net, forged voucher fails in-circuit, …).

### Phase 5 — x402 + streaming relayer + batching
- `apps/api/src/x402.ts` — HTTP 402 voucher-gated service middleware.
- `StreamEscrow.settleBatch` + a streaming relayer that batches channel closes.
- Circle Gateway gasless batching scoped as a documented seam
  (`docs/GATEWAY_SPIKE.md`).

### Phase 6 — Compliance, receipts, agents
- Compliance decision: the pool's `associationRoot` stays the single canonical
  ASP source of truth + a version counter (`docs/COMPLIANCE_MODEL.md`).
- Per-channel **receipts** reconstructed from on-chain events (audits the "gross
  == net" invariant).
- The **agent layer**: `PayerAgent` (rate + budget + pause-on-drop) and
  `PayeeAgent` (verify + enforce rate + track highest + decide-to-settle) — the
  per-tick "meaningful agency" the brief calls for.

### Then: made it real on Arc testnet + cross-chain
- Deployed the full stack to **real Arc testnet** (chainId 5042002) and ran the
  agent-service demo there.
- Executed a **real Circle CCTP transfer** (Base Sepolia → Arc), burning USDC on
  one chain and minting it on Arc, verified on both explorers.

---

## 3. Architecture

```
   Agent (buyer)                         Service (seller)
   ┌───────────────┐   vouchers (off-chain, per call)   ┌───────────────┐
   │  PayerAgent   │ ─────────────────────────────────► │  PayeeAgent   │
   │  @shade/sdk   │   X-Shade-Voucher header (x402)     │  x402 gate    │
   └──────┬────────┘                                     └──────┬────────┘
          │ open (1 ZK proof)                                   │ settle (1 ZK proof)
          ▼                                                     ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │                         ARC  (Circle L1, USDC gas)                    │
   │   StreamEscrow.sol  ──streamInsert──►  ShieldedPool.sol               │
   │   (open/settle/reclaim/batch)          (notes, nullifiers, O(log n)   │
   │                                         Merkle tree, BN254 verifiers) │
   └─────────────────────────────────────────────────────────────────────┘
          ▲
          │ USDC bridged in (Circle CCTP: burn on source → attest → mint on Arc)
   ┌──────┴────────┐
   │ Base Sepolia  │  (or Arbitrum / Ethereum Sepolia)
   └───────────────┘
```

| Layer | Where | Role |
|-------|-------|------|
| Circuits (BN254) | `circuits/*_bn254/` | commitment/membership + voucher EdDSA + value conservation |
| Proving library | `packages/proving/src/bn254/` | TS-native witness + Groth16 proof, native `uint256[]` output |
| Contracts | `contracts/arc/src/` | `ShieldedPool`, `StreamEscrow`, `NullifierRegistry`, verifiers |
| Voucher SDK + agents | `packages/sdk/src/{streams,agents,receipts}.ts` | sign/verify vouchers, agent decisions, receipts |
| Chain client | `packages/arc-actions/` | ethers calls + CCTP config/bridge |
| x402 + relayer | `apps/api/src/x402.ts`, `apps/relayer/src/stream-relayer.ts` | service gating + batched settlement |

---

## 4. The real demo workflow

Prereqs: `npm install`, then build contracts + circuits once:
```bash
cd contracts/arc && forge build && cd ../..
npm run circuits:build:arc && npx tsx scripts/sync-arc-verifiers.ts
```

### Demo A — local (fast, no funds needed)
```bash
npm run agent-service-demo      # spins up a local anvil EVM node
```
Deploys the stack, funds a shielded note, opens a channel, then an **agent makes
100 metered requests to a real x402 HTTP service** — each line shows the prompt
(what was requested) and the running payment — and finally settles the net with
one ZK proof and reconstructs the receipt.

### Demo B — real Arc testnet
```bash
# .env.arc-testnet.local holds a testnet key funded via faucet.circle.com
npm run agent-service-demo:arc          # 100 requests, settle on real Arc
REQUESTS=1000 npm run agent-service-demo:arc   # scale to 1000
npm run stream-demo:arc                 # the pure open→stream→settle→reclaim walkthrough
```

**Ran live on Arc testnet (chainId 5042002)** — verifiable on
[testnet.arcscan.app](https://testnet.arcscan.app):

| Demo | Contract | Open tx | Settle tx |
|------|----------|---------|-----------|
| agent-service | ShieldedPool `0x4650…A0F5`, StreamEscrow `0xee1B…d29b` | `0x6e87f408…` (blk 50,297,330) | `0xec66753c…` (blk 50,297,357) |
| stream | ShieldedPool `0x750a…F32A`, StreamEscrow `0x5F10…241F` | `0x50f2ed84…` (blk 50,295,080) | `0x5d05817d…` (blk 50,295,090) |

Both ZK proofs verified on-chain by **Arc's BN254 pairing precompiles** — the
whole premise of the port, confirmed on the target chain.

### Demo C — real cross-chain funding (Circle CCTP)
```bash
BASE_SEPOLIA_PRIVATE_KEY=0x…  npm run cctp-bridge:arc
```
Executes the **literal** CCTP V2 transfer: `depositForBurn` on Base Sepolia →
Circle Iris attestation → `receiveMessage` on Arc. Real USDC moves cross-chain.

**Executed live:**
| Step | Chain | Tx | Explorer |
|------|-------|-----|----------|
| Burn 5 USDC | Base Sepolia | `0x1d8cb919…` (blk 43,740,493) | [basescan](https://sepolia.basescan.org/tx/0x1d8cb9197aaca35e446e5662948a6dbf730ec9312f6e6ad90ba848732c1103e0) |
| Mint ~4.995 USDC | Arc testnet | `0x8b7af5e6…` (blk 50,304,436) | [arcscan](https://testnet.arcscan.app/tx/0x8b7af5e6dce891ba8a6aaf571b589b525fb49a17858e51921bf8806c2c7e8857) |

Balances confirmed on both chains (Base burner −5 USDC, Arc recipient +~5 USDC).
CCTP config (real, verified) lives in `packages/arc-actions/src/cctp-arc.ts`:
Arc = **CCTP domain 26**, sources Base Sepolia (6) / Arbitrum Sepolia (3) /
Ethereum Sepolia (0), `TokenMessengerV2 0x8FE6B999…`, `MessageTransmitterV2
0xE737e5cE…`.

### Test gates (reproduce all 210+ checks)
```bash
npm run typecheck
cd contracts/arc && forge test        # 79 Foundry
npm run proving-bn254:test            # 21  (7 circuits, real proofs)
npm run stream-proving:test           # 14  (stream circuits, forged-voucher rejection)
npm run streams-sdk:test              # 7   npm run agents:test  # 17
npm run receipts:test                 # 13  npm run x402:test    # 12
npm run stream-relayer:test           # 6
npm run stream-lifecycle:test         # 21  (real proofs on a live chain)
```

---

## 5. Honest status (what's real vs. what's a documented seam)

**Real & verified on-chain:** the BN254 ZK layer, all settlement paths, the
streaming payment channel (open/stream/settle/reclaim/batch), x402 gating, the
agent layer, receipts, deployment on real Arc testnet, and a real cross-chain
CCTP transfer.

**Documented seams (external infra, not code gaps):**
- **Circle Gateway** gasless batching — the on-Arc `settleBatch` is done; the
  Gateway-routed variant needs real Gateway endpoints (`docs/GATEWAY_SPIKE.md`).
- The agent-service demo uses a mock USDC token inside the pool; wiring the pool
  to the *actual* CCTP-minted Arc USDC is a config change (register Arc USDC as
  the pool asset).
- Deny-set compliance enforcement is deferred until the exclusion circuit exists
  (`docs/COMPLIANCE_MODEL.md`).

See also: `docs/ARC_PORT_STATUS.md`, `docs/SHADE_STREAMS_STATUS.md`,
`docs/arc-zk-proof-system.md`.
