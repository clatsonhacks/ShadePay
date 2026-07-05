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

// ============================================================
// mpc_settlement_bn254 — two-party same-asset committee match
// ============================================================
export type MpcSettlementInputBn254 = {
  coinA: Bn254Coin;
  coinB: Bn254Coin; // same assetId as coinA (same-asset crossing)
  outCoinA: Bn254Coin; // new note owned by party B's counterparty flow (per Stellar semantics: A's output goes to B)
  outCoinB: Bn254Coin;
  stateLeaves: bigint[]; // must include coinA.commitment and coinB.commitment
  stateIndexA: number;
  stateIndexB: number;
  assocLabels: bigint[]; // must include coinA.label and coinB.label
  labelIndexA: number;
  labelIndexB: number;
  matchedAmount7dp: bigint;
  batchHash: bigint; // pre-reduced field element (sha256(batch) >> 8), matching the contract's hashToField
  poolId: bigint;
  chainId: bigint;
  deadlineLedger: bigint;
};

export async function buildMpcSettlementProofBn254(p: MpcSettlementInputBn254): Promise<Bn254ProofResult> {
  if (p.coinA.assetId !== p.coinB.assetId) throw new Error("mpc_settlement is same-asset only; use buildMpcPricedSettlementProofBn254 for cross-asset");
  // the circuit binds a single `assetId` public signal into BOTH output
  // commitments (same-asset crossing) — an output coin generated under a
  // different assetId would silently produce a mismatched commitment.
  if (p.outCoinA.assetId !== p.coinA.assetId || p.outCoinB.assetId !== p.coinA.assetId) {
    throw new Error("outCoinA/outCoinB must share coinA/coinB's assetId (mpc_settlement is same-asset for inputs AND outputs)");
  }
  if (p.outCoinA.value + p.outCoinB.value !== p.matchedAmount7dp * 2n) {
    throw new Error("value conservation violated: outCoinA.value + outCoinB.value must equal matchedAmount7dp * 2");
  }
  if (p.stateLeaves[p.stateIndexA] !== p.coinA.commitment) throw new Error("stateLeaves[stateIndexA] must equal coinA.commitment");
  if (p.stateLeaves[p.stateIndexB] !== p.coinB.commitment) throw new Error("stateLeaves[stateIndexB] must equal coinB.commitment");
  if (p.assocLabels[p.labelIndexA] !== p.coinA.label) throw new Error("assocLabels[labelIndexA] must equal coinA.label");
  if (p.assocLabels[p.labelIndexB] !== p.coinB.label) throw new Error("assocLabels[labelIndexB] must equal coinB.label");

  const stateTree = await buildMerkleTree(p.stateLeaves, TREE_DEPTH);
  const proofA = getMerkleProof(stateTree, p.stateIndexA);
  const proofB = getMerkleProof(stateTree, p.stateIndexB);
  const assocTree = await buildMerkleTree(p.assocLabels, ASSOCIATION_DEPTH);
  const assocProofA = getMerkleProof(assocTree, p.labelIndexA);
  const assocProofB = getMerkleProof(assocTree, p.labelIndexB);

  const input = {
    stateRoot: stateTree.root.toString(),
    associationRoot: assocTree.root.toString(),
    batchHash: p.batchHash.toString(),
    poolId: p.poolId.toString(),
    chainId: p.chainId.toString(),
    matchedAmount7dp: p.matchedAmount7dp.toString(),
    deadlineLedger: p.deadlineLedger.toString(),
    assetId: p.coinA.assetId.toString(),

    labelA: p.coinA.label.toString(),
    valueA: p.coinA.value.toString(),
    nullifierA: p.coinA.nullifier.toString(),
    secretA: p.coinA.secret.toString(),
    stateIndexA: p.stateIndexA.toString(),
    stateSiblingsA: proofA.siblings.map(String),
    labelIndexA: p.labelIndexA.toString(),
    labelSiblingsA: assocProofA.siblings.map(String),
    outValueA: p.outCoinA.value.toString(),
    outLabelA: p.outCoinA.label.toString(),
    outNullifierA: p.outCoinA.nullifier.toString(),
    outSecretA: p.outCoinA.secret.toString(),

    labelB: p.coinB.label.toString(),
    valueB: p.coinB.value.toString(),
    nullifierB: p.coinB.nullifier.toString(),
    secretB: p.coinB.secret.toString(),
    stateIndexB: p.stateIndexB.toString(),
    stateSiblingsB: proofB.siblings.map(String),
    labelIndexB: p.labelIndexB.toString(),
    labelSiblingsB: assocProofB.siblings.map(String),
    outValueB: p.outCoinB.value.toString(),
    outLabelB: p.outCoinB.label.toString(),
    outNullifierB: p.outCoinB.nullifier.toString(),
    outSecretB: p.outCoinB.secret.toString(),
  };

  return proveBn254Circuit("mpc_settlement_bn254", input);
}

// ============================================================
// mpc_priced_settlement_bn254 — priced cross-asset committee match
// ============================================================
export type MpcPricedSettlementInputBn254 = {
  coinA: Bn254Coin; // spends assetX (inputAssetA); note value === matchedAmountA
  coinB: Bn254Coin; // spends assetY (inputAssetB); note value === matchedAmountB
  outCoinA: Bn254Coin; // party A receives assetY (outputAssetA), value === matchedAmountB
  outCoinB: Bn254Coin; // party B receives assetX (outputAssetB), value === matchedAmountA
  stateLeaves: bigint[];
  stateIndexA: number;
  stateIndexB: number;
  assocLabels: bigint[];
  labelIndexA: number;
  labelIndexB: number;
  matchedAmountA: bigint;
  matchedAmountB: bigint;
  priceScaled: bigint;
  priceScale?: bigint; // defaults to 1e9, matching the contract's hard-locked PRICE_SCALE
  minOutputA: bigint;
  minOutputB: bigint;
  batchHash: bigint;
  poolId: bigint;
  chainId: bigint;
  deadlineLedger: bigint;
};

