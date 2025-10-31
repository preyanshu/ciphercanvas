"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { CheckCircle, XCircle, Loader2, Gift, Coins } from "lucide-react"
import { useConnection, useWallet } from "@solana/wallet-adapter-react"
import { AnchorProvider, web3 } from "@coral-xyz/anchor"
import { getProgram, checkWalletSubmittedWinningProposal, fetchRoundHistoryWithWinner, getRoundEscrowBalance, buildVerifyWinningVoteInstruction, buildClaimRewardInstruction, getMXEKey, checkVoteReceiptWinnerFlag, pollVoteReceiptWinnerFlag } from "@/lib/contract-utils"
import toast from "react-hot-toast"

interface Artwork {
  id: number
  title: string
  artist: string
  votes: number
  image: string
  date: string
  theme: string
}

interface EligibilityData {
  isEligible: boolean
  rewardAmount: number
  submittedWinner?: boolean
  nftName: string
  nftImage: string
  requirements: string[]
  userStats: {
    artworksCreated: number
    votesCast: number
    daysActive: number
  }
}

interface EligibilityModalProps {
  artwork: Artwork
  isOpen: boolean
  onClose: () => void
}

export default function EligibilityModal({ artwork, isOpen, onClose }: EligibilityModalProps) {
  const { connection } = useConnection()
  const { publicKey, wallet } = useWallet()
  const [isChecking, setIsChecking] = useState(false)
  const [eligibilityData, setEligibilityData] = useState<EligibilityData | null>(null)
  const [hasChecked, setHasChecked] = useState(false)

  const checkEligibility = async () => {
    if (!publicKey) {
      toast.error("Please connect your wallet first", {
        style: {
          fontFamily: 'monospace',
        }
      })
      return
    }

    setIsChecking(true)
    
    try {
      // Create provider and program
      const dummyWallet = {
        publicKey: web3.PublicKey.default,
      } as any
      const provider = new AnchorProvider(connection, dummyWallet, {
        commitment: "confirmed",
      })
      const program = getProgram(provider)

      // Check if wallet submitted the WINNING artwork for this round
      // artwork.id is the round ID
      const hasSubmitted = await checkWalletSubmittedWinningProposal(program, publicKey, artwork.id)
      
      let hasVotedForWinner = false
      let eligibilityReason = ""
      let winnerShareSol: number | null = null
      let voterShareSol: number | null = null
      
      if (!hasSubmitted) {
        // For voters: Check eligibility by verifying vote
        if (!wallet?.adapter || !('signMessage' in wallet.adapter)) {
          console.log(`❌ Wallet does not support signMessage - cannot verify vote on-chain`)
        } else {
          try {
            const { getMXEKey, checkVoteReceiptWinnerFlag, checkWalletVotedForWinningProposal, buildVerifyWinningVoteInstruction, pollVoteReceiptWinnerFlag } = await import("@/lib/contract-utils")
            const mxePublicKey = await getMXEKey(provider, program.programId)
            
            if (mxePublicKey) {
              console.log(`\n🔍 === CHECKING ELIGIBILITY FOR VOTER ===`);
              console.log(`   Round ID: ${artwork.id}`);
              
              // STEP 1: First check if is_winner flag is already true
              const isWinnerAlreadyTrue = await checkVoteReceiptWinnerFlag(
                connection,
                program.programId,
                publicKey,
                artwork.id
              )
              
              if (isWinnerAlreadyTrue) {
                console.log(`✅ is_winner flag is already TRUE - voter is eligible!`)
                hasVotedForWinner = true
              } else {
                console.log(`⚠️ is_winner flag is FALSE - need to verify and set it`)
                
                // STEP 2: Manually verify (decrypt) that they voted for winning proposal
                const signMessageFn = async (message: Uint8Array): Promise<Uint8Array> => {
                  const adapter = wallet.adapter as any
                  return await adapter.signMessage(message)
                }
                
                console.log(`\n🔐 === MANUALLY VERIFYING VOTE (DECRYPT) ===`);
                const manuallyVerified = await checkWalletVotedForWinningProposal(
                  program,
                  publicKey,
                  artwork.id,
                  signMessageFn,
                  mxePublicKey
                )
                
                if (!manuallyVerified) {
                  console.log(`❌ Manual verification failed - did not vote for winning proposal`)
                  hasVotedForWinner = false
                } else {
                  console.log(`✅ Manual verification passed - voted for winning proposal`)
                  console.log(`\n📤 === CALLING verifyWinningVote TRANSACTION ===`);
                  
                  // STEP 3: Call verifyWinningVote transaction
                  // Try to retrieve stored vote data (convenience, not required)
                  let storedVoteData: any = null
                  try {
                    const voteDataKey = `voteData_${publicKey.toString()}_round_${artwork.id}`
                    const stored = localStorage.getItem(voteDataKey)
                    if (stored) {
                      const parsed = JSON.parse(stored)
                      storedVoteData = {
                        voter: parsed.voter,
                        pda: new web3.PublicKey(parsed.pda),
                        round: parsed.round,
                        proposalId: parsed.proposalId,
                        encryptedVote: new Uint8Array(parsed.encryptedVote),
                        voteEncryptionPubkey: new Uint8Array(parsed.voteEncryptionPubkey),
                        voteNonce: new Uint8Array(parsed.voteNonce),
                        timestamp: parsed.timestamp
                      }
                    }
                  } catch (e) {
                    console.log('Could not retrieve stored vote data, will reconstruct deterministically:', e)
                  }
                  
                  // Build and send verifyWinningVote transaction
                  const { instruction: verifyIx } = await buildVerifyWinningVoteInstruction(
                    program,
                    publicKey,
                    artwork.id,
                    signMessageFn,
                    mxePublicKey,
                    storedVoteData
                  )
                  
                  const verifyTx = new web3.Transaction()
                  verifyTx.add(verifyIx)
                  const { blockhash } = await connection.getLatestBlockhash('confirmed')
                  verifyTx.recentBlockhash = blockhash
                  verifyTx.feePayer = publicKey
                  
                  if (!wallet.adapter.sendTransaction) {
                    throw new Error("Wallet adapter sendTransaction not available")
                  }
                  
                  const verifySig = await wallet.adapter.sendTransaction(verifyTx, connection, { 
                    skipPreflight: false,
                    maxRetries: 3
                  })
                  
                  console.log(`✅ Verify transaction sent: ${verifySig}`)
                  await connection.confirmTransaction(verifySig, 'confirmed')
                  console.log(`✅ Verify transaction confirmed`)
                  
                  // STEP 4: Poll for is_winner flag to be set
                  console.log(`⏳ Polling for is_winner flag to be set...`)
                  hasVotedForWinner = await pollVoteReceiptWinnerFlag(
                    connection,
                    program.programId,
                    publicKey,
                    artwork.id,
                    60000, // 60 second timeout
                    2000   // Poll every 2 seconds
                  )
                  
                  if (hasVotedForWinner) {
                    console.log(`✅ is_winner flag is TRUE - voter is eligible!`)
                  } else {
                    console.log(`❌ is_winner flag not set within timeout - voter is not eligible`)
                  }
                }
              }
            } else {
              console.error("❌ Failed to fetch MXE public key")
            }
          } catch (error: any) {
            console.error("❌ Error verifying vote for eligibility:", error)
            // Don't throw - just set hasVotedForWinner to false
            hasVotedForWinner = false
          }
        }
      }

      const isEligible = hasSubmitted || hasVotedForWinner
      eligibilityReason = hasSubmitted 
        ? "Submitted the winning artwork for this round"
        : hasVotedForWinner 
          ? "Voted for the winning artwork in this round"
          : "Not eligible"

      // If the wallet submitted the winning proposal, compute 50% of escrow as SOL share
      if (hasSubmitted) {
        try {
          console.log(`📊 Fetching escrow account for round ${artwork.id} (winner eligibility check)`)
          const { pda, totalCollected, totalDistributed, currentBalance, roundStatus } = await getRoundEscrowBalance(program, artwork.id)
          console.log(`✅ Escrow Account Details (from eligibility check):`)
          console.log(`   - PDA: ${pda.toBase58()}`)
          console.log(`   - Total Collected: ${totalCollected.toString()} lamports`)
          console.log(`   - Total Distributed: ${totalDistributed.toString()} lamports`)
          console.log(`   - Current Balance: ${currentBalance.toString()} lamports`)
          console.log(`   - Round Status: ${roundStatus}`)
          
          // Calculate winner share: 50% of total_collected (NOT current_balance)
          const totalCollectedSol = totalCollected.toNumber() / 1_000_000_000
          winnerShareSol = totalCollectedSol * 0.5
          
          console.log(`   - Total Collected SOL: ${totalCollectedSol.toFixed(9)}`)
          console.log(`   - Winner Share (50%): ${winnerShareSol.toFixed(9)} SOL`)
        } catch (e) {
          console.error("❌ Failed to fetch round escrow for winner share:", e)
        }
      }

      // If voted for winner, compute voter share: 50% of total_collected / total_voters
      if (hasVotedForWinner && !hasSubmitted) {
        try {
          console.log(`📊 Fetching escrow and round history for round ${artwork.id} (voter eligibility check)`)
          const { pda, totalCollected } = await getRoundEscrowBalance(program, artwork.id)
          const roundData = await fetchRoundHistoryWithWinner(program, artwork.id)
          
          if (roundData && roundData.totalVoters > 0) {
            // Calculate voter share: 50% of total_collected / total_voters
            const totalCollectedSol = totalCollected.toNumber() / 1_000_000_000
            const voterPool = totalCollectedSol * 0.5 // 50% pool for voters
            voterShareSol = voterPool / roundData.totalVoters
            
            console.log(`✅ Voter Reward Calculation:`)
            console.log(`   - Total Collected SOL: ${totalCollectedSol.toFixed(9)}`)
            console.log(`   - Voter Pool (50%): ${voterPool.toFixed(9)} SOL`)
            console.log(`   - Total Voters: ${roundData.totalVoters}`)
            console.log(`   - Voter Share: ${voterShareSol.toFixed(9)} SOL`)
          } else {
            console.warn(`⚠️ Round data not found or no voters in round ${artwork.id}`)
          }
        } catch (e) {
          console.error("❌ Failed to fetch voter share:", e)
        }
      }

      const data: EligibilityData = {
        isEligible: isEligible,
        rewardAmount: hasSubmitted ? (winnerShareSol ?? 0) : (voterShareSol ?? 0),
        submittedWinner: hasSubmitted,
        nftName: artwork.title,
        nftImage: artwork.image,
        requirements: [
          "Submitted OR voted for the winning proposal for this round"
        ],
        userStats: {
          artworksCreated: hasSubmitted ? 1 : 0,
          votesCast: hasVotedForWinner ? 1 : 0,
          daysActive: 0
        }
      }
      
      setEligibilityData(data)
      setHasChecked(true)

      if (isEligible) {
        toast.success(`You're eligible! ${eligibilityReason}.`, {
          style: {
            fontFamily: 'monospace',
          }
        })
      } else {
        toast.error("You're not eligible. You need to submit or vote for the winning artwork.", {
          style: {
            fontFamily: 'monospace',
          }
        })
      }
    } catch (error: any) {
      console.error("Error checking eligibility:", error)
      toast.error(`Failed to check eligibility: ${error.message}`, {
        style: {
          fontFamily: 'monospace',
        }
      })
    } finally {
      setIsChecking(false)
    }
  }

  const claimReward = async () => {
    if (!publicKey || !wallet?.adapter) {
      toast.error("Please connect your wallet first", {
        style: {
          fontFamily: 'monospace',
        }
      })
      return
    }

    try {
      setIsChecking(true)
      toast.loading("Claiming reward...", {
        style: {
          fontFamily: 'monospace',
        }
      })

      const dummyWallet = { publicKey: web3.PublicKey.default } as any
      const provider = new AnchorProvider(connection, dummyWallet, { commitment: 'confirmed' })
      const program = getProgram(provider)

      // Determine mode: winner or voter
      const isWinner = eligibilityData?.submittedWinner === true

      // For voters: Verification should have been done during eligibility check
      // Just verify the is_winner flag is still true before claiming
      if (!isWinner) {
        console.log(`\n🔍 === CHECKING is_winner FLAG BEFORE CLAIM (should already be true from eligibility check) ===`);
        const isWinnerFlagSet = await checkVoteReceiptWinnerFlag(
          connection,
          program.programId,
          publicKey,
          artwork.id
        )
        
        console.log(`   is_winner flag: ${isWinnerFlagSet ? '✅ TRUE' : '❌ FALSE'}`);
        
        if (!isWinnerFlagSet) {
          throw new Error('Cannot claim reward - is_winner flag is not set. Please check eligibility first to verify your vote.')
        }
        
        console.log(`✅ is_winner flag confirmed - proceeding to claim reward`);
      }

      // Claim reward (no need to verify again for voters - already verified during eligibility check)
      console.log(`\n💰 === CLAIMING REWARD ===`);
      console.log(`   Round ID: ${artwork.id}`);
      console.log(`   Mode: ${isWinner ? 'Winner' : 'Voter'}`);
      
      const claimIx = await buildClaimRewardInstruction(program, publicKey, artwork.id)

      // Send claim reward transaction
      const claimTx = new web3.Transaction()
      claimTx.add(claimIx)
      const { blockhash: claimBlockhash } = await connection.getLatestBlockhash('confirmed')
      claimTx.recentBlockhash = claimBlockhash
      claimTx.feePayer = publicKey

      if (!wallet.adapter.sendTransaction) {
        throw new Error("Wallet adapter sendTransaction not available")
      }

      console.log(`\n📤 === SENDING CLAIM REWARD TRANSACTION ===`);
      
      const signature = await wallet.adapter.sendTransaction(claimTx, connection, { 
        skipPreflight: false,
        maxRetries: 3
      })
      
      console.log(`✅ === CLAIM TRANSACTION SENT ===`);
      console.log(`   Signature: ${signature}`);
      console.log(`   Waiting for confirmation...`);
      
      await connection.confirmTransaction(signature, 'confirmed')
      
      console.log(`✅ === CLAIM TRANSACTION CONFIRMED ===`);
      console.log(`   Signature: ${signature}`);
      console.log(`   Round ID: ${artwork.id}`);
      
      toast.dismiss()
      toast.success(`Reward claimed successfully! ${isWinner ? '(Winner)' : '(Voter)'}`, {
        style: {
          fontFamily: 'monospace',
        }
      })

      console.log(`✅ Reward claimed: ${signature}`)
    } catch (error: any) {
      console.error("Failed to claim reward:", error)
      toast.dismiss()
      
      let errorMessage = "Failed to claim reward"
      if (error.message?.includes("plugin closed") || error.message?.includes("user rejected")) {
        errorMessage = "Transaction cancelled by user"
      } else if (error.message?.includes("insufficient funds")) {
        errorMessage = "Insufficient funds for transaction"
      } else if (error.message?.includes("VoteMismatch") || error.message?.includes("vote mismatch")) {
        errorMessage = "Vote verification failed - you did not vote for the winning artwork"
      } else if (error.message) {
        errorMessage = `Failed to claim reward: ${error.message}`
      }
      
      toast.error(errorMessage, {
        style: {
          fontFamily: 'monospace',
        }
      })
    } finally {
      setIsChecking(false)
    }
  }

  const handleClose = () => {
    onClose()
    // Reset state when modal closes
    setTimeout(() => {
      setEligibilityData(null)
      setHasChecked(false)
      setIsChecking(false)
    }, 300)
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-center">
            <div className="space-y-1">
              <h3 className="text-lg font-bold text-foreground font-mono">{artwork.title}</h3>
              <p className="text-sm text-muted-foreground font-mono">by {artwork.artist}</p>
              <div className="flex items-center justify-center gap-2">
                <span className="font-mono text-sm font-bold text-accent">{artwork.votes.toLocaleString()}</span>
                <span className="text-xs text-muted-foreground font-mono">votes</span>
              </div>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Artwork Preview - Smaller */}
          <div className="relative w-full h-32 rounded-sm overflow-hidden border border-border/30">
            <img
              src={artwork.image || "/placeholder.svg"}
              alt={artwork.title}
              className="w-full h-full object-cover"
            />
          </div>

          {/* Eligibility Check Section */}
          <div className="space-y-3">
            <div>
              <p className="text-xs font-mono text-muted-foreground tracking-widest mb-1">REWARD ELIGIBILITY</p>
              <p className="text-sm text-muted-foreground font-mono">Check if you're eligible for this artwork's rewards</p>
            </div>

            {!hasChecked ? (
              <div className="border border-border/30 rounded-sm p-4 bg-muted/10">
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 mx-auto bg-accent/20 rounded-full flex items-center justify-center">
                    <Gift className="w-6 h-6 text-accent" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-foreground mb-1 font-mono">CHECK YOUR ELIGIBILITY</h3>
                    <p className="text-xs text-muted-foreground mb-3 font-mono">
                      See if you qualify for this artwork's rewards
                    </p>
                  </div>
                  <Button
                    onClick={checkEligibility}
                    disabled={isChecking}
                    className="bg-accent hover:bg-accent/90 text-black font-mono text-xs font-bold py-2 px-4"
                  >
                    {isChecking ? (
                      <>
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                        CHECKING...
                      </>
                    ) : (
                      "CHECK ELIGIBILITY"
                    )}
                  </Button>
                </div>
              </div>
            ) : eligibilityData ? (
              <div className="space-y-3">
                {eligibilityData.isEligible ? (
                  <div className="border border-accent/50 rounded-sm p-4 bg-accent/5">
                    <div className="flex flex-col items-center">
                      <div className="flex items-center gap-3 mb-4 w-full max-w-xs">
                        <div className="w-8 h-8 bg-green-500/20 rounded-full flex items-center justify-center flex-shrink-0">
                          <CheckCircle className="w-4 h-4 text-green-500" />
                        </div>
                        <div className="text-left">
                          <h3 className="text-sm font-bold text-foreground font-mono">YOU'RE ELIGIBLE</h3>
                          <p className="text-xs text-muted-foreground font-mono">
                            Congratulations! You qualify for this artwork's rewards.
                          </p>
                        </div>
                      </div>
                      
                      {/* Reward Display */}
                      <div className="space-y-3 flex flex-col items-center">
                        <div className="p-3 bg-muted/20 rounded-sm border border-border/30 w-full max-w-xs">
                          <p className="text-xs font-mono text-muted-foreground mb-2 text-left">REWARDS</p>
                          
                          {/* NFT Reward */}
                          <div className="flex items-center gap-3 mb-3">
                            <div className="w-10 h-10 rounded-sm overflow-hidden border border-border/30">
                              <img
                                src={eligibilityData.nftImage}
                                alt={eligibilityData.nftName}
                                className="w-full h-full object-cover"
                              />
                            </div>
                            <div className="flex-1">
                              <h4 className="text-sm font-bold text-foreground font-mono">{eligibilityData.nftName}</h4>
                              <p className="text-xs text-muted-foreground font-mono">1 NFT Artwork</p>
                            </div>
                          </div>

                          {/* SOL Reward */}
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-accent/20 rounded-sm flex items-center justify-center">
                              <Coins className="w-5 h-5 text-accent" />
                            </div>
                            <div className="flex-1">
                              <h4 className="text-sm font-bold text-foreground font-mono">
                                {eligibilityData.rewardAmount > 0 ? `${eligibilityData.rewardAmount.toFixed(4)} SOL` : "0 SOL"}
                              </h4>
                              <p className="text-xs text-muted-foreground font-mono">
                                {eligibilityData.submittedWinner ? "50% of total donations for this round" : "Share of 50% voter pool (split among all voters)"}
                              </p>
                            </div>
                          </div>
                        </div>

                        <Button
                          onClick={claimReward}
                          className="bg-accent hover:bg-accent/90 text-black font-mono text-xs font-bold py-2 px-6"
                        >
                          CLAIM REWARDS
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="border border-red-500/50 rounded-sm p-4 bg-red-500/5">
                    <div className="flex items-start gap-3">
                      <div className="w-8 h-8 bg-red-500/20 rounded-full flex items-center justify-center flex-shrink-0">
                        <XCircle className="w-4 h-4 text-red-500" />
                      </div>
                      <div className="flex-1">
                        <h3 className="text-sm font-bold text-foreground mb-1 font-mono">NOT ELIGIBLE</h3>
                        <p className="text-xs text-muted-foreground mb-3 font-mono">
                          You need to meet the requirements to claim rewards.
                        </p>
                        
                        <div className="space-y-2">
                          <p className="text-xs font-bold text-foreground font-mono">Requirements:</p>
                          <div className="space-y-1">
                            {eligibilityData.requirements.map((requirement, index) => (
                              <div key={index} className="flex items-center gap-2">
                                <div className="w-1.5 h-1.5 bg-muted-foreground rounded-full"></div>
                                <span className="text-xs text-muted-foreground font-mono">{requirement}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
