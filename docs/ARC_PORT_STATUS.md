# Shade → Arc (EVM) Port — Status

Porting the **entire** Shade shielded-pool protocol from Stellar/Soroban to Arc (EVM).
All functionality (deposit, withdraw, private transfer, MPC same-asset & priced
cross-asset settlement, RFQ) is preserved exactly — only the chain changes.
Curve: BLS12-381 → **BN254** (for native EVM pairing precompiles).

## Phase 1 — BN254 derisking spike ✅ COMPLETE & PROVEN

The full BN254 ZK layer works end-to-end on EVM (the direct analog of the
BLS12-381/Soroban spike in `docs/zk-proof-system.md`).

- `circuits/lib_bn254/{commitment,merkleProof}.circom` — shared BN254 circuit lib (circomlib Poseidon)
- `circuits/private_transfer_bn254/` — compiled, real Groth16 proof generated + verified
- `scripts/circuits-build-arc.ts` — BN254 build pipeline (compile → zkey → Solidity verifier)
- `scripts/circuits-test-arc.ts` — TS-native witness builder (circomlibjs Poseidon, **no** stellar-coinutils binary) + proof gen + local verify
- **Proven (Foundry):** real proof verifies on-chain TRUE; tampered signals rejected FALSE

## Phase 2 — Core shielded pool + MPC on Solidity 🟡 IN PROGRESS

### Contracts (`contracts/arc/src/`) — all compile ✅
| Contract | Ports from | Status |
|----------|-----------|--------|
| `NullifierRegistry.sol` | `nullifier_registry` | ✅ + 6 tests |
| `IncrementalMerkleTree.sol` | `lean_imt` (O(n)→**O(log n)**) | ✅ + 7 tests |
| `CommitteeRegistry.sol` (CommitteeLib) | MPC threshold logic | ✅ |
| `ShieldedPool.sol` | `shielded_pool` (all paths + MPC) | ✅ + 28 tests |
| `Poseidon2` (circomlibjs bytecode) | native soroban-poseidon | ✅ + 3 tests (matches circomlib) |

### Circuits (BN254 variants) — all compile ✅
| Circuit | Constraints | ptau | Verifier |
|---------|-------------|------|----------|
| `private_transfer_bn254` | 5,896 | pot14 | ✅ TransferVerifier.sol |
| `withdraw_public_bn254` | ~11k | pot14 | ✅ WithdrawVerifier.sol |
| `deposit_note_mint_bn254` | ~small | pot14 | ✅ DepositVerifier.sol |
| `mpc_settlement_bn254` | 24,254 | pot15 | 🟡 building |
| `mpc_priced_settlement_bn254` | 24,337 | pot15 | 🟡 building |

### Tests — 57/57 passing ✅
- `Poseidon2.t.sol` (3) — on-chain Poseidon == circomlib (roots match circuits)
- `IncrementalMerkleTree.t.sol` (7) — zeros, insert, root history, capacity
- `NullifierRegistry.t.sol` (6) — spend-once, authz, pause
- `ShieldedPool.t.sol` (28) — deposit/withdraw/transfer/MPC + adversarial (double-spend, wrong root/association/domain/operation, committee threshold/duplicate/unknown-signer, invalid proof, expired, wrong recipient)
- `RfqCctp.t.sol` (7) — RFQ solver reimbursement + CCTP exit + adversarial (unauthorized solver, wrong quote/recipient binding, bad sig)
- `TransferVerifier.t.sol` (3) — real BN254 proof on-chain: valid TRUE, tampered FALSE
- **`PoolIntegration.t.sol` (3) — FULL end-to-end: a REAL proof settles through the actual pool + real verifier + real tree; on-chain root EXACTLY matches the circuit's stateRoot (definitive circuit↔contract compatibility)**

### Remaining in Phase 2
- [ ] Finish MPC circuit builds (pot15) + wire MpcSettlementVerifier / MpcPricedSettlementVerifier
- [ ] Port `rfq_settle`, `rfq_settle_atomic_swap`, `withdraw_cctp` entrypoints to Solidity
- [ ] Deploy script (`script/Deploy.s.sol`) — deploys + wires all contracts
- [ ] Wire services (api/relayer/prover) to Arc contract ABIs

## Key technical decisions

1. **Curve BLS12-381 → BN254** (user-approved): native EVM precompiles make per-settlement verification cheap.
2. **Tree O(n) → O(log n)**: the Stellar `append_leaf` rebuilt the whole tree each insert; the EVM version is a frontier tree. Roots still match the circuit (zero-padded fixed-depth-12 tree == Tornado zeros scheme). Proven by `Poseidon2.t.sol` + tree tests.
3. **Public signals**: snarkjs Solidity verifier takes native `uint256[N]` — no byte-parsing (unlike Soroban's `circom2soroban` blob).
4. **ed25519**: no EVM precompile, so the raw signature check is delegated to a pluggable `IEd25519Verifier` (production vendors a Solidity ed25519 lib); the **threshold/distinct/registered** logic is on-chain and tested.
5. **Witness generation**: TS-native circomlibjs Poseidon replaces the patched `stellar-coinutils` Rust binary — one fewer dependency.

## Reproduce

```bash
npm install                       # installs circomlib, circomlibjs
npm run circuits:build:arc        # compile 5 BN254 circuits + Solidity verifiers
npm run circuits:test:arc         # real proof gen + local verify (6/6)
npx tsx scripts/sync-arc-verifiers.ts   # copy verifiers into contracts
cd contracts/arc && forge test    # 47+ Foundry tests
```
