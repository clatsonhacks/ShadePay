// Validates @shade/arc-actions against a REAL local anvil chain (not mocks):
// spawns anvil, deploys the actual compiled NullifierRegistry.sol, and
// exercises both the service-signed path (arcInvoke) and the user-signed
// path (buildUnsignedTx -> sign -> broadcastSignedTx) against it.
// Run via: npm run arc-actions:test (requires `forge build` to have run once
// so contracts/arc/out/NullifierRegistry.sol/NullifierRegistry.json exists).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet, Interface } from "ethers";

import { arcInvoke, buildUnsignedTx, broadcastSignedTx, withdrawArgs, serializeUnsignedTx, type Network } from "./index.js";
import { NULLIFIER_REGISTRY_ABI, SHIELDED_POOL_ABI } from "./abi.js";

type CheckResult = { name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(ok ? "PASS" : "FAIL", name, detail ? `- ${detail}` : "");
}

const SHADE_ROOT = process.env.SHADE_ROOT ?? process.cwd();
const ANVIL_PORT = 8547; // distinct from the default 8545 to avoid clobbering a dev anvil
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const ANVIL_BIN =
  process.env.ANVIL_BIN ??
  (existsSync("C:/Users/clats/.foundry/bin/anvil.exe") ? "C:/Users/clats/.foundry/bin/anvil.exe" : "anvil");

// anvil's well-known default account #0 (deterministic test mnemonic).
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// account #1
const ADMIN_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

let anvilProcess: ChildProcess | undefined;

async function waitForAnvil(provider: JsonRpcProvider, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await provider.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error("anvil did not become ready in time");
}

