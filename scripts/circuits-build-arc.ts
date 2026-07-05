import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beginReport, writeCheckReport, failIfAny, type CheckResult } from "../apps/cli/src/lib/report.js";

// BN254 Circom build pipeline for Arc/EVM.
// Compiles every Shade Arc circuit to r1cs+wasm, runs the Groth16 trusted setup (using BN254 ptau),
// exports Solidity verifiers, and prepares witness generation.
// Idempotent: skips setup if output/main_final.zkey already exists
// (rerun with CIRCUITS_FORCE_SETUP=1 to regenerate keys).

const SHADE_ROOT = process.env.SHADE_ROOT ?? process.cwd();
const CIRCUITS_DIR = resolve(SHADE_ROOT, "circuits");
// Per-circuit ptau: small circuits use pot14 (16384 constraints); the MPC
// circuits have ~24k constraints and need pot15 (32768). Resolve by preferred
// power, falling back to whatever exists.
function ptauFor(minPower: number): string {
  const candidates = [15, 16].filter((p) => p >= minPower).concat([minPower]);
  for (const p of [minPower, ...candidates]) {
    const path = resolve(SHADE_ROOT, `.zk-ref/circuits/pot${p}_bn254_final.ptau`);
    if (existsSync(path)) return path;
  }
  // default
  return resolve(SHADE_ROOT, `.zk-ref/circuits/pot${minPower}_bn254_final.ptau`);
}
const FORCE = process.env.CIRCUITS_FORCE_SETUP === "1";

// circom binary: prefer CIRCOM_BIN env, then PATH, then temp download location.
const CIRCOM_BIN =
  process.env.CIRCOM_BIN ??
  (existsSync("C:/Users/clats/AppData/Local/Temp/circom.exe")
    ? "C:/Users/clats/AppData/Local/Temp/circom.exe"
    : "circom");

// BN254 circuits (Phase 1-2). nPublic = declared public inputs + public outputs.
// minPower = smallest 2^k >= constraint count (private/withdraw/deposit fit pot14;
// MPC circuits ~24k constraints need pot15).
const CIRCUITS: { name: string; nPublic: number; minPower: number }[] = [
  { name: "private_transfer_bn254",       nPublic: 9,  minPower: 14 },
  { name: "withdraw_public_bn254",        nPublic: 18, minPower: 14 },
  { name: "deposit_note_mint_bn254",      nPublic: 14, minPower: 14 },
  { name: "mpc_settlement_bn254",         nPublic: 12, minPower: 15 },
  { name: "mpc_priced_settlement_bn254",  nPublic: 20, minPower: 15 },
  { name: "stream_open_bn254",            nPublic: 13, minPower: 14 }, // 1 out + 12 in
  { name: "stream_settle_bn254",          nPublic: 11, minPower: 14 }, // 2 out + 9 in
];

const checks: CheckResult[] = [];
const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
const PATH_VAR = home
  ? `${home}/.cargo/bin:${process.env.PATH ?? ""}`
  : (process.env.PATH ?? "");
const env = { ...process.env, PATH: PATH_VAR, NODE_OPTIONS: "--max-old-space-size=8192" };

function circomlibPath(): string {
  // Try to find circomlib in node_modules first
  const localPath = resolve(SHADE_ROOT, "node_modules/circomlib/circuits");
  if (existsSync(localPath)) {
    return localPath;
  }

  // Fallback to global npm installation
  const r = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: true });
  const root = r.stdout?.trim();
  if (root && existsSync(resolve(root, "circomlib/circuits"))) {
    return resolve(root, "circomlib/circuits");
  }
  return "";
}

{
  const CIRCOMLIB = circomlibPath();
  if (!CIRCOMLIB) {
    checks.push({ name: "circomlib", ok: false, detail: "circomlib not found in node_modules or global npm — run: npm install -D circomlib" });
  } else {
    checks.push({ name: "circomlib", ok: true, detail: CIRCOMLIB });
    const libArgs = ["-l", ".", "-l", CIRCOMLIB];

    for (const c of CIRCUITS) {
      const dir = resolve(CIRCUITS_DIR, c.name);
      if (!existsSync(dir)) {
        checks.push({ name: `circuit ${c.name}`, ok: false, detail: `directory not found: ${dir}` });
        continue;
      }
      try {
        mkdirSync(resolve(dir, "build"), { recursive: true });
        mkdirSync(resolve(dir, "output"), { recursive: true });

        const PTAU = ptauFor(c.minPower);
        if (!existsSync(PTAU)) {
          checks.push({ name: `circuit ${c.name}`, ok: false, detail: `missing ptau ${PTAU} (need power >= ${c.minPower}) — generate with: snarkjs powersoftau new bn128 ${c.minPower} ...` });
          continue;
        }

        // Compile circom -> r1cs + wasm (BN254 is the default prime, no --prime flag needed)
        execFileSync(
          CIRCOM_BIN,
          ["main.circom", "--r1cs", "--wasm", "--sym", "-o", "build", ...libArgs],
          { cwd: dir, env, shell: true }
        );

        // The witness generator is already built as part of the wasm output
        // No separate build step needed for the JS witness generator

        // Trusted setup: generate zkey (reuse if exists and not forcing)
        const zkeyPath = resolve(dir, "output/main_final.zkey");
        if (!existsSync(zkeyPath) || FORCE) {
          // Phase 1
          execFileSync(
            "node",
            [
              resolve(SHADE_ROOT, "node_modules/snarkjs/cli.js"),
              "zkey",
              "new",
              resolve(dir, "build/main.r1cs"),
              PTAU,
              resolve(dir, "output/main_0000.zkey"),
            ],
            { env }
          );
          // Phase 2 (dummy entropy for testnet)
          execFileSync(
            "node",
            [
              resolve(SHADE_ROOT, "node_modules/snarkjs/cli.js"),
              "zkey",
              "beacon",
              resolve(dir, "output/main_0000.zkey"),
              resolve(dir, "output/main_final.zkey"),
              "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
              "10",
            ],
            { env }
          );
        }

        // Export Solidity verifier (BN254 is native to Solidity precompiles)
        execFileSync(
          "node",
          [
            resolve(SHADE_ROOT, "node_modules/snarkjs/cli.js"),
            "zkey",
            "export",
            "solidityverifier",
            resolve(dir, "output/main_final.zkey"),
            resolve(dir, "output/Verifier.sol"),
          ],
          { env }
        );

        checks.push({ name: `circuit ${c.name}`, ok: true, detail: `compiled to ${dir}/output` });
      } catch (e: unknown) {
        checks.push({ name: `circuit ${c.name}`, ok: false, detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
      }
    }
  }
}

await writeCheckReport("circuits:build:arc", checks);
for (const c of checks) {
  console.log(c.ok ? "PASS" : "FAIL", c.name, "-", c.detail);
}
failIfAny(checks);
