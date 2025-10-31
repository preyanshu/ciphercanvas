import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import idl from "./idl.json";

// Program ID from IDL
export const PROGRAM_ID = new PublicKey(idl.address);

// Initialize the Anchor Program
export function getProgram(provider: AnchorProvider): Program {
  return new Program(idl as any, provider);
}

// Helper function to get provider
export function createProvider(connection: any, wallet: any) {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return provider;
}

