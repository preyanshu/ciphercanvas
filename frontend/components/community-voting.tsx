"use client"

import { Button } from "@/components/ui/button"
import { Heart, Loader2 } from "lucide-react"

interface Artwork {
  id: number
  title: string
  artist: string
  votes: number
  image: string
  voted: boolean
}

interface CommunityVotingProps {
  artworks: Artwork[]
  onVote: (id: number) => void
  hasVoted?: boolean
  votingArtworkId?: number | null
}

export default function CommunityVoting({ artworks, onVote, hasVoted = false, votingArtworkId = null }: CommunityVotingProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      {artworks.map((artwork) => (
        <div key={artwork.id} className="group cursor-pointer">
          <div className="relative overflow-hidden aspect-square rounded-sm mb-3 border border-border/30 bg-muted/20 group-hover:border-accent/50 transition-colors duration-300">
            <img
              src={artwork.image || "/placeholder.svg"}
              alt={artwork.title}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            />
          </div>

          <div className="space-y-3">
            <div>
              <h3 className="font-bold text-sm text-foreground line-clamp-1">{artwork.title}</h3>
              <p className="text-xs text-muted-foreground">{artwork.artist}</p>
            </div>

            <div className="flex justify-end">
              <Button
                onClick={() => onVote(artwork.id)}
                size="sm"
                variant={"outline"}
                className={`h-8 px-3 transition-all duration-200 ${
                  artwork.voted
                    ? "border-accent text-foreground"
                    : "border-border/50 hover:border-accent/50 text-foreground"
                }`}
              >
                {votingArtworkId === artwork.id ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Heart className={`w-3.5 h-3.5 ${artwork.voted ? "fill-accent border-accent" : ""}`} />
                )}
              </Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
