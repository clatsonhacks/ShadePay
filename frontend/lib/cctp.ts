// Circle CCTP v2 browser client — burn on the source chain, poll Iris for the
// attestation, mint on the destination chain. Addresses + domain ids mirror
// packages/arc-actions/src/cctp-arc.ts (single source of truth on the CLI).
import { BrowserProvider, Contract, JsonRpcProvider, Signer, getBytes, zeroPadValue, type Eip1193Provider } from "ethers"

// -----------------------------------------------------------------------------
// Chain configs
// -----------------------------------------------------------------------------

export const BASE_SEPOLIA = {
  chainId: 84532,
  chainIdHex: "0x14a34",
  rpcUrl: "https://sepolia.base.org",
  explorer: "https://sepolia.basescan.org",
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Circle testnet USDC
  cctpDomain: 6,
} as const

// Deterministic v2 addresses (identical on every chain).
export const CCTP_V2 = {
  tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
} as const

export const ARC_CCTP_DOMAIN = 26

export const CCTP_ATTESTATION_API = "https://iris-api-sandbox.circle.com"

// -----------------------------------------------------------------------------
// ABIs — minimal
// -----------------------------------------------------------------------------

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]

const TOKEN_MESSENGER_ABI = [
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) returns (uint64)",
]

const MESSAGE_TRANSMITTER_ABI = [
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
]

// -----------------------------------------------------------------------------
// Chain switching (same pattern as arc.ts)
// -----------------------------------------------------------------------------

let _baseReadOnly: JsonRpcProvider | null = null
export function baseProvider(): JsonRpcProvider {
  if (_baseReadOnly == null) _baseReadOnly = new JsonRpcProvider(BASE_SEPOLIA.rpcUrl, BASE_SEPOLIA.chainId, { staticNetwork: true })
  return _baseReadOnly
}

export async function baseSigner(eip1193: Eip1193Provider): Promise<Signer> {
  await ensureBaseChain(eip1193)
  return new BrowserProvider(eip1193, BASE_SEPOLIA.chainId).getSigner()
}

export async function ensureBaseChain(eip1193: Eip1193Provider): Promise<void> {
  const currentHex = (await eip1193.request({ method: "eth_chainId" })) as string
  if (currentHex.toLowerCase() === BASE_SEPOLIA.chainIdHex.toLowerCase()) return
  try {
    await eip1193.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_SEPOLIA.chainIdHex }] })
  } catch (e: any) {
    if (e?.code === 4902 || /Unrecognized|unknown chain/i.test(String(e?.message ?? ""))) {
      await eip1193.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: BASE_SEPOLIA.chainIdHex,
            chainName: BASE_SEPOLIA.name,
            rpcUrls: [BASE_SEPOLIA.rpcUrl],
            nativeCurrency: BASE_SEPOLIA.nativeCurrency,
            blockExplorerUrls: [BASE_SEPOLIA.explorer],
          },
        ],
      })
    } else {
      throw e
    }
  }
}

// -----------------------------------------------------------------------------
// Read helpers
// -----------------------------------------------------------------------------

export async function baseUsdcBalance(address: string): Promise<bigint> {
  const c = new Contract(BASE_SEPOLIA.usdcAddress, ERC20_ABI, baseProvider())
  return (await c.balanceOf(address)) as bigint
}
export async function baseEthBalance(address: string): Promise<bigint> {
  return baseProvider().getBalance(address)
}
export async function baseAllowance(owner: string, spender: string): Promise<bigint> {
  const c = new Contract(BASE_SEPOLIA.usdcAddress, ERC20_ABI, baseProvider())
  return (await c.allowance(owner, spender)) as bigint
}

// -----------------------------------------------------------------------------
// Burn / mint
// -----------------------------------------------------------------------------

export async function approveTokenMessenger(signer: Signer, amount: bigint): Promise<string> {
  const c = new Contract(BASE_SEPOLIA.usdcAddress, ERC20_ABI, signer)
  const tx = await c.approve(CCTP_V2.tokenMessenger, amount)
  await tx.wait()
  return tx.hash
}

export async function depositForBurn(
  signer: Signer,
  amount: bigint,
  arcRecipient: string,
): Promise<string> {
  const tm = new Contract(CCTP_V2.tokenMessenger, TOKEN_MESSENGER_ABI, signer)
  const mintRecipient = zeroPadValue(arcRecipient, 32) // bytes32 of the Arc recipient
  const destinationCaller = "0x" + "00".repeat(32)     // anyone can complete on Arc
  const maxFee = amount / 1000n                         // small fast-transfer fee cap
  const minFinality = 1000                              // fast
  const tx = await tm.depositForBurn(amount, ARC_CCTP_DOMAIN, mintRecipient, BASE_SEPOLIA.usdcAddress, destinationCaller, maxFee, minFinality)
  await tx.wait()
  return tx.hash
}

/**
 * Poll Circle Iris for the attestation of a burn tx. Resolves when status is
 * complete with a real (non-"PENDING") attestation. `onTick` is fired every
 * poll cycle with the elapsed seconds so the UI can render a live counter.
 */
export async function fetchAttestation(
  sourceDomain: number,
  burnTxHash: string,
  onTick?: (elapsedSecs: number, status: string) => void,
  maxWaitSecs = 600,
): Promise<{ message: string; attestation: string }> {
  const url = `${CCTP_ATTESTATION_API}/v2/messages/${sourceDomain}?transactionHash=${burnTxHash}`
  const start = Date.now()
  while ((Date.now() - start) / 1000 < maxWaitSecs) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const data = (await res.json()) as { messages?: Array<{ status?: string; message?: string; attestation?: string }> }
        const m = data.messages?.[0]
        if (m && m.status === "complete" && m.attestation && m.attestation !== "PENDING") {
          return { message: m.message ?? "", attestation: m.attestation ?? "" }
        }
        onTick?.(Math.floor((Date.now() - start) / 1000), m?.status ?? "pending")
      }
    } catch {
      /* transient network */
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  throw new Error("attestation not ready after timeout")
}

export async function receiveMessage(signer: Signer, message: string, attestation: string): Promise<string> {
  const mt = new Contract(CCTP_V2.messageTransmitter, MESSAGE_TRANSMITTER_ABI, signer)
  const tx = await mt.receiveMessage(getBytes(message), getBytes(attestation))
  await tx.wait()
  return tx.hash
}
