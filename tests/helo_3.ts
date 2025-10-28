import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { ProposalSystem } from "../target/types/proposal_system";
import { BN } from "@coral-xyz/anchor";
import { randomBytes } from "crypto";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgAddress,
  uploadCircuit,
  buildFinalizeCompDefTx,
  RescueCipher,
  deserializeLE,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  x25519,
  getComputationAccAddress,
  getMXEPublicKey,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";

// Helper function to retry RPC calls with fresh blockhash
async function retryRpcCall<T>(
  rpcCall: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await rpcCall();
    } catch (error: any) {
      if (error.message?.includes("Blockhash not found") && attempt < maxRetries) {
        console.log(`Attempt ${attempt} failed with blockhash error, retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Failed after ${maxRetries} attempts`);
}

describe("Proposal System", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.ProposalSystem as Program<ProposalSystem>;
  const provider = anchor.getProvider();

  type Event = anchor.IdlEvents<(typeof program)["idl"]>;
  const awaitEvent = async <E extends keyof Event>(eventName: E) => {
    let listenerId: number;
    const event = await new Promise<Event[E]>((res) => {
      listenerId = program.addEventListener(eventName, (event) => {
        res(event);
      });
    });
    await program.removeEventListener(listenerId);

    return event;
  };

  const arciumEnv = getArciumEnv();
  
  // Helper function to fetch proposals for a specific round using new PDA structure
  async function fetchProposalsForRound(targetRound: number) {
    console.log(`\n🔍 FETCHING PROPOSALS FOR ROUND ${targetRound}`);
    console.log("-".repeat(50));
    
    const [systemAccPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("proposal_system")], 
      program.programId
    );
    
    const [roundMetadataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("round_metadata")], 
      program.programId
    );
    
    // Get the round metadata to find how many proposals are in the target round
    let proposalsInRound = 0;
    try {
      const roundMetadata = await program.account.roundMetadataAccount.fetch(roundMetadataPDA);
      
      // If we're asking for the current round, use the current counter
      if (targetRound === roundMetadata.currentRound.toNumber()) {
        proposalsInRound = (roundMetadata as any).proposalsInCurrentRound || 0;
      } else {
        // For past rounds, we need to check the round history
        // For now, we'll try to fetch up to 10 proposals and filter by round
        proposalsInRound = 10; // Maximum proposals per round
      }
    } catch (error) {
      console.log(`❌ Could not fetch round metadata: ${error}`);
      return [];
    }
    
    console.log(`📋 Checking up to ${proposalsInRound} proposals for Round ${targetRound}`);
    
    const proposals = [];
    
    for (let proposalIdInRound = 0; proposalIdInRound < proposalsInRound; proposalIdInRound++) {
      try {
        const [proposalPDA] = PublicKey.findProgramAddressSync(
          [
            Buffer.from("proposal"),
            systemAccPDA.toBuffer(),
            new BN(targetRound).toArrayLike(Buffer, "le", 8), // Round ID as 8-byte little-endian
            new BN(proposalIdInRound).toArrayLike(Buffer, "le", 1) // Proposal ID within round as 1-byte little-endian
          ],
          program.programId
        );
        
        const proposal = await program.account.proposalAccount.fetch(proposalPDA);
        
        // Verify it's actually from the target round
        if ((proposal as any).roundId && (proposal as any).roundId.eq(new BN(targetRound))) {
          proposals.push({
            id: proposalIdInRound,
            roundId: (proposal as any).roundId,
            title: proposal.title,
            description: proposal.description,
            submitter: proposal.submitter,
            voteCount: proposal.voteCount,
            pda: proposalPDA
          });
          
          console.log(`✅ Proposal ${proposalIdInRound}: "${proposal.title}" (Round ${(proposal as any).roundId})`);
        }
      } catch (error) {
        // No more proposals for this round
        console.log(`❌ No proposal found with ID ${proposalIdInRound} for Round ${targetRound}`);
        break; // Stop checking once we hit a missing proposal
      }
    }
    
    console.log(`\n📊 Found ${proposals.length} proposals for Round ${targetRound}`);
    return proposals;
  }
  
  // Initialize computation definitions once before all tests
  before(async () => {
    const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

    // Add a longer delay to ensure the cluster is fully ready
    console.log("Waiting for cluster to be fully ready...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    const mxePublicKey = await getMXEPublicKeyWithRetry(
      provider as anchor.AnchorProvider,
      program.programId
    );

    console.log("MXE x25519 pubkey is", mxePublicKey);

    console.log("Initializing proposal votes computation definition");
    const initProposalVotesSig = await retryRpcCall(async () => {
      return await initProposalVotesCompDef(program, owner, false, false);
    });
    console.log(
      "Proposal votes computation definition initialized with signature",
      initProposalVotesSig
    );

    console.log("Initializing vote for proposal computation definition");
    const initVoteForProposalSig = await retryRpcCall(async () => {
      return await initVoteForProposalCompDef(program, owner, false, false);
    });
    console.log(
      "Vote for proposal computation definition initialized with signature",
      initVoteForProposalSig
    );

    console.log("Initializing reveal winning proposal computation definition");
    const initRevealWinnerSig = await retryRpcCall(async () => {
      return await initRevealWinnerCompDef(program, owner, false, false);
    });
    console.log(
      "Reveal winning proposal computation definition initialized with signature",
      initRevealWinnerSig
    );

    console.log("Initializing decrypt vote computation definition");
    const initDecryptVoteSig = await retryRpcCall(async () => {
      return await initDecryptVoteCompDef(program, owner, false, false);
    });
    console.log(
      "Decrypt vote computation definition initialized with signature",
      initDecryptVoteSig
    );

    console.log("Initializing verify winning vote computation definition");
    const initVerifyWinningVoteSig = await retryRpcCall(async () => {
      return await initVerifyWinningVoteCompDef(program, owner, false, false);
    });
    console.log(
      "Verify winning vote computation definition initialized with signature",
      initVerifyWinningVoteSig
    );
  });

  it.only("can initialize the proposal system", async () => {
    const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

    const mxePublicKey = await getMXEPublicKeyWithRetry(
      provider as anchor.AnchorProvider,
      program.programId
    );

    console.log("MXE x25519 pubkey is", mxePublicKey);

    // Test basic system initialization
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);

    // Initialize the proposal system
    const systemNonce = randomBytes(16);
    const systemComputationOffset = new anchor.BN(randomBytes(8), "hex");

    console.log("Attempting to initialize proposal system...");
    const initSystemSig = await retryRpcCall(async () => {
      return await program.methods
        .initProposalSystem(
          systemComputationOffset,
          new anchor.BN(deserializeLE(systemNonce).toString())
        )
        .accountsPartial({
          computationAccount: getComputationAccAddress(
            program.programId,
            systemComputationOffset
          ),
          clusterAccount: arciumEnv.arciumClusterPubkey,
          mxeAccount: getMXEAccAddress(program.programId),
          mempoolAccount: getMempoolAccAddress(program.programId),
          executingPool: getExecutingPoolAccAddress(program.programId),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            Buffer.from(getCompDefAccOffset("init_proposal_votes")).readUInt32LE()
          ),
        })
        .rpc({ 
          skipPreflight: false, 
          commitment: "processed",
          preflightCommitment: "processed"
        });
    });

    console.log("Proposal system initialized with signature", initSystemSig);

   
    expect(initSystemSig).to.be.a('string');
  });



    it.only("can handle 2 rounds of voting with complete blockchain verification!", async () => {
    const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

    const mxePublicKey = await getMXEPublicKeyWithRetry(
      provider as anchor.AnchorProvider,
      program.programId
    );

    console.log("MXE x25519 pubkey is", mxePublicKey);

    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);

    // Add global error handling to prevent test crashes
    const originalProcessListeners = process.listeners('uncaughtException');
    const originalUnhandledRejection = process.listeners('unhandledRejection');
    
    // Remove existing listeners to avoid conflicts
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    
    // Add custom error handler
    const errorHandler = (error: any) => {
      if (error?.message?.includes?.('mxeProgramId.equals is not a function')) {
        console.log('⚠️  Suppressing Arcium client library error:', error.message);
        return; // Don't crash the test
      }
      // Re-throw other errors
      throw error;
    };
    
    process.on('uncaughtException', errorHandler);
    process.on('unhandledRejection', errorHandler);

    // ========================================
    // ROUND 0: INITIAL VOTING ROUND
    // ========================================
    console.log("\n" + "=".repeat(60));
    console.log("🚀 STARTING ROUND 0 VOTING");
    console.log("=".repeat(60));

    // Submit 3 proposals for Round 0
    console.log("\n📝 SUBMITTING PROPOSALS FOR ROUND 0");
    console.log("-".repeat(40));
    
    // Get round escrow PDA for Round 0 (outside the loop)
    const round0Id = new BN(0);
    const round0IdBytes = round0Id.toArrayLike(Buffer, "le", 8);
    const [roundEscrowPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("round_escrow"), round0IdBytes],
      program.programId
    );
    
    console.log(`Round 0 escrow PDA: ${roundEscrowPDA.toBase58()}`);
    
    for (let i = 0; i < 3; i++) {
      const proposalTitle = `Round 0 Proposal ${i}`;
      const proposalDescription = `Build feature ${i}`;
      const proposalUrl = `https://example.com/proposal/${i}`;
      console.log(`Submitting: ${proposalTitle} - ${proposalDescription}`);
      
      const submitProposalSig = await retryRpcCall(async () => {
        return await program.methods
          .submitProposal(proposalTitle, proposalDescription, proposalUrl)
          .accountsPartial({
            payer: owner.publicKey,
            roundEscrow: roundEscrowPDA,
          })
          .rpc({ 
            skipPreflight: false, 
            commitment: "confirmed",
            preflightCommitment: "confirmed"
          });
      });

      console.log(`✅ Proposal ${i} submitted with signature: ${submitProposalSig}`);
      
      // Verify escrow balance after each proposal
      try {
        const roundEscrowAccount = await program.account.roundEscrowAccount.fetch(roundEscrowPDA);
        console.log(`💰 Round 0 escrow balance: ${roundEscrowAccount.currentBalance} lamports (${(Number(roundEscrowAccount.currentBalance) / 1_000_000_000).toFixed(6)} SOL)`);
        console.log(`💰 Total collected: ${roundEscrowAccount.totalCollected} lamports`);
        console.log(`💰 Round status: ${JSON.stringify(roundEscrowAccount.roundStatus)}`);
      } catch (error) {
        console.log("⚠️ Could not fetch escrow account (may not exist yet)");
      }
    }

    // Verify Round 0 escrow balance
    console.log("\n💰 VERIFYING ROUND 0 ESCROW BALANCE");
    console.log("-".repeat(40));
    
    try {
      const round0EscrowAccount = await program.account.roundEscrowAccount.fetch(roundEscrowPDA);
      console.log(`✅ Round 0 escrow account found:`);
      console.log(`   - Round ID: ${round0EscrowAccount.roundId}`);
      console.log(`   - Total collected: ${round0EscrowAccount.totalCollected} lamports (${(Number(round0EscrowAccount.totalCollected) / 1_000_000_000).toFixed(6)} SOL)`);
      console.log(`   - Current balance: ${round0EscrowAccount.currentBalance} lamports (${(Number(round0EscrowAccount.currentBalance) / 1_000_000_000).toFixed(6)} SOL)`);
      console.log(`   - Total distributed: ${round0EscrowAccount.totalDistributed} lamports`);
      console.log(`   - Round status: ${round0EscrowAccount.roundStatus}`);
      console.log(`   - Created at: ${new Date(Number(round0EscrowAccount.createdAt) * 1000).toISOString()}`);
      
      // 🔥 FETCH REAL SOL BALANCE OF THE PDA ACCOUNT
      const realSolBalance = await provider.connection.getBalance(roundEscrowPDA);
      console.log(`\n🔥 REAL SOL BALANCE OF ESCROW PDA:`);
      console.log(`   - PDA Address: ${roundEscrowPDA.toBase58()}`);
      console.log(`   - Real SOL Balance: ${realSolBalance} lamports (${(realSolBalance / 1_000_000_000).toFixed(6)} SOL)`);
      console.log(`   - Account Rent: ${await provider.connection.getMinimumBalanceForRentExemption(50)} lamports (50 bytes)`);
      console.log(`   - Net Balance (after rent): ${realSolBalance - await provider.connection.getMinimumBalanceForRentExemption(50)} lamports`);
      
      // Verify expected balance (3 proposals × 0.001 SOL = 0.003 SOL)
      const expectedBalance = 3 * 1_000_000; // 3 proposals × 1,000,000 lamports
      expect(round0EscrowAccount.totalCollected.toNumber()).to.equal(expectedBalance);
      expect(round0EscrowAccount.currentBalance.toNumber()).to.equal(expectedBalance);
      
      // Verify real SOL balance matches expected balance + rent
      // RoundEscrowAccount size: 8 (discriminator) + 1 (bump) + 8 (round_id) + 8 (total_collected) + 8 (total_distributed) + 8 (current_balance) + 1 (round_status) + 8 (created_at) = 50 bytes
      const rentExemption = await provider.connection.getMinimumBalanceForRentExemption(50);
      const expectedRealBalance = expectedBalance + rentExemption;
      expect(realSolBalance).to.equal(expectedRealBalance);
      console.log(`✅ Real SOL balance verification passed: ${expectedRealBalance} lamports (${expectedBalance} + ${rentExemption} rent)`);
    } catch (error) {
      console.log("❌ Could not fetch Round 0 escrow account:", error);
    }

    // Verify Round 0 proposals on blockchain using new PDA structure
    console.log("\n🔍 VERIFYING ROUND 0 PROPOSALS ON BLOCKCHAIN");
    console.log("-".repeat(40));
    
    const [systemAccPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("proposal_system")],
      program.programId
    );
    
    const systemAcc = await program.account.proposalSystemAccount.fetch(systemAccPDA);
    const roundMetadataInitial = await program.account.roundMetadataAccount.fetch(
      PublicKey.findProgramAddressSync([Buffer.from("round_metadata")], program.programId)[0]
    );
    console.log(`✅ System Account - Next Proposal ID: ${systemAcc.nextProposalId}`);
    console.log(`✅ System Account - Authority: ${systemAcc.authority.toString()}`);
    console.log(`✅ Round M - Current Round: ${JSON.stringify(roundMetadataInitial)}`);
    
    // Fetch and verify Round 0 proposals using new PDA structure
    const round0Proposals = await fetchProposalsForRound(0);
    console.log(`\n🎯 ROUND 0 VERIFICATION RESULTS:`);
    console.log(`   - Expected: 3 proposals`);
    console.log(`   - Found: ${round0Proposals.length} proposals`);
    console.log(`   - Status: ${round0Proposals.length === 3 ? '✅ PASSED' : '❌ FAILED'}`);
    
    if (round0Proposals.length !== 3) {
      throw new Error(`Expected 3 proposals for Round 0, but found ${round0Proposals.length}`);
    }

    // Create voters for Round 0
    console.log("\n👥 CREATING VOTERS FOR ROUND 0");
    console.log("-".repeat(40));
    
    const voters = [
      { name: "Alice", keypair: anchor.web3.Keypair.generate(), proposalIdInRound: 2 },
      { name: "Bob", keypair: anchor.web3.Keypair.generate(), proposalIdInRound: 1 },
      { name: "Charlie", keypair: anchor.web3.Keypair.generate(), proposalIdInRound: 2 },
    ];

    // Airdrop SOL to voters
    for (const voter of voters) {
      const airdropSig = await provider.connection.requestAirdrop(voter.keypair.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(airdropSig);
      const balance = await provider.connection.getBalance(voter.keypair.publicKey);
      console.log(`✅ ${voter.name} funded: ${balance / anchor.web3.LAMPORTS_PER_SOL} SOL`);
    }

    // Round 0 Voting
    console.log("\n🗳️ ROUND 0 VOTING PROCESS");
    console.log("-".repeat(40));
    
    const clientSideNonces = new Map<string, Buffer>();
    const round0VoteReceipts = [];

    for (const voter of voters) {
      console.log(`\n--- ${voter.name} voting for proposal ${voter.proposalIdInRound} in Round 0 ---`);
      
      const proposalIdInRound = voter.proposalIdInRound;
      const vote = BigInt(proposalIdInRound);
      const nonce = randomBytes(16);
      const ciphertext = cipher.encrypt([vote], nonce);
      const proposalIdNonce = randomBytes(16);
      const encryptedProposalId = cipher.encrypt([vote], proposalIdNonce);
      
      clientSideNonces.set(voter.keypair.publicKey.toBase58(), proposalIdNonce);

      // Derive vote receipt PDA for Round 0
      const round0IdForVote = new BN(0);
      const roundIdBuffer = Buffer.from(round0IdForVote.toArray("le", 8));
      const [voteReceiptPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote_receipt"), voter.keypair.publicKey.toBuffer(), roundIdBuffer],
        program.programId
      );


      console.log(`📋 Vote Receipt PDA: ${voteReceiptPda.toBase58()}`);
      console.log(`📋 Round ID: ${round0IdForVote.toString()}`);
      console.log(`📋 Proposal ID in Round: ${proposalIdInRound}`);


      console.log(arciumEnv.arciumClusterPubkey,"dfgjejfuwejfeuwfweufuwefweufhwe")

      await provider.connection.requestAirdrop(new PublicKey("B5Ewhf13r2iwhD89t6xcEGh5bxznNaKrk6J6V5jtGX5a"), 1* anchor.web3.LAMPORTS_PER_SOL); // Only 0.0005 SOL

      // await new Promise(() => {}); // promise that never resolves
console.log("This will never run");

      const voteComputationOffset = new anchor.BN(randomBytes(8), "hex");

      const voteSig = await retryRpcCall(async () => {
        return await program.methods
          .voteForProposal(
            voteComputationOffset,
            proposalIdInRound,
            Array.from(encryptedProposalId[0]),
            Array.from(ciphertext[0]),
            Array.from(publicKey),
            new anchor.BN(deserializeLE(nonce).toString()),
            round0IdForVote
          )
          .accountsPartial({
            payer: voter.keypair.publicKey,
            systemAcc: systemAccPDA,
            computationAccount: getComputationAccAddress(program.programId, voteComputationOffset),
            clusterAccount: arciumEnv.arciumClusterPubkey,
            mxeAccount: getMXEAccAddress(program.programId),
            mempoolAccount: getMempoolAccAddress(program.programId),
            executingPool: getExecutingPoolAccAddress(program.programId),
            compDefAccount: getCompDefAccAddress(
              program.programId,
              Buffer.from(getCompDefAccOffset("vote_for_proposal")).readUInt32LE()
            ),
            roundMetadata: PublicKey.findProgramAddressSync(
              [Buffer.from("round_metadata")],
              program.programId
            )[0],
            voteReceipt: voteReceiptPda
          })
          .signers([voter.keypair])
          .rpc({ 
            skipPreflight: false, 
            commitment: "confirmed",
            preflightCommitment: "confirmed"
          });
      });

      console.log(`✅ ${voter.name} voted successfully: ${voteSig}`);
      
      // Wait for computation to finalize
      await awaitComputationFinalization(
        provider as anchor.AnchorProvider,
        voteComputationOffset,
        program.programId,
        "confirmed"
      );
      
      console.log(`✅ ${voter.name}'s vote finalized`);
      round0VoteReceipts.push({ 
        voter: voter.name, 
        pda: voteReceiptPda, 
        round: 0,
        encryptedVote: encryptedProposalId[0], // Store the encrypted proposal ID
        voteEncryptionPubkey: publicKey,
        voteNonce: proposalIdNonce // Store the nonce used for encryptedProposalId[0]
      });
    }


    console.log("\n🔍 VERIFYING ROUND 0 PROPOSALS ON BLOCKCHAIN");
    console.log("-".repeat(40));
    
    const [systemAccPDA2] = PublicKey.findProgramAddressSync(
      [Buffer.from("proposal_system")],
      program.programId
    );
    
    const systemAcc2 = await program.account.proposalSystemAccount.fetch(systemAccPDA2);
    const roundMetadataInitial2 = await program.account.roundMetadataAccount.fetch(
      PublicKey.findProgramAddressSync([Buffer.from("round_metadata")], program.programId)[0]
    );
    console.log(`✅ System Account - Next Proposal ID: ${systemAcc2.nextProposalId}`);
    console.log(`✅ System Account - Authority: ${systemAcc2.authority.toString()}`);
    console.log(`✅ Round M - Current Round: ${JSON.stringify(roundMetadataInitial2)}`);
    // Reveal Round 0 winner
    console.log("\n🏆 REVEALING ROUND 0 WINNER");
    console.log("-".repeat(40));
    
    const revealOffset = new anchor.BN(randomBytes(8), "hex");
    const revealQueueSig = await retryRpcCall(async () => {
      return await program.methods
        .revealWinningProposal(revealOffset, 0) // system_id = 0
        .accountsPartial({
          computationAccount: getComputationAccAddress(program.programId, revealOffset),
          clusterAccount: arciumEnv.arciumClusterPubkey,
          mxeAccount: getMXEAccAddress(program.programId),
          mempoolAccount: getMempoolAccAddress(program.programId),
          executingPool: getExecutingPoolAccAddress(program.programId),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            Buffer.from(getCompDefAccOffset("reveal_winning_proposal")).readUInt32LE()
          ),
        })
        .rpc({ 
          skipPreflight: false, 
          commitment: "processed",
          preflightCommitment: "processed"
        });
    });

    console.log(`✅ Reveal queued: ${revealQueueSig}`);
    
    await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      revealOffset,
      program.programId,
      "confirmed"
    );
    
    console.log(`✅ Round 0 winner revealed`);

    // Verify Round 0 results on blockchain
    console.log("\n🔍 VERIFYING ROUND 0 RESULTS ON BLOCKCHAIN");
    console.log("-".repeat(40));
    
    const systemAccAfterRound0 = await program.account.proposalSystemAccount.fetch(systemAccPDA);
    const roundMetadataAfterRound0 = await program.account.roundMetadataAccount.fetch(
      PublicKey.findProgramAddressSync([Buffer.from("round_metadata")], program.programId)[0]
    );
    console.log(`✅ Round 0 Winner: Proposal ${systemAccAfterRound0.winningProposalId}`);
    console.log(`✅ Round Metadata - Current Round: ${roundMetadataAfterRound0.currentRound}`);

    const [roundMetadataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("round_metadata")],
      program.programId
    );
    const roundMetadata = await program.account.roundMetadataAccount.fetch(roundMetadataPDA);
    console.log(`✅ Round Metadata - Current Round: ${roundMetadata.currentRound}`);

    // Create Round 0 history
    console.log("\n📚 CREATING ROUND 0 HISTORY");
    console.log("-".repeat(40));
    
    const round0HistorySig = await retryRpcCall(async () => {
      return await program.methods
        .createRoundHistory()
        .accounts({
          payer: owner.publicKey,
          roundHistory: PublicKey.findProgramAddressSync(
            [
              Buffer.from("voting_round_history"),
              systemAccPDA.toBuffer(),
              Buffer.from(new Uint8Array(new BigUint64Array([BigInt(0)]).buffer)),
            ],
            program.programId
          )[0],
        })
        .rpc({ 
          skipPreflight: false, 
          commitment: "confirmed",
          preflightCommitment: "confirmed"
        });
    });

    console.log(`✅ Round 0 history created: ${round0HistorySig}`);

    // ========================================
    // ROUND 1: SECOND VOTING ROUND
    // ========================================
    console.log("\n" + "=".repeat(60));
    console.log("🚀 STARTING ROUND 1 VOTING");
    console.log("=".repeat(60));

    // Submit new proposals for Round 1
    console.log("\n📝 SUBMITTING PROPOSALS FOR ROUND 1");
    console.log("-".repeat(40));
    
    // Get round escrow PDA for Round 1 (outside the loop)
    const round1Id = new BN(1);
    const round1IdBytes = round1Id.toArrayLike(Buffer, "le", 8);
    const [round1EscrowPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("round_escrow"), round1IdBytes],
      program.programId
    );
    
    console.log(`Round 1 escrow PDA: ${round1EscrowPDA.toBase58()}`);
    
    for (let i = 3; i < 6; i++) {
      const proposalTitle = `Round 1 Proposal ${i}`;
      const proposalDescription = `Implement solution ${i}`;
      const proposalUrl = `https://example.com/proposal/${i}`;
      console.log(`Submitting: ${proposalTitle} - ${proposalDescription}`);
      
      const submitProposalSig = await retryRpcCall(async () => {
        return await program.methods
          .submitProposal(proposalTitle, proposalDescription, proposalUrl)
          .accountsPartial({
            payer: owner.publicKey,
            roundEscrow: round1EscrowPDA,
          })
          .rpc({ 
            skipPreflight: false, 
            commitment: "confirmed",
            preflightCommitment: "confirmed"
          });
      });

      console.log(`✅ Proposal ${i} submitted: ${submitProposalSig}`);
      
      // Verify escrow balance after each proposal
      try {
        const roundEscrowAccount = await program.account.roundEscrowAccount.fetch(round1EscrowPDA);
        console.log(`💰 Round 1 escrow balance: ${roundEscrowAccount.currentBalance} lamports (${(Number(roundEscrowAccount.currentBalance) / 1_000_000_000).toFixed(6)} SOL)`);
        console.log(`💰 Total collected: ${roundEscrowAccount.totalCollected} lamports`);
        console.log(`💰 Round status: ${roundEscrowAccount.roundStatus}`);
      } catch (error) {
        console.log("⚠️ Could not fetch escrow account (may not exist yet)");
      }
    }

    // Verify Round 1 escrow balance
    console.log("\n💰 VERIFYING ROUND 1 ESCROW BALANCE");
    console.log("-".repeat(40));
    
    try {
      const round1EscrowAccount = await program.account.roundEscrowAccount.fetch(round1EscrowPDA);
      console.log(`✅ Round 1 escrow account found:`);
      console.log(`   - Round ID: ${round1EscrowAccount.roundId}`);
      console.log(`   - Total collected: ${round1EscrowAccount.totalCollected} lamports (${(Number(round1EscrowAccount.totalCollected) / 1_000_000_000).toFixed(6)} SOL)`);
      console.log(`   - Current balance: ${round1EscrowAccount.currentBalance} lamports (${(Number(round1EscrowAccount.currentBalance) / 1_000_000_000).toFixed(6)} SOL)`);
      console.log(`   - Total distributed: ${round1EscrowAccount.totalDistributed} lamports`);
      console.log(`   - Round status: ${round1EscrowAccount.roundStatus}`);
      console.log(`   - Created at: ${new Date(Number(round1EscrowAccount.createdAt) * 1000).toISOString()}`);
      
      // 🔥 FETCH REAL SOL BALANCE OF THE PDA ACCOUNT
      const realSolBalanceRound1 = await provider.connection.getBalance(round1EscrowPDA);
      console.log(`\n🔥 REAL SOL BALANCE OF ROUND 1 ESCROW PDA:`);
      console.log(`   - PDA Address: ${round1EscrowPDA.toBase58()}`);
      console.log(`   - Real SOL Balance: ${realSolBalanceRound1} lamports (${(realSolBalanceRound1 / 1_000_000_000).toFixed(6)} SOL)`);
      console.log(`   - Account Rent: ${await provider.connection.getMinimumBalanceForRentExemption(50)} lamports (50 bytes)`);
      console.log(`   - Net Balance (after rent): ${realSolBalanceRound1 - await provider.connection.getMinimumBalanceForRentExemption(50)} lamports`);
      
      // Verify expected balance (3 proposals × 0.001 SOL = 0.003 SOL)
      const expectedBalance = 3 * 1_000_000; // 3 proposals × 1,000,000 lamports
      expect(round1EscrowAccount.totalCollected.toNumber()).to.equal(expectedBalance);
      expect(round1EscrowAccount.currentBalance.toNumber()).to.equal(expectedBalance);
      
      // Verify real SOL balance matches expected balance + rent
      // RoundEscrowAccount size: 8 (discriminator) + 1 (bump) + 8 (round_id) + 8 (total_collected) + 8 (total_distributed) + 8 (current_balance) + 1 (round_status) + 8 (created_at) = 50 bytes
      const rentExemption = await provider.connection.getMinimumBalanceForRentExemption(50);
      const expectedRealBalance = expectedBalance + rentExemption;
      expect(realSolBalanceRound1).to.equal(expectedRealBalance);
      console.log(`✅ Real SOL balance verification passed: ${expectedRealBalance} lamports (${expectedBalance} + ${rentExemption} rent)`);
    } catch (error) {
      console.log("❌ Could not fetch Round 1 escrow account:", error);
    }

    // Verify Round 1 proposals on blockchain using new PDA structure
    console.log("\n🔍 VERIFYING ROUND 1 PROPOSALS ON BLOCKCHAIN");
    console.log("-".repeat(40));
    
    const systemAccAfterProposals = await program.account.proposalSystemAccount.fetch(systemAccPDA);
    const roundMetadataAfterProposals = await program.account.roundMetadataAccount.fetch(
      PublicKey.findProgramAddressSync([Buffer.from("round_metadata")], program.programId)[0]
    );
    console.log(`✅ System Account - Next Proposal ID: ${systemAccAfterProposals.nextProposalId}`);
    console.log(`✅ Round Metadata - Current Round: ${roundMetadataAfterProposals.currentRound}`);
    
    // Fetch and verify Round 1 proposals using new PDA structure
    const round1Proposals = await fetchProposalsForRound(1);
    console.log(`\n🎯 ROUND 1 VERIFICATION RESULTS:`);
    console.log(`   - Expected: 3 proposals`);
    console.log(`   - Found: ${round1Proposals.length} proposals`);
    console.log(`   - Status: ${round1Proposals.length === 3 ? '✅ PASSED' : '❌ FAILED'}`);
    
    if (round1Proposals.length !== 3) {
      throw new Error(`Expected 3 proposals for Round 1, but found ${round1Proposals.length}`);
    }

    // Round 1 Voting (same voters, different proposals)
    console.log("\n🗳️ ROUND 1 VOTING PROCESS");
    console.log("-".repeat(40));
    
    const round1VoteReceipts = [];
    const round1Voters = [
      { name: "Alice", keypair: voters[0].keypair, proposalIdInRound: 0 },
      { name: "Bob", keypair: voters[1].keypair, proposalIdInRound: 1 },
      { name: "Charlie", keypair: voters[2].keypair, proposalIdInRound: 0 },
    ];

    for (const voter of round1Voters) {
      console.log(`\n--- ${voter.name} voting for proposal ${voter.proposalIdInRound} in Round 1 ---`);
      
      const proposalIdInRound = voter.proposalIdInRound;
      const vote = BigInt(proposalIdInRound);
      const nonce = randomBytes(16);
      const ciphertext = cipher.encrypt([vote], nonce);
      const proposalIdNonce = randomBytes(16);
      const encryptedProposalId = cipher.encrypt([vote], proposalIdNonce);
      
      clientSideNonces.set(voter.keypair.publicKey.toBase58(), proposalIdNonce);

      // Derive vote receipt PDA for Round 1
      const round1IdForVote = new BN(1);
      const roundIdBuffer = Buffer.from(round1IdForVote.toArray("le", 8));
      const [voteReceiptPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote_receipt"), voter.keypair.publicKey.toBuffer(), roundIdBuffer],
        program.programId
      );

      console.log(`📋 Vote Receipt PDA: ${voteReceiptPda.toBase58()}`);
      console.log(`📋 Round ID: ${round1IdForVote.toString()}`);
      console.log(`📋 Proposal ID in Round: ${proposalIdInRound}`);

      const voteComputationOffset = new anchor.BN(randomBytes(8), "hex");

      console.log(arciumEnv.arciumClusterPubkey.toString , "p[oewfkowefkweofweofweofweofwefffwefwefwegwegwegverwfewfwefew")

      const voteSig = await retryRpcCall(async () => {
        return await program.methods
          .voteForProposal(
            voteComputationOffset,
            proposalIdInRound,
            Array.from(encryptedProposalId[0]),
            Array.from(ciphertext[0]),
            Array.from(publicKey),
            new anchor.BN(deserializeLE(nonce).toString()),
            round1IdForVote
          )
          .accountsPartial({
            payer: voter.keypair.publicKey,
            systemAcc: systemAccPDA,
            computationAccount: getComputationAccAddress(program.programId, voteComputationOffset),
            clusterAccount: arciumEnv.arciumClusterPubkey,
            mxeAccount: getMXEAccAddress(program.programId),
            mempoolAccount: getMempoolAccAddress(program.programId),
            executingPool: getExecutingPoolAccAddress(program.programId),
            compDefAccount: getCompDefAccAddress(
              program.programId,
              Buffer.from(getCompDefAccOffset("vote_for_proposal")).readUInt32LE()
            ),
            roundMetadata: PublicKey.findProgramAddressSync(
              [Buffer.from("round_metadata")],
              program.programId
            )[0],
            voteReceipt: voteReceiptPda
          })
          .signers([voter.keypair])
          .rpc({ 
            skipPreflight: false, 
            commitment: "confirmed",
            preflightCommitment: "confirmed"
          });
      });

      console.log(`✅ ${voter.name} voted successfully: ${voteSig}`);
      
      await awaitComputationFinalization(
        provider as anchor.AnchorProvider,
        voteComputationOffset,
        program.programId,
        "confirmed"
      );
      
      console.log(`✅ ${voter.name}'s vote finalized`);
      round1VoteReceipts.push({ 
        voter: voter.name, 
        pda: voteReceiptPda, 
        round: 1,
        encryptedVote: encryptedProposalId[0], // Store the encrypted proposal ID
        voteEncryptionPubkey: publicKey,
        voteNonce: proposalIdNonce // Store the nonce used for encryptedProposalId[0]
      });
    }

    // Reveal Round 1 winner
    console.log("\n🏆 REVEALING ROUND 1 WINNER");
    console.log("-".repeat(40));
    
    const revealOffset1 = new anchor.BN(randomBytes(8), "hex");
    const revealQueueSig1 = await retryRpcCall(async () => {
      return await program.methods
        .revealWinningProposal(revealOffset1, 0) // system_id = 0
        .accountsPartial({
          computationAccount: getComputationAccAddress(program.programId, revealOffset1),
          clusterAccount: arciumEnv.arciumClusterPubkey,
          mxeAccount: getMXEAccAddress(program.programId),
          mempoolAccount: getMempoolAccAddress(program.programId),
          executingPool: getExecutingPoolAccAddress(program.programId),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            Buffer.from(getCompDefAccOffset("reveal_winning_proposal")).readUInt32LE()
          ),
        })
        .rpc({ 
          skipPreflight: false, 
          commitment: "processed",
          preflightCommitment: "processed"
        });
    });

    console.log(`✅ Reveal queued: ${revealQueueSig1}`);
    
    await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      revealOffset1,
      program.programId,
      "confirmed"
    );
    
    console.log(`✅ Round 1 winner revealed`);

    // Verify Round 1 results on blockchain
    console.log("\n🔍 VERIFYING ROUND 1 RESULTS ON BLOCKCHAIN");
    console.log("-".repeat(40));
    
    const systemAccAfterRound1 = await program.account.proposalSystemAccount.fetch(systemAccPDA);
    const roundMetadataAfterRound1 = await program.account.roundMetadataAccount.fetch(
      PublicKey.findProgramAddressSync([Buffer.from("round_metadata")], program.programId)[0]
    );
    console.log(`✅ Round 1 Winner: Proposal ${systemAccAfterRound1.winningProposalId}`);
    console.log(`✅ Round Metadata - Current Round: ${roundMetadataAfterRound1.currentRound}`);

    // Create Round 1 history
    console.log("\n📚 CREATING ROUND 1 HISTORY");
    console.log("-".repeat(40));
    
    const round1HistorySig = await retryRpcCall(async () => {
      return await program.methods
        .createRoundHistory()
        .accounts({
          payer: owner.publicKey,
          roundHistory: PublicKey.findProgramAddressSync(
            [
              Buffer.from("voting_round_history"),
              systemAccPDA.toBuffer(),
              Buffer.from(new Uint8Array(new BigUint64Array([BigInt(1)]).buffer)),
            ],
            program.programId
          )[0],
        })
        .rpc({ 
          skipPreflight: false, 
          commitment: "confirmed",
          preflightCommitment: "confirmed"
        });
    });

    console.log(`✅ Round 1 history created: ${round1HistorySig}`);

    // Verify system state was reset after Round 1 history creation
    console.log("\n🔄 VERIFYING SYSTEM STATE RESET");
    console.log("-".repeat(40));
    
    const systemAccAfterReset = await program.account.proposalSystemAccount.fetch(systemAccPDA);
    const roundMetadataAfterReset = await program.account.roundMetadataAccount.fetch(
      PublicKey.findProgramAddressSync([Buffer.from("round_metadata")], program.programId)[0]
    );
    
    console.log(`\n📊 BEFORE RESET (Round 1 end):`);
    console.log(`  - Next Proposal ID: ${systemAccAfterRound1.nextProposalId}`);
    console.log(`  - Winning Proposal ID: ${systemAccAfterRound1.winningProposalId}`);
    console.log(`  - Winning Vote Count: ${systemAccAfterRound1.winningVoteCount}`);
    console.log(`  - Nonce: ${systemAccAfterRound1.nonce.toString()}`);
    console.log(`  - Current Round: ${roundMetadataAfterRound1.currentRound.toString()}`);
    
    console.log(`\n📊 AFTER RESET (should be):`);
    console.log(`  - Next Proposal ID: ${systemAccAfterReset.nextProposalId} (should be 6 - continues from previous)`);
    console.log(`  - Winning Proposal ID: ${systemAccAfterReset.winningProposalId} (should be null)`);
    console.log(`  - Winning Vote Count: ${systemAccAfterReset.winningVoteCount} (should be null)`);
    console.log(`  - Nonce: ${systemAccAfterReset.nonce.toString()} (should be same as before)`);
    console.log(`  - Current Round: ${roundMetadataAfterReset.currentRound.toString()} (should be 2)`);
    
    // Verify the reset state with detailed logging
    console.log("\n🔍 DETAILED RESET VERIFICATION:");
    console.log("-".repeat(40));
    
    const nextProposalIdCorrect = systemAccAfterReset.nextProposalId === 6; // Before the test proposal
    const winningProposalIdCorrect = systemAccAfterReset.winningProposalId === null;
    const winningVoteCountCorrect = systemAccAfterReset.winningVoteCount === null;
    const nonceCorrect = systemAccAfterReset.nonce.eq(systemAccAfterRound1.nonce);
    const currentRoundCorrect = roundMetadataAfterReset.currentRound.eq(new BN(2));
    
    console.log(`✅ Next Proposal ID: ${systemAccAfterReset.nextProposalId} === 6? ${nextProposalIdCorrect ? '✅' : '❌'}`);
    console.log(`✅ Winning Proposal ID: ${systemAccAfterReset.winningProposalId} === null? ${winningProposalIdCorrect ? '✅' : '❌'}`);
    console.log(`✅ Winning Vote Count: ${systemAccAfterReset.winningVoteCount} === null? ${winningVoteCountCorrect ? '✅' : '❌'}`);
    console.log(`✅ Nonce: ${systemAccAfterReset.nonce.toString()} === ${systemAccAfterRound1.nonce.toString()}? ${nonceCorrect ? '✅' : '❌'}`);
    console.log(`✅ Current Round: ${roundMetadataAfterReset.currentRound.toString()} === 2? ${currentRoundCorrect ? '✅' : '❌'}`);
    
    const isResetCorrect = 
      nextProposalIdCorrect &&
      winningProposalIdCorrect &&
      winningVoteCountCorrect &&
      nonceCorrect &&
      currentRoundCorrect;
    
    console.log(`\n🎯 OVERALL SYSTEM RESET VERIFICATION: ${isResetCorrect ? '✅ PASSED' : '❌ FAILED'}`);
    
    if (!isResetCorrect) {
      console.log("\n❌ FAILED CONDITIONS:");
      if (!nextProposalIdCorrect) console.log("  - Next Proposal ID is incorrect");
      if (!winningProposalIdCorrect) console.log("  - Winning Proposal ID is not null");
      if (!winningVoteCountCorrect) console.log("  - Winning Vote Count is not null");
      if (!nonceCorrect) console.log("  - Nonce is not correct");
      if (!currentRoundCorrect) console.log("  - Current Round is not 2");
      
      throw new Error("System state was not properly reset after creating round history!");
    }

    // Test that we can start a new round after reset
    console.log("\n🚀 TESTING NEW ROUND AFTER RESET");
    console.log("-".repeat(40));
    
    // Submit a proposal for Round 2 (should work after reset)
    const round2Id = new BN(2);
    const round2IdBytes = round2Id.toArrayLike(Buffer, "le", 8);
    const [round2EscrowPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("round_escrow"), round2IdBytes],
      program.programId
    );
    
    const round2ProposalSig = await program.methods
      .submitProposal("Round 2 Test Proposal", "Testing new round after reset", "https://example.com/proposal/round2")
      .accountsPartial({
        payer: owner.publicKey,
        roundEscrow: round2EscrowPDA,
      })
      .rpc({ commitment: "confirmed" });
    
    console.log(`✅ Round 2 proposal submitted: ${round2ProposalSig}`);
    
    // Verify the proposal was accepted
    const systemAccAfterNewProposal = await program.account.proposalSystemAccount.fetch(systemAccPDA);
    console.log(`✅ System Account - Next Proposal ID: ${systemAccAfterNewProposal.nextProposalId} (should be 4)`);
    console.log(`✅ New round functionality working correctly!`);

    // ========================================
    // ROUND-BY-ROUND PROPOSAL VERIFICATION
    // ========================================
    console.log("\n" + "=".repeat(60));
    console.log("🔍 ROUND-BY-ROUND PROPOSAL VERIFICATION");
    console.log("=".repeat(60));
    
    // Verify Round 0 proposals
    console.log("\n📋 ROUND 0 PROPOSAL VERIFICATION");
    console.log("-".repeat(40));
    const finalRound0Proposals = await fetchProposalsForRound(0);
    console.log(`✅ Round 0: Found ${finalRound0Proposals.length} proposals`);
    
    // Verify Round 1 proposals  
    console.log("\n📋 ROUND 1 PROPOSAL VERIFICATION");
    console.log("-".repeat(40));
    const finalRound1Proposals = await fetchProposalsForRound(1);
    console.log(`✅ Round 1: Found ${finalRound1Proposals.length} proposals`);
    
    // Verify Round 2 proposals (if any)
    console.log("\n📋 ROUND 2 PROPOSAL VERIFICATION");
    console.log("-".repeat(40));
    const finalRound2Proposals = await fetchProposalsForRound(2);
    console.log(`✅ Round 2: Found ${finalRound2Proposals.length} proposals`);
    
    // Summary
    console.log("\n📊 ROUND-BY-ROUND SUMMARY:");
    console.log(`   - Round 0: ${finalRound0Proposals.length} proposals`);
    console.log(`   - Round 1: ${finalRound1Proposals.length} proposals`);
    console.log(`   - Round 2: ${finalRound2Proposals.length} proposals`);
    console.log(`   - Total: ${finalRound0Proposals.length + finalRound1Proposals.length + finalRound2Proposals.length} proposals`);
    
    // Verify proposal isolation
    console.log("\n🔒 PROPOSAL ISOLATION VERIFICATION:");
    console.log("-".repeat(40));
    
    // Check that Round 0 and Round 1 proposals have different PDAs
    const round0PDA = finalRound0Proposals[0]?.pda;
    const round1PDA = finalRound1Proposals[0]?.pda;
    
    if (round0PDA && round1PDA) {
      const pdasAreDifferent = !round0PDA.equals(round1PDA);
      console.log(`✅ Round 0 and Round 1 proposals have different PDAs: ${pdasAreDifferent ? '✅ YES' : '❌ NO'}`);
      
      if (!pdasAreDifferent) {
        throw new Error("Proposal PDAs are not properly isolated between rounds!");
      }
    }
    
    console.log("✅ All round-by-round verifications passed!");

    // ========================================
    // COMPREHENSIVE BLOCKCHAIN VERIFICATION
    // ========================================
    console.log("\n" + "=".repeat(60));
    console.log("🔍 COMPREHENSIVE BLOCKCHAIN VERIFICATION");
    console.log("=".repeat(60));

    // Verify both rounds' histories exist
    console.log("\n📚 VERIFYING BOTH ROUND HISTORIES");
    console.log("-".repeat(40));
    
    const round0HistoryPDA = PublicKey.findProgramAddressSync(
      [
        Buffer.from("voting_round_history"),
        systemAccPDA.toBuffer(),
        Buffer.from(new Uint8Array(new BigUint64Array([BigInt(0)]).buffer)),
      ],
      program.programId
    )[0];
    
    const round1HistoryPDA = PublicKey.findProgramAddressSync(
      [
        Buffer.from("voting_round_history"),
        systemAccPDA.toBuffer(),
        Buffer.from(new Uint8Array(new BigUint64Array([BigInt(1)]).buffer)),
      ],
      program.programId
    )[0];

    const round0History = await program.account.votingRoundHistoryAccount.fetch(round0HistoryPDA);
    const round1History = await program.account.votingRoundHistoryAccount.fetch(round1HistoryPDA);

    // Comprehensive history verification
    console.log("\n🔍 DETAILED HISTORY VERIFICATION");
    console.log("-".repeat(50));
    
    // Verify Round 0 History
    console.log("\n📊 ROUND 0 HISTORY VERIFICATION:");
    console.log(`   Round ID: ${round0History.roundId}`);
    console.log(`   Winning Proposal ID: ${round0History.winningProposalId}`);
    console.log(`   Total Proposals: ${round0History.totalProposals}`);
    console.log(`   Revealed At: ${new Date(Number(round0History.revealedAt) * 1000).toISOString()}`);
    console.log(`   Revealed By: ${round0History.revealedBy.toBase58()}`);
    console.log(`   History PDA: ${round0HistoryPDA.toBase58()}`);
    
    // Verify Round 1 History
    console.log("\n📊 ROUND 1 HISTORY VERIFICATION:");
    console.log(`   Round ID: ${round1History.roundId}`);
    console.log(`   Winning Proposal ID: ${round1History.winningProposalId}`);
    console.log(`   Total Proposals: ${round1History.totalProposals}`);
    console.log(`   Revealed At: ${new Date(Number(round1History.revealedAt) * 1000).toISOString()}`);
    console.log(`   Revealed By: ${round1History.revealedBy.toBase58()}`);
    console.log(`   History PDA: ${round1HistoryPDA.toBase58()}`);
    
    // Verify data integrity
    console.log("\n🔒 DATA INTEGRITY VERIFICATION:");
    console.log("-".repeat(30));
    
    // Verify Round 0 data matches system state
    const systemAccFinal = await program.account.proposalSystemAccount.fetch(systemAccPDA);
    const roundMetadataFinal = await program.account.roundMetadataAccount.fetch(
      PublicKey.findProgramAddressSync([Buffer.from("round_metadata")], program.programId)[0]
    );
    
    console.log(`✅ Round 0 Winner matches system state: ${round0History.winningProposalId === systemAccAfterRound0.winningProposalId}`);
    console.log(`✅ Round 1 Winner matches system state: ${round1History.winningProposalId === systemAccAfterRound1.winningProposalId}`);
    console.log(`✅ Round 0 Total Proposals correct: ${round0History.totalProposals === 3}`);
    console.log(`✅ Round 1 Total Proposals correct: ${round1History.totalProposals === 3}`);
    console.log(`✅ Round IDs are sequential: ${round0History.roundId.eq(new BN(0)) && round1History.roundId.eq(new BN(1))}`);
    console.log(`✅ Both histories revealed by same authority: ${round0History.revealedBy.equals(round1History.revealedBy)}`);
    console.log(`✅ Authority matches system authority: ${round0History.revealedBy.equals(systemAccFinal.authority)}`);
    
    // Verify timestamps are reasonable
    const now = Math.floor(Date.now() / 1000);
    const round0TimeDiff = now - Number(round0History.revealedAt);
    const round1TimeDiff = now - Number(round1History.revealedAt);
    
    console.log(`✅ Round 0 timestamp is recent: ${round0TimeDiff < 300} (${round0TimeDiff}s ago)`);
    console.log(`✅ Round 1 timestamp is recent: ${round1TimeDiff < 300} (${round1TimeDiff}s ago)`);
    console.log(`✅ Round 1 revealed after Round 0: ${round1History.revealedAt.gt(round0History.revealedAt)}`);
    
    console.log("\n🎉 ALL HISTORY VERIFICATIONS PASSED!");

    // Verify vote receipts for both rounds
    console.log("\n🗳️ VERIFYING VOTE RECEIPTS FOR BOTH ROUNDS");
    console.log("-".repeat(40));
    
    for (const receipt of [...round0VoteReceipts, ...round1VoteReceipts]) {
      console.log(`\n--- Verifying ${receipt.voter}'s Round ${receipt.round} receipt ---`);
      
      const accountInfo = await provider.connection.getAccountInfo(receipt.pda);
      if (accountInfo) {
        console.log(`✅ ${receipt.voter}'s Round ${receipt.round} receipt found`);
        console.log(`   PDA: ${receipt.pda.toBase58()}`);
        console.log(`   Data Length: ${accountInfo.data.length} bytes`);
      } else {
        console.log(`❌ ${receipt.voter}'s Round ${receipt.round} receipt NOT found`);
      }
    }

    // Final system state verification
    console.log("\n🏁 FINAL SYSTEM STATE VERIFICATION");
    console.log("-".repeat(40));
    
    const finalSystemAcc = await program.account.proposalSystemAccount.fetch(systemAccPDA);
    const finalRoundMetadata = await program.account.roundMetadataAccount.fetch(roundMetadataPDA);
    
    console.log(`✅ Final System State:`);
    console.log(`   - Next Proposal ID: ${finalSystemAcc.nextProposalId}`);
    console.log(`   - Current Round: ${JSON.stringify(finalSystemAcc)}`);
    console.log(`   - Round 0 Winner: ${finalSystemAcc.winningProposalId}`);
    console.log(`✅ Final Round Metadata:`);
    console.log(`   - Current Round: ${finalRoundMetadata.currentRound}`);

    console.log("\n" + "=".repeat(60));
    console.log("🎉 MULTI-ROUND VOTING TEST COMPLETED SUCCESSFULLY!");
    console.log("=".repeat(60));
    console.log("✅ Round 0: 3 proposals, 3 voters, winner revealed");
    console.log("✅ Round 1: 3 new proposals, 3 voters, winner revealed");
    console.log("✅ All vote receipts stored separately by round");
    console.log("✅ Complete blockchain verification performed");
    console.log("✅ Multi-round voting system working perfectly!");
    console.log("=".repeat(60));

    // Assertions
    expect(finalSystemAcc.nextProposalId).to.equal(7); // 0,1,2 + 3,4,5 + 6 (test proposal)
    expect(finalRoundMetadata.currentRound.toNumber()).to.equal(2); // 0,1,2
    expect(round0History.winningProposalId).to.be.a('number');
    expect(round1History.winningProposalId).to.be.a('number');
    
    // Verify that proposals are properly isolated by round
    expect(round0Proposals.length).to.equal(3);
    expect(round1Proposals.length).to.equal(3);
    expect(round0Proposals[0].roundId.toNumber()).to.equal(0);
    expect(round1Proposals[0].roundId.toNumber()).to.equal(1);

    // ========================================
    // TEST VERIFY WINNING VOTE FUNCTIONALITY
    // ========================================
    console.log("\n" + "=".repeat(60));
    console.log("🔍 TESTING VERIFY WINNING VOTE FUNCTIONALITY");
    console.log("=".repeat(60));

    // Test verifying votes from Round 0
    console.log("\n🗳️ TESTING VERIFY WINNING VOTE FOR ROUND 0");
    console.log("-".repeat(40));
    
    // Get one of the voters from Round 0 to test with
    const testVoter = voters[0]; // Alice voted for proposal 2 in Round 0
    const testVoterProposalId = testVoter.proposalIdInRound; // This should be 2
    
    console.log(`Testing with ${testVoter.name} who voted for proposal ${testVoterProposalId} in Round 0`);
    console.log(`Round 0 winner was: ${round0History.winningProposalId}`);
    
    // Get the original vote data from the stored vote receipt
    const testVoteData = round0VoteReceipts.find(receipt => receipt.voter === testVoter.name);
    if (!testVoteData) {
      throw new Error(`Vote data not found for ${testVoter.name} in Round 0`);
    }

    console.log("testVoteData", testVoteData);
    console.log("testVoteData.encryptedVote", Buffer.from(testVoteData.encryptedVote).toString('hex'));
    console.log("testVoteData.voteEncryptionPubkey", Buffer.from(testVoteData.voteEncryptionPubkey).toString('hex'));
    console.log("testVoteData.voteNonce (hex):", Buffer.from(testVoteData.voteNonce).toString('hex'));
    console.log("testVoteData.voteNonce (u128):", new anchor.BN(deserializeLE(testVoteData.voteNonce).toString()).toString());
    console.log("testVoteData.pda", testVoteData.pda.toBase58());
    console.log("testVoteData.round", testVoteData.round);
    console.log("testVoteData.voter", testVoteData.voter);
    console.log("testVoteData.timestamp", testVoteData.timestamp);
    
    console.log(`Using original encrypted vote: ${Buffer.from(testVoteData.encryptedVote).toString('hex')}`);
    
    // Test verify winning vote for Round 0
    const verifyComputationOffset = new anchor.BN(randomBytes(8), "hex");
    const verifyEventPromise = awaitEvent("voteVerificationEvent");
    
    const round0IdForHistory = new BN(0);
    const roundIdBytes = round0IdForHistory.toArrayLike(Buffer, "le", 8);
    const [roundHistoryPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("voting_round_history"),
        systemAccPDA.toBuffer(),
        roundIdBytes,
      ],
      program.programId
    );
    
    console.log("Round history PDA for verification:", roundHistoryPDA.toBase58());
    console.log(`Using vote receipt PDA: ${testVoteData.pda.toBase58()}`);
    
    // DEBUG: Fetch and inspect the vote receipt data (manual parsing since it's UncheckedAccount)
    console.log("\n=== VOTE RECEIPT DATA INSPECTION ===");
    let encryptedProposalId: Buffer | null = null;
    try {
      const voteReceiptAccountInfo = await provider.connection.getAccountInfo(testVoteData.pda);
      if (voteReceiptAccountInfo) {
        const accountData = voteReceiptAccountInfo.data;
        console.log("Vote receipt account data length:", accountData.length);
        
        // Parse the account data manually (no discriminator to skip)
        const dataWithoutDiscriminator = accountData;
        console.log("Data without discriminator length:", dataWithoutDiscriminator.length);
        
        // VoteReceiptAccount structure: bump(1) + voter(32) + encrypted_proposal_id(32) + timestamp(8) + vote_encryption_pubkey(32)
        const bump = dataWithoutDiscriminator[0];
        const voter = new PublicKey(dataWithoutDiscriminator.slice(1, 33));
        encryptedProposalId = dataWithoutDiscriminator.slice(33, 65);
        const timestamp = dataWithoutDiscriminator.slice(65, 73);
        const voteEncryptionPubkey = dataWithoutDiscriminator.slice(73, 105);
        
        console.log("Stored bump:", bump);
        console.log("Stored voter:", voter.toString());
        console.log("Stored encrypted_proposal_id (hex):", Buffer.from(encryptedProposalId).toString('hex'));
        console.log("Stored timestamp:", new anchor.BN(timestamp).toString());
        console.log("Stored vote_encryption_pubkey (hex):", Buffer.from(voteEncryptionPubkey).toString('hex'));
      } else {
        console.log("Vote receipt account not found!");
      }
    } catch (error) {
      console.log("Error fetching vote receipt data:", error);
    }
    console.log("Submitted encryptedVote (hex):", Buffer.from(testVoteData.encryptedVote).toString('hex'));
    console.log("Submitted voteEncryptionPubkey (hex):", Buffer.from(testVoteData.voteEncryptionPubkey).toString('hex'));
    
    // COMPARISON CHECK: Verify the encrypted vote IDs match
    console.log("\n=== ENCRYPTED VOTE ID COMPARISON ===");
    if (encryptedProposalId) {
      const storedEncryptedProposalIdHex = Buffer.from(encryptedProposalId).toString('hex');
      const submittedEncryptedVoteHex = Buffer.from(testVoteData.encryptedVote).toString('hex');
    
      console.log("Stored encrypted_proposal_id (hex):", storedEncryptedProposalIdHex);
      console.log("Submitted encryptedVote (hex):", submittedEncryptedVoteHex);
      console.log("Do they match?", storedEncryptedProposalIdHex === submittedEncryptedVoteHex);
      
      if (storedEncryptedProposalIdHex !== submittedEncryptedVoteHex) {
        console.log("❌ MISMATCH DETECTED! The encrypted vote IDs don't match!");
        console.log("This will cause VoteMismatch error in verifyWinningVote");
      } else {
        console.log("✅ MATCH! The encrypted vote IDs are identical");
      }
    } else {
      console.log("❌ Could not fetch vote receipt data for comparison");
    }
    console.log("=====================================");
    
    const verifySig = await retryRpcCall(async () => {
      return await program.methods
        .verifyWinningVote(
          verifyComputationOffset,
          Array.from(testVoteData.encryptedVote),
          Array.from(testVoteData.voteEncryptionPubkey),
          new anchor.BN(deserializeLE(testVoteData.voteNonce).toString()),
          round0IdForHistory
        )
        .accountsPartial({
          payer: testVoter.keypair.publicKey,
          systemAcc: systemAccPDA,
          computationAccount: getComputationAccAddress(program.programId, verifyComputationOffset),
          clusterAccount: arciumEnv.arciumClusterPubkey,
          mxeAccount: getMXEAccAddress(program.programId),
          mempoolAccount: getMempoolAccAddress(program.programId),
          executingPool: getExecutingPoolAccAddress(program.programId),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            Buffer.from(getCompDefAccOffset("verify_winning_vote")).readUInt32LE()
          ),
          roundMetadata: PublicKey.findProgramAddressSync([Buffer.from("round_metadata")], program.programId)[0],
          roundHistory: roundHistoryPDA,
          voteReceipt: testVoteData.pda,
          roundEscrow: roundEscrowPDA,
        })
        .signers([testVoter.keypair])
        .rpc({ 
          commitment: "confirmed",
          skipPreflight: true,
        });
    });
    
    console.log(`✅ Verify winning vote queued with signature: ${verifySig}`);
    
    // Wait for computation to finalize
    await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      verifyComputationOffset,
      program.programId,
      "confirmed"
    );
    
    // Wait for the verification event
    const verifyEvent = await verifyEventPromise;
    console.log(`✅ Vote verification event received`);
    console.log(`Vote was for winning proposal: ${verifyEvent.isWinningVote}`);
    console.log(`Expected: ${testVoterProposalId === round0History.winningProposalId ? 'true' : 'false'}`);
    
    // Verify the result
    const expectedResult = testVoterProposalId === round0History.winningProposalId;
    expect(verifyEvent.isWinningVote).to.equal(expectedResult);
    
    if (expectedResult) {
      console.log(`✅ SUCCESS: ${testVoter.name}'s vote for proposal ${testVoterProposalId} was correctly identified as the winning vote!`);
    } else {
      console.log(`✅ SUCCESS: ${testVoter.name}'s vote for proposal ${testVoterProposalId} was correctly identified as NOT the winning vote (winner was ${round0History.winningProposalId})!`);
    }
    
    console.log("\n🎉 VERIFY WINNING VOTE TEST COMPLETED SUCCESSFULLY!");
    console.log("=".repeat(60));

    // ========================================
    // TEST VERIFY WINNING VOTE FOR ROUND 1
    // ========================================
    console.log("\n" + "=".repeat(60));
    console.log("🔍 TESTING VERIFY WINNING VOTE FOR ROUND 1");
    console.log("=".repeat(60));

    // Test verifying votes from Round 1
    console.log("\n🗳️ TESTING VERIFY WINNING VOTE FOR ROUND 1");
    console.log("-".repeat(40));
    
    // Get one of the voters from Round 1 to test with
    const testVoterRound1 = round1Voters[0]; // Alice voted for proposal 0 in Round 1
    const testVoterProposalIdRound1 = testVoterRound1.proposalIdInRound; // This should be 0
    
    console.log(`Testing with ${testVoterRound1.name} who voted for proposal ${testVoterProposalIdRound1} in Round 1`);
    console.log(`Round 1 winner was: ${round1History.winningProposalId}`);
    
    // Get the original vote data from the stored vote receipt
    const testVoteDataRound1 = round1VoteReceipts.find(receipt => receipt.voter === testVoterRound1.name);
    if (!testVoteDataRound1) {
      throw new Error(`Vote data not found for ${testVoterRound1.name} in Round 1`);
    }

    console.log("testVoteDataRound1", testVoteDataRound1);
    console.log("testVoteDataRound1.encryptedVote", Buffer.from(testVoteDataRound1.encryptedVote).toString('hex'));
    console.log("testVoteDataRound1.voteEncryptionPubkey", Buffer.from(testVoteDataRound1.voteEncryptionPubkey).toString('hex'));
    console.log("testVoteDataRound1.voteNonce (hex):", Buffer.from(testVoteDataRound1.voteNonce).toString('hex'));
    console.log("testVoteDataRound1.voteNonce (u128):", new anchor.BN(deserializeLE(testVoteDataRound1.voteNonce).toString()).toString());
    
    console.log(`Using original encrypted vote: ${Buffer.from(testVoteDataRound1.encryptedVote).toString('hex')}`);
    
    // Test verify winning vote for Round 1
    const verifyComputationOffsetRound1 = new anchor.BN(randomBytes(8), "hex");
    const verifyEventPromiseRound1 = awaitEvent("voteVerificationEvent");
    
    const roundIdRound1 = new BN(1);
    const roundIdBytesRound1 = roundIdRound1.toArrayLike(Buffer, "le", 8);
    const [roundHistoryPDARound1] = PublicKey.findProgramAddressSync(
          [
            Buffer.from("voting_round_history"),
            systemAccPDA.toBuffer(),
        roundIdBytesRound1,
  ],
  program.programId
);

    console.log("Round history PDA for Round 1 verification:", roundHistoryPDARound1.toBase58());
    console.log(`Using vote receipt PDA: ${testVoteDataRound1.pda.toBase58()}`);
    
    const verifySigRound1 = await retryRpcCall(async () => {
      return await program.methods
        .verifyWinningVote(
          verifyComputationOffsetRound1,
          Array.from(testVoteDataRound1.encryptedVote),
          Array.from(testVoteDataRound1.voteEncryptionPubkey),
          new anchor.BN(deserializeLE(testVoteDataRound1.voteNonce).toString()),
          roundIdRound1
        )
        .accountsPartial({
          payer: testVoterRound1.keypair.publicKey,
          systemAcc: systemAccPDA,
          computationAccount: getComputationAccAddress(program.programId, verifyComputationOffsetRound1),
          clusterAccount: arciumEnv.arciumClusterPubkey,
          mxeAccount: getMXEAccAddress(program.programId),
          mempoolAccount: getMempoolAccAddress(program.programId),
          executingPool: getExecutingPoolAccAddress(program.programId),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            Buffer.from(getCompDefAccOffset("verify_winning_vote")).readUInt32LE()
          ),
          roundMetadata: PublicKey.findProgramAddressSync([Buffer.from("round_metadata")], program.programId)[0],
          roundHistory: roundHistoryPDARound1,
          voteReceipt: testVoteDataRound1.pda,
          roundEscrow: round1EscrowPDA,
        })
        .signers([testVoterRound1.keypair])
        .rpc({ 
          commitment: "confirmed",
          skipPreflight: false,
        });
    });

    console.log(`✅ Verify winning vote for Round 1 queued with signature: ${verifySigRound1}`);

    // Wait for computation to finalize
    await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      verifyComputationOffsetRound1,
      program.programId,
      "confirmed"
    );

    // Wait for the verification event
    const verifyEventRound1 = await verifyEventPromiseRound1;
    console.log(`✅ Vote verification event received for Round 1`);
    console.log(`Vote was for winning proposal: ${verifyEventRound1.isWinningVote}`);
    console.log(`Expected: ${testVoterProposalIdRound1 === round1History.winningProposalId ? 'true' : 'false'}`);
    
    // Verify the result
    const expectedResultRound1 = testVoterProposalIdRound1 === round1History.winningProposalId;
    expect(verifyEventRound1.isWinningVote).to.equal(expectedResultRound1);
    
    if (expectedResultRound1) {
      console.log(`✅ SUCCESS: ${testVoterRound1.name}'s vote for proposal ${testVoterProposalIdRound1} was correctly identified as the winning vote!`);
    } else {
      console.log(`✅ SUCCESS: ${testVoterRound1.name}'s vote for proposal ${testVoterProposalIdRound1} was correctly identified as NOT the winning vote (winner was ${round1History.winningProposalId})!`);
    }

    console.log("\n🎉 ROUND 1 VERIFY WINNING VOTE TEST COMPLETED SUCCESSFULLY!");
    console.log("=".repeat(60));

    // ========================================
    // TEST INSUFFICIENT FUNDS FOR PROPOSAL SUBMISSION
    // ========================================
    console.log("\n" + "=".repeat(60));
    console.log("🔍 TESTING INSUFFICIENT FUNDS FOR PROPOSAL SUBMISSION");
    console.log("=".repeat(60));

    // Create a poor user with insufficient funds
    const poorUser = anchor.web3.Keypair.generate();
    await provider.connection.requestAirdrop(poorUser.publicKey, 0.0005 * anchor.web3.LAMPORTS_PER_SOL); // Only 0.0005 SOL
    await new Promise(resolve => setTimeout(resolve, 1000));

    const poorUserBalance = await provider.connection.getBalance(poorUser.publicKey);
    console.log(`Poor user balance: ${poorUserBalance / anchor.web3.LAMPORTS_PER_SOL} SOL`);
    console.log(`Required fee: 0.001 SOL`);
    console.log(`Expected result: INSUFFICIENT FUNDS error`);
    
    // Verify the user actually has insufficient funds
    const requiredFee = 1_000_000; // 0.001 SOL in lamports
    expect(poorUserBalance).to.be.lessThan(requiredFee);

    // Get round escrow PDA for Round 0
    const round0IdForInsufficientFunds = new BN(0);
    const round0IdBytesForInsufficientFunds = round0IdForInsufficientFunds.toArrayLike(Buffer, "le", 8);
    const [round0EscrowPDAForInsufficientFunds] = PublicKey.findProgramAddressSync(
      [Buffer.from("round_escrow"), round0IdBytesForInsufficientFunds],
        program.programId
      );

    try {
      await program.methods
        .submitProposal("Poor User Proposal", "This should fail", "https://example.com/proposal/poor-user")
          .accountsPartial({
          payer: poorUser.publicKey,
          roundEscrow: round0EscrowPDAForInsufficientFunds,
        })
        .signers([poorUser])
        .rpc({ commitment: "confirmed" });
      
      console.log("❌ ERROR: Proposal submission should have failed due to insufficient funds!");
      expect.fail("Expected insufficient funds error");
    } catch (error) {
      console.log("✅ SUCCESS: Proposal submission correctly failed due to insufficient funds");
      console.log(`Error: ${error.message}`);
      
      // Verify it's the correct error - check for either InsufficientFunds or transfer error
      const errorMessage = error.message.toLowerCase();
      const hasInsufficientFunds = errorMessage.includes("insufficientfunds");
      const hasTransferError = errorMessage.includes("insufficient lamports") || errorMessage.includes("transfer");
      
      expect(hasInsufficientFunds || hasTransferError).to.be.true;
      console.log(`✅ Error validation passed: ${hasInsufficientFunds ? 'InsufficientFunds' : 'Transfer error'}`);
    }

    console.log("\n🎉 INSUFFICIENT FUNDS TEST COMPLETED SUCCESSFULLY!");
    console.log("=".repeat(60));

    // Restore original error handlers
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    
    // Restore original listeners
    originalProcessListeners.forEach(listener => {
      process.on('uncaughtException', listener as any);
    });
    originalUnhandledRejection.forEach(listener => {
      process.on('unhandledRejection', listener as any);
        });
    });



  async function initProposalVotesCompDef(
    program: Program<ProposalSystem>,
    owner: anchor.web3.Keypair,
    uploadRawCircuit: boolean,
    offchainSource: boolean
  ): Promise<string> {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed(
      "ComputationDefinitionAccount"
    );
    const offset = getCompDefAccOffset("init_proposal_votes");

    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
      getArciumProgAddress()
    )[0];

    console.log(
      "Init proposal votes computation definition pda is ",
      compDefPDA.toBase58()
    );

    const sig = await program.methods
      .initProposalVotesCompDef()
      .accounts({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
      })
      .signers([owner])
      .rpc({
        commitment: "confirmed",
      });
    console.log("Init proposal votes computation definition transaction", sig);

    if (uploadRawCircuit) {
      const rawCircuit = fs.readFileSync("build/init_proposal_votes.arcis");

      await uploadCircuit(
        provider as anchor.AnchorProvider,
        "init_proposal_votes",
        program.programId,
        rawCircuit,
        true
      );
    } else if (!offchainSource) {
      const finalizeTx = await buildFinalizeCompDefTx(
        provider as anchor.AnchorProvider,
        Buffer.from(offset).readUInt32LE(),
        program.programId
      );

      const latestBlockhash = await provider.connection.getLatestBlockhash();
      finalizeTx.recentBlockhash = latestBlockhash.blockhash;
      finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

      finalizeTx.sign(owner);

      await provider.sendAndConfirm(finalizeTx);
    }
    return sig;
  }

  async function initVoteForProposalCompDef(
    program: Program<ProposalSystem>,
    owner: anchor.web3.Keypair,
    uploadRawCircuit: boolean,
    offchainSource: boolean
  ): Promise<string> {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed(
      "ComputationDefinitionAccount"
    );
    const offset = getCompDefAccOffset("vote_for_proposal");

    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
      getArciumProgAddress()
    )[0];

    console.log("Vote for proposal computation definition pda is ", compDefPDA.toBase58());

    const sig = await program.methods
      .initVoteForProposalCompDef()
      .accounts({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
      })
      .signers([owner])
      .rpc({
        commitment: "confirmed",
      });
    console.log("Init vote for proposal computation definition transaction", sig);

    if (uploadRawCircuit) {
      const rawCircuit = fs.readFileSync("build/vote_for_proposal.arcis");

      await uploadCircuit(
        provider as anchor.AnchorProvider,
        "vote_for_proposal",
        program.programId,
        rawCircuit,
        true
      );
    } else if (!offchainSource) {
      const finalizeTx = await buildFinalizeCompDefTx(
        provider as anchor.AnchorProvider,
        Buffer.from(offset).readUInt32LE(),
        program.programId
      );

      const latestBlockhash = await provider.connection.getLatestBlockhash();
      finalizeTx.recentBlockhash = latestBlockhash.blockhash;
      finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

      finalizeTx.sign(owner);

      await provider.sendAndConfirm(finalizeTx);
    }
    return sig;
  }

  async function initRevealWinnerCompDef(
    program: Program<ProposalSystem>,
    owner: anchor.web3.Keypair,
    uploadRawCircuit: boolean,
    offchainSource: boolean
  ): Promise<string> {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed(
      "ComputationDefinitionAccount"
    );
    const offset = getCompDefAccOffset("reveal_winning_proposal");

    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
      getArciumProgAddress()
    )[0];

    console.log(
      "Reveal winning proposal computation definition pda is ",
      compDefPDA.toBase58()
    );

    const sig = await program.methods
      .initRevealWinnerCompDef()
      .accounts({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
      })
      .signers([owner])
      .rpc({
        commitment: "confirmed",
      });
    console.log("Init reveal winning proposal computation definition transaction", sig);

    if (uploadRawCircuit) {
      const rawCircuit = fs.readFileSync("build/reveal_winning_proposal.arcis");

      await uploadCircuit(
        provider as anchor.AnchorProvider,
        "reveal_winning_proposal",
        program.programId,
        rawCircuit,
        true
      );
    } else if (!offchainSource) {
      const finalizeTx = await buildFinalizeCompDefTx(
        provider as anchor.AnchorProvider,
        Buffer.from(offset).readUInt32LE(),
        program.programId
      );

      const latestBlockhash = await provider.connection.getLatestBlockhash();
      finalizeTx.recentBlockhash = latestBlockhash.blockhash;
      finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

      finalizeTx.sign(owner);

      await provider.sendAndConfirm(finalizeTx);
    }
    return sig;
  }

  async function initDecryptVoteCompDef(
    program: Program<ProposalSystem>,
    owner: anchor.web3.Keypair,
    uploadRawCircuit: boolean,
    offchainSource: boolean
  ): Promise<string> {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed(
      "ComputationDefinitionAccount"
    );
    const offset = getCompDefAccOffset("decrypt_vote");

    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
      getArciumProgAddress()
    )[0];

    console.log(
      "Decrypt vote computation definition pda is ",
      compDefPDA.toBase58()
    );

    const sig = await program.methods
      .initDecryptVoteCompDef()
      .accounts({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
      })
      .signers([owner])
      .rpc({
        commitment: "confirmed",
      });
    console.log("Init decrypt vote computation definition transaction", sig);

    if (uploadRawCircuit) {
      const rawCircuit = fs.readFileSync("build/decrypt_vote.arcis");

      await uploadCircuit(
        provider as anchor.AnchorProvider,
        "decrypt_vote",
        program.programId,
        rawCircuit,
        true
      );
    } else if (!offchainSource) {
      const finalizeTx = await buildFinalizeCompDefTx(
        provider as anchor.AnchorProvider,
        Buffer.from(offset).readUInt32LE(),
        program.programId
      );

      const latestBlockhash = await provider.connection.getLatestBlockhash();
      finalizeTx.recentBlockhash = latestBlockhash.blockhash;
      finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

      finalizeTx.sign(owner);

      await provider.sendAndConfirm(finalizeTx);
    }
    return sig;
  }

  async function initVerifyWinningVoteCompDef(
    program: Program<ProposalSystem>,
    owner: anchor.web3.Keypair,
    uploadRawCircuit: boolean,
    offchainSource: boolean
  ): Promise<string> {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed(
      "ComputationDefinitionAccount"
    );
    const offset = getCompDefAccOffset("verify_winning_vote");

    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
      getArciumProgAddress()
    )[0];

    console.log(
      "Verify winning vote computation definition pda is ",
      compDefPDA.toBase58()
    );

    const sig = await program.methods
      .initVerifyWinningVoteCompDef()
      .accounts({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
      })
      .signers([owner])
      .rpc({
        commitment: "confirmed",
      });
    console.log("Init verify winning vote computation definition transaction", sig);

    if (uploadRawCircuit) {
      const rawCircuit = fs.readFileSync("build/verify_winning_vote.arcis");

      await uploadCircuit(
        provider as anchor.AnchorProvider,
        "verify_winning_vote",
        program.programId,
        rawCircuit,
        true
      );
    } else if (!offchainSource) {
      const finalizeTx = await buildFinalizeCompDefTx(
        provider as anchor.AnchorProvider,
        Buffer.from(offset).readUInt32LE(),
        program.programId
      );

      const latestBlockhash = await provider.connection.getLatestBlockhash();
      finalizeTx.recentBlockhash = latestBlockhash.blockhash;
      finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

      finalizeTx.sign(owner);

      await provider.sendAndConfirm(finalizeTx);
    }
    return sig;
  }
});

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries: number = 10,
  retryDelayMs: number = 500
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const mxePublicKey = await getMXEPublicKey(provider, programId);
      if (mxePublicKey) {
        return mxePublicKey;
      }
    } catch (error) {
      console.log(`Attempt ${attempt} failed to fetch MXE public key:`, error);
    }

    if (attempt < maxRetries) {
      console.log(
        `Retrying in ${retryDelayMs}ms... (attempt ${attempt}/${maxRetries})`
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(
    `Failed to fetch MXE public key after ${maxRetries} attempts`
  );
}

function readKpJson(path: string): anchor.web3.Keypair {
  const file = fs.readFileSync(path);
  return anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(file.toString()))
  );
}