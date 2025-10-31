import type React from "react"
import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import { QueryProvider } from "@/components/providers/query-provider"
import { SolanaProvider } from "@/components/solana-provider-new";
import { Toaster } from "react-hot-toast";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css"

const _geist = Geist({ subsets: ["latin"] })
const _geistMono = Geist_Mono({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "CipherCanvas – Community Driven On Chain Art Mural",
  description: "A truly decentralized art mural with privacy tech and on chain proofs.",
  generator: "v0.app",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Roboto+Slab:wght@400;700&family=Fira+Code:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className={`font-sans antialiased`}>
        <QueryProvider>
          <SolanaProvider>
            {children}
          </SolanaProvider>
        </QueryProvider>
        <Analytics />
        <Toaster position="bottom-right" />
      </body>
    </html>
  )
}
