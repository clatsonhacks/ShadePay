// Validates @shade/arc-actions against a REAL local anvil chain (not mocks):
// spawns anvil, deploys the actual compiled NullifierRegistry.sol, and
// exercises both the service-signed path (arcInvoke) and the user-signed
// path (buildUnsignedTx -> sign -> broadcastSignedTx) against it.
// Run via: npm run arc-actions:test (requires `forge build` to have run once
// so contracts/arc/out/NullifierRegistry.sol/NullifierRegistry.json exists).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet, Interface } from "ethers";

import { arcInvoke, buildUnsignedTx, broadcastSignedTx, type Network } from "./index.js";
import { NULLIFIER_REGISTRY_ABI } from "./abi.js";

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