async function main() {
  anvilProcess = spawn(ANVIL_BIN, ["--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });

  const network: Network = { rpcUrl: RPC_URL };
  const provider = new JsonRpcProvider(RPC_URL);
  await waitForAnvil(provider);
  check("anvil started", true, RPC_URL);

  const deployer = new Wallet(DEPLOYER_KEY, provider);
  const admin = new Wallet(ADMIN_KEY, provider);

  // deploy the REAL compiled NullifierRegistry
  const artifactPath = resolve(SHADE_ROOT, "contracts/arc/out/NullifierRegistry.sol/NullifierRegistry.json");
  if (!existsSync(artifactPath)) {
    check("NullifierRegistry artifact exists", false, "run: cd contracts/arc && forge build");
    return finish();
  }
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, deployer);
  const registry = await factory.deploy(admin.address);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  check("NullifierRegistry deployed", true, registryAddress);

  // ---- service-signed path: arcInvoke ----
  const adminWallet = new Wallet(ADMIN_KEY);
  await arcInvoke({
    network,
    contractAddress: registryAddress,
    abi: NULLIFIER_REGISTRY_ABI.concat(["function setAuthorizedSpender(address spender, bool allowed)"] as any),
    method: "setAuthorizedSpender",
    args: [deployer.address, true],
    wallet: adminWallet,
  });
  const isAuth = await arcInvoke({
    network,
    contractAddress: registryAddress,
    abi: NULLIFIER_REGISTRY_ABI,
    method: "isAuthorized",
    args: [deployer.address],
    readOnly: true,
  });
  check("arcInvoke write + read round-trip", isAuth.returnValue === true, `isAuthorized=${isAuth.returnValue}`);

  // ---- user-signed path: buildUnsignedTx -> sign -> broadcastSignedTx ----
  const spendAbi = ["function spend(bytes32 nullifier) returns (bool)"];
  const nullifier = "0x" + "11".repeat(32);
  const unsignedTx = await buildUnsignedTx({
    network,
    from: deployer.address,
    contractAddress: registryAddress,
    abi: spendAbi,
    method: "spend",
    params: [nullifier],
  });
  check("buildUnsignedTx produces populated tx", typeof unsignedTx.data === "string" && unsignedTx.gasLimit !== undefined);

  const signedRawTx = await deployer.signTransaction(unsignedTx);
  const broadcastResult = await broadcastSignedTx(network, signedRawTx);
  check("broadcastSignedTx confirms", broadcastResult.status === "SUCCESS", broadcastResult.hash);

  // confirm the nullifier is now actually spent on-chain
  const spent = await arcInvoke({
    network,
    contractAddress: registryAddress,
    abi: ["function isSpent(bytes32) view returns (bool)"],
    method: "isSpent",
    args: [nullifier],
    readOnly: true,
  });
  check("nullifier spent on-chain after user-signed tx", spent.returnValue === true);

  // adversarial: unauthorized spender via arcInvoke should revert
  try {
    await arcInvoke({
      network,
      contractAddress: registryAddress,
      abi: ["function spend(bytes32) returns (bool)"],
      method: "spend",
      args: ["0x" + "22".repeat(32)],
      wallet: new Wallet(ADMIN_KEY), // admin was never authorized as a spender
      retries: 1,
    });
    check("unauthorized spend rejected", false, "should have reverted");
  } catch (e) {
    check("unauthorized spend rejected", /failed after/.test(String(e)), String(e).slice(0, 150));
  }

  // ============================================================
  // Full-loop withdraw settlement: deploy the REAL ShieldedPool (+ Poseidon2,
  // a mock withdraw verifier, a mock ERC20), then drive the exact same
  // build-tx -> sign -> broadcast path apps/api's /v1/withdrawals/build-tx
  // and apps/relayer's WITHDRAW_PUBLIC_SUBMIT use. This is the strongest
  // check available short of running the actual HTTP services: it proves
  // SHIELDED_POOL_ABI's withdraw() tuple/array encoding matches what the
  // compiled contract actually expects (a subtle spot for bugs — struct and
  // fixed-array ABI encoding errors don't show up as TS type errors).
  // ============================================================
  await testWithdrawFullLoop(network, provider, deployer, admin);

  finish();
}

function addressHash(address: string): bigint {
  const addrBytes = Buffer.from(address.slice(2), "hex");
  const hash = createHash("sha256").update(addrBytes).digest();
  return BigInt("0x" + hash.toString("hex")) >> 8n;
}

/** Mirrors ShieldedPool.sol's `_hashToFieldU`: sha256(bytes32(value)) >> 8. */
function hashToField(value: bigint): bigint {
  const hex = value.toString(16).padStart(64, "0");
  const hash = createHash("sha256").update(Buffer.from(hex, "hex")).digest();
  return BigInt("0x" + hash.toString("hex")) >> 8n;
}

function loadArtifact(relPath: string): { abi: unknown; bytecode: string } {
  const p = resolve(SHADE_ROOT, "contracts/arc/out", relPath);
  const j = JSON.parse(readFileSync(p, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

async function testWithdrawFullLoop(network: Network, provider: JsonRpcProvider, deployer: Wallet, admin: Wallet) {
  const requiredArtifacts = [
    "ShieldedPool.sol/ShieldedPool.json",
    "MockVerifiers.sol/MockVerifier.json",
    "MockERC20.sol/MockERC20.json",
  ];
  for (const rel of requiredArtifacts) {
    if (!existsSync(resolve(SHADE_ROOT, "contracts/arc/out", rel))) {
      check("withdraw full-loop artifacts exist", false, `missing ${rel} — run: cd contracts/arc && forge build`);
      return;
    }
  }

  // Manual nonce tracking: automatic "pending"-nonce resolution proved
  // unreliable for this rapid sequential-deploy sequence against local anvil
  // (intermittent "nonce too low" a few calls in, even fully awaited). Explicit
  // per-wallet counters, incremented only after each tx is confirmed mined,
  // remove the ambiguity regardless of the underlying provider timing quirk.
  let deployerNonce = await provider.getTransactionCount(deployer.address, "latest");
  let adminNonce = await provider.getTransactionCount(admin.address, "latest");

  // Poseidon2 (same raw bytecode used by the Foundry tests and Deploy.s.sol)
  const poseidonBytecode = readFileSync(resolve(SHADE_ROOT, "contracts/arc/test/poseidon2.bin"), "utf8").trim();
  const poseidonTx = await deployer.sendTransaction({ data: poseidonBytecode, nonce: deployerNonce++ });
  const poseidonReceipt = await poseidonTx.wait();
  const poseidonAddress = poseidonReceipt!.contractAddress!;

  const nullRegArtifact = loadArtifact("NullifierRegistry.sol/NullifierRegistry.json");
  const nullRegFactory = new ContractFactory(nullRegArtifact.abi as any, nullRegArtifact.bytecode, deployer);
  const nullReg = await nullRegFactory.deploy(admin.address, { nonce: deployerNonce++ });
  await nullReg.waitForDeployment();

  const poolArtifact = loadArtifact("ShieldedPool.sol/ShieldedPool.json");
  const poolFactory = new ContractFactory(poolArtifact.abi as any, poolArtifact.bytecode, admin);
  const POOL_ID = 1n;
  const CHAIN_ID = 42n;
  const pool = await poolFactory.deploy(admin.address, await nullReg.getAddress(), POOL_ID, CHAIN_ID, 12, poseidonAddress, { nonce: adminNonce++ });
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();

  const mockVerifierArtifact = loadArtifact("MockVerifiers.sol/MockVerifier.json");
  const mockVerifierFactory = new ContractFactory(mockVerifierArtifact.abi as any, mockVerifierArtifact.bytecode, admin);
  const mockVerifier = await mockVerifierFactory.deploy({ nonce: adminNonce++ });
  await mockVerifier.waitForDeployment();

  // a trivial mock ERC20: reuse the Foundry test mock (test/mocks/MockERC20.sol).
  const mockErc20Artifact = loadArtifact("MockERC20.sol/MockERC20.json");
  const mockErc20Factory = new ContractFactory(mockErc20Artifact.abi as any, mockErc20Artifact.bytecode, admin);
  const usdc = await mockErc20Factory.deploy({ nonce: adminNonce++ });
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();

  // wire everything directly via the admin wallet with explicit nonces
  // (arcInvoke's own "pending"-based resolution has the same reliability
  // issue in this rapid-fire sequence, so it's sidestepped here too).
  await ((await (nullReg.connect(admin) as any).setAuthorizedSpender(poolAddress, true, { nonce: adminNonce++ })) as any).wait();
  const usdcAssetId = addressHash(usdcAddress);
  await ((await (pool.connect(admin) as any).registerAsset(usdcAssetId, usdcAddress, { nonce: adminNonce++ })) as any).wait();
  await ((await (pool.connect(admin) as any).setWithdrawVerifier(await mockVerifier.getAddress(), { nonce: adminNonce++ })) as any).wait();
  await ((await (pool.connect(admin) as any).setDepositVerifier(await mockVerifier.getAddress(), { nonce: adminNonce++ })) as any).wait();
  const ASSOC_ROOT = 0xa550cn;
  await ((await (pool.connect(admin) as any).setAssociationRoot(ASSOC_ROOT, { nonce: adminNonce++ })) as any).wait();
  await ((await (usdc.connect(admin) as any).mint(poolAddress, 1_000_000n, { nonce: adminNonce++ })) as any).wait();

  check("ShieldedPool withdraw-flow deployment wired", true, poolAddress);

  // Seed the pool's note supply for usdcAssetId via a (mock-verified) deposit
  // BEFORE attempting a withdraw — withdraw decrements noteSupplyOf and
  // reverts SupplyUnderflow if nothing was ever deposited, exactly like the
  // real protocol requires a real deposit before any note can be spent.
  const withdrawnValue = 1000n;
  // depositCommitment is inserted as a tree leaf, so it must be a valid BN254
  // field element (< ~2^254) — NOT an arbitrary 32-byte value like a hash's
  // raw bytes, which routinely exceed the field and get rejected ("leaf >=
  // field"). cctpNonce stays a raw bytes32 since it's only ever sha256-reduced
  // via hashToField before use, which always yields a valid field element
  // regardless of its input.
  const depositCommitment = 123456789012345678901234567890n;
  const cctpNonce = "0x" + "dd".repeat(32);
  const depositPub: string[] = new Array(14).fill("0");
  depositPub[0] = depositCommitment.toString();
  depositPub[1] = "4"; // OP_DEPOSIT_NOTE_MINT
  depositPub[2] = "3"; // sourceDomain
  depositPub[4] = hashToField(BigInt(cctpNonce)).toString();
  depositPub[5] = "1"; // burnTxHashHash (non-zero)
  depositPub[6] = "101"; // amount6dp: *10 >= amount7dp
  depositPub[7] = withdrawnValue.toString(); // amount7dp
  depositPub[8] = addressHash(usdcAddress).toString();
  depositPub[9] = addressHash(poolAddress).toString();
  depositPub[10] = hashToField(1n).toString();
  depositPub[11] = hashToField(1n).toString();
  depositPub[12] = POOL_ID.toString();
  depositPub[13] = CHAIN_ID.toString();
  const zeroProof = { a: ["0", "0"] as [string, string], b: [["0", "0"], ["0", "0"]] as [[string, string], [string, string]], c: ["0", "0"] as [string, string] };
  await ((await (pool.connect(admin) as any).receiveDeposit(
    3, cctpNonce, usdcAddress, withdrawnValue, depositCommitment, 1n, 1n, zeroProof, depositPub,
    { nonce: adminNonce++ }
  )) as any).wait();
  check("deposit seeds note supply before withdraw", true, `noteSupply=${await (pool as any).noteSupply(usdcAssetId)}`);

  // build a valid withdraw public-signals array (mock verifier accepts any proof,
  // so the ONLY thing under test here is whether the ABI-encoded call matches
  // what the real contract's withdraw() actually decodes and checks).
  const relayerFee = 50n;
  const deadline = (await provider.getBlockNumber()) + 1000;
  const pub: string[] = new Array(18).fill("0");
  pub[0] = "0x" + "aa".repeat(32); // nullifierHash (arbitrary; mock verifier doesn't check it)
  pub[1] = "1"; // OP_WITHDRAW_PUBLIC
  pub[2] = withdrawnValue.toString();
  pub[3] = addressHash(deployer.address).toString(); // recipientHash must match `to`
  pub[4] = relayerFee.toString();
  pub[5] = deadline.toString();
  pub[7] = ASSOC_ROOT.toString();
  pub[8] = POOL_ID.toString();
  pub[9] = CHAIN_ID.toString();
  pub[17] = usdcAssetId.toString();

  // stateRoot IS checked against isKnownRoot on-chain (not by the mock
  // verifier) — bind it to the pool's actual current root, which now
  // includes the deposit leaf inserted just above.
  const currentRoot: bigint = await (pool as any).getRoot();
  pub[6] = currentRoot.toString();

  const proof = { a: ["0", "0"] as [string, string], b: [["0", "0"], ["0", "0"]] as [[string, string], [string, string]], c: ["0", "0"] as [string, string] };

  const unsignedTx = await buildUnsignedTx({
    network,
    from: deployer.address,
    contractAddress: poolAddress,
    abi: SHIELDED_POOL_ABI,
    method: "withdraw",
    params: withdrawArgs(deployer.address, proof, pub),
  });
  const serialized = serializeUnsignedTx(unsignedTx);
  check("withdraw unsigned tx serializes to JSON-safe object", JSON.stringify(serialized).length > 0);

  const balBefore: bigint = await (usdc as any).balanceOf(deployer.address);
  const signedRawTx = await deployer.signTransaction(unsignedTx);
  const result = await broadcastSignedTx(network, signedRawTx);
  check("real withdraw() settles via build-tx -> sign -> broadcast path", result.status === "SUCCESS", result.hash);

  const balAfter: bigint = await (usdc as any).balanceOf(deployer.address);
  check("recipient received withdrawnValue - relayerFee", balAfter - balBefore === withdrawnValue - relayerFee, `${balAfter - balBefore}`);

  const spent: boolean = await (nullReg as any).isSpent(pub[0]);
  check("withdraw nullifier spent on the shared registry", spent === true);
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
