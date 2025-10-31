'use client';

import { AnchorProvider, Program, web3, BN } from "@coral-xyz/anchor";
import idl from "./idl.json";
import { randomBytes } from "crypto";
import {
    RescueCipher,
    deserializeLE,
    x25519,
    getMXEAccAddress,
    getMempoolAccAddress,
    getCompDefAccAddress,
    getExecutingPoolAccAddress,
    getComputationAccAddress,
    getClusterAccAddress,
    getCompDefAccOffset,
    getMXEPublicKey,
    getArciumEnv,
    awaitComputationFinalization
} from "@arcium-hq/client";

// Re-export awaitComputationFinalization for use in components
export { awaitComputationFinalization };

export const PROGRAM_ID = new web3.PublicKey(idl.address);

// Cluster offset for Arcium cluster account derivation
// You can override this via NEXT_PUBLIC_ARCIUM_CLUSTER_OFFSET environment variable
const CLUSTER_OFFSET = typeof process !== 'undefined' && process.env.NEXT_PUBLIC_ARCIUM_CLUSTER_OFFSET
    ? parseInt(process.env.NEXT_PUBLIC_ARCIUM_CLUSTER_OFFSET, 10)
    : 1078779259; // Default cluster offset

// Vote data structure (similar to artmural.ts round0VoteReceipts)
export interface VoteData {
    voter: string; // Wallet address
    pda: web3.PublicKey; // Vote receipt PDA
    round: number; // Round ID
    proposalId: number; // Proposal ID that was voted for
    encryptedVote: Uint8Array; // encryptedProposalId (encrypted with proposalIdNonce)
    voteEncryptionPubkey: Uint8Array; // Public key
    voteNonce: Uint8Array; // proposalIdNonce (16 bytes)
    timestamp?: number; // Optional timestamp
}

// Helper function to convert byte array to string
function bytesToString(bytes: Uint8Array): string {
    // Check if all bytes are zeros
    const isEmpty = bytes.every(byte => byte === 0);
    if (isEmpty) {
        return "Open Theme";
    }
    
    // Find the first null byte (0) to determine the actual string length
    let length = 0;
    while (length < bytes.length && bytes[length] !== 0) {
        length++;
    }
    
    // Convert to string
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(bytes.slice(0, length));
}

// Initialize the Anchor Program
export function getProgram(provider: AnchorProvider): Program {
    return new Program(idl as any, provider);
}

// Fetch round escrow account fields
export async function getRoundEscrowBalance(
    program: Program,
    roundId: number
): Promise<{ 
    pda: web3.PublicKey; 
    account: any;
    totalCollected: BN;
    totalDistributed: BN;
    currentBalance: BN;
    roundStatus: any;
    createdAt: BN;
}> {
    console.log(`💰 FETCHING ROUND ESCROW ACCOUNT FOR ROUND ${roundId}`);
    console.log("-".repeat(50));
    
    // Derive the round escrow PDA using seeds ["round_escrow", round_id_le_8]
    const roundIdBN = new BN(roundId);
    const roundIdBytes = Buffer.from(roundIdBN.toArray("le", 8));
    const [roundEscrowPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("round_escrow"), roundIdBytes],
        program.programId
    );

    console.log(`🔑 Round Escrow PDA: ${roundEscrowPDA.toBase58()}`);
    
    // Fetch the escrow account data
    const escrowAccount = await (program.account as any).roundEscrowAccount.fetch(roundEscrowPDA);
    
    console.log(`✅ Round Escrow Account Fields:`);
    console.log(`   - Bump: ${escrowAccount.bump}`);
    console.log(`   - Round ID: ${escrowAccount.roundId.toString()}`);
    console.log(`   - Total Collected: ${escrowAccount.totalCollected.toString()} lamports (${(escrowAccount.totalCollected.toNumber() / 1_000_000_000).toFixed(9)} SOL)`);
    console.log(`   - Total Distributed: ${escrowAccount.totalDistributed.toString()} lamports (${(escrowAccount.totalDistributed.toNumber() / 1_000_000_000).toFixed(9)} SOL)`);
    console.log(`   - Current Balance: ${escrowAccount.currentBalance.toString()} lamports (${(escrowAccount.currentBalance.toNumber() / 1_000_000_000).toFixed(9)} SOL)`);
    console.log(`   - Round Status: ${escrowAccount.roundStatus}`);
    console.log(`   - Created At: ${new Date(escrowAccount.createdAt.toNumber() * 1000).toISOString()}`);
    
    // Calculate winner share: 50% of total_collected (NOT current_balance)
    const totalCollectedSol = escrowAccount.totalCollected.toNumber() / 1_000_000_000;
    const winnerShareSol = totalCollectedSol * 0.5;
    
    console.log(`🎯 Winner Share Calculation:`);
    console.log(`   - Using: total_collected (${totalCollectedSol.toFixed(9)} SOL)`);
    console.log(`   - Winner Share (50%): ${winnerShareSol.toFixed(9)} SOL`);
    console.log("-".repeat(50));
    
    return { 
        pda: roundEscrowPDA, 
        account: escrowAccount,
        totalCollected: escrowAccount.totalCollected,
        totalDistributed: escrowAccount.totalDistributed,
        currentBalance: escrowAccount.currentBalance,
        roundStatus: escrowAccount.roundStatus,
        createdAt: escrowAccount.createdAt
    };
}

// Fetch system state
export async function fetchSystemState(program: Program, setError?: (error: string) => void) {
    try {
        console.log("🔍 FETCHING SYSTEM STATE");
        console.log("-".repeat(50));
        
        const [systemAccPDA] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("proposal_system")], 
            program.programId
        );
        
        console.log("System account PDA:", systemAccPDA.toString());
        
        const systemAccount = await (program.account as any).proposalSystemAccount.fetch(systemAccPDA);
        
        console.log("✅ System account found:");
        console.log("   - Authority:", systemAccount.authority.toBase58());
        console.log("   - Next Proposal ID:", systemAccount.nextProposalId);
        console.log("   - Winning Proposal ID:", systemAccount.winningProposalId);
        console.log("   - Winning Vote Count:", systemAccount.winningVoteCount);
        console.log("   - Nonce:", systemAccount.nonce.toString());
        
        return systemAccount;
    } catch (err: any) {
        console.error("❌ Error fetching system state:", err);
        if (setError) setError(`Failed to fetch system state: ${err.message}`);
        throw err;
    }
}

// Fetch proposals for a specific round
export async function fetchProposalsForRound(program: Program, targetRound: number, setError?: (error: string) => void) {
    try {
        console.log(`🔍 FETCHING PROPOSALS FOR ROUND ${targetRound}`);
        
        const [systemAccPDA] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("proposal_system")], 
            program.programId
        );
        
        const [roundMetadataPDA] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("round_metadata")], 
            program.programId
        );
        
        let proposalsInRound = 0;
        try {
            const roundMetadata = await (program.account as any).roundMetadataAccount.fetch(roundMetadataPDA);
            
            if (targetRound === roundMetadata.currentRound.toNumber()) {
                proposalsInRound = (roundMetadata as any).proposalsInCurrentRound || 0;
            } else {
                proposalsInRound = 20;
            }
        } catch (error) {
            console.log(`❌ Could not fetch round metadata: ${error}`);
            proposalsInRound = 20;
        }
        
        console.log(`📋 Checking up to ${proposalsInRound} proposals for Round ${targetRound}`);
        
        const proposals = [];
        
        for (let proposalIdInRound = 0; proposalIdInRound < proposalsInRound; proposalIdInRound++) {
            try {
                console.log(`🔍 Checking proposal ${proposalIdInRound} for round ${targetRound}`);
                
                const [proposalPDA] = web3.PublicKey.findProgramAddressSync(
                    [
                        Buffer.from("proposal"),
                        systemAccPDA.toBuffer(),
                        new BN(targetRound).toArrayLike(Buffer, "le", 8),
                        new BN(proposalIdInRound).toArrayLike(Buffer, "le", 1)
                    ],
                    program.programId
                );
                
                console.log(`🔑 Proposal PDA for ID ${proposalIdInRound}: ${proposalPDA.toBase58()}`);
                
                const proposal = await (program.account as any).proposalAccount.fetch(proposalPDA);
                
                console.log(`📄 Proposal ${proposalIdInRound} data:`, {
                    roundId: (proposal as any).roundId?.toString(),
                    title: proposal.title,
                    description: proposal.description,
                    url: proposal.url,
                    voteCount: proposal.voteCount?.toString()
                });
                
                if ((proposal as any).roundId && (proposal as any).roundId.eq(new BN(targetRound))) {
                    proposals.push({
                        id: proposalIdInRound,
                        roundId: (proposal as any).roundId,
                        title: proposal.title,
                        description: proposal.description,
                        url: proposal.url,
                        submitter: proposal.submitter,
                        voteCount: proposal.voteCount,
                        pda: proposalPDA
                    });
                    
                    console.log(`✅ Proposal ${proposalIdInRound}: "${proposal.title}" (Round ${(proposal as any).roundId})`);
                } else {
                    console.log(`⚠️ Proposal ${proposalIdInRound} roundId mismatch: expected ${targetRound}, got ${(proposal as any).roundId?.toString()}`);
                }
            } catch (error: any) {
                console.log(`❌ No proposal found with ID ${proposalIdInRound} for Round ${targetRound}:`, error.message);
                break;
            }
        }
        
        console.log(`📊 Found ${proposals.length} proposals for Round ${targetRound}`);
        return proposals;
    } catch (err: any) {
        console.error("❌ Error fetching proposals:", err);
        if (setError) setError(`Failed to fetch proposals: ${err.message}`);
        throw err;
    }
}

