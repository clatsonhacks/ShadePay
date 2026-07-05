// Copies each snarkjs-generated Verifier.sol into contracts/arc/src/verifiers/
// with the contract renamed to match the interface the pool imports
// (TransferVerifier, WithdrawVerifier, DepositVerifier, MpcSettlementVerifier,
// MpcPricedSettlementVerifier). Run after `npm run circuits:build:arc`.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const SHADE_ROOT = process.env.SHADE_ROOT ?? process.cwd();
const OUT = resolve(SHADE_ROOT, "contracts/arc/src/verifiers");
mkdirSync(OUT, { recursive: true });

const MAP: { circuit: string; contract: string; file: string }[] = [
  { circuit: "private_transfer_bn254",      contract: "TransferVerifier",           file: "TransferVerifier.sol" },
  { circuit: "withdraw_public_bn254",       contract: "WithdrawVerifier",           file: "WithdrawVerifier.sol" },
  { circuit: "deposit_note_mint_bn254",     contract: "DepositVerifier",            file: "DepositVerifier.sol" },
  { circuit: "mpc_settlement_bn254",        contract: "MpcSettlementVerifier",      file: "MpcSettlementVerifier.sol" },
  { circuit: "mpc_priced_settlement_bn254", contract: "MpcPricedSettlementVerifier", file: "MpcPricedSettlementVerifier.sol" },
];

let ok = 0;
for (const m of MAP) {
  const src = resolve(SHADE_ROOT, "circuits", m.circuit, "output/Verifier.sol");
  if (!existsSync(src)) {
    console.log("SKIP", m.circuit, "- Verifier.sol not found (run circuits:build:arc)");
    continue;
  }
  let code = readFileSync(src, "utf8");
  code = code.replace(/contract Groth16Verifier/g, `contract ${m.contract}`);
  writeFileSync(resolve(OUT, m.file), code);
  console.log("PASS", m.circuit, "->", m.file, `(contract ${m.contract})`);
  ok++;
}
console.log(`\n${ok}/${MAP.length} verifiers synced`);
if (ok < MAP.length) process.exit(1);
