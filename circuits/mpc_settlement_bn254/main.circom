pragma circom 2.2.0;

include "../lib_bn254/commitment.circom";
include "../lib_bn254/merkleProof.circom";
include "poseidon.circom";
include "bitify.circom";

// Shade MpcSettlement circuit — BN254 variant.
// Proves a two-party same-asset committee match against real deposited notes.
// Identical logic to the BLS12-381 original; only field/hash primitives change.
// Public-signal order (outputs first, then declared inputs):
// [0] nullifierHashA [1] nullifierHashB [2] outputCommitmentA [3] outputCommitmentB
// [4] stateRoot [5] associationRoot [6] batchHash [7] poolId [8] chainId
// [9] matchedAmount7dp [10] deadlineLedger [11] assetId
template MpcSettlement(treeDepth, associationDepth) {
    // PUBLIC
    signal input stateRoot;
    signal input associationRoot;
    signal input batchHash;
    signal input poolId;
    signal input chainId;
    signal input matchedAmount7dp;
    signal input deadlineLedger;
    signal input assetId;

    // PRIVATE — note A
    signal input labelA;
    signal input valueA;
    signal input nullifierA;
    signal input secretA;
    signal input stateIndexA;
    signal input stateSiblingsA[treeDepth];
    signal input labelIndexA;
    signal input labelSiblingsA[associationDepth];
    // output note A
    signal input outValueA;
    signal input outLabelA;
    signal input outNullifierA;
    signal input outSecretA;

    // PRIVATE — note B
    signal input labelB;
    signal input valueB;
    signal input nullifierB;
    signal input secretB;
    signal input stateIndexB;
    signal input stateSiblingsB[treeDepth];
    signal input labelIndexB;
    signal input labelSiblingsB[associationDepth];
    // output note B
    signal input outValueB;
    signal input outLabelB;
    signal input outNullifierB;
    signal input outSecretB;

    // OUTPUTS
    signal output nullifierHashA;
    signal output nullifierHashB;
    signal output outputCommitmentA;
    signal output outputCommitmentB;

    // 1. input commitments
    component cmtA = CommitmentHasher();
    cmtA.assetId <== assetId;
    cmtA.label <== labelA;
    cmtA.value <== valueA;
    cmtA.secret <== secretA;
    cmtA.nullifier <== nullifierA;
    signal commitmentA <== cmtA.commitment;
    signal _inNhA <== cmtA.nullifierHash;

    component cmtB = CommitmentHasher();
    cmtB.assetId <== assetId;
    cmtB.label <== labelB;
    cmtB.value <== valueB;
    cmtB.secret <== secretB;
    cmtB.nullifier <== nullifierB;
    signal commitmentB <== cmtB.commitment;
    signal _inNhB <== cmtB.nullifierHash;

    // 2. Merkle membership
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

    // 5. output commitments
    component outCmtA = CommitmentHasher();
    outCmtA.assetId <== assetId;
    outCmtA.label <== outLabelA;
    outCmtA.value <== outValueA;
    outCmtA.secret <== outSecretA;
    outCmtA.nullifier <== outNullifierA;
    outputCommitmentA <== outCmtA.commitment;
    signal _outNhA <== outCmtA.nullifierHash;

    component outCmtB = CommitmentHasher();
    outCmtB.assetId <== assetId;
    outCmtB.label <== outLabelB;
    outCmtB.value <== outValueB;
    outCmtB.secret <== outSecretB;
    outCmtB.nullifier <== outNullifierB;
    outputCommitmentB <== outCmtB.commitment;
    signal _outNhB <== outCmtB.nullifierHash;

    // 6. match value constraints: matchedAmount <= min(valueA, valueB)
    signal remainA <== valueA - matchedAmount7dp;
    component rngA = Num2Bits(128);
    rngA.in <== remainA;
    _ <== rngA.out;

    signal remainB <== valueB - matchedAmount7dp;
    component rngB = Num2Bits(128);
    rngB.in <== remainB;
    _ <== rngB.out;

    // value conservation
    signal outSum <== outValueA + outValueB;
    signal expectedSum <== matchedAmount7dp * 2;
    outSum === expectedSum;

    // 7. pass-through bindings
    signal bhBind <== batchHash * batchHash;
    signal dlBind <== deadlineLedger * deadlineLedger;
}

component main {public [
    stateRoot, associationRoot, batchHash,
    poolId, chainId, matchedAmount7dp, deadlineLedger, assetId
]} = MpcSettlement(12, 2);
