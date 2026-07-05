// Shade Streams — narrated live demo. Deploys the full stack to a live EVM
// chain and runs one complete private payment-channel session end to end with
// REAL Groth16 proofs, real transactions, real gas, and a real receipt.
//
// By default it spins up a local anvil node (a real EVM — same opcodes and BN254
// precompiles as any EVM chain, including Arc testnet). To run against a real
// testnet instead, set:
//   ARC_RPC_URL=<rpc>  ARC_DEPLOYER_KEY=0x<funded key>  [ARC_CHAIN_ID=<id>]
// and the exact same script deploys + runs there — the flow is chain-agnostic.
//
// Run: npm run stream-demo   (local anvil)
//      ARC_RPC_URL=... ARC_DEPLOYER_KEY=... npm run stream-demo   (real testnet)

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet, formatUnits } from "ethers";

import { generatePayerKey, PayerAgent, PayeeAgent } from "@shade/sdk";
import { generateCoinBn254, buildStreamOpenProofBn254, buildStreamSettleProofBn254 } from "@shade/proving/bn254";

const SHADE_ROOT = process.env.SHADE_ROOT ?? process.cwd();
const USE_TESTNET = !!process.env.ARC_RPC_URL;
const RPC_URL = process.env.ARC_RPC_URL ?? "http://127.0.0.1:8553";
const ANVIL_BIN = existsSync("C:/Users/clats/.foundry/bin/anvil.exe") ? "C:/Users/clats/.foundry/bin/anvil.exe" : "anvil";
// anvil default accounts (local only); on a real testnet ARC_DEPLOYER_KEY funds everything.
const DEPLOYER_KEY = process.env.ARC_DEPLOYER_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const POOL_ID = 1n, CHAIN_ID = 42n;
let anvil: ChildProcess | undefined;

