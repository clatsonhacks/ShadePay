pragma circom 2.2.0;

include "../lib_bn254/commitment.circom";
include "poseidon.circom";
include "bitify.circom";
include "eddsaposeidon.circom";

// Shade Streams — StreamSettle circuit (BN254).
// The payee (or a relayer) submits the HIGHEST voucher a payer signed for a
// channel. This proves the voucher is genuinely signed by the channel's payer
// EdDSA key, that the cumulative amount is within the reserved cap, and mints
// two output notes: a payee note worth `cumulative` and a payer refund note
// worth `cap - cumulative`. Value is conserved (cumulative + refund == cap).
//
// The voucher signature is EdDSA-Poseidon over M = Poseidon(channelId,
// cumulative, seq) — exactly what packages/sdk/src/streams.ts produces off-chain.
//
// Public-signal order (output first, then declared inputs):
// [0]  payeeCommitment    (= cumulative note; goes to the payee)
// [1]  refundCommitment   (= cap - cumulative note; goes back to the payer)
// [2]  associationRoot
// [3]  poolId
// [4]  chainId
// [5]  channelId
// [6]  payerAx            (must match the channel's stored payer pubkey)
// [7]  payerAy
// [8]  cap                (must match the channel's stored cap)
// [9]  cumulative         (the settled net; contract may surface it in a receipt)
// [10] assetId
template StreamSettle() {
    // PUBLIC INPUTS
    signal input associationRoot;
    signal input poolId;
    signal input chainId;
    signal input channelId;
    signal input payerAx;
    signal input payerAy;
    signal input cap;
    signal input cumulative;
    signal input assetId;

    // PRIVATE — voucher (signed by the payer's EdDSA key)
    signal input seq;      // strictly-increasing off-chain; bound into the signed message
    signal input R8x;
    signal input R8y;
    signal input S;

    // PRIVATE — payee note (value = cumulative)
    signal input payeeLabel;
    signal input payeeNullifier;
    signal input payeeSecret;

    // PRIVATE — refund note (value = cap - cumulative)
    signal input refundLabel;
    signal input refundNullifier;
    signal input refundSecret;

    // OUTPUTS
    signal output payeeCommitment;
    signal output refundCommitment;

    // 1) voucher message M = Poseidon(channelId, cumulative, seq), then verify the
    //    payer's EdDSA-Poseidon signature over it. A voucher not signed by the
    //    channel's payerAx/payerAy fails here (enabled=1 forces the check).
    component msgHasher = Poseidon(3);
    msgHasher.inputs[0] <== channelId;
    msgHasher.inputs[1] <== cumulative;
    msgHasher.inputs[2] <== seq;

    component sigVerifier = EdDSAPoseidonVerifier();
    sigVerifier.enabled <== 1;
    sigVerifier.Ax <== payerAx;
    sigVerifier.Ay <== payerAy;
    sigVerifier.S <== S;
    sigVerifier.R8x <== R8x;
    sigVerifier.R8y <== R8y;
    sigVerifier.M <== msgHasher.out;

    // 2) cumulative <= cap (range-checked, 128-bit): the payee can never settle
    //    more than the reserved cap, and refund is non-negative.
    signal refundValue <== cap - cumulative;
    component refundRange = Num2Bits(128);
    refundRange.in <== refundValue;
    _ <== refundRange.out;
    component cumulativeRange = Num2Bits(128);
    cumulativeRange.in <== cumulative;
    _ <== cumulativeRange.out;

    // 3) payee note = cumulative, correctly formed.
    component payeeHasher = CommitmentHasher();
    payeeHasher.assetId <== assetId;
    payeeHasher.value <== cumulative;
    payeeHasher.label <== payeeLabel;
    payeeHasher.nullifier <== payeeNullifier;
    payeeHasher.secret <== payeeSecret;
    payeeCommitment <== payeeHasher.commitment;

    // 4) refund note = cap - cumulative, correctly formed. Value conservation
    //    (cumulative + refundValue == cap) holds by construction of refundValue.
    component refundHasher = CommitmentHasher();
    refundHasher.assetId <== assetId;
    refundHasher.value <== refundValue;
    refundHasher.label <== refundLabel;
    refundHasher.nullifier <== refundNullifier;
    refundHasher.secret <== refundSecret;
    refundCommitment <== refundHasher.commitment;

    // 5) bind domain/compliance so the contract can enforce them against args.
    signal assocBind <== associationRoot * associationRoot;
    signal poolBind <== poolId * poolId;
    signal chainBind <== chainId * chainId;
    signal axBind <== payerAx * payerAx;
    signal ayBind <== payerAy * payerAy;
}

component main {public [associationRoot, poolId, chainId, channelId, payerAx, payerAy, cap, cumulative, assetId]} = StreamSettle();
