# End-to-End Real Workflow — Base Sepolia → Arc → paid service

> The honest walkthrough. What is real vs. what is a documented seam is called
> out at every step.

There are **two rails** in this repo. They both start from the same place
(USDC funded cross-chain into Arc via Circle CCTP) and end at the same place
(a distinct **service address** paid in real USDC on Arc), but they answer a
different question in the middle.

|            | **Base rail — StreamPay**                     | **Privacy layer — agent-service**                    |
|------------|-----------------------------------------------|------------------------------------------------------|
| What ticks | one **on-chain** meter per second              | one **off-chain** voucher per request                |
| Money      | **real native USDC** (Arc's gas token)         | shielded note on a mock token (seam: bind to USDC)   |
| Batching   | not needed — the meter IS the state            | 100+ requests → **one** ZK settle for the private net|
| Privacy    | none (amounts are public on-chain)             | full — only the net is revealed, not per-tick        |
| Live now?  | **fully real** end-to-end                       | **real code path**, mock token in the pool           |

Pick the rail that matches the property you're demonstrating. The rest of this
doc walks both end to end.

---

## 0. The parties (three distinct addresses)

```
   ┌──────────────────────────┐        ┌───────────────────────────┐        ┌──────────────────────────┐
   │  Payer (agent)           │        │  StreamPay / StreamEscrow │        │  Payee (service)         │
   │  ────────                │        │  ─────────                │        │  ────────                │
   │  Base-Sepolia address    │──CCTP─►│  contract on Arc          │──pay──►│  Arc address (distinct!) │
   │  funded with test USDC   │ bridge │  holds the deposit        │        │  operator of the API     │
   └──────────────────────────┘        └───────────────────────────┘        └──────────────────────────┘
        BASE_BURN_KEY                    (deployed by ARC_DEPLOYER_KEY)         SERVICE_ADDR (any EVM addr)
```

The payer and payee are **always different addresses**. In `streampay-demo`
the payee is a fresh `Wallet.createRandom()` so its balance delta is 100%
attributable to the stream. In `agent-service-demo` the payee identifies via
a **Baby Jubjub voucher key** (not an EVM key), and on settle it receives a
**shielded note** that can later be withdrawn to any EVM address it chooses —
still a distinct party.

---

## 1. Fund cross-chain (Circle CCTP v2, Base Sepolia → Arc)

Real burn on Base, real mint on Arc, verifiable on both explorers.

```bash
BASE_BURN_KEY=0x<funded-base-sepolia-key>  npm run cctp-bridge:arc
BASE_BURN_KEY=0x<key>  AMOUNT_USDC=5       npm run cctp-bridge:arc
```

What happens:
1. `depositForBurn` on Base Sepolia's `TokenMessengerV2` (destination domain
   26 = Arc). Real USDC is burned; a message is emitted.
2. Poll Circle's Iris attestation API (`iris-api-sandbox.circle.com`) until
   the attestation is `complete`.
3. `receiveMessage(message, attestation)` on Arc's `MessageTransmitterV2`.
   Real USDC is minted to the Arc recipient (default: the Arc mint signer).

