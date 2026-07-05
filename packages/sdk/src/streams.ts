// Shade Streams — off-chain payment-channel voucher SDK.
//
// A payer holds an EdDSA (Baby Jubjub) private key. Each voucher authorizes a
// cumulative payment amount on a channel; the payee collects vouchers and later
// submits the highest one on-chain. The voucher message is
//
//   M = Poseidon(channelId, cumulative, seq)
//
// signed with EdDSA-Poseidon. A circom circuit's `EdDSAPoseidonVerifier`
// recomputes M and verifies the signature on-chain, so the field ordering and
// hashing here MUST match the circuit exactly.

// @ts-ignore - circomlibjs has no types
import { buildEddsa, buildPoseidon } from "circomlibjs";
import { randomBytes } from "node:crypto";

export type EddsaKeypair = { prvKey: Uint8Array; Ax: bigint; Ay: bigint };

export type Voucher = {
  channelId: bigint;
  cumulative: bigint; // monotonically increasing across a channel's vouchers, must be <= channel cap
  seq: number; // strictly increasing sequence number
  // EdDSA-Poseidon signature over M = Poseidon(channelId, cumulative, seq):
  R8x: bigint;
  R8y: bigint;
  S: bigint;
  // the payer's public key the signature verifies against:
  Ax: bigint;
  Ay: bigint;
};

// Lazy singletons — build the (expensive) circomlibjs instances once and reuse.
let eddsaPromise: Promise<any> | null = null;
function getEddsa(): Promise<any> {
  if (!eddsaPromise) eddsaPromise = buildEddsa();
  return eddsaPromise as Promise<any>;
}

let poseidonPromise: Promise<any> | null = null;
function getPoseidon(): Promise<any> {
  if (!poseidonPromise) poseidonPromise = buildPoseidon();
  return poseidonPromise as Promise<any>;
}

/**
 * Generate a fresh Baby Jubjub EdDSA keypair for a payer. Pass an optional
 * 32-byte seed for deterministic keys in tests; otherwise a random 32-byte
 * private key is used.
 */
export async function generatePayerKey(seed?: Uint8Array): Promise<EddsaKeypair> {
  const eddsa = await getEddsa();
  const F = eddsa.F;
  const prvKey = seed ? Uint8Array.from(seed) : new Uint8Array(randomBytes(32));
  if (prvKey.length !== 32) throw new Error("EdDSA private key seed must be exactly 32 bytes");
  const pub = eddsa.prv2pub(prvKey);
  return {
    prvKey,
    Ax: F.toObject(pub[0]) as bigint,
    Ay: F.toObject(pub[1]) as bigint,
  };
}

/** Compute the voucher message field element M = Poseidon(channelId, cumulative, seq). */
export async function voucherMessage(channelId: bigint, cumulative: bigint, seq: number): Promise<bigint> {
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  const msg = poseidon([channelId, cumulative, BigInt(seq)]);
  return F.toObject(msg) as bigint;
}

/** Sign a voucher with the payer's key. Returns a fully-populated Voucher. */
export async function signVoucher(
  key: EddsaKeypair,
  channelId: bigint,
  cumulative: bigint,
  seq: number
): Promise<Voucher> {
  const eddsa = await getEddsa();
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  // Poseidon must be computed with the SAME field instance the signer expects.
  // circomlibjs' eddsa and poseidon share the BN254 field, so the internal
  // (Montgomery) message element from poseidon feeds straight into signPoseidon.
  const msg = poseidon([channelId, cumulative, BigInt(seq)]);
  const sig = eddsa.signPoseidon(key.prvKey, msg);
  return {
    channelId,
    cumulative,
    seq,
    R8x: F.toObject(sig.R8[0]) as bigint,
    R8y: F.toObject(sig.R8[1]) as bigint,
    S: sig.S as bigint,
    Ax: key.Ax,
    Ay: key.Ay,
  };
}

/** Verify a voucher's signature against the Ax/Ay embedded in it. */
export async function verifyVoucher(voucher: Voucher): Promise<boolean> {
  const eddsa = await getEddsa();
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  const msg = poseidon([voucher.channelId, voucher.cumulative, BigInt(voucher.seq)]);
  const pub = [F.e(voucher.Ax), F.e(voucher.Ay)];
  const sig = {
    R8: [F.e(voucher.R8x), F.e(voucher.R8y)],
    S: voucher.S,
  };
  return eddsa.verifyPoseidon(msg, sig, pub) as boolean;
}

/**
 * Given an array of vouchers (possibly out of order, possibly for the same
 * channel), return the one with the greatest `cumulative` — the payee always
 * settles the highest. Returns undefined for an empty array.
 */
export function highestVoucher(vouchers: Voucher[]): Voucher | undefined {
  let best: Voucher | undefined;
  for (const v of vouchers) {
    if (best === undefined || v.cumulative > best.cumulative) best = v;
  }
  return best;
}
