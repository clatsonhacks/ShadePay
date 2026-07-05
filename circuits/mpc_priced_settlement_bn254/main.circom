pragma circom 2.2.0;

include "../lib_bn254/commitment.circom";
include "../lib_bn254/merkleProof.circom";
include "poseidon.circom";
include "comparators.circom"; // circomlib: LessThan / LessEqThan / GreaterEqThan / IsEqual

// Shade MpcPricedSettlement circuit — BN254 variant.
// PRICED CROSS-ASSET two-party crossing. Identical logic to the BLS12-381
// original; only field/hash primitives change (circomlib Poseidon).
// Public-signal order (outputs first, then declared inputs):
// [0] nullifierHashA [1] nullifierHashB [2] outputCommitmentA [3] outputCommitmentB
// [4] stateRoot [5] associationRoot [6] batchHash [7] poolId [8] chainId
// [9] deadlineLedger [10] inputAssetA [11] outputAssetA [12] inputAssetB
// [13] outputAssetB [14] matchedAmountA [15] matchedAmountB [16] priceScaled
// [17] priceScale [18] minOutputA [19] minOutputB
template MpcPricedSettlement(treeDepth, associationDepth) {
    // PUBLIC
    signal input stateRoot;
    signal input associationRoot;
    signal input batchHash;
    signal input poolId;
    signal input chainId;
    signal input deadlineLedger;
    signal input inputAssetA;
    signal input outputAssetA;
    signal input inputAssetB;
    signal input outputAssetB;
    signal input matchedAmountA;
    signal input matchedAmountB;
    signal input priceScaled;
    signal input priceScale;
    signal input minOutputA;
    signal input minOutputB;

    // PRIVATE — input note A
    signal input labelA;
    signal input nullifierA;
    signal input secretA;
    signal input stateIndexA;
    signal input stateSiblingsA[treeDepth];
    signal input labelIndexA;
    signal input labelSiblingsA[associationDepth];
    // input note B
    signal input labelB;
    signal input nullifierB;
    signal input secretB;
    signal input stateIndexB;
    signal input stateSiblingsB[treeDepth];
    signal input labelIndexB;
    signal input labelSiblingsB[associationDepth];
    // output note A (assetY)
    signal input outLabelA;
    signal input outNullifierA;
    signal input outSecretA;
    // output note B (assetX)
    signal input outLabelB;
    signal input outNullifierB;
    signal input outSecretB;

    // OUTPUTS
    signal output nullifierHashA;
    signal output nullifierHashB;
    signal output outputCommitmentA;
    signal output outputCommitmentB;

    // 1. cross-asset pairing
    outputAssetA === inputAssetB;
    outputAssetB === inputAssetA;
    component sameAsset = IsEqual();
    sameAsset.in[0] <== inputAssetA;
    sameAsset.in[1] <== inputAssetB;
    sameAsset.out === 0;

    priceScale === 1000000000;

    // 2. input commitments + state membership
    component cmtA = CommitmentHasher();
    cmtA.assetId <== inputAssetA;
    cmtA.value <== matchedAmountA;
    cmtA.label <== labelA;
    cmtA.secret <== secretA;
    cmtA.nullifier <== nullifierA;
    signal commitmentA <== cmtA.commitment;
    signal _nhA <== cmtA.nullifierHash;

    component cmtB = CommitmentHasher();
    cmtB.assetId <== inputAssetB;
    cmtB.value <== matchedAmountB;
    cmtB.label <== labelB;
    cmtB.secret <== secretB;
    cmtB.nullifier <== nullifierB;
    signal commitmentB <== cmtB.commitment;
    signal _nhB <== cmtB.nullifierHash;

    component merkleA = MerkleProof(treeDepth);
    merkleA.leaf <== commitmentA;
    merkleA.leafIndex <== stateIndexA;
    merkleA.siblings <== stateSiblingsA;
    stateRoot === merkleA.out;

    component merkleB = MerkleProof(treeDepth);
    merkleB.leaf <== commitmentB;
    merkleB.leafIndex <== stateIndexB;
    merkleB.siblings <== stateSiblingsB;
    stateRoot === merkleB.out;

    // 3. ASP compliance membership
    component assocA = MerkleProof(associationDepth);
    assocA.leaf <== labelA;
    assocA.leafIndex <== labelIndexA;
    assocA.siblings <== labelSiblingsA;
    associationRoot === assocA.out;

    component assocB = MerkleProof(associationDepth);
    assocB.leaf <== labelB;
    assocB.leafIndex <== labelIndexB;
    assocB.siblings <== labelSiblingsB;
    associationRoot === assocB.out;

    // 4. domain-separated nullifier hashes
    component nhA = Poseidon(3);
    nhA.inputs[0] <== nullifierA;
    nhA.inputs[1] <== poolId;
    nhA.inputs[2] <== chainId;
    nullifierHashA <== nhA.out;

    component nhB = Poseidon(3);
    nhB.inputs[0] <== nullifierB;
    nhB.inputs[1] <== poolId;
    nhB.inputs[2] <== chainId;
    nullifierHashB <== nhB.out;

    // 5. output commitments: A receives Y (matchedAmountB), B receives X (matchedAmountA)
    component outCmtA = CommitmentHasher();
    outCmtA.assetId <== outputAssetA;
    outCmtA.value <== matchedAmountB;
    outCmtA.label <== outLabelA;
    outCmtA.secret <== outSecretA;
    outCmtA.nullifier <== outNullifierA;
    outputCommitmentA <== outCmtA.commitment;
    signal _onhA <== outCmtA.nullifierHash;

    component outCmtB = CommitmentHasher();
    outCmtB.assetId <== outputAssetB;
    outCmtB.value <== matchedAmountA;
    outCmtB.label <== outLabelB;
    outCmtB.secret <== outSecretB;
    outCmtB.nullifier <== outNullifierB;
    outputCommitmentB <== outCmtB.commitment;
    signal _onhB <== outCmtB.nullifierHash;

    // 6. fixed-point price: matchedAmountB == floor(matchedAmountA*priceScaled/priceScale)
    signal prod <== matchedAmountA * priceScaled;
    signal scaled <== matchedAmountB * priceScale;
    signal rem <== prod - scaled;
    component le = LessEqThan(128);
    le.in[0] <== scaled;
    le.in[1] <== prod;
    le.out === 1;
    component lt = LessThan(64);
    lt.in[0] <== rem;
    lt.in[1] <== priceScale;
    lt.out === 1;

    // 7. minOutput protections
    component geA = GreaterEqThan(64);
    geA.in[0] <== matchedAmountB;
    geA.in[1] <== minOutputA;
    geA.out === 1;
    component geB = GreaterEqThan(64);
    geB.in[0] <== matchedAmountA;
    geB.in[1] <== minOutputB;
    geB.out === 1;
}

component main {public [
    stateRoot, associationRoot, batchHash, poolId, chainId, deadlineLedger,
    inputAssetA, outputAssetA, inputAssetB, outputAssetB,
    matchedAmountA, matchedAmountB, priceScaled, priceScale, minOutputA, minOutputB
]} = MpcPricedSettlement(12, 2);
