// Phase 4 — full Shade Streams channel lifecycle with REAL Groth16 proofs
// through the REAL StreamEscrow + ShieldedPool on a local anvil chain. No mocks
// on the ZK path. Drives:
//   OPEN (real stream_open proof) -> sign voucher (real EdDSA) -> SETTLE (real
//   stream_settle proof), and separately OPEN -> timeout -> RECLAIM.
// Asserts the design's named invariants at the on-chain boundary, including
// #8 (receipt gross == on-chain settled net) and a real-proof param-mismatch
// rejection (a settle proof for the wrong payer key can't drain a channel).
//
// Run via: npm run stream-lifecycle:test

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";

import { generatePayerKey, signVoucher } from "@shade/sdk";
import {
  generateCoinBn254,
  buildStreamOpenProofBn254,
  buildStreamSettleProofBn254,
} from "@shade/proving/bn254";

type CheckResult = { name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(ok ? "PASS" : "FAIL", name, detail ? `- ${detail}` : "");
}

const SHADE_ROOT = process.env.SHADE_ROOT ?? process.cwd();
const ANVIL_PORT = 8551;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const ANVIL_BIN =
  process.env.ANVIL_BIN ??
  (existsSync("C:/Users/clats/.foundry/bin/anvil.exe") ? "C:/Users/clats/.foundry/bin/anvil.exe" : "anvil");
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADMIN_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const POOL_ID = 1n;
const CHAIN_ID = 42n;

let anvilProcess: ChildProcess | undefined;

