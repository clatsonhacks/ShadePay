# Circle Gateway Batch-Settlement — Feasibility Spike

Phase 5's third deliverable. Per the plan this is the least-grounded item (no
existing repo code, external infra), so it is scoped as a spike: document the
interface and the integration seam, and flag exactly what real infrastructure
is still needed — not build against endpoints that don't exist yet.

## The idea (from the design doc)

When many channels close at once, the streaming relayer batches their
settlements. Today that batching is `StreamEscrow.settleBatch` — one Arc tx
carrying N proofs (implemented + tested, `apps/relayer/src/stream-relayer.ts` +
`test_settleBatch_*`). Circle Gateway would extend this to **gasless, cross-chain
batched settlement**: the relayer submits the batch via Gateway's unified-balance
API so USDC settlement lands without the relayer pre-funding Arc gas, and closes
for payees on multiple chains collapse into one Gateway operation.

## Where it plugs in

`submitSettlementBatch` in `apps/relayer/src/stream-relayer.ts` is the single
seam. It currently does:

```ts
arcInvoke({ ..., method: "settleBatch", args: [proofs, pubs], wallet })
```

A Gateway-routed variant would keep the exact same `PendingSettlement[]` input
and instead hand the batch to Circle Gateway's transfer/settlement endpoint,
returning a Gateway operation id in place of (or alongside) the Arc tx hash. The
batch-selection policy (`selectSettlementBatches`) is transport-agnostic and
needs no changes.

## What's still needed (the gap)

1. **Real Circle Gateway API access**: endpoint base URL, the Arc Gateway
   domain id, wallet/attestation config. None are configured in this repo
   (`packages/cctp-utils`'s `LOCKED_CCTP` only has the Arbitrum-Sepolia↔Stellar
   CCTP route). This is the same class of gap as the Arc CCTP `TokenMessenger`
   address (`ShieldedPool.setCctpConfig`) and the production ed25519 verifier —
   the contract/relayer plumbing is ready; the external address/endpoint is not.
2. **Gateway settlement semantics vs. proof-gated settlement**: Gateway moves
   USDC, but Shade settlement is note accounting (mint payee/refund notes in the
   shielded pool, gated by the stream_settle proof). The two must be reconciled:
   Gateway would most naturally sit at the *funding/exit* boundary (getting USDC
   in/out of the Arc pool across chains), while the per-channel note split stays
   on Arc via `settleBatch`. So "Gateway batch settlement" is really "Gateway
   batches the cross-chain USDC movement that backs a set of closes," not a
   replacement for the on-chain proof verification. This should be confirmed
   against Circle's Gateway docs before committing to an interface — verifying
   finality and failure-handling semantics is called out as a risk in the plan.

## Status

- ✅ On-Arc batching (`settleBatch` + relayer batch-selection) — implemented, tested.
- 🔲 Gateway-routed batching — documented seam, blocked on real Gateway endpoints
  and a docs-confirmed settlement model. Not implemented; would be dishonest to
  claim otherwise.
