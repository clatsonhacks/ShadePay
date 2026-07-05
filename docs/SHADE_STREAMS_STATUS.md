# Shade Streams — Payment Channels (Phase 3-4) Status

The core product: private, per-fraction nanopayments that stream off-chain and
settle a single private net on-chain, over the Arc shielded pool. Phases 3 and 4
of the plan.

## Phase 3 — Streaming primitives ✅ COMPLETE
## Phase 4 — Full lifecycle + named invariants ✅ COMPLETE & PROVEN

### The mechanic
A unidirectional micropayment channel anchored to an escrowed shielded note:

- **OPEN** (1 ZK proof): the payer spends an input note N (value V), reserves a
  cap L for the channel bound to their EdDSA (Baby Jubjub) public key + expiry,
  and gets a change note (V-L). A reclaim note (L) is committed for the timeout path.
- **STREAM** (0 chain writes): the payer signs monotonic vouchers off-chain
  (`{channelId, cumulative, seq}`, EdDSA-Poseidon); the payee keeps the highest.
- **SETTLE** (1 ZK proof): the payee submits the highest voucher. The proof
  verifies the payer's signature *in-circuit*, bounds `cumulative <= cap`, and
  mints a payee note (= cumulative) + a payer refund note (= cap - cumulative).
- **RECLAIM** (no proof): after `expiry + challengeWindow` with no settle, the
  payer reclaims the full cap via the pre-committed reclaim note.

Only the net settles on-chain, shielded. All four note types are ordinary
shielded notes in the shared pool tree, spendable later via withdraw/transfer.

### Deliverables
| Piece | Where | Test |
|-------|-------|------|
| Voucher SDK (EdDSA-Poseidon sign/verify/highest) | `packages/sdk/src/streams.ts` | 7/7 (`npm run streams-sdk:test`) |
| `stream_open_bn254` circuit | `circuits/stream_open_bn254/` | via proving test |
| `stream_settle_bn254` circuit (in-circuit EdDSA voucher verify) | `circuits/stream_settle_bn254/` | via proving test |
| `StreamEscrow.sol` (open/settle/reclaim) | `contracts/arc/src/StreamEscrow.sol` | 18/18 (`forge test`) |
| `ShieldedPool.streamInsert` hook | `contracts/arc/src/ShieldedPool.sol` | " |
| Proof builders (open/settle) | `packages/proving/src/bn254/stream.ts` | 14/14 (`npm run stream-proving:test`) |
| Full lifecycle (real proofs, real chain) | `packages/arc-actions/src/stream-lifecycle-test.ts` | 15/15 (`npm run stream-lifecycle:test`) |

### The 8 named invariants — all covered
| # | Invariant | Covered by |
|---|-----------|------------|
| 1 | Payee never settles > cap L | in-circuit range check (`stream-proving:test`) + on-chain invalid-proof revert (`StreamEscrow.t.sol`) |
| 2 | Payee never settles a voucher not signed by payerKey | in-circuit EdDSA verify — forged voucher (sig for 350, claiming 400) FAILS witness generation (`stream-proving:test`) |
| 3 | cumulative + refund == cap exactly | value conservation by construction (`stream-proving:test`) |
| 4 | Escrow consumed exactly once | `consumed` flag — double-settle / settle-after-reclaim / reclaim-after-settle all revert (`StreamEscrow.t.sol` + `stream-lifecycle:test` with real proofs) |
| 5 | Original note nullifier burned at open, no reuse | shared NullifierRegistry — reuse reverts (`StreamEscrow.t.sol`) |
| 6 | Post-timeout reclaim returns exactly L, blocks settle | `stream-lifecycle:test` (real open proof) + `StreamEscrow.t.sol` |
| 7 | Only ASP-eligible parties can open/settle | associationRoot bound + checked == canonical (`StreamEscrow.t.sol`) |
| 8 | Receipt gross == on-chain settled net | settle proof's public cumulative == signed voucher cumulative (`stream-lifecycle:test`) |

### Key design decisions
1. **EdDSA-Poseidon (Baby Jubjub) for vouchers**, not the payer's EVM key — it's the in-circuit-friendly signature circomlib verifies natively. The payer generates a separate Baby Jubjub key for voucher signing; its pubkey (Ax, Ay) is bound into the channel at open.
2. **Channel consumed via a per-channel flag**, not a Poseidon escrow nullifier — reclaim has no proof and the EVM can't cheaply recompute `Poseidon(channelId,…)` on-chain; the flag gives the identical spend-once guarantee. The *input note's* nullifier still goes through the shared registry (invariant #5).
3. **Escrow-as-reservation, not escrow-as-note**: `cap` leaves the note set at open (supply −cap) and re-enters at settle/reclaim (+cap). The stream circuits enforce value conservation; the pool applies its reserve invariant on every `streamInsert` delta.
4. **Notes land in the shared ShieldedPool tree** so channel outputs are normal shielded notes — a payee can withdraw or transfer their settled note through the existing pool paths with no streaming-specific machinery.

### Reproduce
```bash
npm run circuits:build:arc && npx tsx scripts/sync-arc-verifiers.ts  # includes the 2 stream circuits
npm run streams-sdk:test        # 7/7  — voucher SDK
npm run stream-proving:test     # 14/14 — real open+settle proofs, forged-voucher rejection
cd contracts/arc && forge test  # 75/75 — includes 18 StreamEscrow tests
npm run stream-lifecycle:test   # 15/15 — full lifecycle, real proofs, real chain, invariants #4/#6/#8
```

## Phase 5 — x402 front door + streaming relayer + Gateway batching ✅ COMPLETE (Gateway = documented spike)

| Piece | Where | Test |
|-------|-------|------|
| x402 voucher-gated middleware | `apps/api/src/x402.ts` | 12/12 (`npm run x402:test`) |
| `StreamEscrow.settleBatch` | `contracts/arc/src/StreamEscrow.sol` | 4 tests in the 22-test StreamEscrow suite |
| Streaming relayer (batch policy + submit) | `apps/relayer/src/stream-relayer.ts` | 6/6 (`npm run stream-relayer:test`) |
| `STREAM_SETTLE_BATCH` relayer job | `apps/relayer/src/worker.ts` | — |
| Real-proof batch settle | `stream-lifecycle-test.ts` scenario 3 | 18/18 (`npm run stream-lifecycle:test`) |
| Circle Gateway batch settlement | `docs/GATEWAY_SPIKE.md` | 🔲 documented seam — blocked on real Gateway endpoints (honest gap) |

- **x402**: no voucher → HTTP 402 + channel-open instructions; a voucher whose cumulative reached the required amount (signed by the channel's payer, within cap, open + non-expired) → served. Signature verified via the voucher SDK.
- **settleBatch**: closes N channels in one tx, proof-gated per channel, atomic on any bad member — cheaper than N individual settles (Foundry-measured).
- **Gateway**: on-Arc batching is done; the gasless/cross-chain Gateway variant is a documented integration seam (`submitSettlementBatch`), not built — needs real Circle endpoints, same class of external-address gap as Arc CCTP.

## Remaining (Phase 6, not yet started)
- **Phase 6**: per-stream Shade View receipts, agent layer (payer/seller/broker), compliance-registry decision.
