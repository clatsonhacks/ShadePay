// StreamPay — real per-second USDC streaming on Arc. This is the base
// nanopayment rail: an agent pays a live-data / GPU-second service in REAL
// native USDC, by the second. No mock token, no representation — the money
// moves for real, the amounts are sub-cent, the tx hashes are on-chain.
//
// Flow (one continuous stream, real value settled at every step):
//   1. Deploy StreamPay on Arc (or local anvil for CI).
//   2. Agent OPENs the stream — funds a cap in real native USDC, authorizes
//      a rate of $0.0001 / second. This is continuous authorization of a
//      RATE, not one signature per tick.
//   3. Service does work; every second the on-chain meter (earned()) grows
//      by exactly RATE units of REAL USDC. Printed live.
//   4. Service pulls a mid-stream WITHDRAW — real native USDC lands in its
//      account, balance delta shown.
//   5. Agent PAUSEs during a quiet period — accrual freezes on-chain.
//   6. Agent RESUMEs — accrual restarts.
//   7. Agent STOPs — service is paid the remaining net, agent is refunded
//      the unspent tail. Value is conserved: payee + refund == deposit.
//
// The service's payee address is a freshly generated key so the balance
// deltas printed at each step are 100% attributable to the stream.
//
// Run:  npm run streampay-demo         (local anvil, real EVM)
//       npm run streampay-demo:arc     (REAL Arc testnet, real USDC, real hashes)

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ContractFactory, Interface, JsonRpcProvider, Wallet, formatUnits, id as keccakId, type Log } from "ethers";

const SHADE_ROOT = process.env.SHADE_ROOT ?? process.cwd();
const USE_TESTNET = !!process.env.ARC_RPC_URL;
const RPC_URL = process.env.ARC_RPC_URL ?? "http://127.0.0.1:8557";
const ANVIL_BIN = existsSync("C:/Users/clats/.foundry/bin/anvil.exe") ? "C:/Users/clats/.foundry/bin/anvil.exe" : "anvil";
const DEPLOYER_KEY = process.env.ARC_DEPLOYER_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const EXPLORER = "https://testnet.arcscan.app/tx/";

// Rate: 0.0001 USDC per second — a true sub-cent nanopayment rate. On Arc,
// native USDC uses 18 decimals (it is the gas token), so 0.0001 USDC = 1e14 wei.
const RATE = 100_000_000_000_000n;              // 1e14 wei = 0.0001 USDC / sec
const CAP  = 5_000_000_000_000_000n;             // 5e15 wei = 0.005 USDC total headroom (50s at RATE)
// Payee needs a bit of native USDC to pay gas for its own withdraw tx. Bootstrap
// with a small transfer from the payer up front — comes out of payer's balance,
// NOT out of the stream. Sized to cover one withdraw tx with headroom on Arc
// testnet (empirically ~0.004 USDC per simple tx there vs. ~1e-8 USDC on anvil).
const BOOTSTRAP = 10_000_000_000_000_000n;       // 0.01 USDC to cover payee gas

let anvil: ChildProcess | undefined;

