// TS-native BN254 proof builders for the Arc port. Replaces the Rust
// `stellar-coinutils` witness-assembly binary AND the `circom2soroban` byte
// packer: witnesses are built directly here via poseidon.ts/merkle.ts, and
// proofs are exported as native `uint256`-shaped calldata (via snarkjs'
// `exportSolidityCallData`) ready for `ShieldedPool.sol`'s
// `Groth16Proof {a,b,c}` struct + `uint256[N]` public-signals array — no byte
// blob, no CLI shelling.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-ignore - snarkjs ships its own .d.ts under a subpath not resolved by default
import * as snarkjs from "snarkjs";

import { SHADE_ROOT } from "../paths.js";
import { buildMerkleTree, getMerkleProof } from "./merkle.js";
import type { Bn254Coin } from "./coin.js";

export const TREE_DEPTH = 12;
export const ASSOCIATION_DEPTH = 2;

function circuitDir(name: string): string {
  return resolve(SHADE_ROOT, "circuits", name);
}

export type Groth16CallData = {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
};

export type Bn254ProofResult = {
  proof: Groth16CallData;
  publicSignals: string[]; // decimal strings, in circuit output order (matches ShieldedPool.sol's uint256[N])
  verified: boolean;
};

async function proveBn254Circuit(circuitName: string, input: Record<string, unknown>): Promise<Bn254ProofResult> {
  const dir = circuitDir(circuitName);
  const wasm = resolve(dir, "build/main_js/main.wasm");
  const zkey = resolve(dir, "output/main_final.zkey");
  if (!existsSync(wasm) || !existsSync(zkey)) {
    throw new Error(`circuit ${circuitName} not built — run: npm run circuits:build:arc`);
  }

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);

  const vkeyPath = resolve(dir, "output/vkey.json");
  const vkey = existsSync(vkeyPath)
    ? JSON.parse(readFileSync(vkeyPath, "utf8"))
    : await snarkjs.zKey.exportVerificationKey(zkey);
  const verified: boolean = await snarkjs.groth16.verify(vkey, publicSignals, proof);

  const calldata: string = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const [a, b, c, pub] = JSON.parse(`[${calldata}]`) as [string[], string[][], string[], string[]];
  return {
    proof: { a: [a[0], a[1]], b: [[b[0][0], b[0][1]], [b[1][0], b[1][1]]], c: [c[0], c[1]] },
    publicSignals: pub,
    verified,
  };
}

// ============================================================
// private_transfer_bn254
// ============================================================
export type TransferInputBn254 = {
  inCoin: Bn254Coin;
  outCoin: Bn254Coin; // caller must ensure outCoin.value === inCoin.value - feePublic, same assetId
  stateLeaves: bigint[]; // full state-tree leaf set; must include inCoin.commitment at stateIndex
  stateIndex: number;
  assocLabels: bigint[]; // full ASP allow-tree leaf set; must include inCoin.label at labelIndex
  labelIndex: number;
  feePublic: bigint;
  poolId: bigint;
  chainId: bigint;
};

export async function buildTransferProofBn254(p: TransferInputBn254): Promise<Bn254ProofResult> {
  if (p.stateLeaves[p.stateIndex] !== p.inCoin.commitment) {
    throw new Error("stateLeaves[stateIndex] must equal inCoin.commitment");
  }
  if (p.assocLabels[p.labelIndex] !== p.inCoin.label) {
    throw new Error("assocLabels[labelIndex] must equal inCoin.label");
  }
  if (p.outCoin.assetId !== p.inCoin.assetId) {
    throw new Error("same-asset transfer requires outCoin.assetId === inCoin.assetId");
  }
  if (p.outCoin.value !== p.inCoin.value - p.feePublic) {
    throw new Error("value conservation violated: outCoin.value must equal inCoin.value - feePublic");
  }

  const stateTree = await buildMerkleTree(p.stateLeaves, TREE_DEPTH);
  const stateProof = getMerkleProof(stateTree, p.stateIndex);
  const assocTree = await buildMerkleTree(p.assocLabels, ASSOCIATION_DEPTH);
  const assocProof = getMerkleProof(assocTree, p.labelIndex);

  const input = {
    outputCommitment: p.outCoin.commitment.toString(),
    feePublic: p.feePublic.toString(),
    stateRoot: stateTree.root.toString(),
    associationRoot: assocTree.root.toString(),
    poolId: p.poolId.toString(),
    chainId: p.chainId.toString(),
    inputAssetId: p.inCoin.assetId.toString(),
    outputAssetId: p.outCoin.assetId.toString(),
    inValue: p.inCoin.value.toString(),
    inLabel: p.inCoin.label.toString(),
    inNullifier: p.inCoin.nullifier.toString(),
    inSecret: p.inCoin.secret.toString(),
    stateSiblings: stateProof.siblings.map(String),
    stateIndex: p.stateIndex.toString(),
    labelIndex: p.labelIndex.toString(),
    labelSiblings: assocProof.siblings.map(String),
    outValue: p.outCoin.value.toString(),
    outLabel: p.outCoin.label.toString(),
    outNullifier: p.outCoin.nullifier.toString(),
    outSecret: p.outCoin.secret.toString(),
  };

  return proveBn254Circuit("private_transfer_bn254", input);
}

// ============================================================
// withdraw_public_bn254 (shared by withdraw / CCTP exit / RFQ via operationType)
// ============================================================
export const OP_WITHDRAW_PUBLIC = 1n;
export const OP_WITHDRAW_CCTP = 2n;
export const OP_RFQ_SETTLEMENT = 3n;