export async function buildMpcPricedSettlementProofBn254(p: MpcPricedSettlementInputBn254): Promise<Bn254ProofResult> {
  const priceScale = p.priceScale ?? 1_000_000_000n;
  if (p.coinA.assetId === p.coinB.assetId) throw new Error("mpc_priced_settlement requires a genuine cross-asset pair (coinA.assetId !== coinB.assetId)");
  if (p.outCoinA.assetId !== p.coinB.assetId) throw new Error("outCoinA.assetId must equal coinB.assetId (party A receives what B spent)");
  if (p.outCoinB.assetId !== p.coinA.assetId) throw new Error("outCoinB.assetId must equal coinA.assetId (party B receives what A spent)");
  if (p.coinA.value !== p.matchedAmountA) throw new Error("coinA.value must equal matchedAmountA (no partial fills)");
  if (p.coinB.value !== p.matchedAmountB) throw new Error("coinB.value must equal matchedAmountB (no partial fills)");
  if (p.outCoinA.value !== p.matchedAmountB) throw new Error("outCoinA.value must equal matchedAmountB");
  if (p.outCoinB.value !== p.matchedAmountA) throw new Error("outCoinB.value must equal matchedAmountA");
  // fixed-point price check mirrored from the circuit: matchedAmountB == floor(matchedAmountA*priceScaled/priceScale)
  const expectedB = (p.matchedAmountA * p.priceScaled) / priceScale;
  if (p.matchedAmountB !== expectedB) {
    throw new Error(`price mismatch: matchedAmountB (${p.matchedAmountB}) must equal floor(matchedAmountA*priceScaled/priceScale) = ${expectedB}`);
  }
  if (p.matchedAmountB < p.minOutputA) throw new Error("matchedAmountB is below minOutputA (slippage violation)");
  if (p.matchedAmountA < p.minOutputB) throw new Error("matchedAmountA is below minOutputB (slippage violation)");
  if (p.stateLeaves[p.stateIndexA] !== p.coinA.commitment) throw new Error("stateLeaves[stateIndexA] must equal coinA.commitment");
  if (p.stateLeaves[p.stateIndexB] !== p.coinB.commitment) throw new Error("stateLeaves[stateIndexB] must equal coinB.commitment");
  if (p.assocLabels[p.labelIndexA] !== p.coinA.label) throw new Error("assocLabels[labelIndexA] must equal coinA.label");
  if (p.assocLabels[p.labelIndexB] !== p.coinB.label) throw new Error("assocLabels[labelIndexB] must equal coinB.label");

  const stateTree = await buildMerkleTree(p.stateLeaves, TREE_DEPTH);
  const proofA = getMerkleProof(stateTree, p.stateIndexA);
  const proofB = getMerkleProof(stateTree, p.stateIndexB);
  const assocTree = await buildMerkleTree(p.assocLabels, ASSOCIATION_DEPTH);
  const assocProofA = getMerkleProof(assocTree, p.labelIndexA);
  const assocProofB = getMerkleProof(assocTree, p.labelIndexB);

  const input = {
    stateRoot: stateTree.root.toString(),
    associationRoot: assocTree.root.toString(),
    batchHash: p.batchHash.toString(),
    poolId: p.poolId.toString(),
    chainId: p.chainId.toString(),
    deadlineLedger: p.deadlineLedger.toString(),
    inputAssetA: p.coinA.assetId.toString(),
    outputAssetA: p.outCoinA.assetId.toString(),
    inputAssetB: p.coinB.assetId.toString(),
    outputAssetB: p.outCoinB.assetId.toString(),
    matchedAmountA: p.matchedAmountA.toString(),
    matchedAmountB: p.matchedAmountB.toString(),
    priceScaled: p.priceScaled.toString(),
    priceScale: priceScale.toString(),
    minOutputA: p.minOutputA.toString(),
    minOutputB: p.minOutputB.toString(),

    labelA: p.coinA.label.toString(),
    nullifierA: p.coinA.nullifier.toString(),
    secretA: p.coinA.secret.toString(),
    stateIndexA: p.stateIndexA.toString(),
    stateSiblingsA: proofA.siblings.map(String),
    labelIndexA: p.labelIndexA.toString(),
    labelSiblingsA: assocProofA.siblings.map(String),

    labelB: p.coinB.label.toString(),
    nullifierB: p.coinB.nullifier.toString(),
    secretB: p.coinB.secret.toString(),
    stateIndexB: p.stateIndexB.toString(),
    stateSiblingsB: proofB.siblings.map(String),
    labelIndexB: p.labelIndexB.toString(),
    labelSiblingsB: assocProofB.siblings.map(String),

    outLabelA: p.outCoinA.label.toString(),
    outNullifierA: p.outCoinA.nullifier.toString(),
    outSecretA: p.outCoinA.secret.toString(),
    outLabelB: p.outCoinB.label.toString(),
    outNullifierB: p.outCoinB.nullifier.toString(),
    outSecretB: p.outCoinB.secret.toString(),
  };

  return proveBn254Circuit("mpc_priced_settlement_bn254", input);
}

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
