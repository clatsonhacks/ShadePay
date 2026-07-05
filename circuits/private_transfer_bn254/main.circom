pragma circom 2.2.0;

include "../lib_bn254/commitment.circom";
include "../lib_bn254/merkleProof.circom";
include "poseidon.circom";

// Shade PrivateTransfer (hidden-amount shielded transfer), BN254 variant.
// Spends one input note and creates one output note, paying a public fee.
// The input and output AMOUNTS are private (never revealed); only the public
// fee and the output commitment are public. Value conservation is enforced
// in-circuit: value_in == value_out + fee. This is the Zcash/Penumbra-style
// shielded transfer the bible specifies (PrivateTransfer circuit).
//
// This BN254 version uses circomlib's standard Poseidon instead of the
// BLS12-381-specific poseidon255.circom used in the Stellar path.

template PrivateTransfer(treeDepth, associationDepth) {
    // PUBLIC
    signal input outputCommitment;  // [0]
    signal input feePublic;         // [1]
    signal input stateRoot;         // [2]
    signal input associationRoot;   // [3]
    signal input poolId;            // [4]
    signal input chainId;           // [5]
    signal input inputAssetId;      // [6] input note asset
    signal input outputAssetId;     // [7] output note asset (== input for same-asset)

    // PRIVATE — input note
    signal input inValue;
    signal input inLabel;
    signal input inNullifier;
    signal input inSecret;
    signal input stateSiblings[treeDepth];
    signal input stateIndex;
    signal input labelIndex;
    signal input labelSiblings[associationDepth];

    // PRIVATE — output note
    signal input outValue;
    signal input outLabel;
    signal input outNullifier;
    signal input outSecret;

    // OUTPUT
    signal output nullifierHash;    // [0]

    // 1) same-asset transfer — input and output notes share one asset.
    inputAssetId === outputAssetId;

    component inHasher = CommitmentHasher();
    inHasher.assetId <== inputAssetId;
    inHasher.value <== inValue;
    inHasher.label <== inLabel;
    inHasher.nullifier <== inNullifier;
    inHasher.secret <== inSecret;
    signal inCommitment <== inHasher.commitment;

    component stateRootChecker = MerkleProof(treeDepth);
    stateRootChecker.leaf <== inCommitment;
    stateRootChecker.leafIndex <== stateIndex;
    stateRootChecker.siblings <== stateSiblings;
    stateRoot === stateRootChecker.out;

    // 2) domain-separated nullifier for the input note
    component nullifierHasher = Poseidon(3);
    nullifierHasher.inputs[0] <== inNullifier;
    nullifierHasher.inputs[1] <== poolId;
    nullifierHasher.inputs[2] <== chainId;
    nullifierHash <== nullifierHasher.out;

    // 3) output commitment is correctly formed and matches the public signal
    component outHasher = CommitmentHasher();
    outHasher.assetId <== outputAssetId;
    outHasher.value <== outValue;
    outHasher.label <== outLabel;
    outHasher.nullifier <== outNullifier;
    outHasher.secret <== outSecret;
    outputCommitment === outHasher.commitment;

    // 4) value conservation: inValue == outValue + feePublic (amounts hidden)
    inValue === outValue + feePublic;

    // 5) range checks: outValue and feePublic in [0, 2^128) so the sum can't wrap
    component outRange = Num2Bits(128);
    outRange.in <== outValue;
    _ <== outRange.out;
    component feeRange = Num2Bits(128);
    feeRange.in <== feePublic;
    _ <== feeRange.out;

    // 6) ENFORCED association-set membership: the spender's label must
    // be in the association tree (hard equality, no zero-bypass) — matches
    // withdraw_public's check so transfers are held to the same compliance
    // envelope as deposit/withdraw.
    component associationRootChecker = MerkleProof(associationDepth);
    associationRootChecker.leaf <== inLabel;
    associationRootChecker.leafIndex <== labelIndex;
    associationRootChecker.siblings <== labelSiblings;
    associationRoot === associationRootChecker.out;
}

component main {public [outputCommitment, feePublic, stateRoot, associationRoot, poolId, chainId, inputAssetId, outputAssetId]} = PrivateTransfer(12, 2);
