import { StubPage } from "@/components/ui/stub-page"

export default function ServicePage() {
  return (
    <StubPage
      title="Service · 100 requests, one ZK settle"
      subtitle="Rail B · off-chain vouchers + one Groth16 proof for the private net"
      body="The browser UI for the privacy layer lives here. The CLI equivalent runs today — see `packages/arc-actions/src/agent-service-demo.ts` and `npm run agent-service-demo:arc`."
    />
  )
}
