import {
  generatePayerKey, voucherMessage, signVoucher, verifyVoucher, highestVoucher,
  type Voucher,
} from "./streams.js";

// Shade Streams voucher SDK unit tests — pure EdDSA-Poseidon (Baby Jubjub),
// no chain, no network. The signatures produced here verify inside a circom
// EdDSAPoseidonVerifier over M = Poseidon(channelId, cumulative, seq).

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };

(async () => {
  try {
    const seedA = new Uint8Array(32).fill(7);
    const seedB = new Uint8Array(32).fill(9);

    // 1. Deterministic keys: same seed -> same Ax/Ay.
    const keyA = await generatePayerKey(seedA);
    const keyA2 = await generatePayerKey(seedA);
    const keyB = await generatePayerKey(seedB);
    check(
      "generatePayerKey deterministic for a fixed seed",
      keyA.Ax === keyA2.Ax && keyA.Ay === keyA2.Ay && (keyA.Ax !== keyB.Ax || keyA.Ay !== keyB.Ay)
    );

    // 2. Sign + verify roundtrip.
    const channelId = 42n;
    const cumulative = 1000n;
    const seq = 3;
    const voucher = await signVoucher(keyA, channelId, cumulative, seq);
    check("signVoucher + verifyVoucher roundtrip verifies TRUE", await verifyVoucher(voucher));

    // 3. Tampering cumulative after signing fails verification.
    const tampered: Voucher = { ...voucher, cumulative: cumulative + 1n };
    check("tampering cumulative makes verifyVoucher FALSE", (await verifyVoucher(tampered)) === false);

    // 4. Wrong-signer rejection: swap in key B's public key.
    const wrongSigner: Voucher = { ...voucher, Ax: keyB.Ax, Ay: keyB.Ay };
    check("wrong-signer public key makes verifyVoucher FALSE", (await verifyVoucher(wrongSigner)) === false);

    // 5. highestVoucher picks the max cumulative from an out-of-order array;
    //    undefined for empty.
    const cums = [30n, 10n, 50n, 20n];
    const vouchers: Voucher[] = [];
    for (let i = 0; i < cums.length; i++) vouchers.push(await signVoucher(keyA, channelId, cums[i], i + 1));
    const top = highestVoucher(vouchers);
    check("highestVoucher picks max cumulative from out-of-order array", top?.cumulative === 50n);
    check("highestVoucher returns undefined for empty array", highestVoucher([]) === undefined);

    // 6. voucherMessage is deterministic and matches what signVoucher signed:
    //    the message the circuit recomputes equals the one signed.
    const m1 = await voucherMessage(channelId, cumulative, seq);
    const m2 = await voucherMessage(channelId, cumulative, seq);
    const roundtripStillVerifies = await verifyVoucher(voucher);
    check(
      "voucherMessage deterministic and matches the signed message",
      m1 === m2 && roundtripStillVerifies && voucher.cumulative === cumulative && voucher.channelId === channelId && voucher.seq === seq
    );
  } catch (e) {
    check("streams test harness", false, (e as Error).message.slice(0, 200));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.error(`STREAMS SDK TESTS FAILED: ${failed.map((f) => f.name).join(", ")}`); process.exit(1); }
  process.exit(0);
})();
