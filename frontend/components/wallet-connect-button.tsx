"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { ChevronDown, Wallet, LogOut, Coins } from "lucide-react";

function truncateAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function AirdropButton({
  address
}: {
  address: string;
}) {
  const [isRequesting, setIsRequesting] = useState(false);

  const handleAirdrop = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    setIsRequesting(true);
    try {
      const response = await fetch('https://api.devnet.solana.com', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'requestAirdrop',
          params: [address, 1_000_000_000], // 1 SOL in lamports
        }),
      });

      const data = await response.json();
      
      if (data.error) {
        throw new Error(`RPC Error: ${data.error.message || JSON.stringify(data.error)}`);
      }

      console.log("Airdrop successful:", data.result);
      alert("Airdrop successful! Please refresh after a few seconds.");
    } catch (err) {
      console.error("Airdrop failed:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      alert(`Airdrop failed: ${errorMessage}`);
    } finally {
      setIsRequesting(false);
    }
  };

  return (
    <DropdownMenuItem
      className="hover:bg-accent hover:!text-black focus:text-black cursor-pointer font-mono"
      onClick={handleAirdrop}
      disabled={isRequesting}
      onSelect={(e) => e.preventDefault()}
    >
      <Coins className="mr-2 h-4 w-4" />
      {isRequesting ? "REQUESTING..." : "AIRDROP 1 SOL"}
    </DropdownMenuItem>
  );
}

export function WalletConnectButton() {
  const { publicKey, wallet, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const isConnected = !!publicKey;

  const [dropdownOpen, setDropdownOpen] = useState(false);

  const handleConnectClick = () => {
    setVisible(true);
  };

  const handleDisconnect = async () => {
    await disconnect();
    setDropdownOpen(false);
  };

  // If not connected, show a button that opens the modal directly
  if (!isConnected) {
    return (
      <Button 
        onClick={handleConnectClick}
        className="bg-accent hover:bg-accent/90 text-black font-mono text-xs font-bold px-4 py-2 rounded-sm min-w-[140px] justify-center"
      >
        <Wallet className="mr-2 h-4 w-4" />
        CONNECT WALLET
      </Button>
    );
  }

  // If connected, show dropdown with wallet info
  return (
    <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
      <DropdownMenuTrigger asChild>
        <Button className="bg-accent hover:bg-accent/90 text-black font-mono text-xs font-bold px-4 py-2 rounded-sm min-w-[140px] justify-between">
          <div className="flex items-center gap-2">
            {wallet?.adapter?.icon && (
              <img src={wallet.adapter.icon} alt={wallet.adapter.name} className="h-4 w-4" />
            )}
            <span className="font-mono text-xs">
              {truncateAddress(publicKey.toBase58())}
            </span>
          </div>
          <ChevronDown className="ml-2 h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[280px] font-mono">
        <DropdownMenuLabel className="font-mono text-xs font-bold">CONNECTED WALLET</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          <div className="flex items-center gap-2">
            {wallet?.adapter?.icon && (
              <img src={wallet.adapter.icon} alt={wallet.adapter.name} className="h-6 w-6" />
            )}
            <div className="flex flex-col">
              <span className="text-sm font-medium font-mono">
                {wallet?.adapter?.name || "Wallet"}
              </span>
              <span className="text-xs text-muted-foreground font-mono">
                {truncateAddress(publicKey.toBase58())}
              </span>
            </div>
          </div>
        </div>
        <DropdownMenuSeparator />
        {publicKey && <AirdropButton address={publicKey.toBase58()} />}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleDisconnect} className="font-mono">
          <LogOut className="mr-2 h-4 w-4" />
          Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}