// Real CCTP V2 cross-chain leg: burn USDC on Base Sepolia -> Circle Iris
// attestation -> mint on Arc testnet. This is the LITERAL cross-chain transfer
// that funds an Arc service payment from another chain — no representation, real
// Circle infra, real tx hashes on both chains.
//
// Two signers, because gas lives on different chains:
//   • BASE side (burn): BASE_BURN_KEY — the account holding USDC + ETH on Base
//     Sepolia. Signs approve + depositForBurn.
//   • ARC side (mint):  ARC_MINT_KEY (falls back to ARC_DEPLOYER_KEY) — an
//     account with Arc gas (native USDC). Signs receiveMessage. CCTP lets ANY
//     caller complete the mint (destinationCaller = 0), so this need not be the
//     burner. The USDC is minted to ARC_RECIPIENT (default: the Arc mint signer).
//
// Run: BASE_BURN_KEY=0x<key> npm run cctp-bridge:arc
//      BASE_BURN_KEY=0x<key> AMOUNT_USDC=5 npm run cctp-bridge:arc

import { JsonRpcProvider, Wallet, Contract, formatUnits, zeroPadValue, getBytes } from "ethers";
import { CCTP_V2, CCTP_DOMAINS, CCTP_ATTESTATION_API, ARC_DESTINATION } from "./cctp-arc.js";

const BASE_BURN_KEY = process.env.BASE_BURN_KEY ?? process.env.BASE_SEPOLIA_PRIVATE_KEY;
const ARC_MINT_KEY = process.env.ARC_MINT_KEY ?? process.env.ARC_DEPLOYER_KEY;
if (!BASE_BURN_KEY) { console.error("BASE_BURN_KEY required (the account with USDC+ETH on Base Sepolia)"); process.exit(1); }
if (!ARC_MINT_KEY) { console.error("ARC_MINT_KEY / ARC_DEPLOYER_KEY required (an account with Arc gas to complete the mint)"); process.exit(1); }
const AMOUNT = BigInt(process.env.AMOUNT_USDC ?? "5") * 1_000_000n; // USDC has 6 decimals

const BASE_RPC = "https://sepolia.base.org";
const BASE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Circle testnet USDC on Base Sepolia

const TOKEN_MESSENGER_ABI = [
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) returns (uint64)",
];
const MESSAGE_TRANSMITTER_ABI = [
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

function kv(k: string, v: string) { console.log(`    ${k.padEnd(22)} ${v}`); }
function step(s: string) { console.log(`\n\x1b[1m\x1b[36m▸ ${s}\x1b[0m`); }

async function fetchAttestation(sourceDomain: number, burnTxHash: string): Promise<{ message: string; attestation: string }> {
  const url = `${CCTP_ATTESTATION_API}/v2/messages/${sourceDomain}?transactionHash=${burnTxHash}`;
  for (let i = 0; i < 90; i++) { // up to ~7.5 min
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json() as any;
        const m = data?.messages?.[0];
        if (m && m.status === "complete" && m.attestation && m.attestation !== "PENDING") {
          return { message: m.message, attestation: m.attestation };
        }
        process.stdout.write(`\r    waiting for Circle attestation… (${i * 5}s, status=${m?.status ?? "pending"})   `);
      }
    } catch { /* transient */ }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("attestation not ready after timeout");
}