Executed live once already:
- burn: [`0x1d8cb919…` on basescan](https://sepolia.basescan.org/tx/0x1d8cb9197aaca35e446e5662948a6dbf730ec9312f6e6ad90ba848732c1103e0)
- mint: [`0x8b7af5e6…` on arcscan](https://testnet.arcscan.app/tx/0x8b7af5e6dce891ba8a6aaf571b589b525fb49a17858e51921bf8806c2c7e8857)

**Result:** the payer address on Arc now holds real native USDC. This is what
funds every downstream rail.

Config (verified deterministic addresses on every CCTP chain):
`packages/arc-actions/src/cctp-arc.ts`
- `TokenMessengerV2 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`
- `MessageTransmitterV2 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`
- Arc destination domain **26**, Base Sepolia source domain **6**.

---

## 2A. The base rail — real per-second USDC on Arc (StreamPay)

Real amounts, real hashes, no privacy. This is the hackathon's core "real
nanopayment" ask.

```bash
npm run streampay-demo             # local anvil (real EVM)
npm run streampay-demo:arc         # REAL Arc testnet
```

Rate today: **$0.0001 / second** (`RATE = 1e14 wei`, native 18-dec USDC).

Timeline (10 steps, all on-chain, real value at every step):

| # | Actor | Action                                | On-chain effect                                 |
|---|-------|---------------------------------------|-------------------------------------------------|
| 1 | —     | Show parties + balances                | reads only                                      |
| 2 | payer | Deploy `StreamPay.sol`                | new contract on Arc                             |
| 3 | payer | Bootstrap payee with 0.002 USDC for gas | plain native transfer (payee ≠ payer)           |
| 4 | payer | `open(id, payee, RATE)` with `msg.value = cap` | real USDC locked in escrow (5,000 units = 0.005 USDC) |
| 5 | —     | Wait 5s, read `earned()`              | meter = 5·RATE = 0.0005 USDC                    |
| 6 | payee | `withdraw(id)`                        | contract sends `accrued − withdrawn` to payee   |
| 7 | payer | `pause(id)`                           | `active=false`, no accrual                      |
| 8 | payer | `resume(id)`                          | `active=true`, accrual restarts from now        |
| 9 | payer | `stop(id)`                            | pay payee `accrued − withdrawn`, refund payer `deposit − accrued` |
| 10| —     | Assert `payee_paid + payer_refund == deposit` and `escrow.balance == 0` | invariant                                       |

Every step emits an event and returns a real tx hash. On `--env-file=.env.arc-testnet.local`
mode, the demo prints arcscan links at the end.

**What's real:** every wei. `msg.value` = real native USDC, `payee.balance`
delta = real native USDC, the invariant is checked from the `Withdrawn` and
`Stopped` events (not brittle balance math). Foundry gate: 14 tests in
`contracts/arc/test/StreamPay.t.sol`, all green.

**What's not:** privacy. Every rate, every accrual, every withdraw is public.

### Live run on Arc testnet (2026-07-05)

`StreamPay 0x469305823f9796f973363F48a508a47309B2D92c` on Arc testnet, chainId
5042002. Payer `0x20D3688967b8d93050C1a1062d7aE6567d691796` (faucet-funded),
payee `0xdAE126fb68B1ee0569B53a022c9Be4D224089970` (fresh keypair — distinct
from the payer, as promised). Stream `0x1cade4…077f5`, cap 0.005 USDC, rate
0.0001 USDC/sec.

| # | Step             | Real tx on arcscan                                                                                                            |
|---|------------------|-------------------------------------------------------------------------------------------------------------------------------|
| 1 | Deploy StreamPay | [`0x86ae9139…`](https://testnet.arcscan.app/tx/0x86ae9139505a673fe0526d19355c5bcd64dd2717d642f797e4418c69a2c5b76d) |
| 2 | Bootstrap payee  | [`0xdce24030…`](https://testnet.arcscan.app/tx/0xdce2403062366fd8fc4fdb213c2ad0df591381a36d0a0edd0a3dd6748be7f163) |
| 3 | Open stream (fund 0.005 USDC) | [`0x8ec9165f…`](https://testnet.arcscan.app/tx/0x8ec9165f7c8c2ff701e35dfb19fed2db315b9369b12f28483790dbd7a9634412) |
| 4 | Withdraw mid-stream (0.0011 USDC to payee) | [`0xf1eb8d0f…`](https://testnet.arcscan.app/tx/0xf1eb8d0f8dbdb583c03ccfafe2ef69d9d611a220e4641885ff382c7cc4fb1e89) |
| 5 | Pause              | [`0x8070d5f9…`](https://testnet.arcscan.app/tx/0x8070d5f938e8c97ee44176e4bf57ef1f53b2182be9f86b1a27d21b2585fef849) |
| 6 | Resume             | [`0x90037365…`](https://testnet.arcscan.app/tx/0x9003736530439cc13a76c9eb6bf9d4123eb7bd548ade015a6f9667b1f93423f0) |
| 7 | Stop (payee +0.0013 USDC, payer refunded 0.0026 USDC) | [`0x8ebc27ad…`](https://testnet.arcscan.app/tx/0x8ebc27ad2771e8e94f8829216cdc3facfcdf9c0631c1b89516110cb1bf17ee5b) |

Value-conservation invariant asserted on-chain from the `Withdrawn` and
`Stopped` events: `0.0011 + 0.0013 + 0.0026 = 0.005 USDC` = deposited cap;
`escrow.balance == 0` afterwards. Full log in `docs/testnet-transactions.md`.

---

## 2B. The privacy layer — 100 requests, one ZK settle (agent-service)

Off-chain vouchers, one on-chain settle for the private net, service earns a
shielded note. Real code path; the **pool asset is currently `MockERC20`**
(seam: `docs/ASSET_BINDING.md`).

```bash
npm run agent-service-demo         # local anvil (no funds needed)
npm run agent-service-demo:arc     # REAL Arc testnet, deploys the full pool
REQUESTS=1000 npm run agent-service-demo:arc
```

Timeline:

| # | Actor  | Action                                          | On-chain? |
|---|--------|-------------------------------------------------|-----------|
| 1 | deployer | Deploy `ShieldedPool`, `StreamEscrow`, verifiers, mock USDC | ✓ real |
| 2 | payer  | Fund a **shielded note** in the pool (mock USDC representing the CCTP-bridged amount) | ✓ real (mock token) |
| 3 | payer  | `open` a payment channel — **1 ZK proof**, cap locked into a channel note | ✓ real |
| 4 | service | Comes online at `http://127.0.0.1:8788/infer` — an x402-gated endpoint that reads the on-chain channel state | (off-chain, but verifies against on-chain) |
| 5 | payer  | **100+ metered requests** — each request signs a fresh voucher `(channelId, cumulative, seq)` with `EdDSA-Poseidon`. Service verifies signature + cap + monotonicity, serves the response. | **0 gas per request** |
| 6 | service | Picks the **highest voucher** it has and calls `settle(...)` — 1 ZK proof. Circuit verifies the payer's EdDSA sig in-circuit, bounds `cumulative ≤ cap`, mints two new shielded notes: (a) the service's earnings, (b) the payer's refund. | ✓ real, private |
| 7 | anyone | Reconstruct a per-channel **receipt** from on-chain events (`open`+`settle`), assert `receipt.gross == highest.cumulative` | — |

Executed live once already on Arc testnet (chainId 5042002):

| Contract       | Address                                | Open tx                    | Settle tx                  |
|----------------|----------------------------------------|----------------------------|----------------------------|
| ShieldedPool   | `0x4650…A0F5`                           | [`0x6e87f408…`](https://testnet.arcscan.app) — blk 50,297,330 | [`0xec66753c…`](https://testnet.arcscan.app) — blk 50,297,357 |
| StreamEscrow   | `0xee1B…d29b`                           |                            |                            |

**What's real:** the whole voucher + settle mechanism. Real Groth16 proofs
verified by Arc's BN254 pairing precompiles. The service address is a
distinct party (a separate Baby Jubjub identity), and its earnings become a
shielded note that only it can spend.

**What's the seam:** the pool holds `MockERC20`, not native Arc USDC. Making
the shielded net **actually pay in native USDC** needs the pool asset bound
to Arc-native USDC (a `payable` deposit path, similar to what StreamPay does
directly). Once that seam is closed, this rail becomes fully real too.

---

## 3. Composed workflow (both rails, one story)

The picture the hackathon actually wants:

```
   Base Sepolia                        Arc                                Service (distinct address)
   ────────────                        ─────                              ────────────────────────
   [ CCTP burn 5 USDC ]  ─── Iris ───► [ Arc balance +5 USDC on Payer ]

                                        │
                                        ├── Rail A (base) — StreamPay
                                        │    open(0.005 USDC cap, $0.0001/sec)
                                        │    ── every second, meter ticks on-chain ──►  Service earns real USDC
                                        │    pause / resume / withdraw / stop           (distinct EVM address)
                                        │
                                        └── Rail B (privacy) — agent-service
                                             open channel (1 ZK proof, cap hidden)
                                             ── 100 requests, off-chain vouchers, 0 gas ──►
                                                                                          Service verifies + serves
                                             settle (1 ZK proof, ONE tx)                  Service earns shielded note
                                                                                          (net is public, per-tick isn't)
```

Same source of funds (CCTP), same destination party (distinct service address),
different privacy / on-chain profile in the middle. Pick per use case:

- Real-time GPU / data feed / live game action → **Rail A** (StreamPay). No
  batching latency, exact per-second billing, public.
- Per-request LLM inference / API metering / high-volume feeds where you
  don't want each price signal on-chain → **Rail B** (agent-service). Batch
  and settle privately.

---

## 4. Reproducing everything

```bash
# 1. one-time setup
npm install
cd contracts/arc && forge build && cd ../..
npm run circuits:build:arc && npx tsx scripts/sync-arc-verifiers.ts

# 2. Foundry gates
cd contracts/arc && forge test              # 79 tests
forge test --match-contract StreamPayTest   # 14 tests, base rail

# 3. base rail — real USDC, real hashes
npm run streampay-demo                      # local (fast, anvil)
npm run streampay-demo:arc                  # REAL Arc testnet

# 4. privacy layer — 100+ requests, ZK settle
npm run agent-service-demo                  # local
REQUESTS=1000 npm run agent-service-demo:arc # REAL Arc, 1000 requests

# 5. cross-chain funding leg (Base Sepolia → Arc)
BASE_BURN_KEY=0x<funded-base-key>  npm run cctp-bridge:arc
```

Requirements for the `:arc` variants:
- `.env.arc-testnet.local` with `ARC_DEPLOYER_KEY` (funded ~24 USDC via
  `faucet.circle.com`).
- For `cctp-bridge:arc`: a Base-Sepolia account with test USDC and a bit of
  ETH for gas. `AMOUNT_USDC=5` is a good starting size.

---

## 5. Answers to the questions you asked

**Q: The rate is $0.00001 / request, right?**
No — that was directionally correct but not what's currently coded. The
**base rail (StreamPay)** streams at **$0.0001 / second** — a true sub-cent
nanopayment. The **privacy layer (agent-service)** currently uses a symbolic
rate of `1 wei` per request because its pool asset is a mock token; when the
asset-binding seam is closed, that rate can be set to whatever real USDC
denomination you want (e.g. `1e11 wei = $0.0000001` per request — arbitrary,
since it's just a `bigint`).

**Q: The service is a different address, right — we pay it?**
Yes. Payer, escrow, and payee are always three distinct parties:
- In StreamPay: `payer.address` (agent) → `StreamPay.address` (contract) →
  `payee.address` (service, fresh `Wallet.createRandom()`).
- In agent-service: `payer` holds a Baby Jubjub voucher key + funds the
  channel; `service` holds its **own** Baby Jubjub identity and receives its
  earnings as a **shielded note** it alone can spend later.

**Q: After ~100 requests it pays the service in a ZK proof, no amount visible?**
Yes — that's exactly what agent-service does today. Each of the 100 requests
is an off-chain voucher (zero gas, zero on-chain state). At the end the
service submits **one** `settle` transaction with a ZK proof; the proof
verifies the payer's EdDSA voucher signature in-circuit and mints a shielded
note to the service. What's public on-chain: that a channel was settled and
two new note commitments exist. What's private: the actual amount, the
per-request breakdown, and everything about the requests themselves.

**Q: Does CCTP-bridged USDC on Arc actually back the shielded pool today?**
No — that's the **asset-binding** seam. CCTP does mint real USDC to Arc; the
shielded pool currently registers a mock ERC20 as its asset. Making the
shielded net truly pay in the CCTP-bridged USDC is a config change (register
Arc-native USDC as the pool asset + swap the `IERC20` deposit path for a
`payable` one, mirroring what StreamPay already does). Called out in
`docs/SHADE_STREAMS.md` §5.
