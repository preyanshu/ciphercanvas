"use client"

import { useState, useEffect } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import TodayView from "@/components/today-view"
import PromptView from "@/components/prompt-view"
import PreviousView from "@/components/previous-view"
import { WalletConnectButton } from "@/components/wallet-connect-button"
import { useWallet } from "@solana/wallet-adapter-react"
import { AnchorProvider, web3 } from "@coral-xyz/anchor"
import { getProgram, fetchProposalsForRound } from "@/lib/contract-utils"

export default function Home() {
  const [activeTab, setActiveTab] = useState("today")
  const { publicKey } = useWallet()
  const isConnected = !!publicKey

  // Fetch proposals on mount - no wallet required
  useEffect(() => {
    const fetchAllProposals = async () => {
      try {
        console.log("🔍 Fetching all proposals on mount...")
        
        // Create connection
        const connection = new web3.Connection("https://api.devnet.solana.com", "confirmed")
        
        // Create a dummy wallet for read-only operations
        const dummyWallet = {
          publicKey: web3.PublicKey.default,
        } as any

        // Create provider
        const provider = new AnchorProvider(connection, dummyWallet, {
          commitment: "confirmed",
        })

        // Get program
        const program = getProgram(provider)

        // Fetch multiple rounds simultaneously using Promise.all
        const roundsToFetch = [0, 1, 2, 3, 4] // You can adjust this based on how many rounds exist
        
        console.log(`📋 Fetching proposals for ${roundsToFetch.length} rounds simultaneously...`)
        
        const proposalPromises = roundsToFetch.map(round => 
          fetchProposalsForRound(program, round)
            .then(proposals => {
              console.log(`✅ Round ${round}: ${proposals.length} proposals`)
              return { round, proposals }
            })
            .catch(error => {
              console.error(`❌ Error fetching round ${round}:`, error)
              return { round, proposals: [], error }
            })
        )
        
        const results = await Promise.all(proposalPromises)
        
        // Log all results
        console.log("📊 All proposals fetched:", results)
        results.forEach((result) => {
          const { round, proposals } = result
          const error = 'error' in result ? result.error : null
          
          if (error) {
            console.error(`Round ${round}: Error - ${error.message}`)
          } else {
            console.log(`Round ${round}: ${proposals.length} proposals`)
            if (proposals.length > 0) {
              console.log(`  Proposals:`, proposals.map(p => `"${p.title}"`).join(", "))
            }
          }
        })
        
        // Total proposals across all rounds
        const totalProposals = results.reduce((sum, { proposals }) => sum + (proposals?.length || 0), 0)
        console.log(`📊 Total proposals across all rounds: ${totalProposals}`)
      } catch (error) {
        console.error("❌ Error fetching proposals:", error)
      }
    }

    fetchAllProposals()
  }, [])

  return (
    <main className="min-h-screen bg-background text-foreground mb-8">
      <header className="border-b border-border/30 sticky top-0 z-50 bg-background/95 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-accent rounded-full"></div>
            <h1 className="text-sm font-bold font-mono tracking-widest text-foreground">CIPHERCANVAS</h1>
          </div>
          <div className="flex items-center gap-6">
            <a href="/rules" className="hidden md:flex text-xs font-mono text-muted-foreground hover:text-foreground transition-colors">
              RULES
            </a>
            <WalletConnectButton />
          </div>
        </div>
      </header>

      <section className="relative border-b border-border/30 overflow-hidden">
        {/* Background Image */}
        <div className="absolute inset-0 z-0">
          <img
            src="/cyberpunk-dragon-neon.jpg"
            alt="Cyberpunk Dragon Background"
            className="w-full h-full object-cover opacity-20"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-background/80 via-background/60 to-background/90"></div>
        </div>
        
        <div className="relative z-10 max-w-7xl mx-auto px-4 pt-16 pb-4 md:pt-20 md:pb-8">
          {/* Main Hero Content */}
          <div className="relative mb-8 -mt-8">
            <div className="text-center space-y-6">
              <div className="flex items-center justify-center mb-6">
                <div className="flex items-center gap-2 px-4 py-2 bg-accent/20 border border-accent/40 rounded-full">
                  <div className="w-2 h-2 bg-foreground rounded-full animate-pulse"></div>
                  <span className="text-sm font-mono text-foreground font-bold tracking-widest">The Autonomous Decentralized Mural</span>
                </div>
              </div>
              
              <h1 className="text-4xl md:text-5xl font-bold font-sans text-foreground tracking-tight text-center relative">
                Community On Chain <span className="text-accent relative inline-block">Mural
                  {/* <img 
                    src="https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExNXljcGo2a3p6MjBwZnEwNm50emd4dDNqdDBvY3E4ZGUzNTZqaHBsNCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9cw/mVfe0ZTGa0qn464HmN/giphy.gif" 
                    alt="Animated Cat" 
                    className="absolute -top-18 -right-6 w-32 h-auto rounded-lg z-10"
                  /> */}
                </span>
              </h1>
              
              <p className="text-base text-muted-foreground font-mono max-w-2xl mx-auto mb-6">
                A blockchain mural powered by Arcium MPC, where art is encrypted, verified, and alive. Privacy has never looked this creative.
              </p>

              {/* CTA Buttons */}
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <button 
                  onClick={() => setActiveTab("prompt")}
                  className="bg-accent hover:bg-accent/90 text-black font-mono text-sm font-bold py-3 px-8 rounded-sm transition-all duration-200 hover:scale-105 shadow-lg"
                >
                  START CREATING NOW
                </button>
                <button 
                  onClick={() => setActiveTab("today")}
                  className="border border-border/30 text-foreground hover:bg-muted/20 font-mono text-sm font-bold py-3 px-8 rounded-sm transition-all duration-200 bg-transparent"
                >
                  EXPLORE TODAY
                </button>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* Navigation Tabs */}
      <div className="flex justify-center py-6 mt-4 border-b border-border/20">
        <div className="flex items-center justify-center gap-2 text-sm font-mono font-bold">
          <button 
            onClick={() => setActiveTab("today")}
            className={`transition-colors px-2 py-1 ${
              activeTab === "today" 
                ? "text-accent" 
                : "text-foreground hover:text-accent/80"
            }`}
          >
            TODAY
          </button>
          <span className="text-muted-foreground">•</span>
          <button 
            onClick={() => setActiveTab("prompt")}
            className={`transition-colors px-2 py-1 ${
              activeTab === "prompt" 
                ? "text-accent" 
                : "text-foreground hover:text-accent/80"
            }`}
          >
            GENERATE
          </button>
          <span className="text-muted-foreground">•</span>
          <button 
            onClick={() => setActiveTab("previous")}
            className={`transition-colors px-2 py-1 ${
              activeTab === "previous" 
                ? "text-accent" 
                : "text-foreground hover:text-accent/80"
            }`}
          >
            MURAL
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-4">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsContent value="today" className="space-y-8">
            <TodayView />
          </TabsContent>

          <TabsContent value="prompt" className="space-y-8">
            <PromptView />
          </TabsContent>

          <TabsContent value="previous" className="space-y-8">
            <PreviousView />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  )
}
