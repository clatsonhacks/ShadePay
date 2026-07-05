// Phase 1 BN254 circuit test: builds a real witness for private_transfer_bn254
// using circomlibjs Poseidon (TS-native, no stellar-coinutils binary), generates
// a Groth16 proof, and verifies it locally. Also emits Solidity calldata + a
// tampered variant for the on-chain Foundry verifier test.
//
// Pass criteria (mirrors the BLS12-381 spike in docs/zk-proof-system.md):
//   - valid proof verifies locally: TRUE
//   - tampered public signal fails local verify: FALSE

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-ignore - snarkjs ships no type declarations
import * as snarkjs from "snarkjs";
// @ts-ignore - circomlibjs has no types
import { buildPoseidon } from "circomlibjs";

const SHADE_ROOT = process.env.SHADE_ROOT ?? process.cwd();
const CIRCUIT_DIR = resolve(SHADE_ROOT, "circuits/private_transfer_bn254");
const WASM = resolve(CIRCUIT_DIR, "build/main_js/main.wasm");
const ZKEY = resolve(CIRCUIT_DIR, "output/main_final.zkey");
const OUT_DIR = resolve(CIRCUIT_DIR, "output");

interface CheckResult { name: string; ok: boolean; detail: string; }
const results: CheckResult[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(ok ? "PASS" : "FAIL", name, detail ? `- ${detail}` : "");
}

const TREE_DEPTH = 12;
const ASSOC_DEPTH = 2;
const POOL_ID = 1n;
const CHAIN_ID = 42n;

