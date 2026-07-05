// Validates the Shade Streams agent layer (packages/sdk/src/agents.ts):
// PayerAgent's rate/budget/pause logic and PayeeAgent's verify/rate/highest
// decisions, using real EdDSA vouchers. Run via: npm run agents:test

import { generatePayerKey } from "./streams.js";
import { PayerAgent, PayeeAgent } from "./agents.js";

type CheckResult = { name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(ok ? "PASS" : "FAIL", name, detail ? `- ${detail}` : "");
}

const CHANNEL_ID = 42n;
const CAP = 1000n;
const RATE = 10n; // per unit

async function main() {
  const key = await generatePayerKey(Buffer.from("44".repeat(32), "hex"));

  // ---- PayerAgent ----
  const payer = new PayerAgent({ key, channelId: CHANNEL_ID, cap: CAP, ratePerUnit: RATE, budget: 500n });

  const v1 = await payer.pay(3n); // 30
  check("payer: first payment advances cumulative", v1.cumulative === 30n && payer.spent() === 30n);
  const v2 = await payer.pay(5n); // +50 = 80
  check("payer: cumulative is monotonic", v2.cumulative === 80n && v2.seq > v1.seq);
  check("payer: remaining budget tracks spend", payer.remainingBudget() === 500n - 80n);

  // over-budget rejected
  {
    let threw = false;
    try { await payer.pay(100n); } catch { threw = true; } // 80 + 1000 > 500 budget
    check("payer: over-budget payment rejected", threw);
  }
  check("payer: cumulative unchanged after rejected payment", payer.spent() === 80n);

  // pause stops payment (proof-of-flow drop)
  payer.pause();
  {
    let threw = false;
    try { await payer.pay(1n); } catch { threw = true; }
    check("payer: paused agent refuses to pay", threw && payer.isPaused());
  }
  payer.resume();
  const v3 = await payer.pay(1n);
  check("payer: resume allows payment again", v3.cumulative === 90n);

  // budget cannot exceed cap
  {
    let threw = false;
    try { new PayerAgent({ key, channelId: CHANNEL_ID, cap: 100n, ratePerUnit: RATE, budget: 200n }); } catch { threw = true; }
    check("payer: budget > cap rejected at construction", threw);
  }

  // ---- PayeeAgent ----
  const payee = new PayeeAgent({ payerAx: key.Ax, payerAy: key.Ay, channelId: CHANNEL_ID, cap: CAP, ratePerUnit: RATE });

  // accept a valid voucher covering the units served
  {
    const v = await payer.pay(2n); // cumulative now 90 + 20 = 110
    const r = await payee.receive(v, 11n); // owed 110, paid 110 -> ok
    check("payee: accepts voucher covering served units", r.accepted === true && payee.highest()?.cumulative === 110n);
  }

  // underpaid voucher rejected (served more than paid for)
  {
    const stale = await payer.pay(1n); // 120
    const r = await payee.receive(stale, 100n); // owed 1000, paid 120 -> underpaid
    check("payee: rejects underpaid voucher", r.accepted === false && (r.reason ?? "").includes("underpaid"));
    check("payee: isUnderpaid flags service should stop", payee.isUnderpaid() === true);
  }

  // wrong-signer voucher rejected
  {
    const otherKey = await generatePayerKey(Buffer.from("55".repeat(32), "hex"));
    const otherPayer = new PayerAgent({ key: otherKey, channelId: CHANNEL_ID, cap: CAP, ratePerUnit: RATE, budget: 500n });
    const v = await otherPayer.pay(1n);
    const r = await payee.receive(v, 1n);
    check("payee: rejects voucher from wrong signer", r.accepted === false && (r.reason ?? "").includes("payer"));
  }

  // fresh payee for clean highest/settle checks
  {
    const p2 = new PayeeAgent({ payerAx: key.Ax, payerAy: key.Ay, channelId: CHANNEL_ID, cap: CAP, ratePerUnit: RATE });
    const payer2 = new PayerAgent({ key, channelId: CHANNEL_ID, cap: CAP, ratePerUnit: RATE, budget: 900n });
    const a = await payer2.pay(5n);  // 50
    const b = await payer2.pay(5n);  // 100
    await p2.receive(a, 5n);
    await p2.receive(b, 10n);
    check("payee: highest tracks the max cumulative", p2.highest()?.cumulative === 100n);
    check("payee: shouldSettle true above threshold", p2.shouldSettle(100n) === true);
    check("payee: shouldSettle false below threshold", p2.shouldSettle(200n) === false);

    // a stale (lower) voucher arriving late is accepted-but-ignored, best unchanged.
    // Serve only 5 units so `a` (cumulative 50) isn't underpaid; it's just stale vs best 100.
    const r = await p2.receive(a, 5n); // owed 50, a.cumulative 50 covers it, but 50 <= best 100 -> stale
    check("payee: stale voucher kept-current-best", r.accepted === true && p2.highest()?.cumulative === 100n);
  }

  // over-cap voucher rejected
  {
    const p3 = new PayeeAgent({ payerAx: key.Ax, payerAy: key.Ay, channelId: CHANNEL_ID, cap: 50n, ratePerUnit: RATE });
    const payer3 = new PayerAgent({ key, channelId: CHANNEL_ID, cap: 1000n, ratePerUnit: RATE, budget: 1000n });
    const v = await payer3.pay(10n); // 100 > cap 50 (payee's view of the cap)
    const r = await p3.receive(v, 10n);
    check("payee: rejects over-cap voucher", r.accepted === false && (r.reason ?? "").includes("cap"));
  }

  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
