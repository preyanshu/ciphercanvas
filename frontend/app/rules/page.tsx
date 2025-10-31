"use client"

import Link from "next/link"

export default function RulesPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/30 sticky top-0 z-50 bg-background/95 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-accent rounded-full"></div>
            <h1 className="text-sm font-bold font-mono tracking-widest text-foreground">CIPHERCANVAS</h1>
            <span className="text-xs font-mono font-bold text-accent opacity-60">RULES</span>
          </div>
          <div className="flex items-center gap-6">
            <Link href="/" className="text-xs font-mono text-muted-foreground hover:text-foreground transition-colors">HOME</Link>
          </div>
        </div>
      </header>

      <section className="max-w-3xl mx-auto px-6 py-10 space-y-8">
        <div className="space-y-2">
          <p className="text-xs font-mono text-muted-foreground tracking-widest">GUIDELINES</p>
          <h2 className="text-3xl font-bold font-sans">Community Rules</h2>
          <p className="text-sm font-mono text-muted-foreground">Short, simple and fair. Please read before creating or voting.</p>
        </div>

        <div className="space-y-6">
          <div className="space-y-2">
            <h3 className="text-sm font-bold font-mono">1. Daily Theme</h3>
            <p className="text-sm font-mono text-muted-foreground">Each round has a single theme. Your prompt and artwork should relate to it.</p>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-bold font-mono">2. Original Prompts</h3>
            <p className="text-sm font-mono text-muted-foreground">Submit only prompts you created. No copyrighted or harmful material.</p>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-bold font-mono">3. One Vote Per Round</h3>
            <p className="text-sm font-mono text-muted-foreground">You can support one artwork per round. Your choice stays private.</p>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-bold font-mono">4. Fair Play</h3>
            <p className="text-sm font-mono text-muted-foreground">No spam, bots or brigading. Respect creators and the community.</p>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-bold font-mono">5. Winner & Rewards</h3>
            <p className="text-sm font-mono text-muted-foreground">Winners are revealed on chain. Rewards are distributed automatically to winners and eligible voters.</p>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-bold font-mono">6. Privacy & Integrity</h3>
            <p className="text-sm font-mono text-muted-foreground">Creation and voting flows use privacy tech; results and proofs are verifiable on chain.</p>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-bold font-mono">7. Transparency</h3>
            <p className="text-sm font-mono text-muted-foreground">All program logic runs permissionlessly. No one can alter votes, winners or payouts.</p>
          </div>
        </div>

        <div className="pt-6">
          <Link href="/" className="text-xs font-mono underline">Back to Mural</Link>
        </div>
      </section>
    </main>
  )
}





