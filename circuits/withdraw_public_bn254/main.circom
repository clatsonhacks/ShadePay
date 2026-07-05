pragma circom 2.2.0;

include "../lib_bn254/commitment.circom";
include "../lib_bn254/merkleProof.circom";
include "poseidon.circom";
include "bitify.circom";

// Shade Withdraw / settlement circuit — BN254 variant.
// Identical logic to the BLS12-381 original (domain-separated nullifier, enforced
// ASP membership, range-checked amounts, RFQ + CCTP pass-through bindings); only
// the field/hash primitives change (circomlib Poseidon).
// Public-signal order:
// [0] nullifierHash [1] operationType [2] withdrawnValue [3] recipientHash
// [4] relayerFee [5] deadlineLedger [6] stateRoot [7] associationRoot
// [8] poolId [9] chainId [10] quoteHash [11] intentHash [12] fillReceiptHash
// [13] destinationDomain [14] destinationRecipient [15] maxFee
// [16] minFinalityThreshold [17] assetId
template Withdraw(treeDepth, associationDepth) {
    signal input operationType;
    signal input withdrawnValue;
    signal input recipientHash;
    signal input relayerFee;
    signal input deadlineLedger;
    signal input stateRoot;
    signal input associationRoot;
    signal input poolId;
    signal input chainId;
    signal input quoteHash;
    signal input intentHash;
    signal input fillReceiptHash;
    signal input destinationDomain;
    signal input destinationRecipient;
    signal input maxFee;
    signal input minFinalityThreshold;
    signal input assetId;

    // PRIVATE
    signal input label;
    signal input value;
    signal input nullifier;
    signal input secret;
    signal input stateSiblings[treeDepth];
    signal input stateIndex;
    signal input labelIndex;
    signal input labelSiblings[associationDepth];

    // OUTPUT
    signal output nullifierHash;

    component commitmentHasher = CommitmentHasher();
    commitmentHasher.assetId <== assetId;
    commitmentHasher.label <== label;
    commitmentHasher.value <== value;
    commitmentHasher.secret <== secret;
    commitmentHasher.nullifier <== nullifier;
    signal commitment <== commitmentHasher.commitment;

    // domain-separated nullifier hash = Poseidon(nullifier, poolId, chainId)
    component nullifierHasher = Poseidon(3);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHasher.inputs[1] <== poolId;
    nullifierHasher.inputs[2] <== chainId;
    nullifierHash <== nullifierHasher.out;

    component stateRootChecker = MerkleProof(treeDepth);
    stateRootChecker.leaf <== commitment;
    stateRootChecker.leafIndex <== stateIndex;
    stateRootChecker.siblings <== stateSiblings;
    stateRoot === stateRootChecker.out;

    // ENFORCED association-set membership (hard equality, no zero-bypass).
    component associationRootChecker = MerkleProof(associationDepth);
    associationRootChecker.leaf <== label;
    associationRootChecker.leafIndex <== labelIndex;
    associationRootChecker.siblings <== labelSiblings;
    associationRoot === associationRootChecker.out;

    // withdrawn value <= commitment value (128-bit range check).
    signal remainingValue <== value - withdrawnValue;
    component remainingValueRangeCheck = Num2Bits(128);
    remainingValueRangeCheck.in <== remainingValue;
    _ <== remainingValueRangeCheck.out;

    component withdrawnValueRangeCheck = Num2Bits(128);
    withdrawnValueRangeCheck.in <== withdrawnValue;
    _ <== withdrawnValueRangeCheck.out;

    // relayerFee <= withdrawnValue (net non-negative).
    signal netOutput <== withdrawnValue - relayerFee;
    component netRangeCheck = Num2Bits(128);
    netRangeCheck.in <== netOutput;
    _ <== netRangeCheck.out;
    component feeRangeCheck = Num2Bits(128);
    feeRangeCheck.in <== relayerFee;
    _ <== feeRangeCheck.out;

    // pass-through bindings enforced by the contract.
    signal opBind <== operationType * operationType;
    signal recBind <== recipientHash * recipientHash;
    signal dlBind <== deadlineLedger * deadlineLedger;
    signal qhBind <== quoteHash * quoteHash;
    signal ihBind <== intentHash * intentHash;
    signal frBind <== fillReceiptHash * fillReceiptHash;
    signal ddBind <== destinationDomain * destinationDomain;
    signal drBind <== destinationRecipient * destinationRecipient;
    signal mfBind <== maxFee * maxFee;
    signal ftBind <== minFinalityThreshold * minFinalityThreshold;
    signal aidBind <== assetId * assetId;
}

component main {public [operationType, withdrawnValue, recipientHash, relayerFee, deadlineLedger, stateRoot, associationRoot, poolId, chainId, quoteHash, intentHash, fillReceiptHash, destinationDomain, destinationRecipient, maxFee, minFinalityThreshold, assetId]} = Withdraw(12, 2);