// Helper function to get current round from round_metadata
export async function getCurrentRound(program: Program): Promise<BN> {
    try {
        const [roundMetadataPDA] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("round_metadata")],
            program.programId
        );
        
        const roundMetadata = await (program.account as any).roundMetadataAccount.fetch(roundMetadataPDA);
        return roundMetadata.currentRound;
    } catch (error) {
        console.error("Error fetching current round:", error);
        return new BN(0); // Fallback to round 0
    }
}

// Check if user has already voted on a proposal
export async function checkVoteReceipt(program: Program, walletPublicKey: web3.PublicKey) {
    try {
        // Get current round from round_metadata
        const roundId = await getCurrentRound(program);
        const roundIdBytes = Buffer.from(roundId.toArray("le", 8));
        
        const [voteReceiptPDA] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("vote_receipt"), walletPublicKey.toBuffer(), roundIdBytes],
            program.programId
        );
        
        // Check if the account exists by checking the connection
        const connection = program.provider.connection;
        const accountInfo = await connection.getAccountInfo(voteReceiptPDA);
        
        return !!accountInfo; // Returns true if account exists (user has voted)
    } catch (error) {
        console.error("Error checking vote receipt:", error);
        return false;
    }
}

// Check if a wallet submitted a proposal for a specific round
export async function checkWalletSubmittedProposal(
    program: Program,
    walletPublicKey: web3.PublicKey,
    roundId: number
): Promise<boolean> {
    try {
        console.log(`🔍 Checking if wallet ${walletPublicKey.toBase58()} submitted proposal for round ${roundId}`);
        
        // Fetch all proposals for the round
        const proposals = await fetchProposalsForRound(program, roundId);
        
        // Check if any proposal has this wallet as the submitter
        const hasSubmitted = proposals.some(
            (proposal: any) => proposal.submitter && proposal.submitter.equals(walletPublicKey)
        );
        
        console.log(`📊 Wallet ${hasSubmitted ? '✅ HAS' : '❌ HAS NOT'} submitted proposal for round ${roundId}`);
        
        return hasSubmitted;
    } catch (error: any) {
        console.error("❌ Error checking wallet submission:", error);
        return false;
    }
}

// Fetch vote receipt data for a specific round
export async function fetchVoteReceiptData(
    program: Program,
    walletPublicKey: web3.PublicKey,
    roundId: number
): Promise<{ 
    encryptedProposalId: Uint8Array; 
    voteEncryptionPubkey: Uint8Array;
    voter: web3.PublicKey;
    timestamp: BN;
    pda: web3.PublicKey;
} | null> {
    try {
        const roundIdBN = new BN(roundId);
        const roundIdBytes = Buffer.from(roundIdBN.toArray("le", 8));
        
        const [voteReceiptPDA] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("vote_receipt"), walletPublicKey.toBuffer(), roundIdBytes],
            program.programId
        );
        
        // Fetch account data manually since VoteReceiptAccount may be UncheckedAccount
        const connection = program.provider.connection;
        const accountInfo = await connection.getAccountInfo(voteReceiptPDA);
        
        if (!accountInfo) {
            console.log(`❌ No vote receipt found for round ${roundId}`);
            return null;
        }
        
        // Parse VoteReceiptAccount structure manually:
        // bump(1) + voter(32) + encrypted_proposal_id(32) + timestamp(8) + vote_encryption_pubkey(32)
        const data = accountInfo.data;
        const bump = data[0];
        const voter = new web3.PublicKey(data.slice(1, 33));
        const encryptedProposalId = data.slice(33, 65);
        const timestamp = new BN(data.slice(65, 73), "le");
        const voteEncryptionPubkey = data.slice(73, 105);
        
        console.log(`✅ Vote receipt found for round ${roundId}:`);
        console.log(`   - Voter: ${voter.toString()}`);
        console.log(`   - Encrypted Proposal ID (hex): ${Buffer.from(encryptedProposalId).toString('hex')}`);
        console.log(`   - Vote Encryption Pubkey (hex): ${Buffer.from(voteEncryptionPubkey).toString('hex')}`);
        
        return {
            encryptedProposalId: new Uint8Array(encryptedProposalId),
            voteEncryptionPubkey: new Uint8Array(voteEncryptionPubkey),
            voter: voter,
            timestamp: timestamp,
            pda: voteReceiptPDA
        };
    } catch (error: any) {
        console.error("❌ Error fetching vote receipt data:", error);
        return null;
    }
}

// Check if a wallet voted for the winning proposal by decrypting their vote receipt
export async function checkWalletVotedForWinningProposal(
    program: Program,
    walletPublicKey: web3.PublicKey,
    roundId: number,
    signMessage: (message: Uint8Array) => Promise<Uint8Array>,
    mxePublicKey: Uint8Array
): Promise<boolean> {
    try {
        console.log(`🔍 Checking if wallet ${walletPublicKey.toBase58()} voted for the WINNING proposal in round ${roundId}`);
        
        // Fetch round history to get winning proposal ID
        const roundData = await fetchRoundHistoryWithWinner(program, roundId);
        
        if (!roundData || roundData.winningProposalId === undefined) {
            console.log(`❌ No winning proposal found for round ${roundId}`);
            return false;
        }
        
        const winningProposalId = roundData.winningProposalId;
        console.log(`📊 Winning proposal ID for round ${roundId}: ${winningProposalId}`);
        
        // Fetch vote receipt data
        const voteReceiptData = await fetchVoteReceiptData(program, walletPublicKey, roundId);
        
        if (!voteReceiptData) {
            console.log(`❌ No vote receipt found for wallet in round ${roundId}`);
            return false;
        }
        
        // Console log the voting receipt object
        console.log(`\n📋 === VOTING RECEIPT OBJECT ===`);
        console.log(`   Voter: ${voteReceiptData.voter.toBase58()}`);
        console.log(`   Encrypted Proposal ID (hex): ${Buffer.from(voteReceiptData.encryptedProposalId).toString('hex')}`);
        console.log(`   Vote Encryption Pubkey (hex): ${Buffer.from(voteReceiptData.voteEncryptionPubkey).toString('hex')}`);
        console.log(`   Timestamp: ${voteReceiptData.timestamp.toString()}`);
        console.log(`   PDA: ${voteReceiptData.pda.toBase58()}`);
        console.log(`=== END RECEIPT ===\n`);
        
        // Derive both nonce and private key from a single common signed message
        // Use the same round-specific message format as during voting
        const messageText = `CipherCanvas Mural – Round ${roundId}\nVoter: ${walletPublicKey.toBase58()}\nSign to cast your secret brushstroke!`;
        const messageBytes = new TextEncoder().encode(messageText);
        const signature = await signMessage(messageBytes);
        
        // Derive private key from signature (round-specific, same for all votes in round)
        const keyHash = new Uint8Array(await crypto.subtle.digest('SHA-256', signature));
        const privateKey = keyHash;
        console.log(`\n🔐 === DETERMINISTIC KEY DERIVATION ===`);
        console.log(`📝 Message: ${messageText}`);
        console.log(`🔑 Signature (first 16 bytes hex): ${Buffer.from(signature.slice(0, 16)).toString('hex')}...`);
        console.log(`✅ Generated Private Key (hex): ${Buffer.from(privateKey).toString('hex')}`);

        // Derive proposal-specific nonce from signature + winning proposal ID combination
        // Same derivation method as during voting, but using winning proposal ID
        const winningProposalIdBytes = Buffer.from([winningProposalId]);
        const combinedForNonce = new Uint8Array(signature.length + winningProposalIdBytes.length);
        combinedForNonce.set(signature);
        combinedForNonce.set(winningProposalIdBytes, signature.length);
        const nonceHash = await crypto.subtle.digest('SHA-256', combinedForNonce);
        const proposalIdNonce = new Uint8Array(nonceHash).slice(0, 16);
        console.log(`✅ Generated Proposal ID Nonce (hex): ${Buffer.from(proposalIdNonce).toString('hex')}`);
        console.log(`=== END KEY DERIVATION ===\n`);
        
        const publicKey = x25519.getPublicKey(privateKey);
        const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
        const cipher = new RescueCipher(sharedSecret);

        // Decrypt the encrypted proposal ID from the receipt
        console.log(`🔓 === DECRYPTING ENCRYPTED PROPOSAL ID ===`);
        console.log(`   Encrypted Proposal ID from receipt (hex): ${Buffer.from(voteReceiptData.encryptedProposalId).toString('hex')}`);
        console.log(`   Using Proposal ID Nonce (hex): ${Buffer.from(proposalIdNonce).toString('hex')}`);
        const decrypted = cipher.decrypt([Array.from(voteReceiptData.encryptedProposalId)], proposalIdNonce);
        const decryptedVote = Number(decrypted[0]);
        console.log(`✅ Decrypted Proposal ID: ${decryptedVote}`);
        console.log(`=== END DECRYPTION ===\n`);
        const isWinningVote = decryptedVote === winningProposalId;
        console.log(`✅ Eligible by vote? ${isWinningVote}`);
        return isWinningVote;
    } catch (error: any) {
        console.error("❌ Error checking if wallet voted for winning proposal:", error);
        return false;
    }
}

