import Link from "next/link"
import { ArrowLeft, Construction } from "lucide-react"

export function StubPage({ title, subtitle, body }: { title: string; subtitle: string; body: string }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6 py-16">
      <Link
        href="/demo"
        className="inline-flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> back to demo
      </Link>
      <div className="rounded-xl border border-border bg-black/30 p-8 backdrop-blur-sm">
        <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-amber-300/80">
          <Construction className="h-4 w-4" /> not built yet · slice pending
        </p>
        <h1 className="mt-4 font-sans text-3xl font-light tracking-tight" style={{ color: "#EDEAE3" }}>
          {title}
        </h1>
        <p className="mt-2 font-mono text-xs uppercase tracking-wider text-foreground/70">{subtitle}</p>
        <p className="mt-6 font-mono text-sm leading-relaxed text-foreground/80">{body}</p>
      </div>
    </div>
  )
}
