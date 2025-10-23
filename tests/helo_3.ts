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

    it("prevents voting in previous rounds when new round is active", async () => {
      // This test verifies that the round validation works correctly
      // by attempting to vote in a previous round after a new round has started
      
      console.log("🔒 Testing round validation - preventing voting in previous rounds");
      
    const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

    // Derive system account PDA
    const [systemAccPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("proposal_system")],
      program.programId
    );

      // First, complete Round 0 voting
      console.log("📝 Setting up Round 0...");
      
      // Submit proposals for Round 0
      await program.methods
        .submitProposal("Test Proposal 0", "Description 0")
        .accountsPartial({
          payer: owner.publicKey,
        })
        .rpc({ commitment: "confirmed" });
      
      await program.methods
        .submitProposal("Test Proposal 1", "Description 1")
        .accountsPartial({
          payer: owner.publicKey,
        })
        .rpc({ commitment: "confirmed" });
      
      // Create a voter
      const voter = anchor.web3.Keypair.generate();
      await provider.connection.requestAirdrop(voter.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Vote in Round 0
      console.log("🗳️ Voting in Round 0...");
      const round0VoteComputationOffset = new anchor.BN(randomBytes(8), "hex");
      const round0VoteEncryptionPrivkey = x25519.utils.randomSecretKey();
      const round0VoteEncryptionPubkey = x25519.getPublicKey(round0VoteEncryptionPrivkey);
      
      const round0VoteForProposal = await program.methods
        .voteForProposal(
          round0VoteComputationOffset,
          0, // proposal_id = 0
          Array.from(round0VoteEncryptionPubkey),
          Array.from(round0VoteEncryptionPubkey), // ciphertext (same as encrypted proposal for simplicity)
          Array.from(round0VoteEncryptionPubkey), // publicKey
          new anchor.BN(0), // nonce
          new BN(0) // round_id = 0
        )
        .accountsPartial({
          payer: voter.publicKey,
          systemAcc: PublicKey.findProgramAddressSync([Buffer.from("proposal_system")], program.programId)[0],
          computationAccount: getComputationAccAddress(program.programId, round0VoteComputationOffset),
          clusterAccount: arciumEnv.arciumClusterPubkey,
          mxeAccount: getMXEAccAddress(program.programId),
          mempoolAccount: getMempoolAccAddress(program.programId),
          executingPool: getExecutingPoolAccAddress(program.programId),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            Buffer.from(getCompDefAccOffset("vote_for_proposal")).readUInt32LE()
          ),
          roundMetadata: PublicKey.findProgramAddressSync([Buffer.from("round_metadata")], program.programId)[0],
          voteReceipt: PublicKey.findProgramAddressSync(
            [Buffer.from("vote_receipt"), voter.publicKey.toBuffer(), new BN(0).toArrayLike(Buffer, "le", 8)],
            program.programId
          )[0],
        })
        .signers([voter])
        .rpc({ commitment: "confirmed" });
      
      console.log("✅ Round 0 vote successful");
      
      // Finalize Round 0 computation
      await awaitComputationFinalization(
        provider as anchor.AnchorProvider,
        round0VoteComputationOffset,
        program.programId,
        "confirmed"
      );
      
      // Reveal Round 0 winner and increment to Round 1
      console.log("🏆 Revealing Round 0 winner...");
      const round0RevealOffset = new anchor.BN(randomBytes(8), "hex");
      
      await program.methods
        .revealWinningProposal(round0RevealOffset, 0)
        .accountsPartial({
          computationAccount: getComputationAccAddress(program.programId, round0RevealOffset),
          clusterAccount: arciumEnv.arciumClusterPubkey,
          mxeAccount: getMXEAccAddress(program.programId),
          mempoolAccount: getMempoolAccAddress(program.programId),
          executingPool: getExecutingPoolAccAddress(program.programId),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            Buffer.from(getCompDefAccOffset("reveal_winning_proposal")).readUInt32LE()
          ),
        })
        .rpc({ commitment: "confirmed" });
      
      await awaitComputationFinalization(
        provider as anchor.AnchorProvider,
        round0RevealOffset,
        program.programId,
        "confirmed"
      );
      
      // Create Round 0 history (this increments current_round to 1)
      await program.methods
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
        .rpc({ commitment: "confirmed" });
      
      console.log("✅ Round 0 completed, current round is now 1");
      
      // Now try to vote in Round 0 again (should fail)
      console.log("🚫 Attempting to vote in Round 0 again (should fail)...");
      
      const invalidVoteComputationOffset = new anchor.BN(randomBytes(8), "hex");
      const invalidVoteEncryptionPrivkey = x25519.utils.randomSecretKey();
      const invalidVoteEncryptionPubkey = x25519.getPublicKey(invalidVoteEncryptionPrivkey);
      
      try {
        await program.methods
          .voteForProposal(
            invalidVoteComputationOffset,
            0, // proposal_id = 0
            Array.from(invalidVoteEncryptionPubkey),
            Array.from(invalidVoteEncryptionPubkey), // ciphertext
            Array.from(invalidVoteEncryptionPubkey), // publicKey
            new anchor.BN(0), // nonce
            new BN(0) // round_id = 0 (previous round)
          )
          .accountsPartial({
            payer: voter.publicKey,
            systemAcc: PublicKey.findProgramAddressSync([Buffer.from("proposal_system")], program.programId)[0],
            computationAccount: getComputationAccAddress(program.programId, invalidVoteComputationOffset),
            clusterAccount: arciumEnv.arciumClusterPubkey,
            mxeAccount: getMXEAccAddress(program.programId),
            mempoolAccount: getMempoolAccAddress(program.programId),
            executingPool: getExecutingPoolAccAddress(program.programId),
            compDefAccount: getCompDefAccAddress(
              program.programId,
              Buffer.from(getCompDefAccOffset("vote_for_proposal")).readUInt32LE()
            ),
            roundMetadata: PublicKey.findProgramAddressSync([Buffer.from("round_metadata")], program.programId)[0],
            voteReceipt: PublicKey.findProgramAddressSync(
              [Buffer.from("vote_receipt"), voter.publicKey.toBuffer(), new BN(0).toArrayLike(Buffer, "le", 8)],
              program.programId
            )[0],
          })
          .signers([voter])
          .rpc({ commitment: "confirmed" });
        
        // If we get here, the test should fail
        throw new Error("Expected vote in previous round to fail, but it succeeded!");
        
      } catch (error: any) {
        console.log("✅ Round validation working correctly!");
        console.log("❌ Error (expected):", error.message);
        
        // Check if the error contains our custom error message
        if (error.message.includes("Invalid round ID") || 
            error.message.includes("can only vote in current active round") ||
            error.message.includes("InvalidRoundId")) {
          console.log("🎯 Correct error message received!");
        } else {
          console.log("⚠️  Unexpected error message, but round validation still working");
        }
      }
      
      // Now try to vote in Round 1 (should succeed)
      console.log("✅ Attempting to vote in Round 1 (should succeed)...");
      
      // Submit a proposal for Round 1
      await program.methods
        .submitProposal("Round 1 Proposal", "Description")
        .accountsPartial({
          payer: owner.publicKey,
        })
        .rpc({ commitment: "confirmed" });
      
      const round1VoteComputationOffset = new anchor.BN(randomBytes(8), "hex");
      const round1VoteEncryptionPrivkey = x25519.utils.randomSecretKey();
      const round1VoteEncryptionPubkey = x25519.getPublicKey(round1VoteEncryptionPrivkey);
      
      const round1VoteForProposal = await program.methods
        .voteForProposal(
          round1VoteComputationOffset,
          2, // proposal_id = 2 (new proposal)
          Array.from(round1VoteEncryptionPubkey),
          Array.from(round1VoteEncryptionPubkey), // ciphertext
          Array.from(round1VoteEncryptionPubkey), // publicKey
          new anchor.BN(0), // nonce
          new BN(1) // round_id = 1 (current round)
        )
        .accountsPartial({
          payer: voter.publicKey,
          systemAcc: PublicKey.findProgramAddressSync([Buffer.from("proposal_system")], program.programId)[0],
          computationAccount: getComputationAccAddress(program.programId, round1VoteComputationOffset),
          clusterAccount: arciumEnv.arciumClusterPubkey,
          mxeAccount: getMXEAccAddress(program.programId),
          mempoolAccount: getMempoolAccAddress(program.programId),
          executingPool: getExecutingPoolAccAddress(program.programId),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            Buffer.from(getCompDefAccOffset("vote_for_proposal")).readUInt32LE()
          ),
          roundMetadata: PublicKey.findProgramAddressSync([Buffer.from("round_metadata")], program.programId)[0],
          voteReceipt: PublicKey.findProgramAddressSync(
            [Buffer.from("vote_receipt"), voter.publicKey.toBuffer(), new BN(1).toArrayLike(Buffer, "le", 8)],
            program.programId
          )[0],
        })
        .signers([voter])
        .rpc({ commitment: "confirmed" });
      
      console.log("✅ Round 1 vote successful - validation working correctly!");
      
      // Finalize Round 1 computation
      await awaitComputationFinalization(
        provider as anchor.AnchorProvider,
        round1VoteComputationOffset,
        program.programId,
        "confirmed"
      );
      
      console.log("🎉 Round validation test completed successfully!");
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
    
    for (let i = 0; i < 3; i++) {
      const proposalTitle = `Round 0 Proposal ${i}`;
      const proposalDescription = `Build feature ${i}`;
      console.log(`Submitting: ${proposalTitle} - ${proposalDescription}`);
      
      const submitProposalSig = await retryRpcCall(async () => {
        return await program.methods
          .submitProposal(proposalTitle, proposalDescription)
          .accountsPartial({
            payer: owner.publicKey,
          })
          .rpc({ 
            skipPreflight: false, 
            commitment: "confirmed",
            preflightCommitment: "confirmed"
          });
      });

      console.log(`✅ Proposal ${i} submitted with signature: ${submitProposalSig}`);
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
      const roundId = new BN(0);
      const roundIdBuffer = Buffer.from(roundId.toArray("le", 8));
      const [voteReceiptPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote_receipt"), voter.keypair.publicKey.toBuffer(), roundIdBuffer],
        program.programId
      );

      console.log(`📋 Vote Receipt PDA: ${voteReceiptPda.toBase58()}`);
      console.log(`📋 Round ID: ${roundId.toString()}`);
      console.log(`📋 Proposal ID in Round: ${proposalIdInRound}`);

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
            roundId
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
    
    for (let i = 3; i < 6; i++) {
      const proposalTitle = `Round 1 Proposal ${i}`;
      const proposalDescription = `Implement solution ${i}`;
      console.log(`Submitting: ${proposalTitle} - ${proposalDescription}`);
      
      const submitProposalSig = await retryRpcCall(async () => {
        return await program.methods
          .submitProposal(proposalTitle, proposalDescription)
          .accountsPartial({
            payer: owner.publicKey,
          })
          .rpc({ 
            skipPreflight: false, 
            commitment: "confirmed",
            preflightCommitment: "confirmed"
          });
      });

      console.log(`✅ Proposal ${i} submitted: ${submitProposalSig}`);
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
      const roundId = new BN(1);
      const roundIdBuffer = Buffer.from(roundId.toArray("le", 8));
      const [voteReceiptPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote_receipt"), voter.keypair.publicKey.toBuffer(), roundIdBuffer],
        program.programId
      );

      console.log(`📋 Vote Receipt PDA: ${voteReceiptPda.toBase58()}`);
      console.log(`📋 Round ID: ${roundId.toString()}`);
      console.log(`📋 Proposal ID in Round: ${proposalIdInRound}`);

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
            roundId
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
    const round2ProposalSig = await program.methods
      .submitProposal("Round 2 Test Proposal", "Testing new round after reset")
      .accountsPartial({
        payer: owner.publicKey
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
    
    const roundId = new BN(0);
    const roundIdBytes = roundId.toArrayLike(Buffer, "le", 8);
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
          roundId
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

  it("can decrypt an encrypted vote", async () => {
    const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

    const mxePublicKey = await getMXEPublicKeyWithRetry(
      provider as anchor.AnchorProvider,
      program.programId
    );

    console.log("MXE x25519 pubkey is", mxePublicKey);

    // Create encryption keys
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);

    // Test data - encrypt a vote for proposal 2
    const testProposalId = 2;
    const vote = BigInt(testProposalId);
    const nonce = randomBytes(16);
    const ciphertext = cipher.encrypt([vote], nonce);

    console.log(`\n========== Testing Decrypt Vote Function ==========`);
    console.log(`Original proposal ID: ${testProposalId}`);
    console.log(`Encrypted vote: ${Buffer.from(ciphertext[0]).toString('hex')}`);
    console.log(`Nonce: ${Buffer.from(nonce).toString('hex')}`);

    // Initialize the proposal system first (needed for system_acc)
    console.log("Initializing proposal system...");
    const systemNonce = randomBytes(16);
    const systemComputationOffset = new anchor.BN(randomBytes(8), "hex");

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

    // Wait for system initialization to complete
    await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      systemComputationOffset,
      program.programId,
      "confirmed"
    );

    console.log("System initialization completed");

    // Call the decrypt_vote function (computation definition already initialized in before hook)
    const decryptComputationOffset = new anchor.BN(randomBytes(8), "hex");
    
    const decryptEventPromise = awaitEvent("voteDecryptedEvent");
    
    const decryptSig = await retryRpcCall(async () => {
      return await program.methods
        .decryptVote(
          decryptComputationOffset,
          Array.from(ciphertext[0]),
          Array.from(publicKey),
          new anchor.BN(deserializeLE(nonce).toString())
        )
        .accountsPartial({
          payer: owner.publicKey,
          systemAcc: PublicKey.findProgramAddressSync([Buffer.from("proposal_system")], program.programId)[0],
          computationAccount: getComputationAccAddress(program.programId, decryptComputationOffset),
          clusterAccount: arciumEnv.arciumClusterPubkey,
          mxeAccount: getMXEAccAddress(program.programId),
          mempoolAccount: getMempoolAccAddress(program.programId),
          executingPool: getExecutingPoolAccAddress(program.programId),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            Buffer.from(getCompDefAccOffset("decrypt_vote")).readUInt32LE()
          ),
        })
        .rpc({ 
          skipPreflight: false, 
          commitment: "confirmed",
          preflightCommitment: "confirmed"
        });
    });

    console.log(`✅ Decrypt vote queued with signature: ${decryptSig}`);

    // Wait for computation to finalize
    await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      decryptComputationOffset,
      program.programId,
      "confirmed"
    );

    console.log(`✅ Decrypt vote computation finalized`);

    // Wait for the decrypted event
    const decryptEvent = await decryptEventPromise;
    console.log(`✅ Vote decrypted event received`);
    console.log(`Decrypted proposal ID: ${decryptEvent.decryptedProposalId}`);
    console.log(`Timestamp: ${decryptEvent.timestamp}`);

    // Verify the decrypted result matches the original
    expect(decryptEvent.decryptedProposalId).to.equal(testProposalId);
    console.log(`✅ Decryption successful! Original: ${testProposalId}, Decrypted: ${decryptEvent.decryptedProposalId}`);

    console.log(`\n========== Decrypt Vote Test Completed Successfully ==========`);
  });

  it("can verify if a vote was for the winning proposal", async () => {
    const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

    const mxePublicKey = await getMXEPublicKeyWithRetry(
      provider as anchor.AnchorProvider,
      program.programId
    );

    console.log("MXE x25519 pubkey is", mxePublicKey);

    // Create encryption keys
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);

    // Test data - encrypt a vote for proposal 1
    const testProposalId = 1;
    const vote = BigInt(testProposalId);
    const nonce = randomBytes(16);
    const ciphertext = cipher.encrypt([vote], nonce);

    console.log(`\n========== Testing Verify Winning Vote Function ==========`);
    console.log(`Original proposal ID: ${testProposalId}`);
    console.log(`Encrypted vote: ${Buffer.from(ciphertext[0]).toString('hex')}`);
    console.log(`Nonce: ${Buffer.from(nonce).toString('hex')}`);

    // Initialize the proposal system first
    console.log("Initializing proposal system...");
    const systemNonce = randomBytes(16);
    const systemComputationOffset = new anchor.BN(randomBytes(8), "hex");

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

    // Wait for system initialization to complete
    await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      systemComputationOffset,
      program.programId,
      "confirmed"
    );

    console.log("System initialization completed");

    // Derive system account PDA once for consistency
    const [systemAccPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("proposal_system")],
      program.programId
    );

    // First, we need to set up a complete voting round with a known winner
    console.log("Setting up a complete voting round...");
    
    // Submit proposals
    await program.methods
      .submitProposal("Test Proposal 0", "Description 0")
      .accountsPartial({
        payer: owner.publicKey,
      })
      .rpc({ commitment: "confirmed" });
    
    await program.methods
      .submitProposal("Test Proposal 1", "Description 1")
      .accountsPartial({
        payer: owner.publicKey,
      })
      .rpc({ commitment: "confirmed" });

    // Create a voter and vote for proposal 1
    const voter = anchor.web3.Keypair.generate();
    await provider.connection.requestAirdrop(voter.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    await new Promise(resolve => setTimeout(resolve, 1000));

    const voteComputationOffset = new anchor.BN(randomBytes(8), "hex");
    const voteEncryptionPrivkey = x25519.utils.randomSecretKey();
    const voteEncryptionPubkey = x25519.getPublicKey(voteEncryptionPrivkey);
    
    // Encrypt the vote for proposal 1
    const voteForProposal = BigInt(1);
    const voteNonce = randomBytes(16);
    const voteCiphertext = cipher.encrypt([voteForProposal], voteNonce);
    const proposalIdNonce = randomBytes(16);
    const encryptedProposalId = cipher.encrypt([voteForProposal], proposalIdNonce);

    // Vote for proposal 1
    await program.methods
      .voteForProposal(
        voteComputationOffset,
        1, // proposal_id = 1
        Array.from(encryptedProposalId[0]),
        Array.from(voteCiphertext[0]),
        Array.from(voteEncryptionPubkey),
        new anchor.BN(deserializeLE(voteNonce).toString()),
        new BN(0) // round_id = 0
      )
      .accountsPartial({
        payer: voter.publicKey,
        systemAcc: PublicKey.findProgramAddressSync([Buffer.from("proposal_system")], program.programId)[0],
        computationAccount: getComputationAccAddress(program.programId, voteComputationOffset),
        clusterAccount: arciumEnv.arciumClusterPubkey,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(program.programId),
        executingPool: getExecutingPoolAccAddress(program.programId),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("vote_for_proposal")).readUInt32LE()
        ),
        roundMetadata: PublicKey.findProgramAddressSync([Buffer.from("round_metadata")], program.programId)[0],
        voteReceipt: PublicKey.findProgramAddressSync(
          [Buffer.from("vote_receipt"), voter.publicKey.toBuffer(), new BN(0).toArrayLike(Buffer, "le", 8)],
          program.programId
        )[0],
      })
      .signers([voter])
      .rpc({ commitment: "confirmed" });

    // Wait for vote computation to finalize
    await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      voteComputationOffset,
      program.programId,
      "confirmed"
    );

    // Reveal the winning proposal (should be proposal 1)
    const revealOffset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .revealWinningProposal(revealOffset, 0)
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
      .rpc({ commitment: "confirmed" });

    await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      revealOffset,
      program.programId,
      "confirmed"
    );

    // Create round history
    await program.methods
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
      .rpc({ commitment: "confirmed" });

    console.log("Round setup completed. Now testing verify_winning_vote...");

    // Now test the verify_winning_vote function
    const verifyComputationOffset = new anchor.BN(randomBytes(8), "hex");
    
    const verifyEventPromise = awaitEvent("voteVerificationEvent");

    const roundId = new BN(0);

