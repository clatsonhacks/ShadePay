import { StubPage } from "@/components/ui/stub-page"

export default function ReceiptsPage() {
  return (
    <StubPage
      title="Receipts · past runs"
      subtitle="Persisted arcscan hashes for every stream + settle"
      body="Lists live runs of StreamPay and shielded-net settles. Backed by `provider.getLogs` over the deployed contracts. The docs already carry the base-rail run — see `docs/testnet-transactions.md`."
    />
  )
}