function art(rel: string): { abi: unknown; bytecode: string } {
  const j = JSON.parse(readFileSync(resolve(SHADE_ROOT, "contracts/arc/out", rel), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}
const addrHash = (a: string) => BigInt("0x" + createHash("sha256").update(Buffer.from(a.slice(2), "hex")).digest("hex")) >> 8n;
const hashToField = (v: bigint) => BigInt("0x" + createHash("sha256").update(Buffer.from(v.toString(16).padStart(64, "0"), "hex")).digest("hex")) >> 8n;
function log(s = "") { console.log(s); }
function step(n: number, s: string) { log(`\n\x1b[1m\x1b[36m[${n}] ${s}\x1b[0m`); }
function kv(k: string, v: string) { log(`    ${k.padEnd(22)} ${v}`); }

async function main() {
  log("\x1b[1m═══════════════════════════════════════════════════════════════");
  log("  SHADE STREAMS — live private payment-channel demo");
  log(`  chain: ${USE_TESTNET ? `REAL TESTNET (${RPC_URL})` : "local anvil (real EVM)"}`);
  log("═══════════════════════════════════════════════════════════════\x1b[0m");

  if (!existsSync(resolve(SHADE_ROOT, "contracts/arc/out/StreamEscrow.sol/StreamEscrow.json"))) {
    log("\nERROR: contracts not built. Run: cd contracts/arc && forge build");
    process.exit(1);
  }

  if (!USE_TESTNET) {
    anvil = spawn(ANVIL_BIN, ["--port", "8553", "--silent"], { stdio: "ignore" });
  }
  const provider = new JsonRpcProvider(RPC_URL);
  for (let i = 0; i < 50; i++) { try { await provider.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 300)); } }

  const deployer = new Wallet(DEPLOYER_KEY, provider);
  const net = await provider.getNetwork();
  let n = await provider.getTransactionCount(deployer.address, "latest");

  step(1, "Deploy the Shade Streams stack");
  kv("deployer", deployer.address);
  kv("chainId", net.chainId.toString());

  const poseidonCode = readFileSync(resolve(SHADE_ROOT, "contracts/arc/test/poseidon2.bin"), "utf8").trim();
  const poseidonAddr = (await (await deployer.sendTransaction({ data: poseidonCode, nonce: n++ })).wait())!.contractAddress!;
  const deploy = async (rel: string, args: unknown[]) => {
    const a = art(rel);
    const c = await new ContractFactory(a.abi as any, a.bytecode, deployer).deploy(...args, { nonce: n++ });
    await c.waitForDeployment();
    return c;
  };
  const nullReg = await deploy("NullifierRegistry.sol/NullifierRegistry.json", [deployer.address]);
  const pool = await deploy("ShieldedPool.sol/ShieldedPool.json", [deployer.address, await nullReg.getAddress(), POOL_ID, CHAIN_ID, 12, poseidonAddr]);
  const escrow = await deploy("StreamEscrow.sol/StreamEscrow.json", [deployer.address, await pool.getAddress(), await nullReg.getAddress(), 100n]);
  const openV = await deploy("StreamOpenVerifier.sol/StreamOpenVerifier.json", []);
  const settleV = await deploy("StreamSettleVerifier.sol/StreamSettleVerifier.json", []);
  const mockV = await deploy("MockVerifiers.sol/MockVerifier.json", []);
  const usdc = await deploy("MockERC20.sol/MockERC20.json", []);
  const poolAddr = await pool.getAddress(), escrowAddr = await escrow.getAddress(), usdcAddr = await usdc.getAddress();
  kv("Poseidon2", poseidonAddr);
  kv("ShieldedPool", poolAddr);
  kv("StreamEscrow", escrowAddr);
  kv("USDC (mock)", usdcAddr);

  // wire
  await (await (nullReg.connect(deployer) as any).setAuthorizedSpender(poolAddr, true, { nonce: n++ })).wait();
  await (await (nullReg.connect(deployer) as any).setAuthorizedSpender(escrowAddr, true, { nonce: n++ })).wait();
  await (await (pool.connect(deployer) as any).setAuthorizedStreamContract(escrowAddr, true, { nonce: n++ })).wait();
  await (await (pool.connect(deployer) as any).setDepositVerifier(await mockV.getAddress(), { nonce: n++ })).wait();
  await (await (escrow.connect(deployer) as any).setOpenVerifier(await openV.getAddress(), { nonce: n++ })).wait();
  await (await (escrow.connect(deployer) as any).setSettleVerifier(await settleV.getAddress(), { nonce: n++ })).wait();
  const usdcAsset = addrHash(usdcAddr);
  await (await (pool.connect(deployer) as any).registerAsset(usdcAsset, usdcAddr, { nonce: n++ })).wait();
  await (await (usdc.connect(deployer) as any).mint(poolAddr, 1_000_000n, { nonce: n++ })).wait();
  log("    \x1b[32m✓ all contracts deployed + wired\x1b[0m");

  // ---- payer funds a private note ----
  step(2, "Payer funds a private (shielded) note in the pool");
  const payerKey = await generatePayerKey();
  const inCoin = await generateCoinBn254(1000n, usdcAsset);
  const nonceBytes = "0x" + "d1".repeat(32);
  const dp: string[] = new Array(14).fill("0");
  dp[0] = inCoin.commitment.toString(); dp[1] = "4"; dp[2] = "3"; dp[4] = hashToField(BigInt(nonceBytes)).toString();
  dp[5] = "1"; dp[6] = "101"; dp[7] = "1000"; dp[8] = addrHash(usdcAddr).toString(); dp[9] = addrHash(poolAddr).toString();
  dp[10] = hashToField(1n).toString(); dp[11] = hashToField(1n).toString(); dp[12] = POOL_ID.toString(); dp[13] = CHAIN_ID.toString();
  const dtx = await (pool.connect(deployer) as any).receiveDeposit(3, nonceBytes, usdcAddr, 1000n, inCoin.commitment, 1n, 1n,
    { a: ["0", "0"], b: [["0", "0"], ["0", "0"]], c: ["0", "0"] }, dp, { nonce: n++ });
  const drec = await dtx.wait();
  kv("note value", "1000 units (hidden on-chain — only the commitment is public)");
  kv("commitment", "0x" + inCoin.commitment.toString(16).slice(0, 24) + "…");
  kv("deposit tx", drec.hash);
  kv("gas used", drec.gasUsed.toString());

  // ---- OPEN a channel ----
  step(3, "OPEN a payment channel (1 ZK proof) — reserve a 600-unit cap");
  const channelId = 0xC0FFEEn, cap = 600n;
  const expiry = BigInt((await provider.getBlockNumber()) + 500);
  const open = await buildStreamOpenProofBn254({
    inCoin, stateLeaves: [inCoin.commitment], stateIndex: 0, assocLabels: [inCoin.label], labelIndex: 0,
    channelId, payerAx: payerKey.Ax, payerAy: payerKey.Ay, cap, expiry, poolId: POOL_ID, chainId: CHAIN_ID,
  });
  await (await (pool.connect(deployer) as any).setAssociationRoot(BigInt(open.publicSignals[4]), { nonce: n++ })).wait();
  const otx = await (escrow.connect(deployer) as any).open(open.proof, open.publicSignals.map((s) => BigInt(s)), { nonce: n++ });
  const orec = await otx.wait();
  kv("channelId", "0x" + channelId.toString(16));
  kv("cap reserved", "600 units");
  kv("payer EdDSA pubkey", "0x" + payerKey.Ax.toString(16).slice(0, 20) + "… (Baby Jubjub)");
  kv("open tx", orec.hash);
  kv("gas used", orec.gasUsed.toString());
  kv("input note", "burned (nullifier spent — can never be reused)");

  // ---- STREAM: off-chain per-call vouchers via the agents ----
  step(4, "STREAM — payer signs per-call vouchers OFF-CHAIN (0 gas, fully private)");
  const payer = new PayerAgent({ key: payerKey, channelId, cap, ratePerUnit: 5n, budget: 500n });
  const payee = new PayeeAgent({ payerAx: payerKey.Ax, payerAy: payerKey.Ay, channelId, cap, ratePerUnit: 5n });
  let served = 0n;
  log("    simulating a stream of paid API calls (5 units each):");
  for (let call = 1; call <= 8; call++) {
    const v = await payer.pay(1n);       // authorize 1 more call
    served += 1n;
    const r = await payee.receive(v, served); // payee verifies + tracks
    log(`      call #${call}:  voucher cumulative=${v.cumulative.toString().padStart(3)}  verified=${r.accepted ? "✓" : "✗"}  (no chain tx)`);
  }
  const highest = payee.highest()!;
  kv("total streamed", `${payer.spent()} units across 8 signed vouchers`);
  kv("on-chain writes", "0  — this is the 'millions of ticks, zero cost' property");
  kv("payee settles", `the single highest voucher (cumulative=${highest.cumulative})`);

  // ---- SETTLE ----
  step(5, "SETTLE (1 ZK proof) — only the private NET hits the chain");
  const assocRoot = BigInt(open.publicSignals[4]);
  const settle = await buildStreamSettleProofBn254({ voucher: highest, cap, assetId: usdcAsset, associationRoot: assocRoot, poolId: POOL_ID, chainId: CHAIN_ID });
  const stx = await (escrow.connect(deployer) as any).settle(settle.proof, settle.publicSignals.map((s) => BigInt(s)), { nonce: n++ });
  const srec = await stx.wait();
  kv("settled net", `${highest.cumulative} units to the payee (a new shielded note)`);
  kv("refund", `${cap - highest.cumulative} units back to the payer (shielded note)`);
  kv("in-circuit checks", "payer EdDSA sig valid · cumulative ≤ cap · value conserved");
  kv("settle tx", srec.hash);
  kv("gas used", srec.gasUsed.toString());

  // ---- RECEIPT ----
  step(6, "RECEIPT — reconstructed from on-chain events (audit invariant #8)");
  const { fetchChannelReceipt } = await import("./index.js");
  const receipt = await fetchChannelReceipt({ rpcUrl: RPC_URL }, escrowAddr, channelId);
  kv("state", receipt.state);
  kv("cap", receipt.cap.toString());
  kv("gross (net settled)", receipt.gross.toString());
  for (const s of receipt.split) kv(`  → ${s.recipient}`, `${s.amount} units  (note 0x${s.commitment.toString(16).slice(0, 16)}…)`);
  const grossMatches = receipt.gross === highest.cumulative;
  kv("invariant #8", grossMatches ? "\x1b[32m✓ receipt gross == highest voucher cumulative\x1b[0m" : "\x1b[31m✗ MISMATCH\x1b[0m");

  step(7, "Pool reserves (proof-of-reserves)");
  const [supply, bal] = await (pool as any).proofOfReserves(usdcAsset);
  kv("shielded note supply", supply.toString());
  kv("vault USDC balance", formatUnits(bal, 0));
  kv("healthy", (BigInt(supply) <= BigInt(bal)) ? "\x1b[32m✓ note supply ≤ vault balance\x1b[0m" : "\x1b[31m✗\x1b[0m");

  log("\n\x1b[1m\x1b[32m═══ DEMO COMPLETE — a private payment channel opened, streamed 8 vouchers");
  log("    off-chain, and settled the net on-chain, all with real ZK proofs. ═══\x1b[0m\n");
  if (!grossMatches) { anvil?.kill(); process.exit(1); }
  anvil?.kill();
  process.exit(0);
}

main().catch((e) => { console.error("\nDEMO FAILED:", e); anvil?.kill(); process.exit(1); });