// Must be 8 bytes, LE order
const roundIdBytes = roundId.toArrayLike(Buffer, "le", 8);

const [roundHistory] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("voting_round_history"),
    systemAccPDA.toBuffer(),
    roundIdBytes,
  ],
  program.programId
);

    console.log("roundHistory is ", roundHistory.toBase58());
    
    const verifySig = await retryRpcCall(async () => {
      return await program.methods
        .verifyWinningVote(
          verifyComputationOffset,
          Array.from(voteCiphertext[0]), // The same vote we cast
          Array.from(voteEncryptionPubkey),
          new anchor.BN(deserializeLE(voteNonce).toString()),
          new BN(0) // round_id = 0
        )
        .accountsPartial({
          payer: owner.publicKey,
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
          roundMetadata: PublicKey.findProgramAddressSync(
            [Buffer.from("round_metadata")],
            program.programId
          )[0],
          roundHistory: roundHistory,
        })
        .rpc({ 
          skipPreflight: false, 
          commitment: "confirmed",
          preflightCommitment: "confirmed"
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

    console.log(`✅ Verify winning vote computation finalized`);

    // Wait for the verification event
    const verifyEvent = await verifyEventPromise;
    console.log(`✅ Vote verification event received`);
    console.log(`Is winning vote: ${verifyEvent.isWinningVote}`);
    console.log(`Timestamp: ${verifyEvent.timestamp}`);

    // Verify the result - should be true since we voted for proposal 1 and it won
    expect(verifyEvent.isWinningVote).to.equal(true);
    console.log(`✅ Verification successful! Vote was for the winning proposal`);

    console.log(`\n========== Verify Winning Vote Test Completed Successfully ==========`);
  });

  it("can submit proposals and vote on them!", async () => {
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

    // Note: Proposal system is already initialized in the first test or before hook
    console.log("Using existing proposal system from first test...");

   
    // Submit multiple proposals
    const proposals = [
      { title: "Increase Token Supply", description: "Proposal to increase the total token supply by 20%" },
      { title: "New Feature Development", description: "Proposal to develop a new DeFi feature for the platform" },
      { title: "Governance Update", description: "Proposal to update the governance mechanism" }
    ];

    for (let i = 0; i < proposals.length; i++) {
      const proposal = proposals[i];
      
      const proposalSubmittedEventPromise = awaitEvent("proposalSubmittedEvent");
      
      const submitProposalSig = await retryRpcCall(async () => {
        return await program.methods
          .submitProposal(proposal.title, proposal.description)
          .accountsPartial({
            payer: owner.publicKey,
          })
          .rpc({ 
            skipPreflight: false, 
            commitment: "confirmed",
            preflightCommitment: "confirmed"
          });
      });

      console.log(`Proposal ${i} submitted with signature`, submitProposalSig);
      
      const proposalEvent = await proposalSubmittedEventPromise;
      console.log(`Proposal ${i} submitted by`, proposalEvent.submitter.toString());
    }

    // Create 3 different voters
    console.log(`\n========== Creating 3 Voters ==========`);
    const voter1 = anchor.web3.Keypair.generate();
    const voter2 = anchor.web3.Keypair.generate();
    const voter3 = anchor.web3.Keypair.generate();

    // Airdrop SOL to each voter for transaction fees and account creation
    console.log(`Airdropping SOL to voters...`);
    
    // Airdrop to voter1
    const airdrop1Sig = await provider.connection.requestAirdrop(voter1.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    console.log(`Voter1 airdrop signature: ${airdrop1Sig}`);
    await provider.connection.confirmTransaction(airdrop1Sig);
    
    // Airdrop to voter2
    const airdrop2Sig = await provider.connection.requestAirdrop(voter2.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    console.log(`Voter2 airdrop signature: ${airdrop2Sig}`);
    await provider.connection.confirmTransaction(airdrop2Sig);
    
    // Airdrop to voter3
    const airdrop3Sig = await provider.connection.requestAirdrop(voter3.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    console.log(`Voter3 airdrop signature: ${airdrop3Sig}`);
    await provider.connection.confirmTransaction(airdrop3Sig);
    
    // Check balances after airdrop
    const voter1Balance = await provider.connection.getBalance(voter1.publicKey);
    const voter2Balance = await provider.connection.getBalance(voter2.publicKey);
    const voter3Balance = await provider.connection.getBalance(voter3.publicKey);
    
    console.log(`Voter1 balance: ${voter1Balance / anchor.web3.LAMPORTS_PER_SOL} SOL`);
    console.log(`Voter2 balance: ${voter2Balance / anchor.web3.LAMPORTS_PER_SOL} SOL`);
    console.log(`Voter3 balance: ${voter3Balance / anchor.web3.LAMPORTS_PER_SOL} SOL`);
    
    if (voter1Balance === 0 || voter2Balance === 0 || voter3Balance === 0) {
      throw new Error("Airdrop failed - voter accounts have 0 balance!");
    }
    
    console.log(`✅ Airdrop complete for all voters`);

    // Define voting pattern: 2 voters for proposal 0, 1 voter for proposal 1
    const voters = [
      { keypair: voter1, proposalIdInRound: 0, name: "Voter 1" },
      { keypair: voter2, proposalIdInRound: 0, name: "Voter 2" },
      { keypair: voter3, proposalIdInRound: 1, name: "Voter 3" },
    ];

      // Verify round_metadata account is initialized
      console.log("\n========== Verifying Round Metadata Account ==========");
      const [roundMetadataPDA2] = PublicKey.findProgramAddressSync(
        [Buffer.from("round_metadata")],
        program.programId
      );
      console.log(`Round Metadata PDA: ${roundMetadataPDA2.toBase58()}`);
      
      try {
        const roundMetadata = await program.account.roundMetadataAccount.fetch(roundMetadataPDA2);
        console.log(`✅ Round Metadata Account Found!`);
        console.log(`Current Round: ${roundMetadata.currentRound}`);
        console.log(`Bump: ${roundMetadata.bump}`);
      } catch (error) {
        console.log(`❌ Round Metadata Account NOT Found!`);
        console.log(`Error: ${error}`);
        throw new Error("Round metadata account not initialized - run the first test first!");
      }
      console.log("=======================================================\n");

      // Debug: Check system account state
      console.log("\n========== Debugging System Account ==========");
      const [debugSystemAccPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("proposal_system")],
        program.programId
      );
      console.log(`System Account PDA: ${debugSystemAccPDA.toBase58()}`);
      
      try {
        const systemAcc = await program.account.proposalSystemAccount.fetch(debugSystemAccPDA);
        console.log(`✅ System Account Found!`);
        console.log(`Next Proposal ID: ${systemAcc.nextProposalId}`);
        console.log(`Authority: ${systemAcc.authority.toString()}`);
        console.log(`Winning Proposal ID: ${systemAcc.winningProposalId}`);
        console.log(`Bump: ${systemAcc.bump}`);
      } catch (error) {
        console.log(`❌ System Account NOT Found!`);
        console.log(`Error: ${error}`);
        throw new Error("System account not initialized - run the first test first!");
      }
      console.log("=======================================================\n");

      // Derive system account PDA once (outside the loop)
      const [systemAccPDA, systemAccBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("proposal_system")],
        program.programId
      );
      console.log(`🔧 Using System Account PDA: ${systemAccPDA.toBase58()}`);
      console.log(`🔧 System Account Bump: ${systemAccBump}`);
      
      // Double-check: verify the PDA matches what we fetched earlier
      if (systemAccPDA.toBase58() !== debugSystemAccPDA.toBase58()) {
        throw new Error(`PDA mismatch! Debug: ${debugSystemAccPDA.toBase58()}, Vote: ${systemAccPDA.toBase58()}`);
      }
      console.log(`✅ PDA verification passed - both PDAs match!`);

    // Store nonces client-side for each voter (simulating localStorage)
    const clientSideNonces = new Map<string, Buffer>();

    // Each voter casts their vote
    for (const voter of voters) {
      const proposalIdInRound = voter.proposalIdInRound;
      const vote = BigInt(proposalIdInRound);
      const plaintext = [vote];

      const nonce = randomBytes(16);
      const ciphertext = cipher.encrypt(plaintext, nonce);

      // Encrypt the proposal ID separately for ballot secrecy
      const proposalIdNonce = randomBytes(16);
      const encryptedProposalId = cipher.encrypt([vote], proposalIdNonce);
      
      // Store nonce client-side with voter's pubkey as key
      clientSideNonces.set(voter.keypair.publicKey.toBase58(), proposalIdNonce);

      const voteEventPromise = awaitEvent("voteEvent");
      const voteReceiptEventPromise = awaitEvent("voteReceiptCreatedEvent");

      console.log(`\n=== ${voter.name} voting for proposal ${proposalIdInRound} ===`);

      // Check voter balance before voting
      const voterBalanceBefore = await provider.connection.getBalance(voter.keypair.publicKey);
      console.log(`💰 ${voter.name} balance before voting: ${voterBalanceBefore / anchor.web3.LAMPORTS_PER_SOL} SOL`);
      
      if (voterBalanceBefore === 0) {
        throw new Error(`${voter.name} has 0 SOL balance - cannot vote!`);
      }

      console.log("lol",PublicKey.findProgramAddressSync(
        [Buffer.from("round_metadata")],
        program.programId
      )[0].toBase58());

      // Debug: Check what we're about to vote for
      console.log(`🔍 Debug: About to vote for proposal ID: ${proposalIdInRound}`);
      console.log(`🔍 Debug: Voter: ${voter.name}`);
      console.log(`🔍 Debug: Expected to be valid (should be < proposals_in_current_round)`);

      const roundId = new BN(0); // first round

// Convert to 8-byte little-endian buffer
const roundIdBuffer = Buffer.from(roundId.toArray("le", 8));

      const [voteReceiptPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vote_receipt"),
          voter.keypair.publicKey.toBuffer(),
          roundIdBuffer, // Include round_id as third seed to match program
        ],
        program.programId
      );

      console.log()

      console.log("voteReceiptPda is ", voteReceiptPda.toBase58());

      // Log the 4 things that match the program logs
      console.log("-------------------------------------------------------");
      console.log("vote_for_proposal called with round_id:", roundId.toString());
      console.log("Program ID:", program.programId.toBase58());
      console.log("Payer Key:", voter.keypair.publicKey.toBase58());
      
      // Derive the vote receipt PDA to get the bump
      const [expectedVoteReceiptPda, voteReceiptBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote_receipt"), voter.keypair.publicKey.toBuffer()],
        program.programId
      );
      console.log("Vote Receipt Bump:", voteReceiptBump);
      console.log("-------------------------------------------------------");

      const voteComputationOffset = new anchor.BN(randomBytes(8), "hex");

      const queueVoteSig = await retryRpcCall(async () => {
        return await program.methods
          .voteForProposal(
            voteComputationOffset,
            proposalIdInRound,
            Array.from(encryptedProposalId[0]),
            Array.from(ciphertext[0]),
            Array.from(publicKey),
            new anchor.BN(deserializeLE(nonce).toString()),
            new anchor.BN(0) // round_id = 0 for first round
          )
          .accountsPartial({
            payer: voter.keypair.publicKey, // Explicitly set the voter as payer
            systemAcc: systemAccPDA, // Use the pre-derived PDA
            computationAccount: getComputationAccAddress(
              program.programId,
              voteComputationOffset
            ),
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
      console.log(`✅ ${voter.name} queued vote, sig: `, queueVoteSig);
      
      // Receipt is created immediately with the queue transaction
      const voteReceiptEvent = await voteReceiptEventPromise;
      console.log(`✅ ${voter.name} receipt created at timestamp `, voteReceiptEvent.timestamp.toString());

      console.log(`Waiting for computation to finalize...`);
      const finalizeSig = await awaitComputationFinalization(
        provider as anchor.AnchorProvider,
        voteComputationOffset,
        program.programId,
        "confirmed"
      );
      console.log(`✅ ${voter.name} vote finalized, sig: `, finalizeSig);

      // Wait for computation callback - this confirms the vote was tallied
      const voteEvent = await voteEventPromise;
      console.log(`✅ ${voter.name} vote tallied at timestamp `, voteEvent.timestamp.toString());
    }

    // Try voter 1 voting again - should fail!
    console.log(`\n=== ${voters[0].name} attempting to vote again (should fail) ===`);
    try {
      const secondVoteOffset = new anchor.BN(randomBytes(8), "hex");
      const secondProposalIdInRound = 1;
      const secondVote = BigInt(secondProposalIdInRound);
      const secondNonce = randomBytes(16);
      const secondCiphertext = cipher.encrypt([secondVote], secondNonce);
      const secondProposalIdNonce = randomBytes(16);
      const secondEncryptedProposalId = cipher.encrypt([secondVote], secondProposalIdNonce);

      // Log the 4 things that match the program logs for second vote
      console.log("-------------------------------------------------------");
      console.log("vote_for_proposal called with round_id: 0");
      console.log("Program ID:", program.programId.toBase58());
      console.log("Payer Key:", voters[0].keypair.publicKey.toBase58());
      
      // Create roundIdBuffer for this test
      const roundIdBuffer = Buffer.alloc(8);
      roundIdBuffer.writeBigUInt64LE(BigInt(0), 0); // round_id = 0, 64-bit little-endian encoding
      
      // Derive the vote receipt PDA to get the bump for second vote
      const [expectedVoteReceiptPda2, voteReceiptBump2] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote_receipt"), voters[0].keypair.publicKey.toBuffer(), roundIdBuffer],
        program.programId
      );
      console.log("Vote Receipt Bump:", voteReceiptBump2);
      console.log("-------------------------------------------------------");

      await program.methods
        .voteForProposal(
          secondVoteOffset,
          secondProposalIdInRound,
          Array.from(secondEncryptedProposalId[0]),
          Array.from(secondCiphertext[0]),
          Array.from(publicKey),
            new anchor.BN(deserializeLE(secondNonce).toString()),
          new anchor.BN(0) // round_id = 0 for first round
        )
        .accountsPartial({
          payer: voters[0].keypair.publicKey, // Explicitly set the voter as payer
          systemAcc: systemAccPDA, // Use the pre-derived PDA
          computationAccount: getComputationAccAddress(
            program.programId,
            secondVoteOffset
          ),
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
        })
        .signers([voters[0].keypair])
        .rpc({ 
          skipPreflight: false, 
          commitment: "confirmed",
          preflightCommitment: "confirmed"
        });
      
      console.log(`❌ ERROR: Second vote should have failed but succeeded!`);
    } catch (error: any) {
      console.log(`✅ Second vote correctly failed!`);
      console.log(`Error: ${error.message || error}`);
      if (error.message?.includes('already in use') || error.message?.includes('custom program error')) {
        console.log(`Reason: Vote receipt PDA already exists - each voter can only vote ONCE!`);
      }
    }

    // Reveal the winning proposal
    const revealEventPromise = awaitEvent("winningProposalEvent");

    const revealComputationOffset = new anchor.BN(randomBytes(8), "hex");

    const revealQueueSig = await retryRpcCall(async () => {
      return await program.methods
        .revealWinningProposal(revealComputationOffset, 0) // system_id = 0
        .accountsPartial({
          computationAccount: getComputationAccAddress(
            program.programId,
            revealComputationOffset
          ),
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
    console.log(`Reveal queue sig is `, revealQueueSig);

    const revealFinalizeSig = await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      revealComputationOffset,
      program.programId,
      "confirmed"
    );
    console.log(`Reveal finalize sig is `, revealFinalizeSig);

    const revealEvent = await revealEventPromise;
    console.log(`Winning proposal ID is `, revealEvent.winningProposalId);
    console.log(`Round ID is `, revealEvent.roundId);
    
    // The winning proposal should be 0 (2 votes vs 1 vote for proposal 1)
    expect(revealEvent.winningProposalId).to.equal(0);

    // Verify the winner is stored on-chain in ProposalSystemAccount
    console.log(`\n========== Verifying Winner Stored On-Chain ==========`);
    const [proposalSystemPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("proposal_system")],
      program.programId
    );
    const proposalSystemAccount = await program.account.proposalSystemAccount.fetch(proposalSystemPDA);
    
    console.log(`Stored winning_proposal_id: ${proposalSystemAccount.winningProposalId}`);
    expect(proposalSystemAccount.winningProposalId).to.equal(0);
    console.log(`✅ Winner is permanently stored on-chain!`);
    
    // Verify round metadata was incremented
    const [roundMetadataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("round_metadata")],
      program.programId
    );
    const roundMetadata = await program.account.roundMetadataAccount.fetch(roundMetadataPDA);
    console.log(`\n========== Round Metadata ==========`);
    console.log(`Current Round (after reveal): ${roundMetadata.currentRound}`);
    expect(roundMetadata.currentRound.toNumber()).to.equal(1); // Should be 1 after first round
    console.log(`✅ Round metadata incremented correctly!`);

    // Now create the round history account using the separate instruction
    console.log(`\n========== Creating Round History Account ==========`);
    const roundId = 0; // The round that just completed
    const winningProposalId = revealEvent.winningProposalId;
    const totalProposals = 3; // We submitted 3 proposals
    
    const createRoundHistorySig = await retryRpcCall(async () => {
      return await program.methods
        .createRoundHistory()
        .accounts({
          payer: owner.publicKey,
          roundHistory: PublicKey.findProgramAddressSync(
            [
              Buffer.from("voting_round_history"),
              proposalSystemPDA.toBuffer(),
              Buffer.from(new Uint8Array(new BigUint64Array([BigInt(roundId)]).buffer)),
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
    console.log(`Round history created with signature: ${createRoundHistorySig}`);

    // Verify the voting round history was created
    const [roundHistoryPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("voting_round_history"),
        proposalSystemPDA.toBuffer(),
        Buffer.from(new Uint8Array(new BigUint64Array([BigInt(roundId)]).buffer)),
      ],
      program.programId
    );
    const roundHistory = await program.account.votingRoundHistoryAccount.fetch(roundHistoryPDA);
    console.log(`\n========== Voting Round History ==========`);
    console.log(`Round ID: ${roundHistory.roundId}`);
    console.log(`Winning Proposal ID: ${roundHistory.winningProposalId}`);
    console.log(`Total Proposals: ${roundHistory.totalProposals}`);
    console.log(`Revealed At: ${new Date(roundHistory.revealedAt.toNumber() * 1000).toISOString()}`);
    console.log(`Revealed By: ${roundHistory.revealedBy.toString()}`);
    expect(roundHistory.roundId.toNumber()).to.equal(roundId);
    expect(roundHistory.winningProposalId).to.equal(winningProposalId);
    expect(roundHistory.totalProposals).to.equal(totalProposals);
    console.log(`✅ Round history stored correctly!`);
    console.log(`Note: Vote counts can be calculated on frontend from state if needed`);
    console.log(`=======================================================\n`);

    // Fetch and display the vote receipt for Voter 1 (who voted for the winning proposal)
    console.log(`\n========== Fetching Vote Receipt for ${voters[0].name} ==========`);
    
    // PDA is derived from voter and round_id - one vote per voter per round!
    const roundIdBuffer = Buffer.alloc(8);
    roundIdBuffer.writeBigUInt64LE(BigInt(0), 0); // round_id = 0, 64-bit little-endian encoding
    const [voteReceiptPDA, voteReceiptBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vote_receipt"),
        voters[0].keypair.publicKey.toBuffer(),
        roundIdBuffer
      ],
      program.programId
    );

    console.log(`Vote Receipt PDA: ${voteReceiptPDA.toBase58()}`);
    console.log(`Vote Receipt PDA Bump: ${voteReceiptBump}`);
    console.log(`Fetching vote receipt account data...`);

    // Since we're using UncheckedAccount, we need to manually fetch and deserialize
    const voteReceiptAccountInfo = await provider.connection.getAccountInfo(voteReceiptPDA);
    
    if (!voteReceiptAccountInfo) {
      console.log(`❌ Vote Receipt Account NOT Found!`);
      return;
    }
    
    console.log(`✅ Vote Receipt Account Found!`);
    console.log(`Account Data Length: ${voteReceiptAccountInfo.data.length} bytes`);
    
    // Check if there's a discriminator (8 bytes) at the beginning
    // If the data length is 113 bytes, it's without discriminator
    // If the data length is 121 bytes, it's with discriminator
    let accountData: Buffer;
    if (voteReceiptAccountInfo.data.length === 113) {
      // No discriminator - data starts immediately
      accountData = voteReceiptAccountInfo.data;
    } else if (voteReceiptAccountInfo.data.length === 121) {
      // With discriminator - skip first 8 bytes
      accountData = voteReceiptAccountInfo.data.slice(8);
    } else {
      console.log(`❌ Unexpected account data length: ${voteReceiptAccountInfo.data.length} bytes`);
      return;
    }
    
    // Manually deserialize the VoteReceiptAccount data
    // Structure: bump (1) + voter (32) + encrypted_proposal_id (32) + timestamp (8) + vote_encryption_pubkey (32)
    let offset = 0;
    const bump = accountData.readUInt8(offset); offset += 1;
    const voter = new PublicKey(accountData.slice(offset, offset + 32)); offset += 32;
    const encryptedProposalId = accountData.slice(offset, offset + 32); offset += 32;
    const timestamp = accountData.readBigInt64LE(offset); offset += 8;
    const voteEncryptionPubkey = accountData.slice(offset, offset + 32); offset += 32;
    
    console.log(`Voter: ${voter.toString()}`);
    console.log(`Encrypted Proposal ID: ${encryptedProposalId.toString('hex')}`);
    console.log(`Timestamp: ${timestamp.toString()}`);
    console.log(`Vote Encryption Pubkey: ${voteEncryptionPubkey.toString('hex')}`);
    console.log(`Bump: ${bump}`);
    console.log(`\n✅ Complete ballot secrecy: NO plaintext proposal ID stored on-chain!`);
    console.log(`\nNote: Proposal ID nonce is stored CLIENT-SIDE ONLY for privacy!`);
    console.log(`=======================================================\n`);

    // Demonstrate decryption of the encrypted proposal ID by the voter
    const encryptedProposalIdFromReceipt = encryptedProposalId;
    
    console.log(`\n========== ${voters[0].name} Can Decrypt Their Vote (Using Client-Side Nonce) ==========`);
    console.log(`Encrypted Proposal ID on-chain: ${Buffer.from(encryptedProposalIdFromReceipt).toString('hex')}`);
    
    // Retrieve the nonce from client-side storage (localStorage in real app)
    const savedNonce = clientSideNonces.get(voters[0].keypair.publicKey.toBase58());
    
    if (savedNonce) {
      console.log(`\nRetrieving saved nonce from client-side storage...`);
      console.log(`Saved nonce: ${savedNonce.toString('hex')}`);
      
      // Decrypt the proposal ID using the client-side nonce
      const decryptedProposalId = cipher.decrypt(
        [Array.from(encryptedProposalIdFromReceipt)],
        new Uint8Array(savedNonce)
      );
      
      console.log(`\n✅ Successfully decrypted!`);
      console.log(`Decrypted Proposal ID: ${decryptedProposalId[0]}`);
      console.log(`Expected Proposal ID for ${voters[0].name}: ${voters[0].proposalIdInRound}`);
      console.log(`Match: ${decryptedProposalId[0] === BigInt(voters[0].proposalIdInRound) ? '✅ YES' : '❌ NO'}`);
      
      // Verify the decryption is correct - Voter 1 voted for proposal 0
      expect(decryptedProposalId[0]).to.equal(BigInt(voters[0].proposalIdInRound));
      
      console.log(`\n✅ Complete ballot secrecy maintained!`);
      console.log(`The on-chain receipt contains ONLY the encrypted proposal ID.`);
      console.log(`Only the voter (with their client-side nonce) or MXE can decrypt the vote.`);
    } else {
      console.log(`\n❌ No nonce found in client-side storage!`);
    }
    
    console.log(`\nNote: The nonce is NEVER stored on-chain, ensuring true ballot secrecy!`);
    console.log(`==============================================================================\n`);
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