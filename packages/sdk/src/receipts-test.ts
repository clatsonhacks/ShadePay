// Validates the pure channel-receipt reconstruction (packages/sdk/src/receipts.ts).
// The on-chain event fetch is validated against REAL events in the lifecycle test.
// Run via: npm run receipts:test

import {
  reconstructChannelReceipt,
  receiptToJson,
  type ChannelEvent,
} from "./receipts.js";

type CheckResult = { name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(ok ? "PASS" : "FAIL", name, detail ? `- ${detail}` : "");
}

function main() {
  const CID = 777n;
  const CAP = 600n;
  const openEv: ChannelEvent = { kind: "opened", channelId: CID, cap: CAP, expiry: 1000n, changeCommitment: 111n, txHash: "0xopen" };

  // 1) open-only -> state "open", gross 0, empty split
  {
    const r = reconstructChannelReceipt(CID, [openEv]);
    check("open-only receipt", r.state === "open" && r.gross === 0n && r.split.length === 0 && r.cap === CAP);
  }

  // 2) settled -> gross == cumulative, split payee/payer with conserved amounts
  {
    const settleEv: ChannelEvent = { kind: "settled", channelId: CID, cumulative: 350n, payeeCommitment: 222n, refundCommitment: 333n, txHash: "0xsettle" };
    const r = reconstructChannelReceipt(CID, [openEv, settleEv]);
    const payee = r.split.find((s) => s.recipient === "payee")!;
    const payer = r.split.find((s) => s.recipient === "payer")!;
    check("settled receipt: state + gross", r.state === "settled" && r.gross === 350n);
    check("settled receipt: payee amount == cumulative", payee.amount === 350n && payee.commitment === 222n);
    check("settled receipt: refund == cap - cumulative", payer.amount === CAP - 350n && payer.commitment === 333n);
    check("invariant #8: gross == on-chain settled net", r.gross === settleEv.cumulative);
    check("value conservation: payee + payer == cap", payee.amount + payer.amount === CAP);
    check("settled receipt: close tx recorded", r.closeTxHash === "0xsettle");
  }

  // 3) reclaimed -> gross 0 (payee got nothing), payer reclaims full cap
  {
    const reclaimEv: ChannelEvent = { kind: "reclaimed", channelId: CID, cap: CAP, reclaimCommitment: 444n, txHash: "0xreclaim" };
    const r = reconstructChannelReceipt(CID, [openEv, reclaimEv]);
    check("reclaimed receipt: state + gross 0", r.state === "reclaimed" && r.gross === 0n);
    check("reclaimed receipt: payer gets full cap", r.split.length === 1 && r.split[0].recipient === "payer" && r.split[0].amount === CAP);
  }

  // 4) events for OTHER channels are ignored
  {
    const other: ChannelEvent = { kind: "settled", channelId: 999n, cumulative: 100n, payeeCommitment: 1n, refundCommitment: 2n, txHash: "0xother" };
    const settleEv: ChannelEvent = { kind: "settled", channelId: CID, cumulative: 200n, payeeCommitment: 5n, refundCommitment: 6n, txHash: "0xsettle2" };
    const r = reconstructChannelReceipt(CID, [openEv, other, settleEv]);
    check("cross-channel events ignored", r.gross === 200n);
  }

  // 5) missing open -> throws
  {
    let threw = false;
    try { reconstructChannelReceipt(CID, [{ kind: "settled", channelId: CID, cumulative: 1n, payeeCommitment: 1n, refundCommitment: 1n, txHash: "0x" }]); }
    catch { threw = true; }
    check("missing ChannelOpened throws", threw);
  }

  // 6) both settle and reclaim -> throws (channel consumed once)
  {
    let threw = false;
    try {
      reconstructChannelReceipt(CID, [
        openEv,
        { kind: "settled", channelId: CID, cumulative: 1n, payeeCommitment: 1n, refundCommitment: 1n, txHash: "0x" },
        { kind: "reclaimed", channelId: CID, cap: CAP, reclaimCommitment: 1n, txHash: "0x" },
      ]);
    } catch { threw = true; }
    check("settle + reclaim on same channel throws", threw);
  }

  // 7) receiptToJson is JSON-safe (no bigints survive)
  {
    const settleEv: ChannelEvent = { kind: "settled", channelId: CID, cumulative: 350n, payeeCommitment: 222n, refundCommitment: 333n, txHash: "0xsettle" };
    const json = receiptToJson(reconstructChannelReceipt(CID, [openEv, settleEv]));
    const str = JSON.stringify(json);
    check("receiptToJson serializes cleanly", str.includes("\"gross\":\"350\"") && str.includes("\"cap\":\"600\""));
  }

  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main();