// Check if a wallet submitted the winning proposal for a specific round
export async function checkWalletSubmittedWinningProposal(
    program: Program,
    walletPublicKey: web3.PublicKey,
    roundId: number
): Promise<boolean> {
    try {
        console.log(`🔍 Checking if wallet ${walletPublicKey.toBase58()} submitted the WINNING proposal for round ${roundId}`);
        
        // Fetch round history with winner
        const roundData = await fetchRoundHistoryWithWinner(program, roundId);
        
        if (!roundData || !roundData.winningProposal) {
            console.log(`❌ No winning proposal found for round ${roundId}`);
            return false;
        }
        
        // Check if the winning proposal's submitter matches the wallet
        const isWinner = roundData.winningProposal.submitter && 
                        roundData.winningProposal.submitter.equals(walletPublicKey);
        
        console.log(`📊 Wallet ${isWinner ? '✅ SUBMITTED' : '❌ DID NOT SUBMIT'} the winning proposal for round ${roundId}`);
        
        return isWinner;
    } catch (error: any) {
        console.error("❌ Error checking wallet winning submission:", error);
        return false;
    }
}

// Build instruction to verify a winning vote on-chain
// Can use stored voteData or reconstruct deterministically
// Returns both the instruction and the computation offset (needed for finalization)
export async function buildVerifyWinningVoteInstruction(
    program: Program,
    walletPublicKey: web3.PublicKey,
    roundId: number,
    signMessage: (message: Uint8Array) => Promise<Uint8Array>,
    mxePublicKey: Uint8Array,
    voteData?: VoteData // Optional: if provided, use stored vote data; otherwise reconstruct
): Promise<{ instruction: web3.TransactionInstruction; computationOffset: BN }> {
    // Fetch round history to get winning proposal ID
    const roundData = await fetchRoundHistory(program, roundId);
    if (!roundData || roundData.winningProposalId === undefined) {
        throw new Error(`No winning proposal found for round ${roundId}`);
    }
    const winningProposalId = roundData.winningProposalId!;
    
    let vote: number[];
    let voteEncryptionPubkey: number[];
    let voteNonce: BN;
    
    if (voteData) {
        // Use stored vote data (much simpler!)
        console.log(`📦 Using stored vote data for proposal ${voteData.proposalId}`);
        
        // Verify the vote data matches the winning proposal
        if (voteData.proposalId !== winningProposalId) {
            throw new Error(`Vote mismatch: stored vote is for proposal ${voteData.proposalId}, but winning proposal is ${winningProposalId}`);
        }
        
        if (voteData.round !== roundId) {
            throw new Error(`Round mismatch: stored vote is for round ${voteData.round}, but claiming for round ${roundId}`);
        }
        
        vote = Array.from(voteData.encryptedVote);
        voteEncryptionPubkey = Array.from(voteData.voteEncryptionPubkey);
        voteNonce = new BN(deserializeLE(voteData.voteNonce).toString());
        
        console.log(`✅ Using stored vote data:`);
        console.log(`   - Proposal ID: ${voteData.proposalId}`);
        console.log(`   - Encrypted Vote (hex): ${Buffer.from(vote).toString('hex')}`);
        console.log(`   - Vote Nonce (hex): ${Buffer.from(voteData.voteNonce).toString('hex')}`);
    } else {
        // Reconstruct deterministically (fallback if voteData not available)
        console.log(`🔄 Reconstructing vote data deterministically...`);
        
        const voteReceipt = await fetchVoteReceiptData(program, walletPublicKey, roundId);
        if (!voteReceipt) {
            throw new Error(`No vote receipt found for round ${roundId}`);
        }

        // Console log the voting receipt object
        console.log(`\n📋 === VOTING RECEIPT OBJECT ===`);
        console.log(`   Voter: ${voteReceipt.voter.toBase58()}`);
        console.log(`   Encrypted Proposal ID (hex): ${Buffer.from(voteReceipt.encryptedProposalId).toString('hex')}`);
        console.log(`   Vote Encryption Pubkey (hex): ${Buffer.from(voteReceipt.voteEncryptionPubkey).toString('hex')}`);
        console.log(`   Timestamp: ${voteReceipt.timestamp.toString()}`);
        console.log(`   PDA: ${voteReceipt.pda.toBase58()}`);
        console.log(`=== END RECEIPT ===\n`);

        // Derive private key from common round message
        const messageText = `CipherCanvas Mural – Round ${roundId}\nVoter: ${walletPublicKey.toBase58()}\nSign to cast your secret brushstroke!`;
        const messageBytes = new TextEncoder().encode(messageText);
        const signature = await signMessage(messageBytes);
        const keyHash = new Uint8Array(await crypto.subtle.digest('SHA-256', signature));
        const privateKey = keyHash;
        
        console.log(`\n🔐 === DETERMINISTIC KEY DERIVATION ===`);
        console.log(`📝 Message: ${messageText}`);
        console.log(`🔑 Signature (first 16 bytes hex): ${Buffer.from(signature.slice(0, 16)).toString('hex')}...`);
        console.log(`✅ Generated Private Key (hex): ${Buffer.from(privateKey).toString('hex')}`);
        
        const publicKey = x25519.getPublicKey(privateKey);
        const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
        const cipher = new RescueCipher(sharedSecret);
        
        // Try to decrypt with the winning proposal ID first
        const winningProposalIdBytes = Buffer.from([winningProposalId]);
        const combinedForNonce = new Uint8Array(signature.length + winningProposalIdBytes.length);
        combinedForNonce.set(signature);
        combinedForNonce.set(winningProposalIdBytes, signature.length);
        const nonceHash = await crypto.subtle.digest('SHA-256', combinedForNonce);
        const proposalIdNonce = new Uint8Array(nonceHash).slice(0, 16);
        console.log(`✅ Generated Proposal ID Nonce (hex): ${Buffer.from(proposalIdNonce).toString('hex')}`);
        console.log(`=== END KEY DERIVATION ===\n`);
        
        // Decrypt to verify they voted for the winning proposal
        console.log(`🔓 === DECRYPTING ENCRYPTED PROPOSAL ID ===`);
        console.log(`   Encrypted Proposal ID from receipt (hex): ${Buffer.from(voteReceipt.encryptedProposalId).toString('hex')}`);
        console.log(`   Using Proposal ID Nonce (hex): ${Buffer.from(proposalIdNonce).toString('hex')}`);
        try {
            const decrypted = cipher.decrypt([Array.from(voteReceipt.encryptedProposalId)], proposalIdNonce);
            const decryptedId = Number(decrypted[0]);
            console.log(`✅ Decrypted Proposal ID: ${decryptedId}`);
            console.log(`=== END DECRYPTION ===\n`);
            
            if (decryptedId !== winningProposalId) {
                throw new Error(`Vote mismatch: user voted for proposal ${decryptedId}, but winning proposal is ${winningProposalId}`);
            }
        } catch (e: any) {
            console.log(`❌ Decryption failed: ${e.message}`);
            throw new Error(`Could not decrypt vote for winning proposal: ${e.message}`);
        }
        
        // Reconstruct encryptedProposalId deterministically using the winning proposal ID and proposalIdNonce
        // This should match what's stored in the receipt
        const reconstructedEncryptedProposalId = cipher.encrypt([BigInt(winningProposalId)], proposalIdNonce);
        
        // Use reconstructed encryptedProposalId (should match receipt)
        vote = Array.from(reconstructedEncryptedProposalId[0]);
        // Reconstruct voteEncryptionPubkey deterministically from privateKey
        voteEncryptionPubkey = Array.from(publicKey); // publicKey was derived from privateKey above
        voteNonce = new BN(deserializeLE(proposalIdNonce).toString());
        
        console.log(`✅ Reconstructed vote data deterministically`);
    }
    
    // Prepare args for verifyWinningVote (following artmural.ts pattern)
    const computationOffset = new BN(randomBytes(8), "hex");
    const roundIdBN = new BN(roundId);
    
    console.log(`🔍 VerifyWinningVote preparation (following artmural.ts pattern):`);
    console.log(`   - Vote (encrypted_proposal_id, hex): ${Buffer.from(vote).toString('hex')}`);
    console.log(`   - Vote nonce (proposalIdNonce): ${voteNonce.toString()}`);
    console.log(`   - Vote encryption pubkey (hex): ${Buffer.from(voteEncryptionPubkey).toString('hex')}`);
    console.log(`   - Winning proposal: ${winningProposalId}`);
    console.log(`   - Note: verifyWinningVote will decrypt the vote using voteNonce and compare with stored encrypted_proposal_id`);

    // PDAs
    const [systemAccPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("proposal_system")],
        program.programId
    );
    const [roundMetadataPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("round_metadata")],
        program.programId
    );
    const [roundHistoryPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("voting_round_history"), systemAccPDA.toBuffer(), Buffer.from(roundIdBN.toArray("le", 8))],
        program.programId
    );
    const [roundEscrowPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("round_escrow"), Buffer.from(roundIdBN.toArray("le", 8))],
        program.programId
    );
    const [voteReceiptPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vote_receipt"), walletPublicKey.toBuffer(), Buffer.from(roundIdBN.toArray("le", 8))],
        program.programId
    );

    // Use the cluster offset from your deployment
    const clusterAccount = getClusterAccAddress(CLUSTER_OFFSET);

    // Build instruction
    console.log(`\n🔨 === BUILDING VERIFY WINNING VOTE INSTRUCTION ===`);
    console.log(`   Round ID: ${roundId}`);
    console.log(`   Wallet: ${walletPublicKey.toBase58()}`);
    console.log(`   Vote Receipt PDA: ${voteReceiptPDA.toBase58()}`);
    
    const instruction = await program.methods
        .verifyWinningVote(
            computationOffset,
            vote,
            voteEncryptionPubkey,
            voteNonce,
            roundIdBN
        )
        .accountsPartial({
            payer: walletPublicKey,
            systemAcc: systemAccPDA,
            computationAccount: getComputationAccAddress(program.programId, computationOffset),
            clusterAccount: clusterAccount,
            mxeAccount: getMXEAccAddress(program.programId),
            mempoolAccount: getMempoolAccAddress(program.programId),
            executingPool: getExecutingPoolAccAddress(program.programId),
            compDefAccount: getCompDefAccAddress(
                program.programId,
                Buffer.from(getCompDefAccOffset("verify_winning_vote")).readUInt32LE()
            ),
            roundMetadata: roundMetadataPDA,
            roundHistory: roundHistoryPDA,
            voteReceipt: voteReceiptPDA,
            roundEscrow: roundEscrowPDA,
        })
        .instruction();

    console.log(`✅ === VERIFY WINNING VOTE INSTRUCTION BUILT ===`);
    console.log(`   Round ID: ${roundId}`);
    console.log(`   Wallet: ${walletPublicKey.toBase58()}`);
    console.log(`   🔑 Computation Offset (hex): ${computationOffset.toString('hex')}`);
    console.log(`   🔑 Computation Offset (decimal): ${computationOffset.toString()}`);
    console.log(`   ⚠️  IMPORTANT: Use this EXACT computation offset when waiting for finalization!`);
    
    return { instruction, computationOffset };
}

