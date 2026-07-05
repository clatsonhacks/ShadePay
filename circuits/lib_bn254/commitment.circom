pragma circom 2.2.0;

include "poseidon.circom";

/*
 * Shade CommitmentHasher — ASSET-BOUND, BN254 variant
 *
 * Commitment scheme (MUST match the off-chain TS Poseidon via @iden3/js-crypto):
 *
 *   precommitment    = Poseidon(nullifier, secret)             // 2 inputs
 *   assetValueLabel  = Poseidon(assetId, value, label)         // 3 inputs
 *   commitment       = Poseidon(assetValueLabel, precommitment)// 2 inputs
 *   nullifierHash    = Poseidon(nullifier)                     // 1 input
 *
 * This BN254 version uses circomlib's standard Poseidon instead of the
 * BLS12-381-specific poseidon255.circom used in the Stellar path.
 */
template CommitmentHasher() {
    // inputs
    signal input assetId;
    signal input value;
    signal input label;
    signal input secret;
    signal input nullifier;

    // outputs
    signal output commitment;
    signal output nullifierHash;

    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== nullifier;

    component precommitmentHasher = Poseidon(2);
    precommitmentHasher.inputs[0] <== nullifier;
    precommitmentHasher.inputs[1] <== secret;

    component assetValueLabel = Poseidon(3);
    assetValueLabel.inputs[0] <== assetId;
    assetValueLabel.inputs[1] <== value;
    assetValueLabel.inputs[2] <== label;

    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== assetValueLabel.out;
    commitmentHasher.inputs[1] <== precommitmentHasher.out;

    commitment <== commitmentHasher.out;
    nullifierHash <== nullifierHasher.out;
}
