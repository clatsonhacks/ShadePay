import { StubPage } from "@/components/ui/stub-page"

export default function BridgePage() {
  return (
    <StubPage
      title="Bridge · Base Sepolia → Arc"
      subtitle="Circle CCTP v2 · burn on Base, Iris attestation, mint on Arc"
      body="The browser UI for the cross-chain leg lives here. The CLI equivalent runs today — see `packages/arc-actions/src/cctp-bridge-demo.ts` and `npm run cctp-bridge:arc`."
    />
  )
}
