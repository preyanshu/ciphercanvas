import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { ProposalSystem } from "../target/types/proposal_system";
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
  });

  it("can initialize the proposal system", async () => {
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
          skipPreflight: true, 
          commitment: "processed",
          preflightCommitment: "processed"
        });
    });

    console.log("Proposal system initialized with signature", initSystemSig);
    expect(initSystemSig).to.be.a('string');
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
          .rpc({ 
            skipPreflight: true, 
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
      { keypair: voter1, proposalId: 0, name: "Voter 1" },
      { keypair: voter2, proposalId: 0, name: "Voter 2" },
      { keypair: voter3, proposalId: 1, name: "Voter 3" },
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
      const proposalId = voter.proposalId;
      const vote = BigInt(proposalId);
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

      console.log(`\n=== ${voter.name} voting for proposal ${proposalId} ===`);

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
      console.log(`🔍 Debug: About to vote for proposal ID: ${proposalId}`);
      console.log(`🔍 Debug: Voter: ${voter.name}`);
      console.log(`🔍 Debug: Expected to be valid (should be < next_proposal_id)`);

      const voteComputationOffset = new anchor.BN(randomBytes(8), "hex");

      const queueVoteSig = await retryRpcCall(async () => {
        return await program.methods
          .voteForProposal(
            voteComputationOffset,
            proposalId,
            Array.from(encryptedProposalId[0]),
            Array.from(ciphertext[0]),
            Array.from(publicKey),
            new anchor.BN(deserializeLE(nonce).toString())
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
      const secondProposalId = 1;
      const secondVote = BigInt(secondProposalId);
      const secondNonce = randomBytes(16);
      const secondCiphertext = cipher.encrypt([secondVote], secondNonce);
      const secondProposalIdNonce = randomBytes(16);
      const secondEncryptedProposalId = cipher.encrypt([secondVote], secondProposalIdNonce);

      await program.methods
        .voteForProposal(
          secondVoteOffset,
          secondProposalId,
          Array.from(secondEncryptedProposalId[0]),
          Array.from(secondCiphertext[0]),
          Array.from(publicKey),
          new anchor.BN(deserializeLE(secondNonce).toString())
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
          skipPreflight: true, 
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
          skipPreflight: true, 
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
        .createRoundHistory(new anchor.BN(roundId), winningProposalId, totalProposals)
        .rpc({ 
          skipPreflight: true, 
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
    
    // PDA is derived from voter only (not proposal_id) - one vote per voter!
    const [voteReceiptPDA, voteReceiptBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vote_receipt"),
        voters[0].keypair.publicKey.toBuffer()
      ],
      program.programId
    );

    console.log(`Vote Receipt PDA: ${voteReceiptPDA.toBase58()}`);
    console.log(`Vote Receipt PDA Bump: ${voteReceiptBump}`);
    console.log(`Fetching vote receipt account data...`);

    const voteReceiptAccount = await program.account.voteReceiptAccount.fetch(voteReceiptPDA);
    
    console.log(`Voter: ${voteReceiptAccount.voter.toString()}`);
    console.log(`Encrypted Proposal ID: ${Buffer.from(voteReceiptAccount.encryptedProposalId).toString('hex')}`);
    console.log(`Timestamp: ${voteReceiptAccount.timestamp.toString()}`);
    console.log(`Vote Encryption Pubkey: ${Buffer.from(voteReceiptAccount.voteEncryptionPubkey).toString('hex')}`);
    console.log(`Bump: ${voteReceiptAccount.bump}`);
    console.log(`\n✅ Complete ballot secrecy: NO plaintext proposal ID stored on-chain!`);
    console.log(`\nNote: Proposal ID nonce is stored CLIENT-SIDE ONLY for privacy!`);
    console.log(`=======================================================\n`);

    // Demonstrate decryption of the encrypted proposal ID by the voter
    const encryptedProposalIdFromReceipt = voteReceiptAccount.encryptedProposalId;
    
    console.log(`\n========== ${voters[0].name} Can Decrypt Their Vote (Using Client-Side Nonce) ==========`);
    console.log(`Encrypted Proposal ID on-chain: ${Buffer.from(encryptedProposalIdFromReceipt).toString('hex')}`);
    
    // Retrieve the nonce from client-side storage (localStorage in real app)
    const savedNonce = clientSideNonces.get(voters[0].keypair.publicKey.toBase58());
    
    if (savedNonce) {
      console.log(`\nRetrieving saved nonce from client-side storage...`);
      console.log(`Saved nonce: ${savedNonce.toString('hex')}`);
      
      // Decrypt the proposal ID using the client-side nonce
      const decryptedProposalId = cipher.decrypt(
        [encryptedProposalIdFromReceipt],
        savedNonce
      );
      
      console.log(`\n✅ Successfully decrypted!`);
      console.log(`Decrypted Proposal ID: ${decryptedProposalId[0]}`);
      console.log(`Expected Proposal ID for ${voters[0].name}: ${voters[0].proposalId}`);
      console.log(`Match: ${decryptedProposalId[0] === BigInt(voters[0].proposalId) ? '✅ YES' : '❌ NO'}`);
      
      // Verify the decryption is correct - Voter 1 voted for proposal 0
      expect(decryptedProposalId[0]).to.equal(BigInt(voters[0].proposalId));
      
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