// Check if vote receipt has is_winner flag set
export async function checkVoteReceiptWinnerFlag(
    connection: web3.Connection,
    programId: web3.PublicKey,
    walletPublicKey: web3.PublicKey,
    roundId: number
): Promise<boolean> {
    const roundIdBN = new BN(roundId);
    const roundIdBuffer = Buffer.from(roundIdBN.toArray("le", 8));
    const [voteReceiptPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vote_receipt"), walletPublicKey.toBuffer(), roundIdBuffer],
        programId
    );
    
    const accountInfo = await connection.getAccountInfo(voteReceiptPDA);
    if (!accountInfo) {
        return false;
    }
    
    // is_winner flag is at offset 105
    const isWinner = accountInfo.data[105] === 1;
    return isWinner;
}

// Check if user has already claimed their reward
// Note: There's no explicit hasClaimed field in VoteReceiptAccount
// This function checks if there might be additional data after is_winner flag
export async function checkVoteReceiptClaimed(
    connection: web3.Connection,
    programId: web3.PublicKey,
    walletPublicKey: web3.PublicKey,
    roundId: number
): Promise<boolean> {
    const roundIdBN = new BN(roundId);
    const roundIdBuffer = Buffer.from(roundIdBN.toArray("le", 8));
    const [voteReceiptPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vote_receipt"), walletPublicKey.toBuffer(), roundIdBuffer],
        programId
    );
    
    const accountInfo = await connection.getAccountInfo(voteReceiptPDA);
    if (!accountInfo) {
        return false;
    }
    
    // Check if account has more data after is_winner flag (offset 105)
    // If account size > 106, there might be additional fields
    // Structure: bump(1) + voter(32) + encrypted_proposal_id(32) + timestamp(8) + vote_encryption_pubkey(32) + is_winner(1) = 106 bytes
    const accountSize = accountInfo.data.length;
    const expectedSize = 106; // Minimum size
    
    // If account is larger than expected, check if there's a claimed flag at offset 106
    if (accountSize > expectedSize) {
        // Check if there's a byte at offset 106 (potential hasClaimed field)
        const hasClaimed = accountSize > 106 && accountInfo.data[106] === 1;
        return hasClaimed;
    }
    
    // No additional field found - would need to check via other means
    // (e.g., checking escrow balance, transaction history, or program logic)
    return false;
}

