// Shade Streams — per-channel receipts. Reconstructs a channel's full history
// from the StreamEscrow events it emitted (ChannelOpened / ChannelSettled /
// ChannelReclaimed) into a verifiable StreamReceipt: how much was reserved, how
// much settled net, the payee/refund split, and the channel's final state.
//
// The reconstruction is PURE (no chain/ethers dependency) so it stays in the
// browser-safe SDK; the on-chain event FETCH lives in @shade/arc-actions
// (fetchChannelReceipt), which calls this function with the parsed events.
//
// Invariant #8 (receipt gross == on-chain settled net) is exactly what this
// makes auditable: gross comes from the ChannelSettled event's cumulative,
// which is the settle proof's public signal.

export type ChannelOpenedEvent = {
  kind: "opened";
  channelId: bigint;
  cap: bigint;
  expiry: bigint;
  changeCommitment: bigint;
  txHash: string;
};

export type ChannelSettledEvent = {
  kind: "settled";
  channelId: bigint;
  cumulative: bigint;
  payeeCommitment: bigint;
  refundCommitment: bigint;
  txHash: string;
};

export type ChannelReclaimedEvent = {
  kind: "reclaimed";
  channelId: bigint;
  cap: bigint;
  reclaimCommitment: bigint;
  txHash: string;
};

export type ChannelEvent = ChannelOpenedEvent | ChannelSettledEvent | ChannelReclaimedEvent;

export type ChannelState = "open" | "settled" | "reclaimed";

export type StreamReceipt = {
  channelId: bigint;
  state: ChannelState;
  cap: bigint;
  // gross = the net amount actually settled to the payee (0 while open;
  // `cumulative` after settle; 0 after reclaim — the payer got everything back).
  gross: bigint;
  // the shielded split of the reserved cap once the channel closes:
  //   settle  -> payee = cumulative, refund = cap - cumulative
  //   reclaim -> payer reclaims the full cap (single note)
  split: { recipient: "payee" | "payer"; amount: bigint; commitment: bigint }[];
  openTxHash: string;
  closeTxHash?: string;
};

/**
 * Reconstruct a receipt from the events emitted for a single channel. Events may
 * arrive in any order; exactly one ChannelOpened is required, and at most one
 * of ChannelSettled / ChannelReclaimed (the channel is consumed once).
 */
export function reconstructChannelReceipt(channelId: bigint, events: ChannelEvent[]): StreamReceipt {
  const forChannel = events.filter((e) => e.channelId === channelId);
  const opened = forChannel.find((e): e is ChannelOpenedEvent => e.kind === "opened");
  if (!opened) throw new Error(`no ChannelOpened event for channel ${channelId}`);

  const settled = forChannel.find((e): e is ChannelSettledEvent => e.kind === "settled");
  const reclaimed = forChannel.find((e): e is ChannelReclaimedEvent => e.kind === "reclaimed");
  if (settled && reclaimed) {
    throw new Error(`channel ${channelId} has both settle and reclaim events — impossible (consumed once)`);
  }

  if (settled) {
    const refund = opened.cap - settled.cumulative;
    return {
      channelId,
      state: "settled",
      cap: opened.cap,
      gross: settled.cumulative,
      split: [
        { recipient: "payee", amount: settled.cumulative, commitment: settled.payeeCommitment },
        { recipient: "payer", amount: refund, commitment: settled.refundCommitment },
      ],
      openTxHash: opened.txHash,
      closeTxHash: settled.txHash,
    };
  }

  if (reclaimed) {
    return {
      channelId,
      state: "reclaimed",
      cap: opened.cap,
      gross: 0n, // nothing settled to the payee; the payer reclaimed the full cap
      split: [{ recipient: "payer", amount: reclaimed.cap, commitment: reclaimed.reclaimCommitment }],
      openTxHash: opened.txHash,
      closeTxHash: reclaimed.txHash,
    };
  }

  // still open
  return {
    channelId,
    state: "open",
    cap: opened.cap,
    gross: 0n,
    split: [],
    openTxHash: opened.txHash,
  };
}

/** Serialize a receipt to JSON-safe form (bigints -> decimal strings). */
export function receiptToJson(r: StreamReceipt): Record<string, unknown> {
  return {
    channelId: r.channelId.toString(),
    state: r.state,
    cap: r.cap.toString(),
    gross: r.gross.toString(),
    split: r.split.map((s) => ({ recipient: s.recipient, amount: s.amount.toString(), commitment: s.commitment.toString() })),
    openTxHash: r.openTxHash,
    closeTxHash: r.closeTxHash,
  };
}