async function main() {
  console.log("\x1b[1m════════════════════════════════════════════════════════════════════");
  console.log("  REAL CCTP cross-chain leg — Base Sepolia → Arc testnet");
  console.log("════════════════════════════════════════════════════════════════════\x1b[0m");

  const base = new JsonRpcProvider(BASE_RPC, 84532);
  const arc = new JsonRpcProvider(ARC_DESTINATION.rpcUrl, ARC_DESTINATION.chainId);
  const baseSigner = new Wallet(BASE_BURN_KEY!, base);
  const arcSigner = new Wallet(ARC_MINT_KEY!, arc);
  const burner = baseSigner.address;
  const arcRecipient = process.env.ARC_RECIPIENT ?? arcSigner.address; // where USDC lands on Arc

  step("Preflight — balances + contracts");
  const usdc = new Contract(BASE_USDC, ERC20_ABI, baseSigner);
  const [baseEth, baseUsdc, arcGas] = await Promise.all([
    base.getBalance(burner), usdc.balanceOf(burner), arc.getBalance(arcSigner.address),
  ]);
  kv("burn account (Base)", burner);
  kv("mint account (Arc)", arcSigner.address);
  kv("USDC lands on Arc at", arcRecipient);
  kv("Base Sepolia ETH (gas)", formatUnits(baseEth, 18) + " ETH");
  kv("Base Sepolia USDC", formatUnits(baseUsdc, 6) + " USDC");
  kv("Arc gas (native USDC)", formatUnits(arcGas, 18) + " USDC");
  kv("transfer amount", formatUnits(AMOUNT, 6) + " USDC");
  if (baseUsdc < AMOUNT) { console.error(`\nInsufficient Base USDC on ${burner}.`); process.exit(1); }
  if (baseEth === 0n) { console.error(`\n\x1b[31mNo Base Sepolia ETH on ${burner} for burn gas.\x1b[0m`); process.exit(1); }
  if (arcGas === 0n) { console.error(`\n\x1b[31mNo Arc gas on the mint account ${arcSigner.address}.\x1b[0m`); process.exit(1); }

  step("1/4 — Approve the TokenMessenger to burn USDC (Base Sepolia)");
  const allowance: bigint = await usdc.allowance(burner, CCTP_V2.tokenMessenger);
  if (allowance < AMOUNT) {
    const atx = await usdc.approve(CCTP_V2.tokenMessenger, AMOUNT);
    kv("approve tx", atx.hash);
    await atx.wait();
  } else { kv("approve", "already sufficient"); }

  step("2/4 — depositForBurn (Base Sepolia → Arc, CCTP domain 26)");
  const tm = new Contract(CCTP_V2.tokenMessenger, TOKEN_MESSENGER_ABI, baseSigner);
  const mintRecipient = zeroPadValue(arcRecipient, 32); // bytes32 of the Arc recipient
  const destinationCaller = "0x" + "00".repeat(32); // anyone can complete on Arc
  const maxFee = AMOUNT / 1000n; // small fast-transfer fee cap
  const minFinality = 1000; // fast
  const btx = await tm.depositForBurn(AMOUNT, CCTP_DOMAINS.arcTestnet, mintRecipient, BASE_USDC, destinationCaller, maxFee, minFinality);
  kv("burn tx (Base)", btx.hash);
  const brec = await btx.wait();
  kv("burned", `${formatUnits(AMOUNT, 6)} USDC on Base Sepolia (block ${brec.blockNumber})`);
  kv("explorer", `https://sepolia.basescan.org/tx/${btx.hash}`);

  step("3/4 — Fetch Circle attestation (Iris)");
  const { message, attestation } = await fetchAttestation(CCTP_DOMAINS.baseSepolia, btx.hash);
  console.log();
  kv("attestation", attestation.slice(0, 42) + "…");
  kv("message", message.slice(0, 42) + "…");

  step("4/4 — receiveMessage on Arc (mint USDC on Arc)");
  const arcBalBefore = await arc.getBalance(arcRecipient);
  const mt = new Contract(CCTP_V2.messageTransmitter, MESSAGE_TRANSMITTER_ABI, arcSigner);
  const mtx = await mt.receiveMessage(getBytes(message), getBytes(attestation));
  kv("mint tx (Arc)", mtx.hash);
  const mrec = await mtx.wait();
  const arcBalAfter = await arc.getBalance(arcRecipient);
  kv("mint status", mrec.status === 1 ? "SUCCESS" : "FAIL");
  kv("recipient balance delta", formatUnits(arcBalAfter - arcBalBefore, 18) + " (USDC minted on Arc)");
  kv("explorer", `https://testnet.arcscan.app/tx/${mtx.hash}`);

  console.log("\n\x1b[1m\x1b[32m═══ REAL CROSS-CHAIN LEG COMPLETE — USDC burned on Base Sepolia and");
  console.log("    minted on Arc testnet via Circle CCTP, verifiable on both explorers. ═══\x1b[0m\n");
  process.exit(mrec.status === 1 ? 0 : 1);
}

main().catch((e) => { console.error("\nBRIDGE FAILED:", e.shortMessage ?? e.message ?? e); process.exit(1); });