// Poll the vote receipt to wait for is_winner flag to be set to true
// Returns true if flag is set, false if timeout is reached
export async function pollVoteReceiptWinnerFlag(
    connection: web3.Connection,
    programId: web3.PublicKey,
    walletPublicKey: web3.PublicKey,
    roundId: number,
    timeoutMs: number = 60000, // 60 seconds default
    pollIntervalMs: number = 2000 // Poll every 2 seconds
): Promise<boolean> {
    const roundIdBN = new BN(roundId);
    const roundIdBuffer = Buffer.from(roundIdBN.toArray("le", 8));
    const [voteReceiptPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vote_receipt"), walletPublicKey.toBuffer(), roundIdBuffer],
        programId
    );
    
    console.log(`\n⏳ === POLLING VOTE RECEIPT FOR is_winner FLAG ===`);
    console.log(`   Vote Receipt PDA: ${voteReceiptPDA.toBase58()}`);
    console.log(`   Timeout: ${timeoutMs}ms`);
    console.log(`   Poll Interval: ${pollIntervalMs}ms`);
    
    const startTime = Date.now();
    let attempt = 0;
    
    while (Date.now() - startTime < timeoutMs) {
        attempt++;
        const elapsed = Date.now() - startTime;
        
        try {
            const accountInfo = await connection.getAccountInfo(voteReceiptPDA);
            
            if (!accountInfo) {
                console.log(`   ⚠️  Attempt ${attempt}: Vote receipt not found`);
                await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
                continue;
            }
            
            // is_winner flag is at offset 105
            const isWinner = accountInfo.data[105] === 1;
            
            if (isWinner) {
                console.log(`   ✅ Attempt ${attempt}: is_winner flag is TRUE! (elapsed: ${elapsed}ms)`);
                return true;
            } else {
                console.log(`   ⏳ Attempt ${attempt}: is_winner flag is false (elapsed: ${elapsed}ms)`);
            }
        } catch (error: any) {
            console.log(`   ⚠️  Attempt ${attempt}: Error checking vote receipt: ${error.message}`);
        }
        
        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    
    // Timeout reached
    const totalElapsed = Date.now() - startTime;
    console.log(`   ❌ TIMEOUT: Polling stopped after ${totalElapsed}ms (${attempt} attempts)`);
    console.log(`   Final check: is_winner flag is still false`);
    return false;
}

// Build instruction to claim reward (winner or voter)
export async function buildClaimRewardInstruction(
    program: Program,
    walletPublicKey: web3.PublicKey,
    roundId: number
): Promise<web3.TransactionInstruction> {
    const roundIdBN = new BN(roundId);

    const [systemAccPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("proposal_system")],
        program.programId
    );
    const [roundHistoryPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("voting_round_history"), systemAccPDA.toBuffer(), Buffer.from(roundIdBN.toArray("le", 8))],
        program.programId
    );
    const [roundEscrowPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("round_escrow"), Buffer.from(roundIdBN.toArray("le", 8))],
        program.programId
    );
    const [voteReceiptPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vote_receipt"), walletPublicKey.toBuffer(), Buffer.from(roundIdBN.toArray("le", 8))],
        program.programId
    );

    // Fetch round history to derive winning proposal PDA
    const roundData = await fetchRoundHistory(program, roundId);
    if (!roundData || roundData.winningProposalId === undefined) {
        throw new Error(`No winning proposal found for round ${roundId}`);
    }
    const [winningProposalPDA] = web3.PublicKey.findProgramAddressSync(
        [
            Buffer.from("proposal"),
            systemAccPDA.toBuffer(),
            Buffer.from(new BN(roundId).toArray("le", 8)),
            Buffer.from([roundData.winningProposalId!])
        ],
        program.programId
    );

    const instruction = await (program.methods as any)
        .claimReward(roundIdBN)
        .accountsPartial({
            payer: walletPublicKey,
            systemAcc: systemAccPDA,
            roundHistory: roundHistoryPDA,
            roundEscrow: roundEscrowPDA,
            voteReceipt: voteReceiptPDA,
            winningProposal: winningProposalPDA,
            systemProgram: web3.SystemProgram.programId,
        })
        .instruction();

    return instruction;
}
// Fetch round history (VotingRoundHistoryAccount)
export async function fetchRoundHistory(program: Program, roundId: number, setError?: (error: string) => void) {
    try {
        console.log(`🔍 FETCHING ROUND HISTORY FOR ROUND ${roundId}`);
        console.log("-".repeat(50));
        
        const [systemAccPDA] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("proposal_system")], 
            program.programId
        );
        
        // Derive round history PDA using the same seeds as the reference
        // Convert roundId to 8-byte little-endian buffer
        const roundIdBN = new BN(roundId);
        const roundIdBuffer = Buffer.from(roundIdBN.toArray("le", 8));
        
        const [roundHistoryPDA] = web3.PublicKey.findProgramAddressSync(
            [
                Buffer.from("voting_round_history"),
                systemAccPDA.toBuffer(),
                roundIdBuffer,
            ],
            program.programId
        );
        
        console.log("Round history PDA:", roundHistoryPDA.toString());
        
        const roundHistory = await (program.account as any).votingRoundHistoryAccount.fetch(roundHistoryPDA);
        
        console.log("✅ Round history found:");
        console.log("   - Round ID:", roundHistory.roundId.toString());
        console.log("   - Winning Proposal ID:", roundHistory.winningProposalId);
        console.log("   - Revealed At:", new Date(roundHistory.revealedAt.toNumber() * 1000).toISOString());
        console.log("   - Revealed By:", roundHistory.revealedBy.toBase58());
        console.log("   - Total Proposals:", roundHistory.totalProposals);
        console.log("   - Winning Vote Count:", roundHistory.winningVoteCount.toString());
        console.log("   - Total Voters:", roundHistory.totalVoters?.toString() || "N/A");
        
        // Convert theme from byte array to string
        const theme = bytesToString(new Uint8Array(roundHistory.theme));
        console.log("   - Theme:", theme);
        
        return {
            roundId: roundHistory.roundId.toNumber(),
            winningProposalId: roundHistory.winningProposalId,
            revealedAt: roundHistory.revealedAt.toNumber(),
            revealedBy: roundHistory.revealedBy,
            totalProposals: roundHistory.totalProposals,
            winningVoteCount: parseInt(roundHistory.winningVoteCount.toString()),
            totalVoters: roundHistory.totalVoters ? parseInt(roundHistory.totalVoters.toString()) : 0,
            theme: theme,
        };
    } catch (err: any) {
        console.error("❌ Error fetching round history:", err);
        if (setError) setError(`Failed to fetch round history: ${err.message}`);
        return null;
    }
}

// Fetch round history and winner proposal details
export async function fetchRoundHistoryWithWinner(program: Program, roundId: number, setError?: (error: string) => void) {
    try {
        // Fetch round history
        const roundHistory = await fetchRoundHistory(program, roundId, setError);
        if (!roundHistory) return null;
        
        // Fetch winning proposal details
        const winningProposalId = roundHistory.winningProposalId;
        
        console.log(`🔍 Fetching proposal ${winningProposalId} from round ${roundId}`);
        console.log(`📋 This is the ROUND-LOCAL proposal ID (not global ID)`);
        
        // First, get the system account PDA
        const [systemAccPDA] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("proposal_system")], 
            program.programId
        );
        
        console.log(`🔑 System Account PDA: ${systemAccPDA.toBase58()}`);
        
        // Fetch round metadata to get the current round (the round when the proposal was submitted)
        const [roundMetadataPDA] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("round_metadata")],
            program.programId
        );
        
        const roundMetadata = await (program.account as any).roundMetadataAccount.fetch(roundMetadataPDA);
        const proposalRoundId = roundMetadata.currentRound.toNumber();
        console.log(`📋 Proposal was submitted in round: ${proposalRoundId}`);
        
        // The winningProposalId is the round-local proposal ID (0, 1, 2, etc.)
        // PDA seeds: ["proposal", system_acc, round_id, proposal_id_in_round]
        const [proposalPDA] = web3.PublicKey.findProgramAddressSync(
            [
                Buffer.from("proposal"),
                systemAccPDA.toBuffer(),
                new BN(roundId).toArrayLike(Buffer, "le", 8), // Use the round ID from history
                Buffer.from([winningProposalId]) // Use round-local proposal ID as 1-byte
            ],
            program.programId
        );
        
        console.log(`🔑 Proposal PDA: ${proposalPDA.toBase58()}`);
        
        const proposal = await (program.account as any).proposalAccount.fetch(proposalPDA);
        
        console.log("✅ Winner proposal details:");
        console.log("   - Title:", proposal.title);
        console.log("   - Description:", proposal.description);
        console.log("   - URL:", proposal.url);
        
        // Use winning_vote_count from round history instead of proposal.voteCount
        console.log("   - Vote Count (from round history):", roundHistory.winningVoteCount);
        
        return {
            ...roundHistory,
            winningProposal: {
                title: proposal.title,
                description: proposal.description,
                url: proposal.url,
                voteCount: roundHistory.winningVoteCount,
                submitter: proposal.submitter,
            }
        };
    } catch (err: any) {
        console.error("❌ Error fetching round history with winner:", err);
        if (setError) setError(`Failed to fetch round history with winner: ${err.message}`);
        return null;
    }
}

