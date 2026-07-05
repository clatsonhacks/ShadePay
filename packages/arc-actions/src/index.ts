// @shade/arc-actions — the Arc/EVM counterpart to @shade/stellar-actions and
// @shade/stellar-utils's sorobanInvoke. Everything here is ethers-based:
// no XDR, no ScVal, no CLI shelling. Two usage modes, mirroring the Stellar
// package's split:
//   - buildUnsignedTx / broadcastSignedTx: for flows where the END USER's
//     wallet signs (e.g. withdraw, where `to.require_auth()` on Stellar
//     becomes "the withdrawing wallet must be msg.sender or sign the tx"
//     on Arc) — the backend never sees a user's private key.
//   - arcInvoke: for flows a service wallet signs directly (the relayer
//     submitting RFQ/MPC settlements, the registrar submitting private
//     transfers) — the direct equivalent of sorobanInvoke.

import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  type TransactionRequest,
  type TransactionResponse,
  type InterfaceAbi,
} from "ethers";

export type Network = { rpcUrl: string; chainId?: number };

export function arcNetwork(): Network {
  const rpcUrl = process.env.ARC_RPC_URL;
  if (!rpcUrl) throw new Error("ARC_RPC_URL is required");
  const chainIdEnv = process.env.ARC_CHAIN_ID;
  return { rpcUrl, chainId: chainIdEnv ? Number(chainIdEnv) : undefined };
}

export function providerFor(network: Network): JsonRpcProvider {
  return new JsonRpcProvider(network.rpcUrl, network.chainId);
}

/** Mirrors packages/proving/src/bn254/prove.ts's Groth16CallData shape exactly. */
export type Groth16CallData = {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
};

// ============================================================
// User-signed flow: backend builds unsigned calldata, wallet signs, backend
// (or the wallet itself) broadcasts.
// ============================================================

/**
 * Build an unsigned transaction request for `method(...args)` on `contractAddress`,
 * populated with a gas estimate and current nonce for `from`. The caller's
 * wallet (Freighter-equivalent EVM wallet, already the flow used for
 * Arbitrum-Sepolia CCTP per apps/web) signs and submits this — the backend
 * never holds the user's key.
 */
export async function buildUnsignedTx(args: {
  network: Network;
  from: string;
  contractAddress: string;
  abi: InterfaceAbi;
  method: string;
  params: unknown[];
  value?: bigint;
}): Promise<TransactionRequest> {
  const provider = providerFor(args.network);
  const iface = new Interface(args.abi);
  const data = iface.encodeFunctionData(args.method, args.params);

  const [nonce, feeData, gasLimit, network] = await Promise.all([
    provider.getTransactionCount(args.from, "pending"),
    provider.getFeeData(),
    provider.estimateGas({ from: args.from, to: args.contractAddress, data, value: args.value }),
    // always resolve the real chain id from the provider rather than trusting
    // an optional/possibly-stale caller-supplied value — a mismatched chainId
    // on a signed tx is rejected by the node with a confusing RPC error.
    provider.getNetwork(),
  ]);

  return {
    from: args.from,
    to: args.contractAddress,
    data,
    value: args.value ?? 0n,
    nonce,
    gasLimit: (gasLimit * 120n) / 100n, // 20% headroom, matching the spirit of Soroban's simulate+assemble margin
    maxFeePerGas: feeData.maxFeePerGas ?? undefined,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
    chainId: network.chainId,
    type: 2,
  };
}

/** Argument tuple for `withdraw(to, proof, pub)` — mirrors stellar-actions' withdrawParams. */
export function withdrawArgs(to: string, proof: Groth16CallData, pub: string[]): unknown[] {
  return [to, proof, pub];
}

/** Argument tuple for `withdrawCctp(to, destinationRecipient, maxFee, minFinalityThreshold, proof, pub)`. */
export function withdrawCctpArgs(
  to: string,
  destinationRecipient: string,
  maxFee: bigint,
  minFinalityThreshold: number,
  proof: Groth16CallData,
  pub: string[]
): unknown[] {
  return [to, destinationRecipient, maxFee, minFinalityThreshold, proof, pub];
}

/**
 * Broadcast a client-signed raw transaction and wait for confirmation.
 * Direct equivalent of stellar-actions' broadcastSignedXdr, but ethers
 * handles the submit+poll loop natively so this is a thin wrapper.
 */
export async function broadcastSignedTx(
  network: Network,
  signedRawTx: string,
  confirmations = 1
): Promise<{ hash: string; status: "SUCCESS" | "FAILED" }> {
  const provider = providerFor(network);
  const tx = await provider.broadcastTransaction(signedRawTx);
  const receipt = await tx.wait(confirmations);
  if (!receipt) throw new Error(`tx ${tx.hash} did not confirm`);
  return { hash: tx.hash, status: receipt.status === 1 ? "SUCCESS" : "FAILED" };
}

// ============================================================
// Service-signed flow: a service wallet (relayer/registrar) signs and
// submits directly. Direct equivalent of sorobanInvoke.
// ============================================================

export type ArcInvokeResult = {
  hash: string;
  status: "SUCCESS";
  returnValue?: unknown;
};

/**
 * Call `method(...args)` on `contractAddress`, signed and submitted by
 * `wallet`. Retries on transient nonce/rate-limit errors, mirroring
 * sorobanInvoke's TxBadSeq/timeout/429 retry semantics. Set `readOnly: true`
 * for a view call (no tx, no wallet signature needed — returns the decoded
 * result directly as `returnValue`).
 */
export async function arcInvoke(opts: {
  network: Network;
  contractAddress: string;
  abi: InterfaceAbi;
  method: string;
  args?: unknown[];
  wallet?: Wallet; // required unless readOnly
  readOnly?: boolean;
  retries?: number;
}): Promise<ArcInvokeResult> {
  const provider = providerFor(opts.network);

  if (opts.readOnly) {
    const contract = new Contract(opts.contractAddress, opts.abi, provider);
    const returnValue = await contract[opts.method](...(opts.args ?? []));
    return { hash: "", status: "SUCCESS", returnValue };
  }

  if (!opts.wallet) throw new Error("arcInvoke: wallet is required unless readOnly");
  const contract = new Contract(opts.contractAddress, opts.abi, opts.wallet.connect(provider));

  const retries = opts.retries ?? 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const tx: TransactionResponse = await contract[opts.method](...(opts.args ?? []));
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) {
        throw new Error(`tx ${tx.hash} reverted (status ${receipt?.status})`);
      }
      return { hash: tx.hash, status: "SUCCESS" };
    } catch (e) {
      lastErr = e;
      const message = e instanceof Error ? e.message : String(e);
      const retryable = /nonce|NONCE|rate limit|429|timeout|TIMEOUT|replacement/i.test(message);
      if (!retryable || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(`arcInvoke ${opts.method} failed after ${retries} attempts: ${String(lastErr)}`);
}

export function walletFromPrivateKey(privateKey: string, network: Network): Wallet {
  return new Wallet(privateKey, providerFor(network));
}

/**
 * TransactionRequest carries bigint fields (gasLimit, value, chainId, fee
 * fields) that JSON.stringify cannot serialize directly. Converts them to
 * decimal strings for HTTP transport; the receiving wallet/ethers.js accepts
 * BigNumberish strings interchangeably with bigints when signing.
 */
export function serializeUnsignedTx(tx: TransactionRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tx)) {
    out[key] = typeof value === "bigint" ? value.toString() : value;
  }
  return out;
}
