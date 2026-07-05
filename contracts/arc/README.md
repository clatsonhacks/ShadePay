# Shade Protocol — Arc (EVM) Implementation

This directory contains the complete Solidity implementation of the Shade shielded pool protocol, ported from Stellar/Soroban to Arc (an EVM L1 by Circle).

## Overview

Shade is a privacy-first protocol for shielded transfers and multi-party computation (MPC) settlement on Arc. All functionality from the Stellar implementation is preserved exactly as-is, with only the blockchain changing from Soroban to EVM/Solidity.

### Key Components

1. **`ShieldedPool.sol`** — Core settlement contract
   - Manages note commitments (Merkle tree)
   - Handles all settlement paths: deposit, withdraw, private transfer, MPC settlement (same-asset & priced cross-asset)
   - Enforces compliance via association roots (ASP)
   
2. **`NullifierRegistry.sol`** — Spend-once guarantee
   - Tracks spent nullifiers
   - Enforces authorized-spender allowlist
   
3. **`IncrementalMerkleTree.sol`** — O(log n) frontier-based Merkle tree
   - Replaces the O(n) rebuild pattern from Soroban
   - Uses on-chain Poseidon(2) hashing
   
4. **`CommitteeRegistry.sol`** — MPC committee quorum
   - Manages committee member keys
   - Enforces threshold signature requirements (≥2/3)
   
5. **`verifiers/` Solidity Verifiers** — Proof verification
   - Generated from snarkjs zkey export (BN254 Groth16)
   - Leverage EVM precompiles for pairing checks
   - One verifier per circuit: TransferVerifier, WithdrawVerifier, DepositVerifier, MpcSettlementVerifier, MpcPricedSettlementVerifier

## Circuits (BN254 Variants)

All circuits ported from Stellar (originally BLS12-381) to BN254 for efficient EVM verification:

- `circuits/private_transfer_bn254/` — Same-asset private transfer
- `circuits/withdraw_public_bn254/` — Public withdrawal with proof
- `circuits/deposit_note_mint_bn254/` — CCTP deposit to shielded note
- `circuits/mpc_settlement_bn254/` — MPC two-party same-asset match
- `circuits/mpc_priced_settlement_bn254/` — MPC two-party cross-asset match with price

## Building

```bash
# Build Solidity contracts
forge build

# Run tests
forge test -vv

# Run with gas reporting
forge test -vv --gas-report
```

## Testing

All tests mirror the adversarial/functional test matrix from `docs/TESTNET_E2E.md`:

- **Functional tests:** deposit, withdraw, private transfer, MPC settlement (same & priced)
- **Adversarial tests:** double-spend, forged root, wrong association root, malformed proof, committee threshold failures, etc.

## Deployment

Phase 2 deliverable: Foundry test suite passes locally. Phase 3+ will add deployment scripts and testnet verification.

## Differences from Stellar Implementation

1. **Tree structure:** O(log n) frontier-based vs. O(n) rebuild
2. **Proof verification:** Native EVM precompiles (BN254) vs. Soroban host functions (BLS12-381)
3. **Hashing:** Circomlib standard Poseidon vs. custom poseidon255.circom
4. **Committee signatures:** Same ed25519, verified on-chain via Solidity instead of Soroban

## Status

- Phase 1: BN254 derisking (in progress — zkey generation running)
- Phase 2: Full port with tests (next)
- Phase 3: Streaming channels on top of full system