function art(rel: string): { abi: unknown; bytecode: string } {
  const j = JSON.parse(readFileSync(resolve(SHADE_ROOT, "contracts/arc/out", rel), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}
function log(s = "") { console.log(s); }
function step(n: number, s: string) { log(`\n\x1b[1m\x1b[36m[${n}] ${s}\x1b[0m`); }
function kv(k: string, v: string) { log(`    ${k.padEnd(24)} ${v}`); }
function fmtUsdc(wei: bigint): string { return formatUnits(wei, 18) + " USDC"; }
async function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// Advance wall-clock time. On local anvil, force a fresh block so block.timestamp
// (which earned() reads) advances even if the node's auto-mine hasn't fired. On
// testnet, blocks are produced continuously — just wait.
async function passSeconds(provider: JsonRpcProvider, secs: number, label: string) {
  process.stdout.write(`    ${label.padEnd(24)} `);
  for (let s = 0; s < secs; s++) {
    await sleep(1000);
    process.stdout.write("·");
    if (!USE_TESTNET) { try { await provider.send("evm_mine", []); } catch { /* noop */ } }
  }
  process.stdout.write("  \n");
}

async function main() {
  log("\x1b[1m════════════════════════════════════════════════════════════════════");
  log("  STREAMPAY — real per-second USDC streaming on Arc");
  log("  Continuous authorization of a rate. Real money. Sub-cent per tick.");
  log(`  chain: ${USE_TESTNET ? `\x1b[33mREAL ARC TESTNET\x1b[0m (${RPC_URL})` : "local anvil (real EVM)"}`);
  log("════════════════════════════════════════════════════════════════════\x1b[0m");

  if (!existsSync(resolve(SHADE_ROOT, "contracts/arc/out/StreamPay.sol/StreamPay.json"))) {
    log("\nERROR: StreamPay artifact missing. Run: cd contracts/arc && forge build");
    process.exit(1);
  }

  if (!USE_TESTNET) {
    anvil = spawn(ANVIL_BIN, ["--port", "8557", "--silent"], { stdio: "ignore" });
  }
  const provider = new JsonRpcProvider(RPC_URL);
  for (let i = 0; i < 50; i++) { try { await provider.getBlockNumber(); break; } catch { await sleep(300); } }

  // ---------- accounts ----------
  const payer = new Wallet(DEPLOYER_KEY, provider);
  const payee = Wallet.createRandom(provider); // fresh key so balance deltas isolate the stream
  const net = await provider.getNetwork();
  let n = await provider.getTransactionCount(payer.address, "latest");

  step(1, "Parties & balances (real native USDC on-chain)");
  kv("chainId", net.chainId.toString());
  kv("payer (agent)", payer.address);
  kv("payee (service)", payee.address);
  const payerBalStart = await provider.getBalance(payer.address);
  kv("payer balance", fmtUsdc(payerBalStart));
  kv("payee balance", fmtUsdc(await provider.getBalance(payee.address)));
  if (payerBalStart < CAP + BOOTSTRAP + 1_000_000_000_000_000n) {
    log(`\n\x1b[31mERROR:\x1b[0m payer needs ~${fmtUsdc(CAP + BOOTSTRAP + 1_000_000_000_000_000n)} in native USDC on this chain.`);
    if (USE_TESTNET) log("Fund the payer address at https://faucet.circle.com (select Arc Testnet).");
    anvil?.kill(); process.exit(1);
  }

  // ---------- deploy ----------
  step(2, "Deploy StreamPay");
  const a = art("StreamPay.sol/StreamPay.json");
  const iface = new Interface(a.abi as any);
  const decode = (logs: readonly Log[], name: string): any => {
    for (const l of logs) {
      try { const p = iface.parseLog({ topics: [...l.topics], data: l.data }); if (p && p.name === name) return p.args; } catch { /* not ours */ }
    }
    throw new Error(`no ${name} event in receipt`);
  };
  const factory = new ContractFactory(a.abi as any, a.bytecode, payer);
  const streamPay = await factory.deploy({ nonce: n++ });
  await streamPay.waitForDeployment();
  const streamPayAddr = await streamPay.getAddress();
  kv("StreamPay", streamPayAddr);
  const deployTx = streamPay.deploymentTransaction()!.hash;
  kv("deploy tx", deployTx);
  if (USE_TESTNET) kv("explorer", EXPLORER + deployTx);

  // ---------- bootstrap payee gas ----------
  step(3, "Bootstrap payee with a tiny slice of USDC for withdraw-tx gas");
  kv("bootstrap amount", fmtUsdc(BOOTSTRAP));
  const btx = await payer.sendTransaction({ to: payee.address, value: BOOTSTRAP, nonce: n++ });
  const brec = await btx.wait();
  kv("bootstrap tx", brec!.hash);
  kv("payee balance", fmtUsdc(await provider.getBalance(payee.address)) + "  (pre-stream, gas only)");

  // ---------- open ----------
  step(4, `OPEN — agent funds ${fmtUsdc(CAP)} at ${fmtUsdc(RATE)} / second`);
  const streamId = keccakId(`streampay-demo-${Date.now()}-${Math.random()}`) as `0x${string}`;
  const balBeforeOpen = await provider.getBalance(payer.address);
  const otx = await (streamPay.connect(payer) as any).open(streamId, payee.address, RATE, { value: CAP, nonce: n++ });
  const orec = await otx.wait();
  kv("streamId", streamId);
  kv("cap deposited", fmtUsdc(CAP) + "  (real native USDC locked in escrow)");
  kv("rate", fmtUsdc(RATE) + " / sec  (~$0.0001/sec — sub-cent nanopayment)");
  kv("open tx", orec.hash);
  if (USE_TESTNET) kv("explorer", EXPLORER + orec.hash);
  const escrowBal = await provider.getBalance(streamPayAddr);
  kv("escrow balance", fmtUsdc(escrowBal) + "  (contract now holds the cap)");
  const payerDelta = balBeforeOpen - await provider.getBalance(payer.address);
  kv("payer delta", `-${fmtUsdc(payerDelta)}  (cap + gas)`);

  // ---------- watch the meter ----------
  step(5, "STREAM — live per-second meter (real accrual in real USDC)");
  const contractView = streamPay.connect(provider) as any;
  await passSeconds(provider, 5, "streaming");
  const earnedA = await contractView.earned(streamId) as bigint;
  const withdrawableA = await contractView.withdrawable(streamId) as bigint;
  kv("earned() after ~5s", fmtUsdc(earnedA));
  kv("withdrawable() now", fmtUsdc(withdrawableA));
  const expectedA = 5n * RATE;
  kv("expected (~5·RATE)", fmtUsdc(expectedA) + `  (drift OK: block time can jitter ±1s)`);

  // ---------- mid-stream withdraw ----------
  step(6, "WITHDRAW — service pulls accrued USDC mid-stream");
  const payeeBalBefore = await provider.getBalance(payee.address);
  const wtx = await (streamPay.connect(payee) as any).withdraw(streamId);
  const wrec = await wtx.wait();
  const payeeBalAfter = await provider.getBalance(payee.address);
  const withdrawnEvt = decode(wrec!.logs, "Withdrawn");
  const withdrawnAmt: bigint = withdrawnEvt.amount;
  kv("withdraw tx", wrec!.hash);
  if (USE_TESTNET) kv("explorer", EXPLORER + wrec!.hash);
  kv("payee received", fmtUsdc(withdrawnAmt) + "  (from Withdrawn event — REAL native USDC)");
  kv("payee balance now", fmtUsdc(payeeBalAfter) + `  (${payeeBalAfter >= payeeBalBefore ? "+" : ""}${fmtUsdc(payeeBalAfter - payeeBalBefore)} after tx gas)`);
  const earnedAfterW = await contractView.earned(streamId) as bigint;
  const withdrawableAfterW = await contractView.withdrawable(streamId) as bigint;
  kv("earned() (running)", fmtUsdc(earnedAfterW));
  kv("withdrawable() (0)", fmtUsdc(withdrawableAfterW) + "  (paid up to now)");

  // ---------- pause ----------
  step(7, "PAUSE — agent taps the brake, accrual freezes on-chain");
  const ptx = await (streamPay.connect(payer) as any).pause(streamId, { nonce: n++ });
  const prec = await ptx.wait();
  kv("pause tx", prec.hash);
  if (USE_TESTNET) kv("explorer", EXPLORER + prec.hash);
  const earnedAtPause = await contractView.earned(streamId) as bigint;
  kv("earned() at pause", fmtUsdc(earnedAtPause));
  await passSeconds(provider, 4, "paused (silent)");
  const earnedAfterPauseGap = await contractView.earned(streamId) as bigint;
  kv("earned() 4s later", fmtUsdc(earnedAfterPauseGap) + (earnedAfterPauseGap === earnedAtPause ? "  \x1b[32m✓ no accrual while paused\x1b[0m" : "  \x1b[31m✗ accrued while paused!\x1b[0m"));

  // ---------- resume ----------
  step(8, "RESUME — agent restarts the meter");
  const rtx = await (streamPay.connect(payer) as any).resume(streamId, { nonce: n++ });
  const rrec = await rtx.wait();
  kv("resume tx", rrec.hash);
  if (USE_TESTNET) kv("explorer", EXPLORER + rrec.hash);
  await passSeconds(provider, 4, "streaming again");
  const earnedAfterResume = await contractView.earned(streamId) as bigint;
  kv("earned() after ~4s", fmtUsdc(earnedAfterResume));
  const accruedSinceResume = earnedAfterResume - earnedAtPause;
  kv("delta since resume", fmtUsdc(accruedSinceResume) + `  (should ≈ ${fmtUsdc(4n * RATE)})`);

  // ---------- stop ----------
  step(9, "STOP — pay the net, refund the tail. Terminal. Value conserved.");
  const stx = await (streamPay.connect(payer) as any).stop(streamId, { nonce: n++ });
  const srec = await stx.wait();
  kv("stop tx", srec.hash);
  if (USE_TESTNET) kv("explorer", EXPLORER + srec.hash);
  const stoppedEvt = decode(srec!.logs, "Stopped");
  const paidToPayeeAtStop: bigint = stoppedEvt.paidToPayee;
  const refundAtStop: bigint = stoppedEvt.refundToPayer;
  kv("payee paid at stop", fmtUsdc(paidToPayeeAtStop) + "  (from Stopped event)");
  kv("payer refunded", fmtUsdc(refundAtStop) + "  (the unspent tail)");
  const escrowBalEnd = await provider.getBalance(streamPayAddr);
  kv("escrow balance", fmtUsdc(escrowBalEnd) + (escrowBalEnd === 0n ? "  \x1b[32m✓ fully drained\x1b[0m" : "  \x1b[31m✗ leftover!\x1b[0m"));

  // ---------- value conservation ----------
  step(10, "Value conservation — sum of on-chain payouts == deposit");
  const totalToPayee = withdrawnAmt + paidToPayeeAtStop;
  const totalOut = totalToPayee + refundAtStop;
  kv("paid to payee (total)", fmtUsdc(totalToPayee) + `  (${fmtUsdc(withdrawnAmt)} withdraw + ${fmtUsdc(paidToPayeeAtStop)} stop)`);
  kv("refunded to payer", fmtUsdc(refundAtStop));
  kv("sum", fmtUsdc(totalOut));
  kv("deposit (cap)", fmtUsdc(CAP));
  const conserved = totalOut === CAP && escrowBalEnd === 0n;
  kv("invariant", conserved ? "\x1b[32m✓ payee_paid + payer_refund == deposit  AND escrow drained\x1b[0m" : "\x1b[31m✗ mismatch\x1b[0m");

  log("\n\x1b[1m\x1b[32m═══ STREAMPAY COMPLETE — real per-second USDC nanopayments on Arc,");
  log("    with pause/resume, mid-stream withdraw, and stop-with-refund,");
  log("    every step settled on-chain in real value. ═══\x1b[0m");
  if (USE_TESTNET) {
    log("\n\x1b[1mReceipts on arcscan:\x1b[0m");
    log(`    open:     ${EXPLORER}${orec.hash}`);
    log(`    withdraw: ${EXPLORER}${wrec!.hash}`);
    log(`    pause:    ${EXPLORER}${prec.hash}`);
    log(`    resume:   ${EXPLORER}${rrec.hash}`);
    log(`    stop:     ${EXPLORER}${srec.hash}`);
  }
  log("");

  anvil?.kill();
  process.exit(conserved ? 0 : 1);
}

main().catch((e) => { console.error("\nDEMO FAILED:", e); anvil?.kill(); process.exit(1); });
