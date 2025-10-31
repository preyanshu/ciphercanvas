"use client"

import { useState, useEffect } from "react"
import ThemeDisplay from "./theme-display"
import CommunityVoting from "./community-voting"
import { AnchorProvider, web3, BN } from "@coral-xyz/anchor"
import { Connection, PublicKey, Transaction } from "@solana/web3.js"
import { useConnection, useWallet } from "@solana/wallet-adapter-react"
import { getProgram, fetchProposalsForRound, checkVoteReceipt, voteOnProposal } from "@/lib/contract-utils"
import toast from "react-hot-toast"
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

// Helper function to get image - use URL if valid, otherwise use random image
function getImageForProposal(url: string | undefined, title: string): string {
  if (url && isValidImageUrl(url)) {
    return url
  }
  
  const images = [
    "/cyberpunk-dragon-neon.jpg",
    "/phoenix-digital-art-neon.jpg",
    "/cyberpunk-serpent-neon-glow.jpg",
    "/dragon-protocol-cyberpunk.jpg",
  ]
  // Use title as seed for consistent images
  const index = title.length % images.length
  return images[index]
}

// Helper function to convert byte array to string
function bytesToString(bytes: Uint8Array): string {
  // Check if all bytes are zeros
  const isEmpty = bytes.every(byte => byte === 0)
  if (isEmpty) {
    return "Open Theme"
  }
  
  // Find the first null byte (0) to determine the actual string length
  let length = 0
  while (length < bytes.length && bytes[length] !== 0) {
    length++
  }
  
  // Convert to string
  const decoder = new TextDecoder('utf-8')
  return decoder.decode(bytes.slice(0, length))
}

// Get current round from metadata
async function getCurrentRound(program: any): Promise<number> {
  try {
    const [roundMetadataPDA] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("round_metadata")],
      program.programId
    )
    
    const roundMetadata = await (program.account as any).roundMetadataAccount.fetch(roundMetadataPDA)
    return roundMetadata.currentRound.toNumber()
  } catch (error) {
    console.error("Error fetching current round:", error)
    return 0 // Default to round 0
  }
}

interface Artwork {
  id: number
  title: string
  artist: string
  votes: number
  image: string
  voted: boolean
}