async function main() {
  if (!existsSync(WASM) || !existsSync(ZKEY)) {
    check("circuit built", false, "run: npm run circuits:build:arc");
    finish();
    return;
  }
  check("circuit built", true, "wasm + zkey present");

  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const H = (arr: bigint[]) => F.toObject(poseidon(arr)) as bigint;

  // ---- build input note ----
  const inputAssetId = 111n;
  const inValue = 1000n;
  const inLabel = 7n;
  const inNullifier = 12345n;
  const inSecret = 67890n;

  // CommitmentHasher: commitment = Poseidon(Poseidon(assetId,value,label), Poseidon(nullifier,secret))
  const inPre = H([inNullifier, inSecret]);
  const inAVL = H([inputAssetId, inValue, inLabel]);
  const inCommitment = H([inAVL, inPre]);

  // ---- state tree (depth 12): commitment at index 0, rest zero ----
  // zeros[i]: z0=0, z(i)=Poseidon(z(i-1),z(i-1))
  const zeros: bigint[] = [0n];
  for (let i = 1; i <= TREE_DEPTH; i++) zeros.push(H([zeros[i - 1], zeros[i - 1]]));

  // leaf at index 0, all siblings are zeros of the corresponding level.
  const stateSiblings: bigint[] = [];
  let node = inCommitment;
  for (let i = 0; i < TREE_DEPTH; i++) {
    stateSiblings.push(zeros[i]);
    node = H([node, zeros[i]]); // index 0 => node is always left child
  }
  const stateRoot = node;

  // ---- association tree (depth 2): label at index 0 ----
  const labelSiblings: bigint[] = [];
  let anode = inLabel;
  for (let i = 0; i < ASSOC_DEPTH; i++) {
    labelSiblings.push(zeros[i]);
    anode = H([anode, zeros[i]]);
  }
  const associationRoot = anode;

  // ---- output note ----
  const outputAssetId = inputAssetId; // same-asset transfer
  const feePublic = 100n;
  const outValue = inValue - feePublic; // value conservation
  const outLabel = 9n;
  const outNullifier = 54321n;
  const outSecret = 98765n;
  const outPre = H([outNullifier, outSecret]);
  const outAVL = H([outputAssetId, outValue, outLabel]);
  const outputCommitment = H([outAVL, outPre]);

  const nullifierHash = H([inNullifier, POOL_ID, CHAIN_ID]);

  const input = {
    outputCommitment: outputCommitment.toString(),
    feePublic: feePublic.toString(),
    stateRoot: stateRoot.toString(),
    associationRoot: associationRoot.toString(),
    poolId: POOL_ID.toString(),
    chainId: CHAIN_ID.toString(),
    inputAssetId: inputAssetId.toString(),
    outputAssetId: outputAssetId.toString(),
    inValue: inValue.toString(),
    inLabel: inLabel.toString(),
    inNullifier: inNullifier.toString(),
    inSecret: inSecret.toString(),
    stateSiblings: stateSiblings.map((s) => s.toString()),
    stateIndex: "0",
    labelIndex: "0",
    labelSiblings: labelSiblings.map((s) => s.toString()),
    outValue: outValue.toString(),
    outLabel: outLabel.toString(),
    outNullifier: outNullifier.toString(),
    outSecret: outSecret.toString(),
  };

  // ---- prove ----
  let proof: any, publicSignals: string[];
  try {
    const r = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    proof = r.proof;
    publicSignals = r.publicSignals;
    check("witness + proof generation", true, `${publicSignals.length} public signals`);
  } catch (e) {
    check("witness + proof generation", false, String(e).slice(0, 300));
    finish();
    return;
  }

  // publicSignals[0] should be nullifierHash (circuit output first)
  check(
    "nullifierHash matches computed",
    BigInt(publicSignals[0]) === nullifierHash,
    `${publicSignals[0]}`
  );

  // ---- local verify (valid) ----
  const vkey = JSON.parse(
    execFileSync(
      "node",
      [resolve(SHADE_ROOT, "node_modules/snarkjs/cli.js"), "zkey", "export", "verificationkey", ZKEY, resolve(OUT_DIR, "vkey.json")],
      { encoding: "utf8" }
    ) ? readFileSync(resolve(OUT_DIR, "vkey.json"), "utf8") : "{}"
  );

  const okValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  check("valid proof verifies (local)", okValid === true, `verify=${okValid}`);

  // ---- tamper a public signal (flip outputCommitment) ----
  const tampered = [...publicSignals];
  tampered[1] = (BigInt(tampered[1]) ^ 1n).toString(); // flip a bit in outputCommitment
  const okTampered = await snarkjs.groth16.verify(vkey, tampered, proof);
  check("tampered proof rejected (local)", okTampered === false, `verify=${okTampered}`);

  // ---- emit Foundry-parseable calldata for the on-chain verifier test ----
  // exportSolidityCallData does the G2 coordinate swap for us. Parse it into
  // decimal-string arrays the Foundry test reads via vm.parseJsonUintArray.
  const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const [a, b, c, inputArr] = JSON.parse(`[${calldata}]`) as [string[], string[][], string[], string[]];
  const toDec = (h: string) => BigInt(h).toString();
  const foundryJson = {
    a: a.map(toDec),
    b: b.map((row) => row.map(toDec)),
    c: c.map(toDec),
    input: inputArr.map(toDec),
  };
  writeFileSync(resolve(OUT_DIR, "proof.json"), JSON.stringify(proof, null, 2));
  writeFileSync(resolve(OUT_DIR, "public.json"), JSON.stringify(publicSignals, null, 2));
  writeFileSync(resolve(OUT_DIR, "calldata.json"), JSON.stringify(foundryJson, null, 2));
  // scenario file for the pool integration test: the private input commitment
  // (so the pool tree can be seeded to reproduce the circuit's stateRoot) + domain.
  writeFileSync(
    resolve(OUT_DIR, "transfer_scenario.json"),
    JSON.stringify(
      {
        inCommitment: inCommitment.toString(),
        stateRoot: stateRoot.toString(),
        associationRoot: associationRoot.toString(),
        poolId: POOL_ID.toString(),
        chainId: CHAIN_ID.toString(),
        ...foundryJson,
      },
      null,
      2
    )
  );
  check("solidity calldata emitted", true, "output/calldata.json + transfer_scenario.json");

  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
  // snarkjs keeps worker threads alive; force clean exit.
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