// Vote on a proposal
export async function voteOnProposal(
    program: Program,
    walletPublicKey: web3.PublicKey,
    proposalId: number,
    mxePublicKey: Uint8Array,
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>,
    setError?: (error: string) => void
): Promise<{ instruction: web3.TransactionInstruction; voteData: VoteData }> {
    try {
        console.log(`\n🗳️  Voting on proposal ${proposalId}`);
        console.log("-".repeat(50));
        
        // Check if already voted
        const hasVoted = await checkVoteReceipt(program, walletPublicKey);
        if (hasVoted) {
            console.log("⚠️  Already voted on this proposal");
            const errorMsg = "You have already voted on this proposal";
            if (setError) setError(errorMsg);
            throw new Error(errorMsg);
        }
        
        // Get current round from round_metadata
        const roundId = await getCurrentRound(program);
        const roundIdBytes = Buffer.from(roundId.toArray("le", 8));
        
        // Generate proposalIdNonce and privateKey from a single common signed message
        // Use a round-specific message (without proposal ID) so it's the same for all votes in a round
        // Then derive proposal-specific nonce from signature + proposal ID combination
        let proposalIdNonce: Uint8Array;
        let privateKey: Uint8Array;
        
        let signature: Uint8Array;
        if (signMessage) {
            // Create a common round-specific message (same for all votes in the round)
            const messageText = `CipherCanvas Mural – Round ${roundId.toString()}\nVoter: ${walletPublicKey.toBase58()}\nSign to cast your secret brushstroke!`;
            const messageBytes = new TextEncoder().encode(messageText);
            
            console.log(`📝 Signing single common message for round ${roundId}...`);
            console.log(`   Message: ${messageText}`);
            
            // Sign the message once
            signature = await signMessage(messageBytes);
            
            // Derive private key from signature (round-specific, same for all votes in round)
            const keyHash = new Uint8Array(await crypto.subtle.digest('SHA-256', signature));
            privateKey = keyHash;
            
            // Derive proposal-specific nonce from signature + proposal ID combination
            // Combine signature with proposal ID bytes for proposal-specific nonce
            const proposalIdBytes = Buffer.from([proposalId]);
            const combinedForNonce = new Uint8Array(signature.length + proposalIdBytes.length);
            combinedForNonce.set(signature);
            combinedForNonce.set(proposalIdBytes, signature.length);
            const nonceHash = await crypto.subtle.digest('SHA-256', combinedForNonce);
            proposalIdNonce = new Uint8Array(nonceHash).slice(0, 16);
            
            console.log(`\n🔐 === DETERMINISTIC KEY DERIVATION ===`);
            console.log(`📝 Message: ${messageText}`);
            console.log(`🔑 Signature (first 16 bytes hex): ${Buffer.from(signature.slice(0, 16)).toString('hex')}...`);
            console.log(`\n✅ Initial derivation:`);
            console.log(`   - Private Key (hex): ${Buffer.from(privateKey).toString('hex')}`);
            console.log(`   - Proposal ID Nonce (hex): ${Buffer.from(proposalIdNonce).toString('hex')}`);
            
            // VERIFICATION: Recreate multiple times to prove determinism
            console.log(`\n🔍 === VERIFICATION: Recreating from same signature ===`);
            for (let i = 1; i <= 3; i++) {
                // Recreate privateKey
                const recreatedKeyHash = new Uint8Array(await crypto.subtle.digest('SHA-256', signature));
                const recreatedPrivateKey = recreatedKeyHash;
                
                // Recreate proposalIdNonce
                const recreatedProposalIdBytes = Buffer.from([proposalId]);
                const recreatedCombined = new Uint8Array(signature.length + recreatedProposalIdBytes.length);
                recreatedCombined.set(signature);
                recreatedCombined.set(recreatedProposalIdBytes, signature.length);
                const recreatedNonceHash = await crypto.subtle.digest('SHA-256', recreatedCombined);
                const recreatedProposalIdNonce = new Uint8Array(recreatedNonceHash).slice(0, 16);
                
                console.log(`\n   Attempt ${i}:`);
                console.log(`   - Recreated Private Key (hex): ${Buffer.from(recreatedPrivateKey).toString('hex')}`);
                console.log(`   - Recreated Proposal ID Nonce (hex): ${Buffer.from(recreatedProposalIdNonce).toString('hex')}`);
                
                // Verify they match
                const privateKeyMatch = Buffer.from(privateKey).equals(Buffer.from(recreatedPrivateKey));
                const nonceMatch = Buffer.from(proposalIdNonce).equals(Buffer.from(recreatedProposalIdNonce));
                
                console.log(`   - Private Key Match: ${privateKeyMatch ? '✅' : '❌'}`);
                console.log(`   - Proposal ID Nonce Match: ${nonceMatch ? '✅' : '❌'}`);
                
                if (!privateKeyMatch || !nonceMatch) {
                    throw new Error(`❌ Deterministic recreation failed on attempt ${i}! Values should be identical.`);
                }
            }
            console.log(`\n✅ All recreations match! Deterministic derivation verified.`);
            console.log(`=== END VERIFICATION ===\n`);
        } else {
            const errorMsg = "Wallet must support signMessage to cast a vote (needed for deterministic encryption)";
            if (setError) setError(errorMsg);
            throw new Error(errorMsg);
        }
        
        // Generate encryption data
        const vote = BigInt(proposalId);

        const publicKey = x25519.getPublicKey(privateKey);
        const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
        const cipher = new RescueCipher(sharedSecret);
        
        // Derive ciphertext nonce deterministically from signature + proposal ID
        // Use bytes 16-32 of the hash (different from proposalIdNonce which uses bytes 0-16 from different hash)
        // This allows us to re-derive it later for verification
        // Reuse the same signature we already have from above
        const cipherNonceHash = await crypto.subtle.digest('SHA-256', Buffer.concat([
            signature,
            Buffer.from([proposalId]),
            Buffer.from("ciphertext") // Add suffix to make it different from proposalIdNonce derivation
        ]));
        const cipherNonceHashArray = new Uint8Array(cipherNonceHash);
        const nonceSlice = cipherNonceHashArray.slice(16, 32); // Use bytes 16-32 for ciphertext nonce (16 bytes)
        
        // Convert to Buffer to ensure proper format
        const nonce = Buffer.from(nonceSlice);
        
        // Validate nonce length
        if (nonce.length !== 16) {
            throw new Error(`Invalid nonce length: expected 16 bytes, got ${nonce.length}`);
        }
        
        console.log(`✅ Ciphertext nonce derived: ${nonce.toString('hex')} (length: ${nonce.length})`);
        
        // Convert back to Uint8Array for encryption (RescueCipher expects Uint8Array)
        const nonceUint8Array = new Uint8Array(nonce);
        const ciphertext = cipher.encrypt([vote], nonceUint8Array);
        const encryptedProposalId = cipher.encrypt([vote], proposalIdNonce);
        
        console.log(`🔐 Generated encryption data:`);
        console.log(`   - Vote: ${vote}`);
        console.log(`   - Public Key: ${Buffer.from(publicKey).toString('hex')}`);
        console.log(`   - Nonce: ${nonce.toString('hex')} (deterministic from signature)`);
        console.log(`   - Proposal ID Nonce: ${Buffer.from(proposalIdNonce).toString('hex')} (from signature)`);
        
        const [systemAccPDA] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("proposal_system")], 
            program.programId
        );
        
        const [roundMetadataPDA] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("round_metadata")],
            program.programId
        );
        
        const [voteReceiptPDA] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("vote_receipt"), walletPublicKey.toBuffer(), roundIdBytes],
            program.programId
        );
        
        // Generate random voteComputationOffset
        const voteComputationOffset = new BN(randomBytes(8), "hex");
        
        // Use the cluster offset from your deployment
        const clusterAccount = getClusterAccAddress(CLUSTER_OFFSET);
        console.log("🌐 Using cluster account:", clusterAccount.toBase58());
        
        console.log(`💰 System Account: ${systemAccPDA.toBase58()}`);
        console.log(`📋 Round Metadata: ${roundMetadataPDA.toBase58()}`);
        console.log(`📝 Vote Receipt: ${voteReceiptPDA.toBase58()}`);
        console.log(`🔧 Computation Offset: ${voteComputationOffset.toString()}`);
        console.log(`🌐 Cluster Account: ${clusterAccount.toBase58()}`);
        
        // Build the instruction instead of calling .rpc()
        const instruction = await program.methods
            .voteForProposal(
                voteComputationOffset,
                proposalId,
                Array.from(encryptedProposalId[0]),
                Array.from(ciphertext[0]),
                Array.from(publicKey),
                new BN(deserializeLE(nonce).toString()),
                roundId
            )
            .accountsPartial({
                payer: walletPublicKey,
                systemAcc: systemAccPDA,
                computationAccount: getComputationAccAddress(program.programId, voteComputationOffset),
                clusterAccount: clusterAccount,
                mxeAccount: getMXEAccAddress(program.programId),
                mempoolAccount: getMempoolAccAddress(program.programId),
                executingPool: getExecutingPoolAccAddress(program.programId),
                compDefAccount: getCompDefAccAddress(
                    program.programId,
                    Buffer.from(getCompDefAccOffset("vote_for_proposal")).readUInt32LE()
                ),
                roundMetadata: roundMetadataPDA,
                voteReceipt: voteReceiptPDA
            })
            .instruction();
        
        console.log(`✅ Vote instruction built successfully!`);
        
        // Create vote data structure (similar to artmural.ts round0VoteReceipts)
        // Convert encryptedProposalId to Uint8Array if needed
        const encryptedVoteBytes = encryptedProposalId[0];
        const encryptedVoteUint8 = encryptedVoteBytes instanceof Uint8Array 
            ? encryptedVoteBytes 
            : new Uint8Array(encryptedVoteBytes);
        
        const voteData: VoteData = {
            voter: walletPublicKey.toBase58(),
            pda: voteReceiptPDA,
            round: roundId.toNumber(),
            proposalId: proposalId,
            encryptedVote: encryptedVoteUint8, // encryptedProposalId stored in receipt
            voteEncryptionPubkey: publicKey,
            voteNonce: proposalIdNonce, // proposalIdNonce used for encryptedProposalId
            timestamp: Date.now()
        };
        
        console.log(`📦 Vote data prepared:`);
        console.log(`   - Voter: ${voteData.voter}`);
        console.log(`   - Proposal ID: ${voteData.proposalId}`);
        console.log(`   - Round: ${voteData.round}`);
        console.log(`   - Encrypted Vote (hex): ${Buffer.from(voteData.encryptedVote).toString('hex')}`);
        console.log(`   - Vote Nonce (hex): ${Buffer.from(voteData.voteNonce).toString('hex')}`);
        
        // Return both instruction and vote data
        return { instruction, voteData };
    } catch (err: any) {
        console.error(`❌ Failed to vote on proposal:`, err.message);
        if (setError) setError(`Failed to vote on proposal: ${err.message}`);
        throw err;
    }
}

