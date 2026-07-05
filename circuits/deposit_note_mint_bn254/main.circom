pragma circom 2.2.0;

include "../lib_bn254/commitment.circom";
include "bitify.circom";

// Shade DepositNoteMint circuit — BN254 variant.
// Binds a freshly-minted CCTP deposit to the note commitment inserted into the
// shielded pool. Identical logic to the BLS12-381 original; only the field/hash
// primitives change (circomlib Poseidon).
// Public-signal order (output first, then declared inputs):
// [0] commitment [1] operationType [2] sourceDomain [3] destinationDomain
// [4] cctpNonceHash [5] burnTxHashHash [6] amount6dp [7] amount7dp
// [8] assetIdHash [9] recipientPool [10] encryptedNotePayloadHash
// [11] policyIdHash [12] poolId [13] chainId
template DepositNoteMint() {
    // PUBLIC INPUTS
    signal input operationType;
    signal input sourceDomain;
    signal input destinationDomain;
    signal input cctpNonceHash;
    signal input burnTxHashHash;
    signal input amount6dp;
    signal input amount7dp;
    signal input assetIdHash;
    signal input recipientPool;
    signal input encryptedNotePayloadHash;
    signal input policyIdHash;
    signal input poolId;
    signal input chainId;

    // PRIVATE INPUTS (the note opening)
    signal input value;
    signal input label;
    signal input nullifier;
    signal input secret;

    // OUTPUT
    signal output commitment;

    component commitmentHasher = CommitmentHasher();
    commitmentHasher.assetId <== assetIdHash;
    commitmentHasher.value <== value;
    commitmentHasher.label <== label;
    commitmentHasher.secret <== secret;
    commitmentHasher.nullifier <== nullifier;
    commitment <== commitmentHasher.commitment;

    // value <= amount7dp (anti-inflation), 128-bit non-negativity range check.
    signal surplus <== amount7dp - value;
    component surplusRangeCheck = Num2Bits(128);
    surplusRangeCheck.in <== surplus;
    _ <== surplusRangeCheck.out;
    component valueRangeCheck = Num2Bits(128);
    valueRangeCheck.in <== value;
    _ <== valueRangeCheck.out;

    // Pass-through bindings enforced by the contract.
    signal opBind   <== operationType * operationType;
    signal sdBind   <== sourceDomain * sourceDomain;
    signal ddBind   <== destinationDomain * destinationDomain;
    signal nonceBind<== cctpNonceHash * cctpNonceHash;
    signal btBind   <== burnTxHashHash * burnTxHashHash;
    signal a6Bind   <== amount6dp * amount6dp;
    signal asBind   <== assetIdHash * assetIdHash;
    signal rpBind   <== recipientPool * recipientPool;
    signal enBind   <== encryptedNotePayloadHash * encryptedNotePayloadHash;
    signal piBind   <== policyIdHash * policyIdHash;
    signal poolBind <== poolId * poolId;
    signal chainBind<== chainId * chainId;
}

component main {public [operationType, sourceDomain, destinationDomain, cctpNonceHash, burnTxHashHash, amount6dp, amount7dp, assetIdHash, recipientPool, encryptedNotePayloadHash, policyIdHash, poolId, chainId]} = DepositNoteMint();
