pragma circom 2.2.0;

include "../lib_bn254/commitment.circom";
include "../lib_bn254/merkleProof.circom";
include "poseidon.circom";
include "bitify.circom";

// Shade Streams — StreamOpen circuit (BN254).
// Opens a unidirectional payment channel anchored to an escrowed shielded note:
// spends input note N (value V), reserves `cap` L for the channel, and mints a
// change note worth V - L plus a "reclaim" note worth L that the payer gets
// back only if the channel times out unsettled (StreamEscrow.reclaim inserts it).
// The channel binds the payer's EdDSA (Baby Jubjub) public key (payerAx,payerAy)
// so only the payer can sign vouchers that stream_settle will honor.
//
// Value accounting (all conserved in-circuit): burn N(V) -> change(V-L) + a
// reserved cap L that becomes EITHER settle's payee(cumulative)+refund(L-cumulative)
// OR reclaim's single note(L) — never both (StreamEscrow's per-channel consumed flag).
//
// Public-signal order (output first, then declared inputs):
// [0]  inputNullifierHash  (burns note N; domain-separated)
// [1]  changeCommitment    (V - L note; goes back to payer immediately)
// [2]  reclaimCommitment    (L note; inserted only on timeout reclaim)
// [3]  stateRoot
// [4]  associationRoot
// [5]  poolId
// [6]  chainId
// [7]  channelId
// [8]  payerAx              (payer EdDSA pubkey x)
// [9]  payerAy              (payer EdDSA pubkey y)
// [10] cap                  (L, reserved for the channel)
// [11] expiry               (block/ledger after which reclaim is allowed)
// [12] assetId
template StreamOpen(treeDepth, associationDepth) {
    // PUBLIC INPUTS
    signal input changeCommitment;
    signal input reclaimCommitment;
    signal input stateRoot;
    signal input associationRoot;
    signal input poolId;
    signal input chainId;
    signal input channelId;
    signal input payerAx;
    signal input payerAy;
    signal input cap;
    signal input expiry;
    signal input assetId;

    // PRIVATE — input note N
    signal input inValue;
    signal input inLabel;
    signal input inNullifier;
    signal input inSecret;
    signal input stateSiblings[treeDepth];
    signal input stateIndex;
    signal input labelIndex;
    signal input labelSiblings[associationDepth];

    // PRIVATE — change note (V - L)
    signal input changeLabel;
    signal input changeNullifier;
    signal input changeSecret;

    // PRIVATE — reclaim note (L)
    signal input reclaimLabel;
    signal input reclaimNullifier;
    signal input reclaimSecret;

    // OUTPUT
    signal output inputNullifierHash;

    // 1) input note membership in the state tree
    component inHasher = CommitmentHasher();
    inHasher.assetId <== assetId;
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

    // 2) ENFORCED association-set membership on the spender's label.
    component associationRootChecker = MerkleProof(associationDepth);
    associationRootChecker.leaf <== inLabel;
    associationRootChecker.leafIndex <== labelIndex;
    associationRootChecker.siblings <== labelSiblings;
    associationRoot === associationRootChecker.out;

    // 3) domain-separated nullifier burns note N (channelized note cannot be reused).
    component nullifierHasher = Poseidon(3);
    nullifierHasher.inputs[0] <== inNullifier;
    nullifierHasher.inputs[1] <== poolId;
    nullifierHasher.inputs[2] <== chainId;
    inputNullifierHash <== nullifierHasher.out;

    // 4) cap L <= value V (range-checked, 128-bit): can't reserve more than the note holds.
    signal changeValue <== inValue - cap;
    component changeRange = Num2Bits(128);
    changeRange.in <== changeValue;
    _ <== changeRange.out;
    component capRange = Num2Bits(128);
    capRange.in <== cap;
    _ <== capRange.out;

    // 5) change note = V - L, correctly formed and equal to the public signal.
    component changeHasher = CommitmentHasher();
    changeHasher.assetId <== assetId;
    changeHasher.value <== changeValue;
    changeHasher.label <== changeLabel;
    changeHasher.nullifier <== changeNullifier;
    changeHasher.secret <== changeSecret;
    changeCommitment === changeHasher.commitment;

    // 6) reclaim note = L, correctly formed and equal to the public signal.
    component reclaimHasher = CommitmentHasher();
    reclaimHasher.assetId <== assetId;
    reclaimHasher.value <== cap;
    reclaimHasher.label <== reclaimLabel;
    reclaimHasher.nullifier <== reclaimNullifier;
    reclaimHasher.secret <== reclaimSecret;
    reclaimCommitment === reclaimHasher.commitment;

    // 7) bind channel params (payer pubkey, expiry) into the constraint system so
    //    a relayer can't mutate them; the contract records them keyed by channelId.
    signal cidBind <== channelId * channelId;
    signal axBind <== payerAx * payerAx;
    signal ayBind <== payerAy * payerAy;
    signal expBind <== expiry * expiry;
}

component main {public [changeCommitment, reclaimCommitment, stateRoot, associationRoot, poolId, chainId, channelId, payerAx, payerAy, cap, expiry, assetId]} = StreamOpen(12, 2);
