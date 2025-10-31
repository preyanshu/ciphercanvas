"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { CircularProgress } from "@/components/ui/circular-progress"
import { useImageGeneration } from "@/hooks/use-image-generation"
import { useConnection, useWallet } from "@solana/wallet-adapter-react"
import { AnchorProvider, web3, BN } from "@coral-xyz/anchor"
import { getProgram, submitProposal } from "@/lib/contract-utils"
import { uploadToCloudinary } from "@/lib/cloudinary"
import { Loader2 } from "lucide-react"
import toast from "react-hot-toast"

export default function PromptView() {
  const { imageData, updateImageState, generateImage, isGenerating } = useImageGeneration()
  const { prompt, imageName, generatedImage, progress, promptError } = imageData
  const [artistName, setArtistName] = useState("")
  const [currentTheme, setCurrentTheme] = useState<string>("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [themeLoading, setThemeLoading] = useState<boolean>(true)
  const [themeError, setThemeError] = useState<string>("")
  const [fieldErrors, setFieldErrors] = useState<{
    artistName?: string
    imageName?: string
    generatedImage?: string
  }>({})
  
  // Wallet connection
  const { connection } = useConnection()
  const { publicKey, wallet } = useWallet()
  const isConnected = !!publicKey

  // Helper to convert theme bytes (fixed array) to string
  function bytesToString(bytes: Uint8Array): string {
    const isEmpty = bytes.every((b) => b === 0)
    if (isEmpty) return "Open Theme"
    let length = 0
    while (length < bytes.length && bytes[length] !== 0) length++
    const decoder = new TextDecoder("utf-8")
    return decoder.decode(bytes.slice(0, length))
  }

  // Fetch current theme from round metadata
  useEffect(() => {
    const fetchTheme = async () => {
      setThemeLoading(true)
      setThemeError("")
      try {
        const dummyWallet = { publicKey: web3.PublicKey.default } as any
        const provider = new AnchorProvider(connection, dummyWallet, { commitment: "confirmed" })
        const program = getProgram(provider)
        const [roundMetadataPDA] = web3.PublicKey.findProgramAddressSync(
          [Buffer.from("round_metadata")],
          program.programId
        )
        const roundMetadata = await (program.account as any).roundMetadataAccount.fetch(roundMetadataPDA)
        const themeBytes = new Uint8Array(roundMetadata.theme)
        const themeStr = bytesToString(themeBytes)
        setCurrentTheme(themeStr || "Open Theme")
      } catch (e: any) {
        console.error("Failed to fetch theme:", e)
        setCurrentTheme("Open Theme")
        setThemeError("")
      } finally {
        setThemeLoading(false)
      }
    }
    fetchTheme()
  }, [connection])

  const retryFetchTheme = async () => {
    try {
      setThemeLoading(true)
      setThemeError("")
      const dummyWallet = { publicKey: web3.PublicKey.default } as any
      const provider = new AnchorProvider(connection, dummyWallet, { commitment: "confirmed" })
      const program = getProgram(provider)
      const [roundMetadataPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("round_metadata")],
        program.programId
      )
      const roundMetadata = await (program.account as any).roundMetadataAccount.fetch(roundMetadataPDA)
      const themeBytes = new Uint8Array(roundMetadata.theme)
      const themeStr = bytesToString(themeBytes)
      setCurrentTheme(themeStr || "Open Theme")
    } catch (e) {
      setCurrentTheme("Open Theme")
      setThemeError("")
    } finally {
      setThemeLoading(false)
    }
  }

  const handleGenerate = () => {
    // Ensure the prompt includes today's theme (case-insensitive)
    let ensuredPrompt = prompt
    const theme = (currentTheme || "").trim()
    if (!themeError && theme && theme !== "Open Theme" && !prompt.toLowerCase().includes(theme.toLowerCase())) {
      ensuredPrompt = `${theme}: ${prompt}`.trim()
      updateImageState({ prompt: ensuredPrompt })
    }

    generateImage({ prompt: ensuredPrompt, imageName })
    // Clear generatedImage error when generating
    if (fieldErrors.generatedImage) {
      setFieldErrors(prev => ({ ...prev, generatedImage: undefined }))
    }
  }

  const handleSubmit = async () => {
    if (!isConnected) {
      toast.error("Please connect your wallet to submit", {
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

    // Clear previous errors
    setFieldErrors({})

    // Validate fields and set specific errors
    const errors: typeof fieldErrors = {}
    let hasErrors = false

    if (!artistName.trim()) {
      errors.artistName = "Artist name is required"
      hasErrors = true
    }

    if (!imageName.trim()) {
      errors.imageName = "Image name is required"
      hasErrors = true
    }

    if (!generatedImage) {
      errors.generatedImage = "Please generate an image first"
      hasErrors = true
    }

    if (hasErrors) {
      setFieldErrors(errors)
      return
    }

    setIsSubmitting(true)

    try {
      // Convert image to blob for upload
      const response = await fetch(generatedImage!)
      const imageBlob = await response.blob()

      // Upload to Cloudinary
      console.log("📤 Uploading image to Cloudinary...")
      const imageUrl = await uploadToCloudinary(imageBlob)
      console.log("✅ Image uploaded:", imageUrl)

      // Create provider and program (read-only for instruction building)
      const provider = new AnchorProvider(connection, {
        publicKey: publicKey,
        signTransaction: async () => { throw new Error("Read-only") },
        signAllTransactions: async () => { throw new Error("Read-only") },
      } as any, {
        commitment: "confirmed",
      })

      const program = getProgram(provider)

      // Submit proposal to blockchain using instruction approach
      console.log("📝 Submitting proposal to blockchain...")
      
      // Get current round from round_metadata (required for round_escrow PDA derivation)
      const [roundMetadataPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("round_metadata")],
        program.programId
      )
      
      const roundMetadata = await (program.account as any).roundMetadataAccount.fetch(roundMetadataPDA)
      const currentRound = roundMetadata.currentRound
      console.log(`📅 Current round: ${currentRound.toString()}`)
      
      // Create round escrow PDA using current round from round_metadata
      const roundIdBytes = Buffer.from(currentRound.toArray("le", 8))
      
      const [roundEscrowPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("round_escrow"), roundIdBytes],
        program.programId
      )
      
      console.log(`💰 Round Escrow: ${roundEscrowPDA.toBase58()}`)

      // Derive system account PDA (needed for Anchor to derive proposal_acc)
      const [systemAccPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("proposal_system")],
        program.programId
      )
      
      // Use accountsPartial and let Anchor auto-derive proposal_acc from round_metadata
      // Anchor will derive proposal_acc using seeds:
      // ["proposal", system_acc, round_metadata.current_round, round_metadata.proposals_in_current_round]
      const instruction = await program.methods
        .submitProposal(imageName, artistName, imageUrl)
        .accountsPartial({
          payer: publicKey,
          roundEscrow: roundEscrowPDA,
          roundMetadata: roundMetadataPDA,
          systemAcc: systemAccPDA,
        })
        .instruction()

      // Build and send transaction using wallet adapter
      const { Transaction } = await import("@solana/web3.js")
      const transaction = new Transaction()
      transaction.add(instruction)
      
      // Check if wallet is still connected before sending
      if (!wallet?.adapter?.connected || !publicKey) {
        throw new Error("Wallet is not connected. Please reconnect your wallet.")
      }
      
      if (!wallet?.adapter?.sendTransaction) {
        throw new Error("Wallet adapter sendTransaction not available")
      }
      
      const { blockhash } = await connection.getLatestBlockhash('confirmed')
      transaction.recentBlockhash = blockhash
      transaction.feePayer = publicKey
      
      console.log("📤 Sending transaction to wallet for signing...")
      
      let signature: string
      try {
        signature = await wallet.adapter.sendTransaction(transaction, connection, { 
          skipPreflight: false,
          maxRetries: 3
        })
        
        console.log("⏳ Waiting for transaction confirmation...")
        await connection.confirmTransaction(signature, 'confirmed')
      } catch (txError: any) {
        // Check for wallet-specific errors
        const errorMessage = txError?.message?.toLowerCase() || ''
        
        if (errorMessage.includes('plugin closed') || errorMessage.includes('user rejected') || errorMessage.includes('user cancelled')) {
          throw new Error("Transaction was cancelled. Please try again and approve the transaction in your wallet.")
        } else if (errorMessage.includes('not connected') || errorMessage.includes('disconnected')) {
          throw new Error("Wallet disconnected. Please reconnect your wallet and try again.")
        } else if (errorMessage.includes('insufficient funds') || errorMessage.includes('0x1')) {
          throw new Error("Insufficient SOL balance. Please add more SOL to your wallet.")
        } else {
          throw new Error(txError?.message || "Transaction failed. Please try again.")
        }
      }

      console.log("✅ Proposal submitted successfully:", signature)
      
      toast.success("Artwork submitted successfully!", {
        duration: 4000,
        style: {
          background: "#f0fdf4",
          color: "#166534",
          border: "1px solid #86efac",
          fontFamily: "monospace",
          fontSize: "14px",
          fontWeight: "bold",
        },
      })

      // Reset form
      setArtistName("")
      updateImageState({ imageName: "", prompt: "", generatedImage: null })

    } catch (error: any) {
      console.error("❌ Error submitting proposal:", error)
      
      // Provide user-friendly error messages
      let errorMessage = error.message || "Failed to submit proposal"
      
      // Handle specific error cases
      if (errorMessage.includes("plugin closed") || errorMessage.includes("cancelled")) {
        errorMessage = "Transaction was cancelled. Please approve the transaction in your wallet to continue."
      } else if (errorMessage.includes("disconnected") || errorMessage.includes("not connected")) {
        errorMessage = "Wallet disconnected. Please reconnect your wallet and try again."
      } else if (errorMessage.includes("Insufficient") || errorMessage.includes("insufficient funds")) {
        errorMessage = "Insufficient SOL balance. You need at least 0.001 SOL to submit."
      } else if (errorMessage.includes("ConstraintSeeds")) {
        errorMessage = "Account derivation error. Please refresh the page and try again."
      } else if (errorMessage.includes("Read-only")) {
        errorMessage = "Read-only error. Please ensure your wallet is properly connected."
      }
      
      toast.error(errorMessage, {
        duration: 5000,
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
      setIsSubmitting(false)
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-start">
        {/* Left Side - Form */}
        <div className="space-y-8">
          <div>
            <p className="text-xs font-mono text-muted-foreground tracking-widest mb-8">CREATE YOUR MASTERPIECE</p>

            <div className="space-y-6">
              <div>
                <label className="text-sm font-mono text-foreground mb-3 block">Artist Name</label>
                <Input 
                  placeholder="Enter your artist name" 
                  value={artistName}
                  onChange={(e) => {
                    setArtistName(e.target.value)
                    if (fieldErrors.artistName) {
                      setFieldErrors(prev => ({ ...prev, artistName: undefined }))
                    }
                  }}
                  className={`bg-muted/20 border-border/30 text-sm h-12 font-mono ${fieldErrors.artistName ? 'border-red-500' : ''}`} 
                />
                <p className="text-xs text-muted-foreground mt-2 font-mono">This will be visible to everyone</p>
                {fieldErrors.artistName && (
                  <p className="text-xs text-red-400 mt-1 font-mono">{fieldErrors.artistName}</p>
                )}
              </div>

              <div>
                <label className="text-sm font-mono text-foreground mb-3 block">Image Name </label>
                <Input 
                  placeholder="Give your artwork a title..." 
                  value={imageName}
                  onChange={(e) => {
                    updateImageState({ imageName: e.target.value })
                    if (fieldErrors.imageName) {
                      setFieldErrors(prev => ({ ...prev, imageName: undefined }))
                    }
                  }}
                  className={`bg-muted/20 border-border/30 text-sm h-12 font-mono ${fieldErrors.imageName ? 'border-red-500' : ''}`} 
                />
                <p className="text-xs text-muted-foreground mt-2 font-mono">This will be visible to everyone</p>
                {fieldErrors.imageName && (
                  <p className="text-xs text-red-400 mt-1 font-mono">{fieldErrors.imageName}</p>
                )}
              </div>

              <div>
                <label className="text-sm font-mono text-foreground mb-3 block">Creative Prompt</label>
                <Textarea
                  placeholder="Describe your artwork based on today's theme..."
                  value={prompt}
                  onChange={(e) => {
                    updateImageState({ prompt: e.target.value, promptError: "" })
                  }}
                  className={`bg-muted/20 border-border/30 text-sm min-h-32 resize-none font-mono ${promptError ? 'border-red-500' : ''}`}
                />
                <div className="mt-3">
                  <p className="text-xs text-muted-foreground font-mono">
                    {themeLoading ? (
                      <>Loading today's theme…</>
                    ) : (
                      <>Based on today's theme: {currentTheme} • This will remain private</>
                    )}
                  </p>
                  {promptError && (
                    <p className="text-xs text-red-400 mt-1 font-mono">{promptError}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-1 font-mono">
                    {prompt.length}/5 characters minimum
                  </p>
                </div>
              </div>

              <div className="flex justify-start pt-6">
                <Button
                  onClick={handleGenerate}
                  disabled={!prompt.trim() || isGenerating}
                  className="bg-accent hover:bg-accent/90 text-black font-mono text-sm font-bold py-5 px-8"
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      GENERATING...
                    </>
                  ) : (
                    "GENERATE ART"
                  )}
                </Button>
              </div>
            </div>
          </div>

          {isGenerating && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-accent rounded-full animate-pulse"></div>
              </div>
            </div>
          )}
        </div>

        {/* Right Side - Image Preview */}
        <div className="space-y-4">
          <div>
            <p className="text-xs font-mono text-muted-foreground tracking-widest mb-4 ml-7">IMAGE PREVIEW</p>
            <div className={`relative rounded-sm overflow-hidden border aspect-square max-w-lg max-h-lg mx-auto ${fieldErrors.generatedImage ? 'border-red-500 bg-red-50/20' : 'border-border/30 bg-muted/20'}`}>
              {generatedImage ? (
                <img
                  src={generatedImage}
                  alt="Generated artwork"
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  {!isGenerating ? (
                    <div className="text-center space-y-4">
                      <div className="w-16 h-16 mx-auto bg-muted/30 rounded-sm flex items-center justify-center">
                        <svg className="w-8 h-8 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      </div>
                      <p className="text-sm text-muted-foreground font-mono">Generate image to see preview</p>
                    </div>
                  ) : (
                    <div className="text-center space-y-4">
                      <CircularProgress 
                        value={progress} 
                        size={100} 
                        strokeWidth={8}
                        className="mx-auto"
                      />
                      <p className="text-sm text-muted-foreground font-mono">Generating artwork...</p>
                    </div>
                  )}
                </div>
              )}
            </div>
            {fieldErrors.generatedImage && (
              <p className="text-xs text-red-400 mt-2 font-mono text-center">{fieldErrors.generatedImage}</p>
            )}
          </div>

          {generatedImage && (
            <div className="flex gap-3 max-w-lg mx-auto">
              <Button 
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="flex-1 bg-accent hover:bg-accent/90 text-black font-mono text-sm font-bold"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    SUBMITTING...
                  </>
                ) : (
                  "SUBMIT TO GALLERY (0.001 SOL)"
                )}
              </Button>
              <Button
                variant="outline"
                onClick={() => updateImageState({ generatedImage: null })}
                className="flex-1 border-border/30 text-foreground hover:bg-muted/20 font-mono text-sm font-bold bg-transparent"
              >
                REGENERATE
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
