// Validates the Shade Streams proof builders end to end with REAL Groth16
// proofs: generate a payer EdDSA key, open a channel (stream_open proof), sign
// a voucher, settle it (stream_settle proof), and confirm both verify locally.
// Also checks the value-conservation invariant and adversarial rejections.
// Run via: npm run stream-proving:test

// @ts-ignore - circomlibjs has no types
import { buildEddsa, buildPoseidon } from "circomlibjs";
import { generateCoinBn254 } from "./coin.js";
import {
  buildStreamOpenProofBn254,
  buildStreamSettleProofBn254,
  type VoucherSig,
} from "./stream.js";

type CheckResult = { name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(ok ? "PASS" : "FAIL", name, detail ? `- ${detail}` : "");
}

const POOL_ID = 1n;
const CHAIN_ID = 42n;
const USDC_ASSET = 111n;

async function main() {
  const eddsa = await buildEddsa();
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // payer EdDSA key
  const prv = Buffer.from("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20", "hex");
  const pub = eddsa.prv2pub(prv);
  const Ax = F.toObject(pub[0]) as bigint;
  const Ay = F.toObject(pub[1]) as bigint;

  // payer's input note (value 1000), plus a state tree + ASP tree
  const inCoin = await generateCoinBn254(1000n, USDC_ASSET);
  const stateLeaves = [inCoin.commitment];
  const assocLabels = [inCoin.label];

  const channelId = 777n;
  const cap = 600n;
  const expiry = 999999n;

  // ---- OPEN ----
  let openResult;
  try {
    openResult = await buildStreamOpenProofBn254({
      inCoin, stateLeaves, stateIndex: 0, assocLabels, labelIndex: 0,
      channelId, payerAx: Ax, payerAy: Ay, cap, expiry, poolId: POOL_ID, chainId: CHAIN_ID,
    });
    check("stream_open proof generated", true, `${openResult.publicSignals.length} public signals`);
    check("stream_open proof verifies locally", openResult.verified === true);
    check("stream_open change note = value - cap", openResult.changeCoin.value === inCoin.value - cap, `${openResult.changeCoin.value}`);
    check("stream_open reclaim note = cap", openResult.reclaimCoin.value === cap, `${openResult.reclaimCoin.value}`);
  } catch (e) {
    check("stream_open proof generated", false, String(e).slice(0, 300));
    return finish();
  }

  // adversarial: cap > note value must be rejected before proving.
  try {
    await buildStreamOpenProofBn254({
      inCoin, stateLeaves, stateIndex: 0, assocLabels, labelIndex: 0,
      channelId, payerAx: Ax, payerAy: Ay, cap: 5000n, expiry, poolId: POOL_ID, chainId: CHAIN_ID,
    });
    check("stream_open rejects cap > note value", false, "should have thrown");
  } catch (e) {
    check("stream_open rejects cap > note value", /cap exceeds/.test(String(e)), String(e).slice(0, 120));
  }

  // ---- STREAM: sign a voucher for cumulative=350 ----
  const cumulative = 350n;
  const seq = 3;
  const msg = poseidon([channelId, cumulative, BigInt(seq)]);
  const sig = eddsa.signPoseidon(prv, msg);
  const voucher: VoucherSig = {
    channelId, cumulative, seq,
    R8x: F.toObject(sig.R8[0]) as bigint,
    R8y: F.toObject(sig.R8[1]) as bigint,
    S: sig.S as bigint,
    Ax, Ay,
  };
  check("voucher verifies off-chain (circomlibjs)", eddsa.verifyPoseidon(msg, sig, pub) === true);

  // ---- SETTLE ----
  try {
    const settleResult = await buildStreamSettleProofBn254({
      voucher, cap, assetId: USDC_ASSET,
      associationRoot: 0n, // stream_settle binds associationRoot but doesn't Merkle-prove it; contract checks it == canonical. Use 0 for the local proof; the on-chain test sets a real one.
      poolId: POOL_ID, chainId: CHAIN_ID,
    });
    check("stream_settle proof generated", true, `${settleResult.publicSignals.length} public signals`);
    check("stream_settle proof verifies locally", settleResult.verified === true);
    check("stream_settle payee note = cumulative", settleResult.payeeCoin.value === cumulative, `${settleResult.payeeCoin.value}`);
    check("stream_settle refund note = cap - cumulative", settleResult.refundCoin.value === cap - cumulative, `${settleResult.refundCoin.value}`);
    check("value conservation: payee + refund == cap", settleResult.payeeCoin.value + settleResult.refundCoin.value === cap);
    // public signal [9] is cumulative
    check("stream_settle public cumulative matches voucher", BigInt(settleResult.publicSignals[9]) === cumulative, settleResult.publicSignals[9]);
  } catch (e) {
    check("stream_settle proof generated", false, String(e).slice(0, 300));
  }

  // adversarial: cumulative > cap rejected before proving.
  try {
    const badVoucher: VoucherSig = { ...voucher, cumulative: 900n };
    await buildStreamSettleProofBn254({ voucher: badVoucher, cap, assetId: USDC_ASSET, associationRoot: 0n, poolId: POOL_ID, chainId: CHAIN_ID });
    check("stream_settle rejects cumulative > cap", false, "should have thrown");
  } catch (e) {
    check("stream_settle rejects cumulative > cap", /exceeds channel cap/.test(String(e)), String(e).slice(0, 120));
  }

  // adversarial: a voucher whose signature doesn't match its cumulative fails
  // IN-CIRCUIT (witness generation fails) — sign for 350 but claim 400 with the
  // same signature. cumulative <= cap passes the JS guard, so this must fail at proving.
  try {
    const forged: VoucherSig = { ...voucher, cumulative: 400n }; // 400 <= 600 cap, but sig is for 350
    await buildStreamSettleProofBn254({ voucher: forged, cap, assetId: USDC_ASSET, associationRoot: 0n, poolId: POOL_ID, chainId: CHAIN_ID });
    check("stream_settle rejects forged voucher (sig/cumulative mismatch)", false, "should have failed in-circuit");
  } catch (e) {
    check("stream_settle rejects forged voucher (sig/cumulative mismatch)", true, "witness generation failed as expected");
  }

  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.error("FAILED:", failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