export type WithdrawBindingBn254 = {
  operationType: bigint;
  recipientHash: bigint;
  relayerFee: bigint;
  deadlineLedger: bigint;
  quoteHash?: bigint;
  intentHash?: bigint;
  fillReceiptHash?: bigint;
  destinationDomain?: bigint;
  destinationRecipient?: bigint;
  maxFee?: bigint;
  minFinalityThreshold?: bigint;
};

export type WithdrawInputBn254 = {
  coin: Bn254Coin;
  withdrawnValue: bigint; // amount taken from the note; must be <= coin.value
  stateLeaves: bigint[];
  stateIndex: number;
  assocLabels: bigint[];
  labelIndex: number;
  poolId: bigint;
  chainId: bigint;
  binding: WithdrawBindingBn254;
};

export async function buildWithdrawProofBn254(p: WithdrawInputBn254): Promise<Bn254ProofResult> {
  if (p.stateLeaves[p.stateIndex] !== p.coin.commitment) {
    throw new Error("stateLeaves[stateIndex] must equal coin.commitment");
  }
  if (p.assocLabels[p.labelIndex] !== p.coin.label) {
    throw new Error("assocLabels[labelIndex] must equal coin.label");
  }
  if (p.withdrawnValue > p.coin.value) {
    throw new Error("withdrawnValue exceeds note value");
  }

  const stateTree = await buildMerkleTree(p.stateLeaves, TREE_DEPTH);
  const stateProof = getMerkleProof(stateTree, p.stateIndex);
  const assocTree = await buildMerkleTree(p.assocLabels, ASSOCIATION_DEPTH);
  const assocProof = getMerkleProof(assocTree, p.labelIndex);
  const b = p.binding;

  const input = {
    operationType: b.operationType.toString(),
    withdrawnValue: p.withdrawnValue.toString(),
    recipientHash: b.recipientHash.toString(),
    relayerFee: b.relayerFee.toString(),
    deadlineLedger: b.deadlineLedger.toString(),
    stateRoot: stateTree.root.toString(),
    associationRoot: assocTree.root.toString(),
    poolId: p.poolId.toString(),
    chainId: p.chainId.toString(),
    quoteHash: (b.quoteHash ?? 0n).toString(),
    intentHash: (b.intentHash ?? 0n).toString(),
    fillReceiptHash: (b.fillReceiptHash ?? 0n).toString(),
    destinationDomain: (b.destinationDomain ?? 0n).toString(),
    destinationRecipient: (b.destinationRecipient ?? 0n).toString(),
    maxFee: (b.maxFee ?? 0n).toString(),
    minFinalityThreshold: (b.minFinalityThreshold ?? 0n).toString(),
    assetId: p.coin.assetId.toString(),
    label: p.coin.label.toString(),
    value: p.coin.value.toString(),
    nullifier: p.coin.nullifier.toString(),
    secret: p.coin.secret.toString(),
    stateSiblings: stateProof.siblings.map(String),
    stateIndex: p.stateIndex.toString(),
    labelIndex: p.labelIndex.toString(),
    labelSiblings: assocProof.siblings.map(String),
  };

  return proveBn254Circuit("withdraw_public_bn254", input);
}

// ============================================================
// deposit_note_mint_bn254
// ============================================================
export type DepositBindingBn254 = {
  sourceDomain: bigint;
  destinationDomain: bigint;
  cctpNonceHash: bigint;
  burnTxHashHash: bigint;
  amount6dp: bigint;
  amount7dp: bigint; // must be >= coin.value
  assetIdHash: bigint;
  recipientPool: bigint;
  encryptedNotePayloadHash: bigint;
  policyIdHash: bigint;
  poolId: bigint;
  chainId: bigint;
};

export async function buildDepositProofBn254(coin: Bn254Coin, b: DepositBindingBn254): Promise<Bn254ProofResult> {
  if (coin.value > b.amount7dp) {
    throw new Error("note value exceeds minted amount7dp (anti-inflation check would fail in-circuit)");
  }
  // The circuit binds `assetIdHash` (not a separate private assetId signal)
  // into the commitment via CommitmentHasher.assetId <== assetIdHash — so the
  // coin passed in here must have been generated with assetId === assetIdHash,
  // or the recomputed on-chain/in-circuit commitment won't match coin.commitment.
  if (coin.assetId !== b.assetIdHash) {
    throw new Error("coin.assetId must equal binding.assetIdHash (the circuit binds assetIdHash into the commitment, not a separate private assetId)");
  }

  const input = {
    operationType: "4", // OP_DEPOSIT_NOTE_MINT
    sourceDomain: b.sourceDomain.toString(),
    destinationDomain: b.destinationDomain.toString(),
    cctpNonceHash: b.cctpNonceHash.toString(),
    burnTxHashHash: b.burnTxHashHash.toString(),
    amount6dp: b.amount6dp.toString(),
    amount7dp: b.amount7dp.toString(),
    assetIdHash: b.assetIdHash.toString(),
    recipientPool: b.recipientPool.toString(),
    encryptedNotePayloadHash: b.encryptedNotePayloadHash.toString(),
    policyIdHash: b.policyIdHash.toString(),
    poolId: b.poolId.toString(),
    chainId: b.chainId.toString(),
    value: coin.value.toString(),
    label: coin.label.toString(),
    nullifier: coin.nullifier.toString(),
    secret: coin.secret.toString(),
  };

  return proveBn254Circuit("deposit_note_mint_bn254", input);
}
