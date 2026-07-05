// TS-native coin (shielded note) generation for the BN254/Arc path — replaces
// the Rust `stellar-coinutils generate` binary. A coin is the private opening
// of a note commitment: {value, assetId, label, nullifier, secret}.

import { randomBytes } from "node:crypto";
import { BN254_FIELD_MODULUS, commitmentHasher } from "./poseidon.js";

/**
 * A random field element well under the BN254 scalar field modulus. Uses 31
 * random bytes (248 bits < ~254-bit modulus), matching the same convention
 * used elsewhere in this codebase (recipientHashField, hashToField) for
 * hash-to-field reductions.
 */
export function randomFieldElement(): bigint {
  const v = BigInt("0x" + randomBytes(31).toString("hex"));
  return v % BN254_FIELD_MODULUS;
}

export type Bn254Coin = {
  value: bigint;
  assetId: bigint;
  label: bigint;
  nullifier: bigint;
  secret: bigint;
  commitment: bigint;
  nullifierHash: bigint;
};

/**
 * Generate a new coin (shielded note opening) for `value` of `assetId`.
 * `label` defaults to a fresh random field element (the ASP allow-tree binds
 * on this value); pass an explicit label to reuse the same spender identity
 * across multiple coins.
 */
export async function generateCoinBn254(value: bigint, assetId: bigint, label?: bigint): Promise<Bn254Coin> {
  const nullifier = randomFieldElement();
  const secret = randomFieldElement();
  const lbl = label ?? randomFieldElement();
  const { commitment, nullifierHash } = await commitmentHasher(assetId, value, lbl, nullifier, secret);
  return { value, assetId, label: lbl, nullifier, secret, commitment, nullifierHash };
}
