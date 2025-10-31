"use client"

import { useState, useEffect } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import EligibilityModal from "@/components/eligibility-modal"
import EligibilityCheck from "@/components/eligibility-check"
import { Gift } from "lucide-react"
import { AnchorProvider, web3 } from "@coral-xyz/anchor"
import { useConnection } from "@solana/wallet-adapter-react"
import { getProgram, fetchRoundHistoryWithWinner, fetchProposalsForRound } from "@/lib/contract-utils"
import { Skeleton } from "@/components/ui/skeleton"

// Helper function to validate if a URL is valid and not an example URL
function isValidImageUrl(url: string | undefined): boolean {
  if (!url) return false
  
  // Check if it's an example URL
  if (url.includes('example.com')) return false
  
  // Check if it's a valid URL
  try {
    const parsedUrl = new URL(url)
    // Check if it's HTTPS or HTTP
    return parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:'
  } catch {
    return false
  }
}

interface PreviousArtwork {
  id: number
  date: string
  theme: string
  title: string
  artist: string
  votes: number
  image: string
  url?: string
}

export default function PreviousView() {
  const [selectedArtwork, setSelectedArtwork] = useState<PreviousArtwork | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [artworks, setArtworks] = useState<PreviousArtwork[]>([])
  const [isLoading, setIsLoading] = useState(true)
  
  const { connection } = useConnection()

  const openEligibilityModal = (artwork: PreviousArtwork) => {
    setSelectedArtwork(artwork)
    setIsModalOpen(true)
  }

  const closeModal = () => {
    setIsModalOpen(false)
    setSelectedArtwork(null)
  }

  useEffect(() => {
    const fetchPreviousRounds = async () => {
      setIsLoading(true)
      try {
        console.log("🔍 Fetching previous rounds...")
        
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

        // Get current round from round metadata
        const [roundMetadataPDA] = web3.PublicKey.findProgramAddressSync(
          [Buffer.from("round_metadata")],
          program.programId
        )
        const roundMetadata = await (program.account as any).roundMetadataAccount.fetch(roundMetadataPDA)
        const currentRound = roundMetadata.currentRound.toNumber()
        
        console.log(`📊 Current round: ${currentRound}`)
        
        // Fetch previous rounds (all rounds before current round)
        const rounds = []
        
        // Start from round 0 and go up to (currentRound - 1)
        // Only fetch rounds that have history (i.e., rounds that have completed)
        let roundId = 0
        while (roundId < currentRound) {
          try {
            const roundData = await fetchRoundHistoryWithWinner(program, roundId)
            if (roundData && roundData.winningProposal) {
              const revealedAt = new Date(roundData.revealedAt * 1000)
              const month = revealedAt.toLocaleString('default', { month: 'short' })
              const day = revealedAt.getDate()
              
              const artwork: PreviousArtwork = {
                id: roundId,
                date: `${month} ${day}`,
                theme: roundData.theme || "Previous Theme", // Theme from round history
                title: roundData.winningProposal.title || "Untitled", // title field from proposal
                artist: roundData.winningProposal.description || "Unknown", // description field from proposal (contains artist name)
                votes: roundData.winningProposal.voteCount || 0,
                image: isValidImageUrl(roundData.winningProposal.url) 
                  ? roundData.winningProposal.url 
                  : "/placeholder.svg",
                url: roundData.winningProposal.url,
              }
              
              rounds.push(artwork)
              console.log(`✅ Fetched round ${roundId}:`, artwork)
            }
          } catch (error) {
            console.log(`❌ Round ${roundId} not found or no history yet`)
            // Continue to next round instead of breaking
          }
          
          roundId++
        }
        
        // Reverse the array so latest rounds appear first
        rounds.reverse()
        setArtworks(rounds)
        console.log(`📊 Fetched ${rounds.length} previous rounds (latest first)`)
      } catch (error) {
        console.error("❌ Error fetching previous rounds:", error)
        setArtworks([]) // Fallback to empty array
      } finally {
        setIsLoading(false)
      }
    }

    fetchPreviousRounds()
  }, [])

  // Get the latest winner (first in the array, if available)
  const latestWinner = artworks.length > 0 ? artworks[0] : null
  const otherWinners = artworks.slice(1)

  return (
    <div className="space-y-8">
      {/* Simple Text Header */}
      <div className="space-y-4 pb-8 border-b border-border/30">
        <div>
          <p className="text-xs font-mono text-muted-foreground tracking-widest mb-2">HALL OF LEGENDS</p>
          <h2 className="text-3xl md:text-4xl font-bold text-foreground font-sans mb-4">CIPHERCANVAS</h2>
          <p className="text-sm font-mono text-muted-foreground">Encrypted winners and the themes they conquered</p>
        </div>
      </div>

      {/* Latest Winner - Special Big Card */}
      {isLoading ? (
        <div className="space-y-4">
          <div className="relative h-[450px]">
            <div className="flex h-full">
              <Skeleton className="w-1/2 h-full bg-muted" />
              <Skeleton className="w-1/2 h-full bg-muted" />
            </div>
          </div>
        </div>
      ) : latestWinner ? (
        <div className="space-y-4">
          <div className="group border border-accent/50 rounded-sm overflow-hidden hover:border-accent/70 transition-colors duration-300 bg-accent/5 relative">
            {/* Card Header - Above Image with Z-Index */}
            <div className="absolute top-4 left-4 z-10">
              <h3 className="text-sm font-bold text-accent font-mono tracking-widest mb-1">YESTERDAY'S WINNER</h3>
              <div className="w-12 h-0.5 bg-accent"></div>
            </div>
            
            <div className="flex h-[450px]">
              {/* Left Side - Square Image */}
              <div className="w-1/2 relative overflow-hidden">
                <img
                  src={latestWinner.image || "/placeholder.svg"}
                  alt={latestWinner.title}
                  className="w-full h-full object-cover object-center group-hover:scale-105 transition-transform duration-300"
                />
                
                {/* Overlay with Details */}
                <div className="absolute inset-0 bg-black/60 flex flex-col justify-end p-6">
                  <div className="text-center">
                    <div className="flex items-center justify-center gap-2 mb-4 flex-wrap">
                      <Badge variant="outline" className="text-xs border-accent/50 text-accent font-mono">
                        {latestWinner.date}
                      </Badge>
                      <Badge variant="secondary" className="text-xs bg-accent/20 text-accent font-mono">
                        {latestWinner.theme}
                      </Badge>
                      <Badge className="text-xs bg-accent text-black font-mono font-bold">
                        WINNER
                      </Badge>
                    </div>
                    <h3 className="font-bold text-2xl text-white font-mono mb-3">{latestWinner.title}</h3>
                    <p className="text-lg text-gray-300 font-mono mb-4">by {latestWinner.artist}</p>
                    
                    <div className="flex items-center justify-center gap-2">
                      <span className="font-mono text-2xl font-bold text-accent">{latestWinner.votes.toLocaleString()}</span>
                      <span className="text-lg text-gray-300 font-mono">votes</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right Side - Eligibility Check */}
              <div className="w-1/2 flex items-center justify-center p-8">
                <div className="w-full">
                  <EligibilityCheck artwork={latestWinner} />
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Other Winners */}
      {!isLoading && latestWinner && (
        <div className="space-y-4">
          <div className="space-y-3">
            {otherWinners.length > 0 ? (
              otherWinners.map((artwork, index) => (
                <div
                  key={artwork.id}
                  className="group border border-border/30 rounded-sm overflow-hidden hover:border-accent/50 transition-colors duration-300"
                >
                  <div className="flex gap-4 p-4 bg-muted/10 hover:bg-muted/20 transition-colors duration-300">
                    <div className="relative w-20 h-20 rounded-sm overflow-hidden flex-shrink-0 border border-border/30">
                      <img
                        src={artwork.image || "/placeholder.svg"}
                        alt={artwork.title}
                        className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300"
                      />
                    </div>

                    <div className="flex-1 flex flex-col justify-between min-w-0">
                      <div>
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <Badge variant="outline" className="text-xs border-border/50 text-muted-foreground">
                            {artwork.date}
                          </Badge>
                          <Badge variant="secondary" className="text-xs bg-muted/30 text-foreground">
                            {artwork.theme}
                          </Badge>
                        </div>
                        <h3 className="font-bold text-sm text-foreground line-clamp-1">{artwork.title}</h3>
                        <p className="text-xs text-muted-foreground">by {artwork.artist}</p>
                      </div>

                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-bold text-accent">{artwork.votes.toLocaleString()}</span>
                          <span className="text-xs text-muted-foreground">votes</span>
                        </div>
                        
                        <Button
                          onClick={() => openEligibilityModal(artwork)}
                          variant="outline"
                          size="sm"
                          className="border-accent/50 text-accent hover:bg-accent/10 font-mono text-xs font-bold"
                        >
                          <Gift className="w-3 h-3 mr-1" />
                          CHECK REWARDS
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              ))
            ) : null}
          </div>
        </div>
      )}

      {/* Show single "No mural found" message when loading is done and no artworks */}
      {!isLoading && !latestWinner && (
        <div className="text-center py-12">
          <p className="text-mono text-muted-foreground">No past winners yet</p>
        </div>
      )}

      {/* Eligibility Modal */}
      {selectedArtwork && (
        <EligibilityModal
          artwork={selectedArtwork}
          isOpen={isModalOpen}
          onClose={closeModal}
        />
      )}
    </div>
  )
}