// Submit a new proposal
export async function submitProposal(
    program: Program,
    walletPublicKey: web3.PublicKey,
    proposalTitle: string,
    proposalDescription: string,
    proposalUrl: string,
    setError?: (error: string) => void
) {
    try {
        console.log(`\n📝 SUBMITTING PROPOSAL: "${proposalTitle}"`);
        console.log(`📄 Description: "${proposalDescription}"`);
        console.log(`🔗 URL: "${proposalUrl}"`);
        console.log("-".repeat(50));
        
        if (!proposalTitle.trim() || !proposalDescription.trim() || !proposalUrl.trim()) {
            const errorMsg = "Please fill in title, description, and URL";
            if (setError) setError(errorMsg);
            throw new Error(errorMsg);
        }
        
        const [systemAccPDA] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("proposal_system")], 
            program.programId
        );
        
        const systemAccount = await (program.account as any).proposalSystemAccount.fetch(systemAccPDA);
        const proposalId = systemAccount.nextProposalId;
        
        console.log(`🆔 Proposal ID: ${proposalId.toString()}`);
        console.log(`👤 Submitter: ${walletPublicKey.toBase58()}`);
        
        // Get current round from round_metadata (required for round_escrow PDA derivation)
        const roundId = await getCurrentRound(program);
        const roundIdBytes = Buffer.from(roundId.toArray("le", 8));
        
        console.log(`📅 Current round: ${roundId.toString()}`);
        
        const [roundEscrowPDA] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("round_escrow"), roundIdBytes],
            program.programId
        );
        
        console.log(`💰 Round Escrow: ${roundEscrowPDA.toBase58()}`);
        
        // Get round_metadata PDA (needed for Anchor to derive round_escrow)
        const [roundMetadataPDA] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("round_metadata")],
            program.programId
        );
        
        const signature = await program.methods
            .submitProposal(proposalTitle, proposalDescription, proposalUrl)
            .accountsPartial({
                payer: walletPublicKey,
                roundEscrow: roundEscrowPDA,
                roundMetadata: roundMetadataPDA,
            })
            .rpc({ 
                skipPreflight: false, 
                commitment: "confirmed",
                preflightCommitment: "confirmed"
            });
        
        console.log(`✅ Proposal submitted successfully!`);
        console.log(`📝 Transaction signature: ${signature}`);
        
        return signature;
    } catch (err: any) {
        console.error(`❌ Failed to submit proposal:`, err.message);
        if (setError) setError(`Failed to submit proposal: ${err.message}`);
        throw err;
    }
}

// Get MXE public key
export async function getMXEKey(provider: AnchorProvider, programId: web3.PublicKey) {
    try {
        const mxeKey = await getMXEPublicKey(provider, programId);
        if (mxeKey) {
            console.log("✅ MXE Public Key loaded:", Buffer.from(mxeKey).toString('hex'));
            return mxeKey;
        } else {
            console.error("❌ MXE public key is null");
            return null;
        }
    } catch (err) {
        console.error("❌ Failed to load MXE public key:", err);
        return null;
    }
}

// Load vote receipts
export async function loadVoteReceipts(program: Program, walletPublicKey: web3.PublicKey) {
    try {
        // Get current round from round_metadata
        const roundId = await getCurrentRound(program);
        const roundIdBytes = Buffer.from(roundId.toArray("le", 8));
        
        const [voteReceiptPDA] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("vote_receipt"), walletPublicKey.toBuffer(), roundIdBytes],
            program.programId
        );
        
        const voteReceipt = await (program.account as any).voteReceiptAccount.fetch(voteReceiptPDA);
        
        console.log("✅ Found existing vote receipt:", voteReceipt);
        
        return {
            signature: "existing_vote",
            timestamp: voteReceipt.timestamp * 1000,
            roundId: voteReceipt.roundId
        };
    } catch (error) {
        console.log("No existing vote receipt found");
        return null;
    }
}

