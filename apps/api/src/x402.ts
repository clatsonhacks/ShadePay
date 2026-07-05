// x402 "HTTP 402 Payment Required" gating for Shade Streams. A paid resource
// server uses this to require a valid payment-channel voucher before serving:
// no voucher -> 402 with instructions; a voucher whose cumulative has reached
// the required amount (and is signed by the channel's payer, within cap, on an
// open non-expired channel) -> allowed.
//
// Framework-agnostic on purpose (no Fastify types) so it is unit-testable
// without a server. A Fastify/Express handler just calls checkX402 and maps the
// X402Result to a reply.

import { verifyVoucher, type Voucher } from "@shade/sdk";

/** On-chain channel state, looked up by the caller (production: StreamEscrow.getChannel). */
export type ChannelInfo = {
  cap: bigint;
  payerAx: bigint;
  payerAy: bigint;
  consumed: boolean; // a settled/reclaimed channel can no longer authorize payments
  expiryBlock: bigint;
};

export type X402Config = {
  // the cumulative a voucher must have REACHED to access this resource.
  requiredCumulative: bigint;
  // channel lookup; undefined => not an open channel.
  lookupChannel: (channelId: bigint) => Promise<ChannelInfo | undefined>;
  // optional current block for expiry enforcement; omitted => expiry not checked.
  currentBlock?: () => Promise<bigint>;
  // human-readable 402 body fields (escrow address, rate, etc.).
  paymentInstructions: Record<string, unknown>;
};

export type X402Result =
  | { ok: true; voucher: Voucher }
  | { ok: false; status: 402 | 403; body: Record<string, unknown> };

// Wire format: base64(JSON) where every bigint field is a decimal string
// (bigints don't survive JSON), and seq stays a number.
type VoucherWire = {
  channelId: string;
  cumulative: string;
  seq: number;
  R8x: string;
  R8y: string;
  S: string;
  Ax: string;
  Ay: string;
};

export function serializeVoucherHeader(voucher: Voucher): string {
  const wire: VoucherWire = {
    channelId: voucher.channelId.toString(),
    cumulative: voucher.cumulative.toString(),
    seq: voucher.seq,
    R8x: voucher.R8x.toString(),
    R8y: voucher.R8y.toString(),
    S: voucher.S.toString(),
    Ax: voucher.Ax.toString(),
    Ay: voucher.Ay.toString(),
  };
  return Buffer.from(JSON.stringify(wire), "utf8").toString("base64");
}

export function parseVoucherHeader(headerValue: string | undefined): Voucher | undefined {
  if (!headerValue) return undefined;
  try {
    const json = Buffer.from(headerValue, "base64").toString("utf8");
    const w = JSON.parse(json) as VoucherWire;
    if (
      w.channelId === undefined || w.cumulative === undefined || w.seq === undefined ||
      w.R8x === undefined || w.R8y === undefined || w.S === undefined ||
      w.Ax === undefined || w.Ay === undefined
    ) {
      return undefined;
    }
    return {
      channelId: BigInt(w.channelId),
      cumulative: BigInt(w.cumulative),
      seq: Number(w.seq),
      R8x: BigInt(w.R8x),
      R8y: BigInt(w.R8y),
      S: BigInt(w.S),
      Ax: BigInt(w.Ax),
      Ay: BigInt(w.Ay),
    };
  } catch {
    return undefined;
  }
}

export async function checkX402(voucher: Voucher | undefined, config: X402Config): Promise<X402Result> {
  const instructions = config.paymentInstructions;
  if (!voucher) {
    return {
      ok: false,
      status: 402,
      body: { error: "payment required", ...instructions, requiredCumulative: config.requiredCumulative.toString() },
    };
  }

  const ch = await config.lookupChannel(voucher.channelId);
  if (!ch) {
    return { ok: false, status: 402, body: { error: "channel not open", ...instructions } };
  }
  if (ch.consumed) {
    return { ok: false, status: 403, body: { error: "channel already settled or reclaimed" } };
  }
  if (config.currentBlock && (await config.currentBlock()) > ch.expiryBlock) {
    return { ok: false, status: 403, body: { error: "channel expired" } };
  }
  if (!(await verifyVoucher(voucher))) {
    return { ok: false, status: 403, body: { error: "invalid voucher signature" } };
  }
  if (voucher.Ax !== ch.payerAx || voucher.Ay !== ch.payerAy) {
    return { ok: false, status: 403, body: { error: "voucher not signed by channel payer" } };
  }
  if (voucher.cumulative > ch.cap) {
    return { ok: false, status: 403, body: { error: "voucher exceeds channel cap" } };
  }
  if (voucher.cumulative < config.requiredCumulative) {
    return {
      ok: false,
      status: 402,
      body: {
        error: "insufficient payment",
        requiredCumulative: config.requiredCumulative.toString(),
        providedCumulative: voucher.cumulative.toString(),
        ...instructions,
      },
    };
  }
  return { ok: true, voucher };
}
