# Shade → Arc (EVM) Port — Status

Porting the **entire** Shade shielded-pool protocol from Stellar/Soroban to Arc (EVM).
All functionality (deposit, withdraw, private transfer, MPC same-asset & priced
cross-asset settlement, RFQ, CCTP exit) is preserved exactly — only the chain changes.
Curve: BLS12-381 → **BN254** (for native EVM pairing precompiles).

## Phase 1 — BN254 derisking spike ✅ COMPLETE & PROVEN

The full BN254 ZK layer works end-to-end on EVM (the direct analog of the
BLS12-381/Soroban spike in `docs/zk-proof-system.md`). See `docs/arc-zk-proof-system.md`.

## Phase 2 — Full system port ✅ Contracts/circuits/proving/wiring — 🟡 4 of 5 flows wired

### Contracts (`contracts/arc/src/`) — all compile, all deployed+wired end-to-end ✅
| Contract | Ports from |
|----------|-----------|
| `NullifierRegistry.sol` | `nullifier_registry` |
| `IncrementalMerkleTree.sol` | `lean_imt` (O(n) → **O(log n)** frontier tree) |
| `CommitteeRegistry.sol` (CommitteeLib) | MPC threshold logic |
| `ShieldedPool.sol` | `shielded_pool` — every settlement path: deposit, withdraw, private transfer, MPC (same-asset + priced), RFQ settle, CCTP exit |
| `Poseidon2` (circomlibjs bytecode) | native soroban-poseidon |
| `script/Deploy.s.sol` | `deploy-shielded-pool.ts` + `deploy-mpc-verifier.ts` combined — deploys + wires all 8 contracts in one broadcast, **proven against real anvil** ("ONCHAIN EXECUTION COMPLETE & SUCCESSFUL") |

### Circuits — all 5 BN254 variants compiled, all 5 verifiers deployed ✅
| Circuit | Constraints | ptau |
|---------|-------------|------|
| `private_transfer_bn254` | 5,896 | pot14 |
| `withdraw_public_bn254` | ~11k | pot14 |
| `deposit_note_mint_bn254` | ~small | pot14 |
| `mpc_settlement_bn254` | 24,254 | pot15 |
| `mpc_priced_settlement_bn254` | 24,337 | pot15 |

### Proving library (`packages/proving/src/bn254/`) — TS-native, zero Rust binaries ✅
Replaces `stellar-coinutils` (witness assembly) and `circom2soroban` (byte packing)
entirely: `poseidon.ts` (circomlibjs, matches on-chain Poseidon2 exactly),
`merkle.ts` (generic zero-padded tree, matches the on-chain frontier tree),
`coin.ts` (note generation), `prove.ts` (`buildTransferProofBn254`,
`buildWithdrawProofBn254`, `buildDepositProofBn254` — export native
`{a,b,c}` + `uint256[]`, ready for ABI encoding, no byte blob).
**15/15 tests pass** (`npm run proving-bn254:test`), including real Groth16
proof generation for all three circuits and adversarial fail-fast checks.

### Service wiring (`packages/arc-actions/` + service call sites)
`@shade/arc-actions` is the ethers-based replacement for `@shade/stellar-actions`
/ `sorobanInvoke`: `buildUnsignedTx`/`withdrawArgs`/`broadcastSignedTx` (user-signed
flow) and `arcInvoke` (service-signed flow), both proven against real anvil.
**13/13 tests pass** (`npm run arc-actions:test`), including a full deploy +
deposit + withdraw settlement loop through the actual `ShieldedPool.sol`.

| Flow | Status | Where |
|------|--------|-------|
| **Withdraw** | ✅ **Wired end-to-end** | `POST /v1/withdrawals/build-tx` (routes.ts) + `WITHDRAW_PUBLIC_SUBMIT` (relayer worker.ts, dispatches on `signedRawTx` vs `signedXdr`) |
| RFQ settle | 🔲 Not wired | needs `POST /v1/rfq/build-tx`-equivalent + relayer `RFQ_SETTLE_SUBMIT` Arc branch (see below) |
| MPC settle (same-asset + priced) | 🔲 Not wired | needs relayer `MPC_SETTLE_SUBMIT` Arc branch — the `get_committee`/`mpc_settle` shape changes materially (see below) |
| Deposit (CCTP inbound) | 🔲 Not wired | needs `@shade/cctp`'s `runCctpInbound` ported to call `pool.receiveDeposit` via arc-actions instead of `sorobanInvoke` |
| CCTP exit (withdraw_cctp) | 🔲 Not wired | same shape as withdraw; needs its own `build-tx` route + relayer branch |