export default function TodayView() {
  const [artworks, setArtworks] = useState<Artwork[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [votingArtworkId, setVotingArtworkId] = useState<number | null>(null)
  const [hasVotedThisRound, setHasVotedThisRound] = useState(false)
  const [countdown, setCountdown] = useState<string | null>(null)
  const [currentTheme, setCurrentTheme] = useState<string>("")
  const [currentRound, setCurrentRound] = useState<number | null>(null)
  
  // Use Wallet Adapter
  const { connection } = useConnection()
  const { publicKey, wallet } = useWallet()
  const isConnected = !!publicKey
  
  // Get storage key for current wallet and round
  const getStorageKey = (roundId: number): string => {
    if (!publicKey) return ''
    return `likedArtworks_${publicKey.toString()}_round_${roundId}`
  }
  
  // Get liked artworks from localStorage for current wallet and specific round
  const getLikedArtworks = (roundId: number): number[] => {
    if (typeof window === 'undefined' || !publicKey) return []
    const storageKey = getStorageKey(roundId)
    const liked = localStorage.getItem(storageKey)
    return liked ? JSON.parse(liked) : []
  }
  
  // Save liked artwork to localStorage for current wallet and round
  const saveLikedArtwork = (artworkId: number, roundId: number) => {
    if (typeof window === 'undefined' || !publicKey) return
    const storageKey = getStorageKey(roundId)
    const liked = getLikedArtworks(roundId)
    if (!liked.includes(artworkId)) {
      liked.push(artworkId)
      localStorage.setItem(storageKey, JSON.stringify(liked))
    }
  }

  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null
    
    const fetchProposals = async () => {
      setIsLoading(true)
      try {
        console.log("🔍 Fetching current round proposals...")
        
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

        // Get current round
        const fetchedCurrentRound = await getCurrentRound(program)
        console.log("📅 Current round:", fetchedCurrentRound)
        setCurrentRound(fetchedCurrentRound)

        // Fetch round metadata to get round start timestamp
        const [roundMetadataPDA] = web3.PublicKey.findProgramAddressSync(
          [Buffer.from("round_metadata")],
          program.programId
        )
        
        const roundMetadata = await (program.account as any).roundMetadataAccount.fetch(roundMetadataPDA)
        const roundStartedTimestamp = roundMetadata.roundStarted.toNumber()
        
        // Fetch and set theme
        const themeBytes = new Uint8Array(roundMetadata.theme)
        const theme = bytesToString(themeBytes)
        setCurrentTheme(theme || "Open Theme") // Fallback to default theme
        
        // Calculate end time (24 hours from start)
        const roundEndTime = roundStartedTimestamp + (24 * 60 * 60) // Add 24 hours in seconds
        
        // Calculate and set countdown
        const updateCountdown = () => {
          const now = Math.floor(Date.now() / 1000) // Current time in seconds
          const remaining = roundEndTime - now
          
          if (remaining <= 0) {
            setCountdown("Round ended")
            if (intervalId) {
              clearInterval(intervalId)
            }
            return
          }
          
          const hours = Math.floor(remaining / 3600)
          const minutes = Math.floor((remaining % 3600) / 60)
          const seconds = remaining % 60
          
          setCountdown(`${hours}h ${minutes}m ${seconds}s`)
        }
        
        // Initial update
        updateCountdown()
        
        // Update every second
        intervalId = setInterval(updateCountdown, 1000)

        // Fetch proposals for current round
        const proposals = await fetchProposalsForRound(program, fetchedCurrentRound)
        
        console.log("✅ Fetched proposals:", proposals)
        
        // Map proposals to artwork format
        let mappedArtworks = proposals.map((proposal) => ({
          id: proposal.id,
          title: proposal.description, // description as image name
          artist: proposal.title, // title as artist name
          votes: proposal.voteCount?.toNumber() || 0,
          image: getImageForProposal(proposal.url, proposal.title),
          voted: false, // Will be updated from localStorage if available
        }))
        
        // Restore voted state from localStorage if wallet is connected and currentRound is available
        if (isConnected && publicKey && fetchedCurrentRound !== null) {
          const likedArtworks = getLikedArtworks(fetchedCurrentRound)
          if (likedArtworks.length > 0) {
            console.log(`📦 Restoring voted state from localStorage for round ${fetchedCurrentRound}:`, likedArtworks)
            mappedArtworks = mappedArtworks.map(art => ({
              ...art,
              voted: likedArtworks.includes(art.id)
            }))
            setHasVotedThisRound(true)
          }
        }
        
        setArtworks(mappedArtworks)
        console.log("📊 Mapped artworks:", mappedArtworks)
      } catch (error) {
        // If theme loading failed, set it to "Open Theme"
        setCurrentTheme("Open Theme")
        console.error("❌ Error fetching proposals:", error)
        setArtworks([]) // Set empty array on error
      } finally {
        setIsLoading(false)
      }
    }

    fetchProposals()
    
    // Cleanup function
    return () => {
      if (intervalId) {
        clearInterval(intervalId)
      }
    }
  }, [isConnected, publicKey]) // Re-fetch when wallet connection changes

  // Check if user has already voted in this round and load localStorage data
  useEffect(() => {
    const checkVoted = async () => {
      if (!isConnected || !publicKey || currentRound === null) {
        setHasVotedThisRound(false)
        return
      }

      try {
        console.log(`🔍 Checking if user has voted in round ${currentRound}...`)
        
        // Check localStorage first - if this wallet has voted in this specific round
        const likedArtworks = getLikedArtworks(currentRound)
        
        if (likedArtworks.length > 0) {
          console.log(`📦 Found votes in localStorage for round ${currentRound}:`, likedArtworks)
          // User has voted in this round, disable all votes
          setHasVotedThisRound(true)
          // Mark only the specific voted artwork as liked
          setArtworks(prev => prev.map(art => ({ 
            ...art, 
            voted: likedArtworks.includes(art.id)
          })))
          return
        }
        
        // If nothing in localStorage, check on-chain
        console.log("🔗 No localStorage data, checking on-chain...")
        
        // Create provider with wallet adapter wallet (read-only check)
        const provider = new AnchorProvider(connection, {
          publicKey: publicKey,
          signTransaction: async () => { throw new Error("Read-only") },
          signAllTransactions: async () => { throw new Error("Read-only") },
        } as any, {
          commitment: "confirmed",
        })

        const program = getProgram(provider)
        
        const hasVoted = await checkVoteReceipt(program, publicKey)
        setHasVotedThisRound(hasVoted)
        
        if (hasVoted) {
          console.log("✅ User has already voted in this round (on-chain)")
          // Don't update artwork voted state - just disable voting
        }
      } catch (error) {
        console.error("Error checking vote:", error)
      }
    }

    checkVoted()
  }, [isConnected, publicKey, connection, currentRound])
  
  // Restore voted state when artworks are set (if wallet is connected but state wasn't restored during fetch)
  useEffect(() => {
    if (isConnected && publicKey && currentRound !== null && artworks.length > 0) {
      const likedArtworks = getLikedArtworks(currentRound)
      if (likedArtworks.length > 0) {
        // Check if any artwork needs to have voted state restored
        const needsUpdate = artworks.some(art => {
          const shouldBeVoted = likedArtworks.includes(art.id)
          return shouldBeVoted !== art.voted
        })
        
        if (needsUpdate) {
          console.log(`📦 Restoring voted state in artworks update for round ${currentRound}`)
          setArtworks(prev => prev.map(art => ({ 
            ...art, 
            voted: likedArtworks.includes(art.id)
          })))
          setHasVotedThisRound(true)
        }
      }
    }
  }, [artworks.length, isConnected, publicKey, currentRound])

  const handleVote = async (id: number) => {
    if (!isConnected) {
      toast.error("Please connect your wallet to vote", {
        duration: 3000,
        style: {
          background: "#fef2f2",
          color: "#dc2626",
          border: "1px solid #fca5a5",
          fontFamily: "monospace",
          fontSize: "14px",
          fontWeight: "bold",
        },
      })
      return
    }

    if (hasVotedThisRound) {
      toast("Already voted in this round", {
        icon: "ℹ️",
        duration: 2000,
        style: {
          fontFamily: "monospace",
          fontSize: "14px",
        },
      })
      return
    }

    if (!isConnected || !publicKey) {
      toast.error("Wallet not connected")
      return
    }

    setVotingArtworkId(id)
    
    try {
      console.log(`🗳️ Voting on proposal ${id}`)
      
      // First check if the user has already voted in this round
      console.log("🔍 Checking if user has already voted in this round...")
      
      try {
        const provider = new AnchorProvider(connection, {
          publicKey: publicKey,
          signTransaction: async () => { throw new Error("Read-only") },
          signAllTransactions: async () => { throw new Error("Read-only") },
        } as any, {
          commitment: "confirmed",
        })

        const program = getProgram(provider)
        const hasAlreadyVoted = await checkVoteReceipt(program, publicKey)
        
        if (hasAlreadyVoted) {
          console.log("⚠️ User has already voted in this round")
          toast.error("You have already voted in this round", {
            id: "already-voted",
            duration: 3000,
            style: {
              background: "#fef2f2",
              color: "#dc2626",
              border: "1px solid #fca5a5",
              fontFamily: "monospace",
              fontSize: "14px",
              fontWeight: "bold",
            },
          })
          return
        }
      } catch (checkError) {
        console.error("Error checking vote receipt:", checkError)
        // Continue with vote anyway if check fails
      }
      
      console.log("✅ User has not voted yet, proceeding with vote...")
      
      // Don't show toast, just show spinner in UI
      
      if (!wallet) {
        throw new Error("Wallet not available")
      }

      // For now, let's skip the Anchor provider approach
      // and use a mock wallet that will return the instruction
      const adapterWallet = {
        publicKey: publicKey,
      } as any

      const provider = new AnchorProvider(connection, adapterWallet, {
        commitment: "confirmed",
      })
      
      // Get program
      const program = getProgram(provider)
      
      // Get MXE public key
      const { getMXEKey } = await import("@/lib/contract-utils")
      const mxePublicKey = await getMXEKey(provider, program.programId)
      
      if (!mxePublicKey) {
        throw new Error("Failed to get MXE public key")
      }
      
      // Prepare signMessage function if wallet adapter supports it
      // signMessage is available on adapters that implement SignerMessage interface
      const signMessageFn = wallet?.adapter && 'signMessage' in wallet.adapter
        ? async (message: Uint8Array): Promise<Uint8Array> => {
            const adapter = wallet.adapter as any
            if (typeof adapter.signMessage !== 'function') {
              throw new Error("Wallet does not support signMessage")
            }
            const signature = await adapter.signMessage(message)
            return signature
          }
        : undefined

      // Call voteOnProposal using Anchor - this will now return an instruction and voteData
      const { instruction, voteData } = await voteOnProposal(
        program, 
        publicKey, 
        id, 
        mxePublicKey,
        signMessageFn,
        (error: string) => {
          throw new Error(error)
        }
      )
      
      // Build and send the transaction
      const transaction = new Transaction()
      transaction.add(instruction)
      
      const { blockhash } = await connection.getLatestBlockhash('confirmed')
      transaction.recentBlockhash = blockhash
      transaction.feePayer = publicKey
      
      // Send the transaction using wallet adapter's sendTransaction
      if (!wallet.adapter || !wallet.adapter.sendTransaction) {
        throw new Error("Wallet adapter sendTransaction not available")
      }
      
      const signature = await wallet.adapter.sendTransaction(transaction, connection, { skipPreflight: false })
      await connection.confirmTransaction(signature)
      
      // Do not persist "already voted" state in localStorage.
      // Optionally store vote data in memory only; skip localStorage writes.
      
      // Update UI - mark only the voted artwork as liked, disable all votes
      setHasVotedThisRound(true)
      setArtworks(prev => prev.map(art => ({ 
        ...art, 
        voted: art.id === id 
      })))
      
      console.log("✅ Vote successful:", signature)
    } catch (error: any) {
      console.error("❌ Error voting:", error)
      // Show error toast
      toast.error(`Failed to vote: ${error.message}`, {
        id: "voting-error",
        duration: 4000,
        style: {
          background: "#fef2f2",
          color: "#dc2626",
          border: "1px solid #fca5a5",
          fontFamily: "monospace",
          fontSize: "14px",
          fontWeight: "bold",
        },
      })
    } finally {
      setVotingArtworkId(null)
    }
  }

  return (
    <div className="space-y-8">
      <ThemeDisplay currentTheme={currentTheme} countdown={countdown} isLoading={isLoading} />

      <div className="space-y-4">
        <div>
          <p className="text-sm font-mono text-muted-foreground">Pick your favorite creation and tap the heart</p>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="space-y-3">
                <Skeleton className="aspect-square w-full rounded-sm" />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
                <div className="flex justify-end">
                  <Skeleton className="h-8 w-8 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : artworks.length > 0 ? (
          <>
            <CommunityVoting artworks={artworks} onVote={handleVote} hasVoted={hasVotedThisRound} votingArtworkId={votingArtworkId} />
          </>
        ) : (
          <div className="text-center py-12">
            <p className="text-mono text-muted-foreground">No artworks yet. Be the first to create!</p>
          </div>
        )}
      </div>
    </div>
  )
}
