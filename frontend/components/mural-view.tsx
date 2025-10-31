"use client"

import { useState, useEffect } from "react"

interface Artwork {
  id: number
  title: string
  artist: string
  votes: number
  image: string
}

interface MuralViewProps {
  artwork: Artwork
}

export default function MuralView({ artwork }: MuralViewProps) {
  const [isAnimating, setIsAnimating] = useState(false)

  useEffect(() => {
    setIsAnimating(true)
    const timer = setTimeout(() => setIsAnimating(false), 600)
    return () => clearTimeout(timer)
  }, [artwork.id])

  return (
    <div className="space-y-6 pb-8 border-b border-border/30">
      <div>
        <p className="text-xs font-mono text-muted-foreground tracking-widest mb-4">WINNING ARTWORK</p>

        <div
          className={`relative transition-all duration-500 ${isAnimating ? "scale-95 opacity-50" : "scale-100 opacity-100"}`}
        >
          <div className="relative w-full aspect-square rounded-sm overflow-hidden border border-border/50 bg-muted/20">
            <img src={artwork.image || "/placeholder.svg"} alt={artwork.title} className="w-full h-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent"></div>

            <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/80 to-transparent">
              <h3 className="text-xl font-bold text-white font-sans mb-1">{artwork.title}</h3>
              <p className="text-sm text-accent mb-3">by {artwork.artist}</p>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-bold text-accent">{artwork.votes.toLocaleString()} VOTES</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
