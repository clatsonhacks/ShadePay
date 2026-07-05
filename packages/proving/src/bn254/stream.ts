// TS-native BN254 proof builders for Shade Streams (payment channels).
// stream_open: spend an input note, reserve `cap`, emit change + reclaim notes.
// stream_settle: prove a payer-signed voucher, split `cap` into payee + refund.
//
// The voucher signature is produced by packages/sdk/src/streams.ts's signVoucher
// (EdDSA-Poseidon over M = Poseidon(channelId, cumulative, seq)) — this module
// consumes that Voucher's R8x/R8y/S/Ax/Ay fields directly.

import { buildMerkleTree, getMerkleProof } from "./merkle.js";
import { generateCoinBn254, type Bn254Coin } from "./coin.js";
import { commitmentHasher } from "./poseidon.js";
import { proveBn254Circuit, type Bn254ProofResult, TREE_DEPTH, ASSOCIATION_DEPTH } from "./prove.js";

// ============================================================
// stream_open_bn254
// pub (13): [0] inputNullifierHash [1] changeCommitment [2] reclaimCommitment
// [3] stateRoot [4] associationRoot [5] poolId [6] chainId [7] channelId
// [8] payerAx [9] payerAy [10] cap [11] expiry [12] assetId
// ============================================================
export type StreamOpenInputBn254 = {
  inCoin: Bn254Coin;
  stateLeaves: bigint[]; // must include inCoin.commitment at stateIndex
  stateIndex: number;
  assocLabels: bigint[]; // must include inCoin.label at labelIndex
  labelIndex: number;
  channelId: bigint;
  payerAx: bigint;
  payerAy: bigint;
  cap: bigint; // <= inCoin.value
  expiry: bigint;
  poolId: bigint;
  chainId: bigint;
};

export type StreamOpenResult = Bn254ProofResult & {
  changeCoin: Bn254Coin; // the V - cap change note (payer keeps its opening)
  reclaimCoin: Bn254Coin; // the cap note, minted only on timeout reclaim
};

export async function buildStreamOpenProofBn254(p: StreamOpenInputBn254): Promise<StreamOpenResult> {
  if (p.stateLeaves[p.stateIndex] !== p.inCoin.commitment) throw new Error("stateLeaves[stateIndex] must equal inCoin.commitment");
  if (p.assocLabels[p.labelIndex] !== p.inCoin.label) throw new Error("assocLabels[labelIndex] must equal inCoin.label");
  if (p.cap > p.inCoin.value) throw new Error("cap exceeds input note value");

  const changeValue = p.inCoin.value - p.cap;
  const changeCoin = await generateCoinBn254(changeValue, p.inCoin.assetId);
  const reclaimCoin = await generateCoinBn254(p.cap, p.inCoin.assetId);

  const stateTree = await buildMerkleTree(p.stateLeaves, TREE_DEPTH);
  const stateProof = getMerkleProof(stateTree, p.stateIndex);
  const assocTree = await buildMerkleTree(p.assocLabels, ASSOCIATION_DEPTH);
  const assocProof = getMerkleProof(assocTree, p.labelIndex);

  const input = {
    changeCommitment: changeCoin.commitment.toString(),
    reclaimCommitment: reclaimCoin.commitment.toString(),
    stateRoot: stateTree.root.toString(),
    associationRoot: assocTree.root.toString(),
    poolId: p.poolId.toString(),
    chainId: p.chainId.toString(),
    channelId: p.channelId.toString(),
    payerAx: p.payerAx.toString(),
    payerAy: p.payerAy.toString(),
    cap: p.cap.toString(),
    expiry: p.expiry.toString(),
    assetId: p.inCoin.assetId.toString(),
    inValue: p.inCoin.value.toString(),
    inLabel: p.inCoin.label.toString(),
    inNullifier: p.inCoin.nullifier.toString(),
    inSecret: p.inCoin.secret.toString(),
    stateSiblings: stateProof.siblings.map(String),
    stateIndex: p.stateIndex.toString(),
    labelIndex: p.labelIndex.toString(),
    labelSiblings: assocProof.siblings.map(String),
    changeLabel: changeCoin.label.toString(),
    changeNullifier: changeCoin.nullifier.toString(),
    changeSecret: changeCoin.secret.toString(),
    reclaimLabel: reclaimCoin.label.toString(),
    reclaimNullifier: reclaimCoin.nullifier.toString(),
    reclaimSecret: reclaimCoin.secret.toString(),
  };

  const result = await proveBn254Circuit("stream_open_bn254", input);
  return { ...result, changeCoin, reclaimCoin };
}

// ============================================================
// stream_settle_bn254
// pub (11): [0] payeeCommitment [1] refundCommitment [2] associationRoot
// [3] poolId [4] chainId [5] channelId [6] payerAx [7] payerAy [8] cap
// [9] cumulative [10] assetId
// ============================================================
export type VoucherSig = {
  channelId: bigint;
  cumulative: bigint;
  seq: number;
  R8x: bigint;
  R8y: bigint;
  S: bigint;
  Ax: bigint;
  Ay: bigint;
};

export type StreamSettleInputBn254 = {
  voucher: VoucherSig; // the highest voucher, from packages/sdk/src/streams.ts
  cap: bigint; // channel cap; cumulative <= cap
  assetId: bigint;
  associationRoot: bigint;
  poolId: bigint;
  chainId: bigint;
};

export type StreamSettleResult = Bn254ProofResult & {
  payeeCoin: Bn254Coin; // the cumulative note (payee keeps its opening)
  refundCoin: Bn254Coin; // the cap - cumulative note (payer keeps its opening)
};

export async function buildStreamSettleProofBn254(p: StreamSettleInputBn254): Promise<StreamSettleResult> {
  const v = p.voucher;
  if (v.cumulative > p.cap) throw new Error("voucher cumulative exceeds channel cap");

  const refundValue = p.cap - v.cumulative;
  const payeeCoin = await generateCoinBn254(v.cumulative, p.assetId);
  const refundCoin = await generateCoinBn254(refundValue, p.assetId);

  const input = {
    associationRoot: p.associationRoot.toString(),
    poolId: p.poolId.toString(),
    chainId: p.chainId.toString(),
    channelId: v.channelId.toString(),
    payerAx: v.Ax.toString(),
    payerAy: v.Ay.toString(),
    cap: p.cap.toString(),
    cumulative: v.cumulative.toString(),
    assetId: p.assetId.toString(),
    seq: v.seq.toString(),
    R8x: v.R8x.toString(),
    R8y: v.R8y.toString(),
    S: v.S.toString(),
    payeeLabel: payeeCoin.label.toString(),
    payeeNullifier: payeeCoin.nullifier.toString(),
    payeeSecret: payeeCoin.secret.toString(),
    refundLabel: refundCoin.label.toString(),
    refundNullifier: refundCoin.nullifier.toString(),
    refundSecret: refundCoin.secret.toString(),
  };

  const result = await proveBn254Circuit("stream_settle_bn254", input);
  return { ...result, payeeCoin, refundCoin };
}
