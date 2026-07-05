# Phase 2: Full System Port to Arc — Porting Guide

## Scope

Port the **entire Shade protocol from Stellar/Soroban to Arc/EVM/Solidity**, keeping all functionality (MPC, RFQ, relayer, solver, API) intact. Only the blockchain changes; all logic, invariants, and workflows remain exactly the same.

## Key Differences: Soroban → Solidity

| Aspect | Soroban (Stellar) | Solidity (Arc/EVM) |
|--------|-------------------|-------------------|
| **Language** | Rust + soroban-sdk | Solidity |
| **Curve** | BLS12-381 | BN254 |
| **Verifier** | Custom `proof_verifiers` contract + host functions | snarkjs-generated `Verifier.sol` + precompiles |
| **Tree** | O(n) rebuild per append | O(log n) frontier-based incremental |
| **State** | Account storage (key-value) | Contract storage (mappings) |
| **Assets** | Stellar-specific SAC contracts | ERC-20 tokens on Arc |
| **Numbers** | Soroban i128/u128 | Solidity uint256 (with bounds checking) |
| **Admin/Governance** | Custom pause/upgrade | OpenZeppelin AccessControl/UUPSUpgradeable |

## Contracts to Port

### Core Settlement
- **`contracts/stellar/shielded_pool/src/lib.rs`** (1437 lines, 35 tests) → **`contracts/arc/src/ShieldedPool.sol`**
  - All entrypoints: `receive_deposit`, `withdraw`, `private_transfer_settle`, `mpc_settle`, `mpc_settle_priced`, `rfq_settle*`
  - Storage: `ADMIN`, `USDC`, verifiers (VERIFIER, XVERIFIER, DEPVERIFIER, MPC_VERIFIER, MPC_PVERIFIER), committee (MPC_CMTE), roots, assets, note supply
  - Invariants: root known-set check, asset binding, nullifier spend-once, value conservation, association-root membership
  
- **`contracts/stellar/nullifier_registry/src/lib.rs`** (82 lines) → **`contracts/arc/src/NullifierRegistry.sol`**
  - `spend(nullifier)` — revert if already spent
  - authorized-spender allowlist
  
- **`contracts/stellar/lean_imt/src/lib.rs`** (504 lines, tests built-in) → **`contracts/arc/src/IncrementalMerkleTree.sol`**
  - Replace O(n) rebuild with O(log n) frontier-based insert
  - Use on-chain Poseidon(2) hashing
  
- **MPC Committee Registry** — `contracts/stellar/shielded_pool`'s MPC functions → **`contracts/arc/src/CommitteeRegistry.sol`**
  - `set_committee`, `verify_committee_threshold` logic
  - Ed25519 signature verification (Solidity library)

### Proof Verifiers (Generated)
Per circuit, generate from snarkjs:
- `contracts/arc/src/verifiers/TransferVerifier.sol` (from `private_transfer_bn254`)
- `contracts/arc/src/verifiers/WithdrawVerifier.sol` (from `withdraw_public_bn254`)
- `contracts/arc/src/verifiers/DepositVerifier.sol` (from `deposit_note_mint_bn254`)
- `contracts/arc/src/verifiers/MpcSettlementVerifier.sol` (from `mpc_settlement_bn254`)
- `contracts/arc/src/verifiers/MpcPricedSettlementVerifier.sol` (from `mpc_priced_settlement_bn254`)

### Optional (Phase 6+)
- `contracts/stellar/compliance_registry/src/lib.rs` → Keep policy metadata only (not hooked into settlement yet)
- `contracts/stellar/intent_escrow/src/lib.rs` → RFQ state machine (may be simpler in EVM)
- `contracts/stellar/governance_guardian/src/lib.rs` → Replace with OpenZeppelin Timelock if needed

## Circuits to Port

All BLS12-381 circuits → BN254 variants:

- `circuits/private_transfer/` → `circuits/private_transfer_bn254/` ✓ (done Phase 1)
- `circuits/withdraw_public/` → `circuits/withdraw_public_bn254/`
- `circuits/deposit_note_mint/` → `circuits/deposit_note_mint_bn254/`
- `circuits/mpc_settlement/` → `circuits/mpc_settlement_bn254/`
- `circuits/mpc_priced_settlement/` → `circuits/mpc_priced_settlement_bn254/`

All use `circuits/lib_bn254/{commitment,merkleProof}.circom` (shared, already ported Phase 1).

## Services & Infrastructure (Unchanged)

These stay as-is — they interact with the Arc shielded pool via the same JSON-RPC/contract interface:

- **`apps/api`** — Express backend (no Rust/Soroban changes needed, just Arc contract ABIs)
- **`apps/relayer`** — Settlement relayer (replaces Soroban invoke with Arc contract calls)
- **`apps/solver`** — RFQ solver (unchanged except ethers instead of stellar-sdk for Arc)
- **`apps/mpc-committee`** — MPC coordinator (unchanged, works with Arc verifiers)
- **`apps/prover`** — Proof generation (uses new BN254 circuit artifacts)
- **`packages/mpc-crypto`** — Shamir/ed25519 (pure crypto, unchanged)
- **`packages/rfq`** — RFQ types/state machine (unchanged)

