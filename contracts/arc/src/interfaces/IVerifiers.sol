// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @dev snarkjs-generated Groth16 verifier interfaces, one per circuit arity.
 *
 * snarkjs `zkey export solidityverifier` produces a contract with:
 *   function verifyProof(uint[2] _pA, uint[2][2] _pB, uint[2] _pC, uint[N] _pubSignals)
 *     public view returns (bool)
 * where N is the number of public signals for that circuit.
 *
 * Public-signal counts (from scripts/circuits-build.ts + circuit outputs):
 *   private_transfer      : 9   [nullifierHash, outputCommitment, feePublic, stateRoot,
 *                                associationRoot, poolId, chainId, inputAssetId, outputAssetId]
 *   withdraw_public       : 18
 *   deposit_note_mint     : 14
 *   mpc_settlement        : 12  (but only [0..10] are bound on-chain)
 *   mpc_priced_settlement : 20
 */

interface ITransferVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[9] calldata pubSignals
    ) external view returns (bool);
}

interface IWithdrawVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[18] calldata pubSignals
    ) external view returns (bool);
}

interface IDepositVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[14] calldata pubSignals
    ) external view returns (bool);
}

interface IMpcSettlementVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[12] calldata pubSignals
    ) external view returns (bool);
}

interface IMpcPricedSettlementVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[20] calldata pubSignals
    ) external view returns (bool);
}

interface IStreamOpenVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[13] calldata pubSignals
    ) external view returns (bool);
}

interface IStreamSettleVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[11] calldata pubSignals
    ) external view returns (bool);
}

/// @dev A Groth16 proof, decomposed as snarkjs emits it.
struct Groth16Proof {
    uint256[2] a;
    uint256[2][2] b;
    uint256[2] c;
}