// Verify winning vote using stored private key and proposal ID nonce
export async function verifyWinningVoteWithStoredKeys(
    provider: AnchorProvider,
    program: Program,
    walletPublicKey: web3.PublicKey,
    roundId: number,
    storedPrivateKey: Uint8Array,     // ✅ Stored private key from VoteData
    storedProposalIdNonce: Uint8Array, // ✅ Stored proposalIdNonce from VoteData (16 bytes)
    mxePublicKey: Uint8Array
): Promise<{
    isWinner: boolean;
    decryptedProposalId: number;
    transactionSignature: string;
}> {
    console.log(`\n🔍 VERIFYING WINNING VOTE WITH STORED KEYS`);
    console.log("-".repeat(50));
    console.log(`   Round ID: ${roundId}`);
    console.log(`   Wallet: ${walletPublicKey.toBase58()}`);
    
    // ============================================
    // STEP 1: Recreate the vote encryption public key
    // ============================================
    const publicKey = x25519.getPublicKey(storedPrivateKey);
    console.log(`🔑 Generated public key from stored private key (hex): ${Buffer.from(publicKey).toString('hex')}`);
    
    // ============================================
    // STEP 2: Derive the vote receipt PDA
    // ============================================
    const roundIdBN = new BN(roundId);
    const roundIdBuffer = Buffer.from(roundIdBN.toArray("le", 8));
    const [voteReceiptPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vote_receipt"), walletPublicKey.toBuffer(), roundIdBuffer],
        program.programId
    );
    
    console.log(`📝 Vote Receipt PDA: ${voteReceiptPDA.toBase58()}`);
    
    // ============================================
    // STEP 3: Fetch vote receipt from blockchain and extract encrypted_proposal_id
    // ============================================
    const voteReceiptAccountInfo = await provider.connection.getAccountInfo(voteReceiptPDA);
    if (!voteReceiptAccountInfo) {
        throw new Error("Vote receipt not found");
    }
    
    const accountData = voteReceiptAccountInfo.data;
    
    // Parse VoteReceiptAccount structure manually:
    // bump(1) + voter(32) + encrypted_proposal_id(32) + timestamp(8) + vote_encryption_pubkey(32) + is_winner(1)
    // Extract encrypted_proposal_id from vote receipt (offset 33-65, 32 bytes)
    // This is what gets passed to verifyWinningVote (like testVoteData.encryptedVote in artmural.ts)
    const encryptedProposalId = accountData.slice(33, 65); // 32 bytes
    
    // Extract vote_encryption_pubkey from receipt (offset 73-105) for verification
    const storedVoteEncryptionPubkey = accountData.slice(73, 105);
    
    console.log("\n📋 === VOTING RECEIPT OBJECT ===");
    console.log(`   Voter: ${walletPublicKey.toBase58()}`);
    console.log(`   Encrypted Proposal ID (hex): ${Buffer.from(encryptedProposalId).toString('hex')}`);
    console.log(`   Vote Encryption Pubkey (hex): ${Buffer.from(storedVoteEncryptionPubkey).toString('hex')}`);
    console.log(`   PDA: ${voteReceiptPDA.toBase58()}`);
    console.log(`=== END RECEIPT ===\n`);
    
    // ============================================
    // STEP 4: OPTIONAL - Decrypt to verify yourself
    // ============================================
    const sharedSecret = x25519.getSharedSecret(storedPrivateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);
    
    console.log(`🔓 === DECRYPTING ENCRYPTED PROPOSAL ID ===`);
    console.log(`   Encrypted Proposal ID from receipt (hex): ${Buffer.from(encryptedProposalId).toString('hex')}`);
    console.log(`   Using Proposal ID Nonce (hex): ${Buffer.from(storedProposalIdNonce).toString('hex')}`);
    
    const decrypted = cipher.decrypt([Array.from(encryptedProposalId)], storedProposalIdNonce);
    const decryptedProposalId = Number(decrypted[0]);
    
    console.log(`✅ Decrypted Proposal ID: ${decryptedProposalId}`);
    console.log(`   (You can verify this matches what you voted for)`);
    console.log(`=== END DECRYPTION ===\n`);
    
    // ============================================
    // STEP 5: Fetch round history to get winning proposal ID
    // ============================================
    const roundData = await fetchRoundHistory(program, roundId);
    if (!roundData || roundData.winningProposalId === undefined) {
        throw new Error(`No winning proposal found for round ${roundId}`);
    }
    const winningProposalId = roundData.winningProposalId!;
    
    console.log(`🏆 Winning Proposal ID for round ${roundId}: ${winningProposalId}`);
    
    if (decryptedProposalId !== winningProposalId) {
        throw new Error(`Vote mismatch: decrypted proposal ID is ${decryptedProposalId}, but winning proposal is ${winningProposalId}`);
    }
    
    // ============================================
    // STEP 6: Derive required PDAs for verify_winning_vote
    // ============================================
    const [systemAccPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("proposal_system")],
        program.programId
    );
    
    const [roundHistoryPDA] = web3.PublicKey.findProgramAddressSync(
        [
            Buffer.from("voting_round_history"),
            systemAccPDA.toBuffer(),
            roundIdBuffer,
        ],
        program.programId
    );
    
    const [roundEscrowPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("round_escrow"), roundIdBuffer],
        program.programId
    );
    
    const [roundMetadataPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("round_metadata")],
        program.programId
    );
    
    console.log(`📋 System Account PDA: ${systemAccPDA.toBase58()}`);
    console.log(`📋 Round History PDA: ${roundHistoryPDA.toBase58()}`);
    console.log(`📋 Round Escrow PDA: ${roundEscrowPDA.toBase58()}`);
    
    // ============================================
    // STEP 7: Generate computation offset for MPC
    // ============================================
    const verifyComputationOffset = new BN(randomBytes(8), "hex");
    console.log(`🔧 Computation Offset: ${verifyComputationOffset.toString()}`);
    
    // ============================================
    // STEP 8: Use the cluster offset from your deployment
    // ============================================
    const clusterAccount = getClusterAccAddress(CLUSTER_OFFSET);
    console.log(`🌐 Cluster Account: ${clusterAccount.toBase58()}`);
    
    // ============================================
    // STEP 9: Call verify_winning_vote
    // ============================================
    // Convert encrypted proposal ID from vote receipt to array format (like testVoteData.encryptedVote)
    const encryptedProposalIdArray = Array.from(encryptedProposalId);
    
    console.log(`\n🚀 === CALLING VERIFY WINNING VOTE ===`);
    console.log(`   Round ID: ${roundId}`);
    console.log(`   Wallet: ${walletPublicKey.toBase58()}`);
    console.log(`   Vote (encrypted_proposal_id from receipt, hex): ${Buffer.from(encryptedProposalId).toString('hex')}`);
    console.log(`   Vote encryption pubkey (hex): ${Buffer.from(publicKey).toString('hex')}`);
    console.log(`   Vote nonce (proposalIdNonce): ${new BN(deserializeLE(storedProposalIdNonce).toString()).toString()}`);
    console.log(`   Vote Receipt PDA: ${voteReceiptPDA.toBase58()}`);
    
    const verifySig = await program.methods
        .verifyWinningVote(
            verifyComputationOffset,
            encryptedProposalIdArray,                      // ← encrypted_proposal_id from vote receipt (not decrypted!)
            Array.from(publicKey),                        // ← Your X25519 public key derived from stored private key
            new BN(deserializeLE(storedProposalIdNonce).toString()), // ← Stored proposalIdNonce (16 bytes)
            roundIdBN                                     // ← Round ID
        )
        .accountsPartial({
            payer: walletPublicKey,
            systemAcc: systemAccPDA,
            computationAccount: getComputationAccAddress(program.programId, verifyComputationOffset),
            clusterAccount: clusterAccount,              // ← Hardcoded cluster account
            mxeAccount: getMXEAccAddress(program.programId),
            mempoolAccount: getMempoolAccAddress(program.programId),
            executingPool: getExecutingPoolAccAddress(program.programId),
            compDefAccount: getCompDefAccAddress(
                program.programId,
                Buffer.from(getCompDefAccOffset("verify_winning_vote")).readUInt32LE()
            ),
            roundMetadata: roundMetadataPDA,
            roundHistory: roundHistoryPDA,
            voteReceipt: voteReceiptPDA,                  // ← Vote receipt PDA
            roundEscrow: roundEscrowPDA,
        })
        .rpc({
            commitment: "confirmed",
            skipPreflight: false,
        });
    
    console.log(`✅ === VERIFY WINNING VOTE SUCCESSFUL ===`);
    console.log(`   Transaction Signature: ${verifySig}`);
    console.log(`   Round ID: ${roundId}`);
    console.log(`   Wallet: ${walletPublicKey.toBase58()}`);
    
    // ============================================
    // STEP 10: Wait for MPC computation to complete
    // ============================================
    console.log(`⏳ Waiting for computation to finalize...`);
    await awaitComputationFinalization(
        provider,
        verifyComputationOffset,
        program.programId,
        "confirmed"
    );
    
    console.log(`✅ Verification computation finalized`);
    console.log(`✅ === VERIFY WINNING VOTE COMPUTATION COMPLETE ===`);
    
    // ============================================
    // STEP 11: Check if vote receipt was marked as winner
    // ============================================
    const updatedReceiptInfo = await provider.connection.getAccountInfo(voteReceiptPDA);
    if (!updatedReceiptInfo) {
        throw new Error("Vote receipt not found after verification");
    }
    const updatedAccountData = updatedReceiptInfo.data;
    const isWinner = updatedAccountData[105] === 1; // Offset 105
    
    console.log(`\n🏆 === VERIFICATION RESULT ===`);
    console.log(`   Vote was for winning proposal: ${isWinner}`);
    console.log(`   Transaction: ${verifySig}`);
    console.log(`=== END RESULT ===\n`);
    
    return {
        isWinner,
        decryptedProposalId,
        transactionSignature: verifySig
    };
}