## Testing Strategy

### Phase 2 Test Gate

**Unit tests (Foundry):**
```solidity
// contracts/arc/test/ShieldedPool.t.sol
- ✓ Deposit mints note, updates root, emits event
- ✓ Withdraw with valid proof pays out, spends nullifier
- ✓ Private transfer: input nullifier spent, output committed
- ✓ MPC same-asset: both notes settled, value conserved
- ✓ MPC priced cross-asset: price check enforced, slippage protection
- ✗ Double-spend reverts
- ✗ Wrong association root reverts
- ✗ Forged root reverts
- ✗ Committee threshold not met reverts
- ✗ Batch hash mismatch reverts
- ...etc (all A1-A17 + A18-A25 MPC adversarial cases)
```

**Circuit tests (snarkjs + Foundry):**
```bash
npm run circuits:test:arc
  - Witness generation for each circuit
  - Verifier Solidity export validation
  - Real proof → anvil → on-chain verify: ✓ true
  - Tampered proof → ✗ false
```

**E2E (once deployed to Arc testnet):**
```bash
npm run e2e:testnet:arc:all
  - All F1-F9 functional scenarios (once Phase 3+ adds deposits/funding)
  - All A1-A25 adversarial scenarios
```

## High-Level Porting Checklist

- [ ] **Phase 2a — BN254 Circuit Compilation**
  - [ ] `circuits:build:arc` completes successfully for all 5 circuits
  - [ ] `Verifier.sol` files generated and validated
  - [ ] `npm run circuits:test:arc` passes

- [ ] **Phase 2b — Solidity Contracts**
  - [ ] `ShieldedPool.sol` with all settlement paths + committee management
  - [ ] `NullifierRegistry.sol`
  - [ ] `IncrementalMerkleTree.sol` (O(log n))
  - [ ] `CommitteeRegistry.sol` (ed25519 verification)
  - [ ] Import and wire all 5 Verifier contracts

- [ ] **Phase 2c — Foundry Tests**
  - [ ] Unit tests for all entrypoints
  - [ ] Functional tests (deposit, withdraw, transfer, MPC same/priced)
  - [ ] Adversarial tests (double-spend, wrong root, threshold failures, etc.)
  - [ ] `npm run contracts:test:arc` passes with 100% coverage of invariants

- [ ] **Phase 2d — Integration Setup**
  - [ ] Update `apps/api` to use Arc contract ABIs instead of Stellar
  - [ ] Update `apps/relayer` to call Arc contracts instead of Soroban
  - [ ] Update `apps/prover` to use BN254 circuit artifacts
  - [ ] Verify all tests still pass: `npm run test:ts && npm run test:arc`

## File Mapping (Stellar → Arc)

```
contracts/stellar/                  contracts/arc/src/
├── shielded_pool/src/lib.rs    →   ├── ShieldedPool.sol
├── nullifier_registry/src/lib.rs → ├── NullifierRegistry.sol
├── lean_imt/src/lib.rs         →   ├── IncrementalMerkleTree.sol
├── proof_verifiers/src/lib.rs  →   ├── verifiers/
│                                   │   ├── TransferVerifier.sol (generated)
│                                   │   ├── WithdrawVerifier.sol (generated)
│                                   │   ├── DepositVerifier.sol (generated)
│                                   │   ├── MpcSettlementVerifier.sol (generated)
│                                   │   └── MpcPricedSettlementVerifier.sol (generated)
├── compliance_registry/src/lib.rs → └── ComplianceRegistry.sol (later phase)

circuits/private_transfer/          circuits/private_transfer_bn254/
├── main.circom                  →   ├── main.circom ✓ (Phase 1 done)
└── commitment.circom            →   └── (uses shared lib_bn254/)

...same for withdraw_public, deposit_note_mint, mpc_settlement, mpc_priced_settlement
```

## Known Challenges

1. **Ed25519 verification in Solidity** — Need a working ed25519 Solidity library. Options:
   - Use OpenZeppelin's `SignatureChecker` with ECDSA (requires wrapping)
   - Direct ed25519 implementation (check gas cost)
   - Pre-verify off-chain, submit signatures to contract (committee relayer does this)

2. **Poseidon(2) on-chain** — Use `poseidon-solidity` or generate via circomlibjs. Verify byte-compatibility with circomlib.

3. **U256 bounds** — Solidity's uint256 is 2^256 - 1. Shade uses at most 128-bit amounts, so no overflow risk, but need range checks in-circuit (already in Circom).

4. **Nullifier storage** — Mapping is more efficient than Soroban's DataKey pattern.

5. **Multi-asset handling** — USDC + XLM on Stellar → need Arc equivalents (probably just USDC + wrapped tokens).

## Success Criteria

✓ Phase 2 complete when:
- All 5 BN254 circuits compile and generate Solifier verifiers
- All Solidity contracts deploy to local anvil without errors
- All Foundry tests pass (functional + adversarial)
- Manual e2e on Arc testnet: deposit, transfer, withdraw, MPC settle all work
- All invariants from `docs/SECURITY_MODEL.md` verified in tests