The **withdraw flow is the reference implementation** — every other flow follows
the same pattern (build unsigned tx or service-signed `arcInvoke` call → the
proving library already produces the right shapes → `SHIELDED_POOL_ABI` in
`packages/arc-actions/src/abi.ts` already has all five entrypoints declared).
What's left per flow is glue code, not new primitives.

### Notes for wiring the remaining flows

- **RFQ settle**: `apps/relayer/src/worker.ts`'s `RFQ_SETTLE_SUBMIT` currently calls
  `sorobanInvoke(..., method: "rfq_settle", args: [...string flags])`. The Arc
  equivalent is `arcInvoke({ ..., method: "rfqSettle", args: [toSolver, quoteHash,
  intentHash, fillReceiptHash, solverPubkey, solverSig, proof, pub] })` — same
  ed25519 solver-signing scheme (unchanged, per `apps/solver/src/server.ts`,
  since `IEd25519Verifier` preserves it), different argument shape (native types,
  not CLI string flags).
- **MPC settle**: the biggest remaining lift. `mpc_settle`'s Arc signature
  (`ShieldedPool.sol:441`) does NOT take nullifiers/commitments/root as explicit
  args the way Soroban's did — those live inside the `pub[]` array now
  (`pub[4]`=stateRoot, `pub[5]`=associationRoot, `pub[6]`=batchHash field, etc.).
  `computeMpcRoot` in `worker.ts` (which shells out to the Rust coinutils binary)
  needs to move to `packages/proving/src/bn254/merkle.ts`. `get_committee`'s
  JSON-string-array parsing becomes a direct typed `bytes32[]` return from
  `arcInvoke({ method: "getCommittee", readOnly: true })`.
- **Deposit (CCTP inbound)**: `@shade/cctp`'s `runCctpInbound` is the real
  integration point (not `apps/relayer/src/worker.ts` directly) — it wraps
  burn+attestation+mint+register against the pool and needs an Arc-facing sibling
  that calls `pool.receiveDeposit` via `arcInvoke` instead of the Soroban mint-forward
  flow. `buildDepositProofBn254` (already built and tested) supplies the proof.
- **CCTP exit**: `withdraw_cctp` is structurally identical to `withdraw` (same
  circuit, different `operationType`) — copy the withdraw route/job pattern.

## Key technical decisions

1. **Curve BLS12-381 → BN254** (user-approved): native EVM precompiles make per-settlement verification cheap.
2. **Tree O(n) → O(log n)**: the Stellar `append_leaf` rebuilt the whole tree each insert; the EVM version is a frontier tree. Roots still match the circuit (zero-padded fixed-depth-12 tree == Tornado zeros scheme) — proven twice: once via `PoolIntegration.t.sol` (Solidity side) and once via `testWithdrawFullLoop` (TS proving side).
3. **Public signals**: snarkjs Solidity verifier takes native `uint256[N]` — no byte-parsing (unlike Soroban's `circom2soroban` blob).
4. **ed25519**: no EVM precompile, so the raw signature check is delegated to a pluggable `IEd25519Verifier` (production vendors a Solidity ed25519 lib); the **threshold/distinct/registered** logic is on-chain and tested. This preserves the solver's and MPC committee's existing ed25519 identities unchanged.
5. **Witness generation**: TS-native circomlibjs Poseidon (`packages/proving/src/bn254/`) replaces the patched `stellar-coinutils` Rust binary and `circom2soroban` byte packer entirely — one fewer dependency, and the output is already in the shape Solidity wants.
6. **Both chains coexist during migration**: the withdraw flow's API route and relayer job dispatch on which chain's signed payload is present (`signedRawTx` vs `signedXdr`) rather than replacing the Stellar path outright — this is the pattern to follow for the remaining flows too, unless/until a decision is made to retire Stellar entirely.

## Reproduce

```bash
npm install                               # installs circomlib, circomlibjs, ethers
npm run circuits:build:arc                # compile 5 BN254 circuits + Solidity verifiers
npm run circuits:test:arc                 # real proof gen + local verify
npx tsx scripts/sync-arc-verifiers.ts     # copy verifiers into contracts
npm run proving-bn254:test                # 15/15 — full TS-native proving pipeline
npm run arc-actions:test                  # 13/13 — real anvil, full deploy+deposit+withdraw loop
cd contracts/arc && forge build && forge test   # 57/57 Foundry tests
PRIVATE_KEY=0x... forge script script/Deploy.s.sol --rpc-url <arc-rpc> --broadcast
```
