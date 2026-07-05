// Validates the x402 voucher-gating middleware (apps/api/src/x402.ts) with real
// vouchers signed via @shade/sdk and a stub channel lookup. Run via:
// npm run x402:test

import { generatePayerKey, signVoucher } from "@shade/sdk";
import {
  checkX402,
  parseVoucherHeader,
  serializeVoucherHeader,
  type ChannelInfo,
} from "./x402.js";

type CheckResult = { name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(ok ? "PASS" : "FAIL", name, detail ? `- ${detail}` : "");
}

const INSTRUCTIONS = { escrow: "0xEsc0000000000000000000000000000000000000", ratePerCall: "10" };

async function main() {
  const payer = await generatePayerKey(Buffer.from("22".repeat(32), "hex"));
  const other = await generatePayerKey(Buffer.from("33".repeat(32), "hex"));

  const CHANNEL_ID = 555n;
  const CAP = 1000n;
  const openChannel: ChannelInfo = { cap: CAP, payerAx: payer.Ax, payerAy: payer.Ay, consumed: false, expiryBlock: 1_000_000n };
  const lookupOpen = async (id: bigint) => (id === CHANNEL_ID ? openChannel : undefined);

  // 1) no voucher -> 402 with instructions
  {
    const r = await checkX402(undefined, { requiredCumulative: 100n, lookupChannel: lookupOpen, paymentInstructions: INSTRUCTIONS });
    check("no voucher -> 402 payment required", !r.ok && r.status === 402 && r.body.error === "payment required" && r.body.escrow === INSTRUCTIONS.escrow);
  }

  // 2) header round-trip
  {
    const v = await signVoucher(payer, CHANNEL_ID, 300n, 1);
    const parsed = parseVoucherHeader(serializeVoucherHeader(v));
    const eq = !!parsed && parsed.channelId === v.channelId && parsed.cumulative === v.cumulative &&
      parsed.seq === v.seq && parsed.R8x === v.R8x && parsed.R8y === v.R8y && parsed.S === v.S &&
      parsed.Ax === v.Ax && parsed.Ay === v.Ay;
    check("voucher header round-trips exactly", eq);
  }

  // 3) malformed headers -> undefined
  check("parseVoucherHeader(undefined) -> undefined", parseVoucherHeader(undefined) === undefined);
  check("parseVoucherHeader(garbage) -> undefined", parseVoucherHeader("not-valid-base64-@@") === undefined);

  // 4) valid voucher, cumulative >= required -> ok
  {
    const v = await signVoucher(payer, CHANNEL_ID, 500n, 2);
    const r = await checkX402(v, { requiredCumulative: 100n, lookupChannel: lookupOpen, paymentInstructions: INSTRUCTIONS });
    check("valid voucher (cumulative >= required) -> ok", r.ok === true);
  }

  // 5) channel not open -> 402
  {
    const v = await signVoucher(payer, 999n, 500n, 1); // no such channel
    const r = await checkX402(v, { requiredCumulative: 100n, lookupChannel: lookupOpen, paymentInstructions: INSTRUCTIONS });
    check("unknown channel -> 402 channel not open", !r.ok && r.status === 402 && r.body.error === "channel not open");
  }

  // 6) consumed channel -> 403
  {
    const consumed: ChannelInfo = { ...openChannel, consumed: true };
    const v = await signVoucher(payer, CHANNEL_ID, 500n, 1);
    const r = await checkX402(v, { requiredCumulative: 100n, lookupChannel: async () => consumed, paymentInstructions: INSTRUCTIONS });
    check("consumed channel -> 403", !r.ok && r.status === 403 && r.body.error === "channel already settled or reclaimed");
  }

  // 7) expired channel -> 403
  {
    const v = await signVoucher(payer, CHANNEL_ID, 500n, 1);
    const r = await checkX402(v, {
      requiredCumulative: 100n, lookupChannel: lookupOpen,
      currentBlock: async () => 2_000_000n, // > expiryBlock 1_000_000
      paymentInstructions: INSTRUCTIONS,
    });
    check("expired channel -> 403", !r.ok && r.status === 403 && r.body.error === "channel expired");
  }

  // 8) voucher signed by a different key than the channel's payer -> 403
  {
    const v = await signVoucher(other, CHANNEL_ID, 500n, 1); // signed by `other`, channel payer is `payer`
    const r = await checkX402(v, { requiredCumulative: 100n, lookupChannel: lookupOpen, paymentInstructions: INSTRUCTIONS });
    check("wrong signer -> 403 not signed by channel payer", !r.ok && r.status === 403 && r.body.error === "voucher not signed by channel payer");
  }

  // 9) over-cap voucher -> 403
  {
    const v = await signVoucher(payer, CHANNEL_ID, 5000n, 1); // > cap 1000
    const r = await checkX402(v, { requiredCumulative: 100n, lookupChannel: lookupOpen, paymentInstructions: INSTRUCTIONS });
    check("over-cap voucher -> 403 exceeds cap", !r.ok && r.status === 403 && r.body.error === "voucher exceeds channel cap");
  }

  // 10) under-payment -> 402 insufficient with providedCumulative
  {
    const v = await signVoucher(payer, CHANNEL_ID, 50n, 1); // < required 100
    const r = await checkX402(v, { requiredCumulative: 100n, lookupChannel: lookupOpen, paymentInstructions: INSTRUCTIONS });
    check("under-payment -> 402 insufficient",
      !r.ok && r.status === 402 && r.body.error === "insufficient payment" && r.body.providedCumulative === "50");
  }

  // 11) tampered voucher (cumulative changed after signing) -> 403 invalid signature
  {
    const v = await signVoucher(payer, CHANNEL_ID, 300n, 1);
    const tampered = { ...v, cumulative: 700n }; // signature is for 300, claim 700 (still <= cap)
    const r = await checkX402(tampered, { requiredCumulative: 100n, lookupChannel: lookupOpen, paymentInstructions: INSTRUCTIONS });
    check("tampered voucher -> 403 invalid signature", !r.ok && r.status === 403 && r.body.error === "invalid voucher signature");
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
