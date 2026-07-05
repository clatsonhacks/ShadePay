"use client"

import type React from "react"
import Link from "next/link"
import { useRouter, usePathname } from "next/navigation"
import { useEffect } from "react"
import { usePrivy } from "@privy-io/react-auth"
import { useHealth } from "@/lib/hooks"
import { GlyphMatrix } from "@/components/ui/glyph-matrix"

const NAV = [
  { href: "/demo",     label: "Demo" },
  { href: "/bridge",   label: "Bridge" },
  { href: "/stream",   label: "Stream" },
  { href: "/service",  label: "Service" },
  { href: "/receipts", label: "Receipts" },
]

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, logout } = usePrivy()
  const router = useRouter()
  const pathname = usePathname()
  const health = useHealth()

  useEffect(() => {
    if (ready && !authenticated) router.replace("/")
  }, [ready, authenticated, router])

  if (!ready) return <FullScreenNote text="loading…" />
  if (!authenticated) return <FullScreenNote text="redirecting…" />

  return (
    <div className="relative z-0 min-h-screen" style={{ background: "#050505" }}>
      <GlyphMatrix
        color="#3b82f6"
        cellSize={14}
        mutationRate={0.05}
        interval={100}
        fadeBottom={0.4}
        className="fixed inset-0 z-0 opacity-70"
      />

      <div className="relative z-10">
      <header className="sticky top-0 z-40 bg-black/60 backdrop-blur-md">
        <div className="flex items-center justify-between px-8 py-4">
          <Link href="/" className="font-sans text-2xl font-light tracking-tight transition-opacity hover:opacity-80" style={{ color: "#EDEAE3" }}>
            SHADE
          </Link>
          <nav className="hidden items-center gap-6 md:flex">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={`font-mono text-xs uppercase tracking-wider transition-colors ${
                  pathname?.startsWith(n.href) ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground sm:flex">
              <span className={`h-1.5 w-1.5 rounded-full ${health.data?.ok ? "bg-emerald-400" : "bg-red-400"}`} />
              testnet
            </span>
            <button
              onClick={() => logout()}
              className="rounded-full border border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              Disconnect
            </button>
          </div>
        </div>
        {/* skinny grey glow line, left → right */}
        <div className="h-px w-full bg-gradient-to-r from-transparent via-white/25 to-transparent" />
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
      </div>
    </div>
  )
}

function FullScreenNote({ text }: { text: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center" style={{ background: "#050505" }}>
      <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">{text}</span>
    </div>
  )
}