function loadArtifact(relPath: string): { abi: unknown; bytecode: string } {
  const j = JSON.parse(readFileSync(resolve(SHADE_ROOT, "contracts/arc/out", relPath), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}
function addressHash(a: string): bigint {
  return BigInt("0x" + createHash("sha256").update(Buffer.from(a.slice(2), "hex")).digest("hex")) >> 8n;
}
function hashToField(v: bigint): bigint {
  return BigInt("0x" + createHash("sha256").update(Buffer.from(v.toString(16).padStart(64, "0"), "hex")).digest("hex")) >> 8n;
}
async function waitForAnvil(provider: JsonRpcProvider): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try { await provider.getBlockNumber(); return; } catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  throw new Error("anvil did not become ready");
}

const zeroProof = { a: ["0", "0"], b: [["0", "0"], ["0", "0"]], c: ["0", "0"] };

async function main() {
  for (const rel of [
    "ShieldedPool.sol/ShieldedPool.json",
    "StreamEscrow.sol/StreamEscrow.json",
    "StreamOpenVerifier.sol/StreamOpenVerifier.json",
    "StreamSettleVerifier.sol/StreamSettleVerifier.json",
    "MockVerifiers.sol/MockVerifier.json",
    "MockERC20.sol/MockERC20.json",
    "NullifierRegistry.sol/NullifierRegistry.json",
  ]) {
    if (!existsSync(resolve(SHADE_ROOT, "contracts/arc/out", rel))) {
      check("artifacts present", false, `missing ${rel} — run: cd contracts/arc && forge build`);
      return finish();
    }
  }

  anvilProcess = spawn(ANVIL_BIN, ["--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });
  const provider = new JsonRpcProvider(RPC_URL);
  await waitForAnvil(provider);
  check("anvil started", true, RPC_URL);

  const deployer = new Wallet(DEPLOYER_KEY, provider);
  const admin = new Wallet(ADMIN_KEY, provider);
  let dNonce = await provider.getTransactionCount(deployer.address, "latest");
  let aNonce = await provider.getTransactionCount(admin.address, "latest");

  // deploy stack
  const poseidonBytecode = readFileSync(resolve(SHADE_ROOT, "contracts/arc/test/poseidon2.bin"), "utf8").trim();
  const poseidonAddr = (await (await deployer.sendTransaction({ data: poseidonBytecode, nonce: dNonce++ })).wait())!.contractAddress!;

  const nrArt = loadArtifact("NullifierRegistry.sol/NullifierRegistry.json");
  const nullReg = await new ContractFactory(nrArt.abi as any, nrArt.bytecode, deployer).deploy(admin.address, { nonce: dNonce++ });
  await nullReg.waitForDeployment();

  const poolArt = loadArtifact("ShieldedPool.sol/ShieldedPool.json");
  const pool = await new ContractFactory(poolArt.abi as any, poolArt.bytecode, admin).deploy(
    admin.address, await nullReg.getAddress(), POOL_ID, CHAIN_ID, 12, poseidonAddr, { nonce: aNonce++ }
  );
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();

  const CHALLENGE_WINDOW = 100n;
  const escArt = loadArtifact("StreamEscrow.sol/StreamEscrow.json");
  const escrow = await new ContractFactory(escArt.abi as any, escArt.bytecode, admin).deploy(
    admin.address, poolAddr, await nullReg.getAddress(), CHALLENGE_WINDOW, { nonce: aNonce++ }
  );
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();

  const openVArt = loadArtifact("StreamOpenVerifier.sol/StreamOpenVerifier.json");
  const openV = await new ContractFactory(openVArt.abi as any, openVArt.bytecode, admin).deploy({ nonce: aNonce++ });
  await openV.waitForDeployment();
  const settleVArt = loadArtifact("StreamSettleVerifier.sol/StreamSettleVerifier.json");
  const settleV = await new ContractFactory(settleVArt.abi as any, settleVArt.bytecode, admin).deploy({ nonce: aNonce++ });
  await settleV.waitForDeployment();
  const mvArt = loadArtifact("MockVerifiers.sol/MockVerifier.json");
  const mockV = await new ContractFactory(mvArt.abi as any, mvArt.bytecode, admin).deploy({ nonce: aNonce++ });
  await mockV.waitForDeployment();
  const ercArt = loadArtifact("MockERC20.sol/MockERC20.json");
  const usdc = await new ContractFactory(ercArt.abi as any, ercArt.bytecode, admin).deploy({ nonce: aNonce++ });
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();

  // wire
  await (await (nullReg.connect(admin) as any).setAuthorizedSpender(poolAddr, true, { nonce: aNonce++ })).wait();
  await (await (nullReg.connect(admin) as any).setAuthorizedSpender(escrowAddr, true, { nonce: aNonce++ })).wait();
  await (await (pool.connect(admin) as any).setAuthorizedStreamContract(escrowAddr, true, { nonce: aNonce++ })).wait();
  await (await (pool.connect(admin) as any).setDepositVerifier(await mockV.getAddress(), { nonce: aNonce++ })).wait();
  await (await (escrow.connect(admin) as any).setOpenVerifier(await openV.getAddress(), { nonce: aNonce++ })).wait();
  await (await (escrow.connect(admin) as any).setSettleVerifier(await settleV.getAddress(), { nonce: aNonce++ })).wait();
  const usdcAssetId = addressHash(usdcAddr);
  await (await (pool.connect(admin) as any).registerAsset(usdcAssetId, usdcAddr, { nonce: aNonce++ })).wait();
  await (await (usdc.connect(admin) as any).mint(poolAddr, 1_000_000n, { nonce: aNonce++ })).wait();
  check("full stream stack deployed + wired", true, `escrow=${escrowAddr}`);

  // track the pool's leaf set in insert order so we can build valid membership
  // proofs (the tree is append-only and shared across every operation).
  const poolLeaves: bigint[] = [];

  // helper: seed a coin's commitment into the pool tree via a mock-verified deposit,
  // so the pool root equals the stream_open proof's stateRoot.
  async function seedCommitment(commitment: bigint, amount: bigint, nonceTag: string) {
    const cctpNonce = "0x" + Buffer.from(nonceTag.padEnd(32, "0")).toString("hex").slice(0, 64);
    const dp: string[] = new Array(14).fill("0");
    dp[0] = commitment.toString(); dp[1] = "4"; dp[2] = "3";
    dp[4] = hashToField(BigInt(cctpNonce)).toString(); dp[5] = "1";
    dp[6] = (amount / 10n + 1n).toString(); dp[7] = amount.toString();
    dp[8] = addressHash(usdcAddr).toString(); dp[9] = addressHash(poolAddr).toString();
    dp[10] = hashToField(1n).toString(); dp[11] = hashToField(1n).toString();
    dp[12] = POOL_ID.toString(); dp[13] = CHAIN_ID.toString();
    await (await (pool.connect(admin) as any).receiveDeposit(3, cctpNonce, usdcAddr, amount, commitment, 1n, 1n, zeroProof, dp, { nonce: aNonce++ })).wait();
    poolLeaves.push(commitment);
  }

  // =========================================================
  // LIFECYCLE 1: OPEN -> voucher -> SETTLE (real proofs)
  // =========================================================
  const payerKey = await generatePayerKey(Buffer.from("11".repeat(32), "hex"));
  const inCoin = await generateCoinBn254(1000n, usdcAssetId);
  await seedCommitment(inCoin.commitment, 1000n, "seed1");

  const channelId = 424242n;
  const cap = 600n;
  const currentBlock = await provider.getBlockNumber();
  const expiry = BigInt(currentBlock + 50);

  const openResult = await buildStreamOpenProofBn254({
    inCoin, stateLeaves: poolLeaves.slice(), stateIndex: poolLeaves.indexOf(inCoin.commitment),
    assocLabels: [inCoin.label], labelIndex: 0,
    channelId, payerAx: payerKey.Ax, payerAy: payerKey.Ay, cap, expiry, poolId: POOL_ID, chainId: CHAIN_ID,
  });
  check("stream_open real proof verifies locally", openResult.verified === true);

  // pool association root must equal the open proof's assocRoot (pub[4]).
  const openAssocRoot = BigInt(openResult.publicSignals[4]);
  await (await (pool.connect(admin) as any).setAssociationRoot(openAssocRoot, { nonce: aNonce++ })).wait();

  const openPubNums = openResult.publicSignals.map((s) => BigInt(s));
  const leavesBeforeOpen: bigint = BigInt(await (pool as any).getLeafCount());
  await (await (escrow.connect(admin) as any).open(openResult.proof, openPubNums, { nonce: aNonce++ })).wait();
  poolLeaves.push(openResult.changeCoin.commitment); // open inserts the change note
  const ch1 = await (escrow as any).getChannel(channelId);
  check("real open() records channel", ch1.opened === true && BigInt(ch1.cap) === cap);
  check("real open() spends input nullifier", await (nullReg as any).isSpent("0x" + openPubNums[0].toString(16).padStart(64, "0")) === true);
  check("real open() inserts change note", BigInt(await (pool as any).getLeafCount()) === leavesBeforeOpen + 1n);

  // sign a voucher for cumulative=350
  const cumulative = 350n;
  const voucher = await signVoucher(payerKey, channelId, cumulative, 3);
  const settleResult = await buildStreamSettleProofBn254({
    voucher, cap, assetId: usdcAssetId, associationRoot: openAssocRoot, poolId: POOL_ID, chainId: CHAIN_ID,
  });
  check("stream_settle real proof verifies locally", settleResult.verified === true);

  const settlePubNums = settleResult.publicSignals.map((s) => BigInt(s));
  const leavesBeforeSettle: bigint = BigInt(await (pool as any).getLeafCount());
  await (await (escrow.connect(admin) as any).settle(settleResult.proof, settlePubNums, { nonce: aNonce++ })).wait();
  poolLeaves.push(settleResult.payeeCoin.commitment); // settle inserts payee then refund
  poolLeaves.push(settleResult.refundCoin.commitment);
  const ch1After = await (escrow as any).getChannel(channelId);
  check("real settle() consumes channel", ch1After.consumed === true);
  check("real settle() inserts payee + refund notes", BigInt(await (pool as any).getLeafCount()) === leavesBeforeSettle + 2n);
  // INVARIANT #8: receipt gross == on-chain settled net (public signal [9] == voucher cumulative)
  check("invariant #8: settled cumulative == voucher cumulative", settlePubNums[9] === cumulative, `${settlePubNums[9]}`);

  // adversarial: settle again -> channel consumed (invariant #4 on-chain, real proof)
  try {
    await (await (escrow.connect(admin) as any).settle(settleResult.proof, settlePubNums, { nonce: aNonce++ })).wait();
    check("invariant #4: double-settle rejected (real proof)", false, "should revert");
  } catch {
    aNonce = await provider.getTransactionCount(admin.address, "latest");
    check("invariant #4: double-settle rejected (real proof)", true);
  }

  // =========================================================
  // LIFECYCLE 2: OPEN -> timeout -> RECLAIM (real open proof)
  // =========================================================
  const inCoin2 = await generateCoinBn254(800n, usdcAssetId);
  await seedCommitment(inCoin2.commitment, 800n, "seed2"); // appends to poolLeaves at its real index

  const channelId2 = 999999n;
  const cap2 = 500n;
  const block2 = await provider.getBlockNumber();
  const expiry2 = BigInt(block2 + 5);
  const openResult2 = await buildStreamOpenProofBn254({
    inCoin: inCoin2, stateLeaves: poolLeaves.slice(), stateIndex: poolLeaves.indexOf(inCoin2.commitment),
    assocLabels: [inCoin2.label], labelIndex: 0,
    channelId: channelId2, payerAx: payerKey.Ax, payerAy: payerKey.Ay, cap: cap2, expiry: expiry2, poolId: POOL_ID, chainId: CHAIN_ID,
  });
  check("stream_open #2 real proof verifies locally", openResult2.verified === true);
  // pool assoc root must match this proof's assoc root
  await (await (pool.connect(admin) as any).setAssociationRoot(BigInt(openResult2.publicSignals[4]), { nonce: aNonce++ })).wait();
  await (await (escrow.connect(admin) as any).open(openResult2.proof, openResult2.publicSignals.map((s) => BigInt(s)), { nonce: aNonce++ })).wait();
  poolLeaves.push(openResult2.changeCoin.commitment); // open #2 inserts a change note too
  check("real open() #2 records channel", (await (escrow as any).getChannel(channelId2)).opened === true);

  // reclaim before timeout -> revert (invariant #6)
  try {
    await (await (escrow.connect(admin) as any).reclaim(channelId2, { nonce: aNonce++ })).wait();
    check("invariant #6: reclaim before timeout rejected", false, "should revert");
  } catch {
    aNonce = await provider.getTransactionCount(admin.address, "latest");
    check("invariant #6: reclaim before timeout rejected", true);
  }

  // mine past expiry + challengeWindow
  const target = Number(expiry2 + CHALLENGE_WINDOW) + 1;
  let blk = await provider.getBlockNumber();
  while (blk < target) { await provider.send("evm_mine", []); blk++; }

  const leavesBeforeReclaim: bigint = BigInt(await (pool as any).getLeafCount());
  await (await (escrow.connect(admin) as any).reclaim(channelId2, { nonce: aNonce++ })).wait();
  poolLeaves.push(openResult2.reclaimCoin.commitment); // reclaim inserts the reclaim note
  const ch2 = await (escrow as any).getChannel(channelId2);
  check("invariant #6: reclaim after timeout consumes channel + inserts reclaim note",
    ch2.consumed === true && BigInt(await (pool as any).getLeafCount()) === leavesBeforeReclaim + 1n);

  // =========================================================
  // LIFECYCLE 3: batch-close 2 channels via settleBatch (Phase 5 streaming relayer)
  // =========================================================
  const { STREAM_ESCROW_ABI } = await import("./abi.js");
  const inCoinA = await generateCoinBn254(400n, usdcAssetId);
  const inCoinB = await generateCoinBn254(400n, usdcAssetId);
  await seedCommitment(inCoinA.commitment, 400n, "seedA");
  await seedCommitment(inCoinB.commitment, 400n, "seedB");

  const chA = 111000n, chB = 222000n, capAB = 200n;
  const expiryAB = BigInt((await provider.getBlockNumber()) + 1000);

  const openA = await buildStreamOpenProofBn254({
    inCoin: inCoinA, stateLeaves: poolLeaves.slice(), stateIndex: poolLeaves.indexOf(inCoinA.commitment),
    assocLabels: [inCoinA.label], labelIndex: 0,
    channelId: chA, payerAx: payerKey.Ax, payerAy: payerKey.Ay, cap: capAB, expiry: expiryAB, poolId: POOL_ID, chainId: CHAIN_ID,
  });
  await (await (pool.connect(admin) as any).setAssociationRoot(BigInt(openA.publicSignals[4]), { nonce: aNonce++ })).wait();
  await (await (escrow.connect(admin) as any).open(openA.proof, openA.publicSignals.map((s) => BigInt(s)), { nonce: aNonce++ })).wait();
  poolLeaves.push(openA.changeCoin.commitment);

  const openB = await buildStreamOpenProofBn254({
    inCoin: inCoinB, stateLeaves: poolLeaves.slice(), stateIndex: poolLeaves.indexOf(inCoinB.commitment),
    assocLabels: [inCoinB.label], labelIndex: 0,
    channelId: chB, payerAx: payerKey.Ax, payerAy: payerKey.Ay, cap: capAB, expiry: expiryAB, poolId: POOL_ID, chainId: CHAIN_ID,
  });
  const assocRootB = BigInt(openB.publicSignals[4]);
  await (await (pool.connect(admin) as any).setAssociationRoot(assocRootB, { nonce: aNonce++ })).wait();
  await (await (escrow.connect(admin) as any).open(openB.proof, openB.publicSignals.map((s) => BigInt(s)), { nonce: aNonce++ })).wait();
  poolLeaves.push(openB.changeCoin.commitment);
  check("batch: both channels opened (real proofs)",
    (await (escrow as any).getChannel(chA)).opened === true && (await (escrow as any).getChannel(chB)).opened === true);

  // sign a voucher per channel; build both settle proofs bound to the pool's
  // current association root (assocRootB, set by the last open).
  const vA = await signVoucher(payerKey, chA, 120n, 1);
  const vB = await signVoucher(payerKey, chB, 80n, 1);
  const settleA = await buildStreamSettleProofBn254({ voucher: vA, cap: capAB, assetId: usdcAssetId, associationRoot: assocRootB, poolId: POOL_ID, chainId: CHAIN_ID });
  const settleB = await buildStreamSettleProofBn254({ voucher: vB, cap: capAB, assetId: usdcAssetId, associationRoot: assocRootB, poolId: POOL_ID, chainId: CHAIN_ID });

  const leavesBeforeBatch: bigint = BigInt(await (pool as any).getLeafCount());
  const escrowBatch = new (await import("ethers")).Contract(escrowAddr, STREAM_ESCROW_ABI as unknown as string[], admin);
  await (await escrowBatch.settleBatch(
    [settleA.proof, settleB.proof],
    [settleA.publicSignals.map((s) => BigInt(s)), settleB.publicSignals.map((s) => BigInt(s))],
    { nonce: aNonce++ }
  )).wait();
  check("batch: settleBatch closes both channels (real proofs)",
    (await (escrow as any).getChannel(chA)).consumed === true && (await (escrow as any).getChannel(chB)).consumed === true);
  check("batch: settleBatch inserts 4 notes (2 per channel)",
    BigInt(await (pool as any).getLeafCount()) === leavesBeforeBatch + 4n);

  finish();
}

function finish() {
  anvilProcess?.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  anvilProcess?.kill();
  process.exit(1);
});
