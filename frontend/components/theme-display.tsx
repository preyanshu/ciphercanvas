"use client"

import { Button } from "@/components/ui/button"

const THEMES = ["Cyberpunk Dragon", "Neon Phoenix", "Digital Serpent", "Quantum Beast", "Holographic Leviathan"]

interface ThemeDisplayProps {
  currentTheme?: string
  countdown?: string | null
  isLoading?: boolean
}

export default function ThemeDisplay({ currentTheme = THEMES[0], countdown, isLoading = false }: ThemeDisplayProps) {
  // Format countdown to HH:MM:SS format for display
  const formatCountdown = (timeStr: string | null): string => {
    if (!timeStr) return "00:00:00"
    if (timeStr === "Round ended") return "00:00:00"
    
    // Parse "23h 59m 59s" format
    const match = timeStr.match(/(\d+)h\s+(\d+)m\s+(\d+)s/)
    if (!match) {
      console.warn("Countdown format not recognized:", timeStr)
      return "00:00:00"
    }
    
    const [, h, m, s] = match.map(Number)
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  }
  
  const timeLeft = formatCountdown(countdown)
  
  // Debug log to see what's being passed
  console.log("ThemeDisplay - countdown prop:", countdown, "formatted:", timeLeft)

  return (
    <div className="space-y-4 pb-8 border-b border-border/30">
      <div>
        <p className="text-xs font-mono text-muted-foreground tracking-widest mb-2">TODAY'S THEME</p>
        <h2 className="text-3xl md:text-4xl font-bold text-foreground font-sans mb-4">{currentTheme}</h2>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground">NEXT THEME IN</span>
            {isLoading ? (
              <div className="w-16 h-6 bg-muted animate-pulse rounded"></div>
            ) : (
              <span className="font-mono text-lg font-bold text-accent">{timeLeft}</span>
            )}
          </div>
          <button
            onClick={() => {
              const galleryTab = document.querySelector('[value="previous"]') as HTMLElement;
              galleryTab?.click();
            }}
            className="ml-auto bg-accent hover:bg-accent/90 text-black font-mono text-xs font-bold py-2 px-4 rounded-sm transition-all duration-200"
          >
            VIEW PAST CHALLENGES
          </button>
        </div>
      </div>
    </div>
  )
}
