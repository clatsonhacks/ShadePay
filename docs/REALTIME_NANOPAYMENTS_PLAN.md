# Plan — Real-Time USDC Nanopayments on Arc (the core the hackathon asks for)

## Why this plan exists (the correction)

The Lepton theme is **nanopayments in real time** — actual sub-cent value moving
per second / per call. Privacy is a **layer on top**. Our earlier demos buried
that: the streaming lifecycle ran on a **MockERC20**, so the amounts weren't real
USDC. The cross-chain bridge *did* move real USDC, but it never connected to the
streaming demo. **If the base real-USDC nanopayment doesn't work, the submission
fails its own premise.** This plan fixes that first, then re-layers privacy.

Reference we align to: Circle's `arc-nanopayments` (x402 + Gateway paying **real
USDC per call**). Our chosen use case from the hackathon doc: **Streaming &
Continuous Payments** — pay-per-second, start / pause / stop, real-time metering.

## The key technical fact

On **Arc, USDC is the native token** (it *is* the gas token). Real USDC moves via
`msg.value` / native transfer, **not** an ERC-20 `transfer`. That is exactly why:
- the CCTP mint showed up in `getBalance()` (native), and
- the shielded pool (written for `IERC20`) could only ever hold a *mock* token.

So the real-USDC streaming rail must be **native-USDC-native**: a payable escrow
that streams `msg.value`. That's `StreamPay.sol`.

## What we build

### 1. `contracts/arc/src/StreamPay.sol` — real native-USDC per-second streaming
A payable escrow. Continuous authorization of a **rate**, not a payment per tick.
- `open(id, payee, ratePerSecond)` **payable** — funds the stream with real USDC (`msg.value` = the cap).
- `earned(id)` / `withdrawable(id)` — the real-time meter: `accrued + rate × elapsed`, capped at the deposit.
- `withdraw(id)` — payee pulls accrued USDC (real native transfer).
- `pause(id)` / `resume(id)` — payer freezes / restarts accrual ("tap to stop").
- `stop(id)` — payee paid everything accrued, payer refunded the unspent tail. Terminal, value-conserving.

Invariants (mirroring the Shade Streams invariants, but on real USDC):
never pays more than deposited; only payee withdraws; only payer controls;
value conserved (`payee + refund == deposit`); stop is once-only.

### 2. `contracts/arc/test/StreamPay.t.sol` — Foundry gate ✅ (written)
Accrual-per-second, cap ceiling, withdraw moves real value, pause freezes,
resume continues, stop pays+refunds, value conservation, and the access-control /
double-stop / id-reuse / zero-deposit reverts.

### 3. `packages/arc-actions/src/streampay-demo.ts` — the real demo
A concrete streaming use case (a **live data feed / GPU-second service**) where an
agent pays **per second in real USDC** on Arc testnet:
1. Deploy `StreamPay` on Arc testnet (real chain).
2. Agent (payer) `open`s a stream: deposits a real sub-cent-scale USDC cap, rate ≈ **$0.0001/sec**.
3. Service runs; every second the meter (`earned`) grows in **real USDC** — printed live with the actual USDC amount.
4. Agent **pauses** during a quiet period (no accrual), then **resumes**.
5. Service `withdraw`s accrued real USDC mid-stream (real balance delta shown).
6. Agent `stop`s — service paid the net, agent refunded the tail. Real balances confirmed before/after on-chain.
7. Print the real tx hashes (open / withdraw / stop) + arcscan links.

Uses the **real USDC already on Arc** (~24 USDC from the CCTP bridge + faucet).
Amounts are genuine, sub-cent, and visible on-chain — closing the "no real
amount" gap directly.

### 4. Wire-up
- npm scripts: `streampay-demo` (local anvil) + `streampay-demo:arc` (real Arc testnet).
- `contracts:test:arc` already runs the new Foundry test.
- Docs: fold this into `docs/SHADE_STREAMS.md` + README as **the base real-USDC rail**.

## How privacy re-composes (unchanged, now honest about layering)

`StreamPay` is the **real-money rail**. The existing Shade Streams voucher +
shielded-settlement layer sits **on top**: instead of the payee pulling on-chain
every second, the payer signs off-chain vouchers and the **net** settles privately.
The base amounts are real USDC; the privacy layer hides the per-tick detail. We
state this split plainly rather than presenting the mock-token pool as the payment.

## Honest scope

- **In:** real native-USDC per-second streaming on Arc testnet, real amounts, start/pause/stop, real tx hashes. This is the hackathon's core requirement, actually met.
- **Still a documented seam:** Circle **Gateway** gasless batching (optimization layer — streaming works without it; the settling party pays Arc gas). Wire if time permits after the real rail is proven.

## Test gate for this plan

1. `forge test --match-contract StreamPayTest` — all pass.
2. `npm run streampay-demo` — full lifecycle on local anvil, value conserved.
3. `npm run streampay-demo:arc` — same on **real Arc testnet**, real USDC, real tx hashes.
