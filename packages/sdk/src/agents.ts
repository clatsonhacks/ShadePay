// Shade Streams — the agent layer. Thin decision-making wrappers over the
// voucher SDK that make the per-tick choices the design doc calls "meaningful
// agency": a PayerAgent that authorizes payment up to a rate + budget and stops
// on drop, and a PayeeAgent that verifies incoming vouchers, enforces the agreed
// rate, tracks the highest, and decides when settling is worth it.
//
// Pure logic over @shade/sdk's streams primitives — no chain calls — so agents
// are unit-testable and embeddable anywhere (browser, server, edge).

import { signVoucher, verifyVoucher, type EddsaKeypair, type Voucher } from "./streams.js";

// ============================================================
// PayerAgent — spends on a channel per rate + budget.
// ============================================================
export type PayerAgentConfig = {
  key: EddsaKeypair;
  channelId: bigint;
  cap: bigint;          // the on-chain channel cap; cumulative can never exceed this
  ratePerUnit: bigint;  // price per unit (call / second / fraction) served
  budget: bigint;       // the agent's self-imposed spend ceiling (<= cap)
};

export class PayerAgent {
  private cfg: PayerAgentConfig;
  private cumulative = 0n;
  private seq = 0;
  private paused = false;

  constructor(cfg: PayerAgentConfig) {
    if (cfg.budget > cfg.cap) throw new Error("budget cannot exceed channel cap");
    this.cfg = cfg;
  }

  /**
   * Authorize payment for `units` more units of service. Advances the cumulative
   * by rate*units and returns a fresh voucher the payee can present. Throws if
   * paused, or if the new cumulative would exceed the budget (or cap). The payee
   * gets a monotonically increasing cumulative, so it always settles the latest.
   */
  async pay(units: bigint): Promise<Voucher> {
    if (this.paused) throw new Error("payer agent is paused (service degraded); resume to continue paying");
    if (units <= 0n) throw new Error("units must be positive");
    const next = this.cumulative + this.cfg.ratePerUnit * units;
    if (next > this.cfg.budget) throw new Error(`payment ${next} exceeds budget ${this.cfg.budget}`);
    if (next > this.cfg.cap) throw new Error(`payment ${next} exceeds channel cap ${this.cfg.cap}`);
    this.cumulative = next;
    this.seq += 1;
    return signVoucher(this.cfg.key, this.cfg.channelId, this.cumulative, this.seq);
  }

  /** Stop authorizing further payment (proof-of-flow dropped: service stopped delivering). */
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  isPaused(): boolean { return this.paused; }

  spent(): bigint { return this.cumulative; }
  remainingBudget(): bigint { return this.cfg.budget - this.cumulative; }
}

// ============================================================
// PayeeAgent — verifies vouchers, enforces the rate, tracks the highest.
// ============================================================
export type PayeeAgentConfig = {
  payerAx: bigint;      // the channel's payer pubkey — vouchers must be signed by it
  payerAy: bigint;
  channelId: bigint;
  cap: bigint;
  ratePerUnit: bigint;  // the rate the payee prices its service at
};

export type ReceiveResult = { accepted: boolean; reason?: string };

export class PayeeAgent {
  private cfg: PayeeAgentConfig;
  private best: Voucher | undefined;
  private unitsServed = 0n;

  constructor(cfg: PayeeAgentConfig) {
    this.cfg = cfg;
  }

  /**
   * Record that `unitsServed` total units have been delivered so far, then accept
   * or reject an incoming voucher. A voucher is accepted iff:
   *  - its signature is valid and signed by the channel's payer,
   *  - it's for this channel,
   *  - cumulative <= cap,
   *  - cumulative >= ratePerUnit * unitsServed (the payer has paid for what was served),
   *  - cumulative > the current best (monotonic; stale/replayed vouchers are ignored, not rejected).
   * On accept, it becomes the new best (the one the payee will settle).
   */
  async receive(voucher: Voucher, totalUnitsServed: bigint): Promise<ReceiveResult> {
    this.unitsServed = totalUnitsServed;
    if (voucher.channelId !== this.cfg.channelId) return { accepted: false, reason: "wrong channel" };
    if (voucher.Ax !== this.cfg.payerAx || voucher.Ay !== this.cfg.payerAy) {
      return { accepted: false, reason: "voucher not signed by channel payer" };
    }
    if (!(await verifyVoucher(voucher))) return { accepted: false, reason: "invalid signature" };
    if (voucher.cumulative > this.cfg.cap) return { accepted: false, reason: "voucher exceeds cap" };
    const owed = this.cfg.ratePerUnit * totalUnitsServed;
    if (voucher.cumulative < owed) return { accepted: false, reason: `underpaid: ${voucher.cumulative} < owed ${owed}` };
    // stale (not greater than best) — ignore silently, keep serving.
    if (this.best && voucher.cumulative <= this.best.cumulative) return { accepted: true, reason: "stale (kept current best)" };
    this.best = voucher;
    return { accepted: true };
  }

  /** The highest voucher seen — the one to submit at settle. */
  highest(): Voucher | undefined { return this.best; }

  /** Whether accumulated value is worth an on-chain settle (>= threshold). */
  shouldSettle(threshold: bigint): boolean {
    return this.best !== undefined && this.best.cumulative >= threshold;
  }

  /** Whether service should stop: the payer is behind on payment for what's served. */
  isUnderpaid(): boolean {
    const owed = this.cfg.ratePerUnit * this.unitsServed;
    return (this.best?.cumulative ?? 0n) < owed;
  }
}
