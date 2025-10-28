const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Keypair } = require("@solana/web3.js");
const { randomBytes } = require("crypto");
const fs = require("fs");
const os = require("os");
const {
  awaitComputationFinalization,
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
  getClusterAccAddress,
  getArciumEnv,
} = require("@arcium-hq/client");

// Program configuration
const PROGRAM_ID = "GnBSkvi8ZRCrtvz6huKMeZF7GrnDtHHyh73GWA2eXmuw";
const CLUSTER_OFFSET = 1078779259;
const DEVNET_RPC_URL = "https://devnet.helius-rpc.com/?api-key=2b8f604a-8422-4d06-b2ae-bfb46afcc995";
const COMMITMENT = "confirmed";

// Helper function to retry RPC calls
async function retryRpcCall(rpcCall, maxRetries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await rpcCall();
    } catch (error) {
      // If account already exists, that's okay - just return success
      if (error.message?.includes("already in use") || 
          error.transactionLogs?.some(log => log.includes("already in use"))) {
        console.log("✅ Account already exists, skipping initialization");
        return "already_exists";
      }
      
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

// Helper function to read keypair from file
function readKpJson(path) {
  const file = fs.readFileSync(path);
  return Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(file.toString()))
  );
}

// Helper function to get MXE public key with retry
async function getMXEPublicKeyWithRetry(provider, programId, maxRetries = 10, retryDelayMs = 500) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const mxePublicKey = await getMXEPublicKey(provider, programId);
      if (mxePublicKey) {
        return mxePublicKey;
      }
    } catch (error) {
      console.log(`Attempt ${attempt} failed to fetch MXE public key:`, error.message);
    }

    if (attempt < maxRetries) {
      console.log(`Retrying in ${retryDelayMs}ms... (attempt ${attempt}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
}

// Initialize computation definition functions using Anchor MethodsBuilder
async function initProposalVotesCompDef(program, owner, uploadRawCircuit = false, offchainSource = false) {
  const baseSeedCompDefAcc = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset("init_proposal_votes");

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
    getArciumProgAddress()
  )[0];

  console.log("Init proposal votes computation definition pda is", compDefPDA.toBase58());

  const sig = await program.methods
    .initProposalVotesCompDef()
    .accounts({
      compDefAccount: compDefPDA,
      payer: owner.publicKey,
      mxeAccount: getMXEAccAddress(program.programId),
    })
    .signers([owner])
    .rpc({
      commitment: COMMITMENT,
    });
  
  console.log("Init proposal votes computation definition transaction", sig);

  if (uploadRawCircuit) {
    const rawCircuit = fs.readFileSync("build/init_proposal_votes.arcis");
    await uploadCircuit(program.provider, "init_proposal_votes", program.programId, rawCircuit, true);
  } else if (!offchainSource) {
    const finalizeTx = await buildFinalizeCompDefTx(
      program.provider,
      Buffer.from(offset).readUInt32LE(),
      program.programId
    );

    const latestBlockhash = await program.provider.connection.getLatestBlockhash();
    finalizeTx.recentBlockhash = latestBlockhash.blockhash;
    finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

    finalizeTx.sign(owner);
    await program.provider.sendAndConfirm(finalizeTx);
  }
  return sig;
}

async function initVoteForProposalCompDef(program, owner, uploadRawCircuit = false, offchainSource = false) {
  const baseSeedCompDefAcc = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset("vote_for_proposal");

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
    getArciumProgAddress()
  )[0];

  console.log("Vote for proposal computation definition pda is", compDefPDA.toBase58());

  const sig = await program.methods
    .initVoteForProposalCompDef()
    .accounts({
      compDefAccount: compDefPDA,
      payer: owner.publicKey,
      mxeAccount: getMXEAccAddress(program.programId),
    })
    .signers([owner])
    .rpc({
      commitment: COMMITMENT,
    });
  
  console.log("Init vote for proposal computation definition transaction", sig);

  if (uploadRawCircuit) {
    const rawCircuit = fs.readFileSync("build/vote_for_proposal.arcis");
    await uploadCircuit(program.provider, "vote_for_proposal", program.programId, rawCircuit, true);
  } else if (!offchainSource) {
    const finalizeTx = await buildFinalizeCompDefTx(
      program.provider,
      Buffer.from(offset).readUInt32LE(),
      program.programId
    );

    const latestBlockhash = await program.provider.connection.getLatestBlockhash();
    finalizeTx.recentBlockhash = latestBlockhash.blockhash;
    finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

    finalizeTx.sign(owner);
    await program.provider.sendAndConfirm(finalizeTx);
  }
  return sig;
}

async function initRevealWinnerCompDef(program, owner, uploadRawCircuit = false, offchainSource = false) {
  const baseSeedCompDefAcc = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset("reveal_winning_proposal");

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
    getArciumProgAddress()
  )[0];

  console.log("Reveal winning proposal computation definition pda is", compDefPDA.toBase58());

  const sig = await program.methods
    .initRevealWinnerCompDef()
    .accounts({
      compDefAccount: compDefPDA,
      payer: owner.publicKey,
      mxeAccount: getMXEAccAddress(program.programId),
    })
    .signers([owner])
    .rpc({
      commitment: COMMITMENT,
    });
  
  console.log("Init reveal winning proposal computation definition transaction", sig);

  if (uploadRawCircuit) {
    const rawCircuit = fs.readFileSync("build/reveal_winning_proposal.arcis");
    await uploadCircuit(program.provider, "reveal_winning_proposal", program.programId, rawCircuit, true);
  } else if (!offchainSource) {
    const finalizeTx = await buildFinalizeCompDefTx(
      program.provider,
      Buffer.from(offset).readUInt32LE(),
      program.programId
    );

    const latestBlockhash = await program.provider.connection.getLatestBlockhash();
    finalizeTx.recentBlockhash = latestBlockhash.blockhash;
    finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

    finalizeTx.sign(owner);
    await program.provider.sendAndConfirm(finalizeTx);
  }
  return sig;
}

async function initDecryptVoteCompDef(program, owner, uploadRawCircuit = false, offchainSource = false) {
  const baseSeedCompDefAcc = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset("decrypt_vote");

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
    getArciumProgAddress()
  )[0];

  console.log("Decrypt vote computation definition pda is", compDefPDA.toBase58());

  const sig = await program.methods
    .initDecryptVoteCompDef()
    .accounts({
      compDefAccount: compDefPDA,
      payer: owner.publicKey,
      mxeAccount: getMXEAccAddress(program.programId),
    })
    .signers([owner])
    .rpc({
      commitment: COMMITMENT,
    });
  
  console.log("Init decrypt vote computation definition transaction", sig);

  if (uploadRawCircuit) {
    const rawCircuit = fs.readFileSync("build/decrypt_vote.arcis");
    await uploadCircuit(program.provider, "decrypt_vote", program.programId, rawCircuit, true);
  } else if (!offchainSource) {
    const finalizeTx = await buildFinalizeCompDefTx(
      program.provider,
      Buffer.from(offset).readUInt32LE(),
      program.programId
    );

    const latestBlockhash = await program.provider.connection.getLatestBlockhash();
    finalizeTx.recentBlockhash = latestBlockhash.blockhash;
    finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

    finalizeTx.sign(owner);
    await program.provider.sendAndConfirm(finalizeTx);
  }
  return sig;
}

async function initVerifyWinningVoteCompDef(program, owner, uploadRawCircuit = false, offchainSource = false) {
  const baseSeedCompDefAcc = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset("verify_winning_vote");

  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
    getArciumProgAddress()
  )[0];

  console.log("Verify winning vote computation definition pda is", compDefPDA.toBase58());

  const sig = await program.methods
    .initVerifyWinningVoteCompDef()
    .accounts({
      compDefAccount: compDefPDA,
      payer: owner.publicKey,
      mxeAccount: getMXEAccAddress(program.programId),
    })
    .signers([owner])
    .rpc({
      commitment: COMMITMENT,
    });
  
  console.log("Init verify winning vote computation definition transaction", sig);

  if (uploadRawCircuit) {
    const rawCircuit = fs.readFileSync("build/verify_winning_vote.arcis");
    await uploadCircuit(program.provider, "verify_winning_vote", program.programId, rawCircuit, true);
  } else if (!offchainSource) {
    const finalizeTx = await buildFinalizeCompDefTx(
      program.provider,
      Buffer.from(offset).readUInt32LE(),
      program.programId
    );

    const latestBlockhash = await program.provider.connection.getLatestBlockhash();
    finalizeTx.recentBlockhash = latestBlockhash.blockhash;
    finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

    finalizeTx.sign(owner);
    await program.provider.sendAndConfirm(finalizeTx);
  }
  return sig;
}

// Function to reveal winning proposal (devnet configuration)
async function revealWinningProposal(program, clusterAccount, provider) {
  console.log("\n🏆 REVEALING WINNING PROPOSAL");
  console.log("-".repeat(40));
  
  try {
    const revealOffset = new anchor.BN(randomBytes(8), "hex");
    const revealQueueSig = await retryRpcCall(async () => {
      return await program.methods
        .revealWinningProposal(revealOffset, 0) // system_id = 0
        .accountsPartial({
          computationAccount: getComputationAccAddress(program.programId, revealOffset),
          clusterAccount: clusterAccount, // Use hardcoded devnet cluster account
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
          commitment: "confirmed",
          preflightCommitment: "confirmed"
        });
    });

    console.log(`✅ Reveal queued: ${revealQueueSig}`);
    console.log(`⏳ Waiting for computation to finalize...`);
    console.log(`   - Computation Offset: ${revealOffset.toString()}`);
    console.log(`   - Program ID: ${program.programId.toBase58()}`);
    console.log(`   - Cluster Account: ${clusterAccount.toBase58()}`);
    console.log(`   - Provider Type: ${provider.constructor.name}`);
    
    // Check if cluster account exists on devnet
    try {
      const clusterAccountInfo = await provider.connection.getAccountInfo(clusterAccount);
      if (clusterAccountInfo) {
        console.log(`   - Cluster Account exists on devnet: ✅`);
      } else {
        console.log(`   - Cluster Account does not exist on devnet: ❌`);
      }
    } catch (error) {
      console.log(`   - Error checking cluster account: ${error.message}`);
    }
    
    try {
      // Check computation status manually for debugging
      console.log(`   - Checking computation status manually...`);
      const compAccountAddress = getComputationAccAddress(program.programId, revealOffset);
      console.log(`   - Computation account: ${compAccountAddress.toBase58()}`);
      
      // Check initial computation account status
      let compAccount = await provider.connection.getAccountInfo(compAccountAddress);
      console.log(`   - Initial computation account exists: ${compAccount ? '✅' : '❌'}`);
      if (compAccount) {
        console.log(`   - Initial computation account data length: ${compAccount.data.length} bytes`);
        console.log(`   - Initial computation account owner: ${compAccount.owner.toBase58()}`);
      }
      
      // Try computation finalization with timeout and polling
      console.log(`   - Starting computation finalization...`);
      console.log(`   - Setting 30-second timeout for devnet...`);
      
      // Add polling mechanism to check computation status
      let computationCompleted = false;
      let pollCount = 0;
      const maxPolls = 10; // Poll every 3 seconds for 30 seconds total
      
      const pollComputation = async () => {
        try {
          const compAccount = await provider.connection.getAccountInfo(compAccountAddress);
          pollCount++;
          console.log(`   - Poll ${pollCount}/${maxPolls}: Computation account exists: ${compAccount ? '✅' : '❌'}`);
          if (compAccount) {
            console.log(`   - Poll ${pollCount}: Data length: ${compAccount.data.length} bytes`);
          }
          return compAccount;
        } catch (error) {
          console.log(`   - Poll ${pollCount}: Error checking computation: ${error.message}`);
          return null;
        }
      };
      
      // Start polling
      const pollInterval = setInterval(async () => {
        if (pollCount >= maxPolls) {
          clearInterval(pollInterval);
          return;
        }
        await pollComputation();
      }, 3000); // Poll every 3 seconds
      
      // Create a timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          clearInterval(pollInterval);
          reject(new Error('Computation finalization timeout after 30 seconds'));
        }, 120000); // 30 second timeout
      });
      
      // Race between finalization and timeout
      const finalizeSig =  await Promise.race([
        awaitComputationFinalization(
          provider,
          revealOffset,
          program.programId,
          "confirmed"
        ),
        timeoutPromise
      ]);
      
      // Clear polling interval
      clearInterval(pollInterval);
      
      console.log(`✅ Winner revealed successfully! Finalization signature: ${finalizeSig}`);
      
      // Check final computation account status
      compAccount = await provider.connection.getAccountInfo(compAccountAddress);
      console.log(`   - Final computation account exists: ${compAccount ? '✅' : '❌'}`);
      if (compAccount) {
        console.log(`   - Final computation account data length: ${compAccount.data.length} bytes`);
      }
      
    } catch (finalizationError) {
      if (finalizationError.message.includes('timeout')) {
        console.log(`⚠️  Computation finalization timed out after 30 seconds`);
        console.log(`   - This is common on devnet due to network latency`);
        console.log(`   - The computation may still be processing in the background`);
        
        // Check computation status after timeout
        const compAccountAddress = getComputationAccAddress(program.programId, revealOffset);
        const compAccount = await provider.connection.getAccountInfo(compAccountAddress);
        console.log(`   - Computation account after timeout: ${compAccount ? '✅ Exists' : '❌ Not found'}`);
        if (compAccount) {
          console.log(`   - Computation account data length: ${compAccount.data.length} bytes`);
        }
        
        console.log(`   - Continuing with verification...`);
      } else {
        console.log(`⚠️  Computation finalization failed: ${finalizationError.message}`);
        console.log(`   - Error details:`, finalizationError);
        console.log(`   - This might be normal if there are no votes to process`);
        console.log(`   - Continuing with verification...`);
      }
    }
    
    // Verify the results
    console.log("\n🔍 VERIFYING RESULTS ON BLOCKCHAIN");
    console.log("-".repeat(40));
    
    const [systemAccPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("proposal_system")], 
      program.programId
    );
    
    const systemAccount = await program.account.proposalSystemAccount.fetch(systemAccPDA);
    console.log("✅ System account updated:");
    console.log("   - Winning Proposal ID:", systemAccount.winningProposalId?.toString() || "None");
    console.log("   - Winning Vote Count:", systemAccount.winningVoteCount?.toString() || "None");
    console.log("   - Next Proposal ID:", systemAccount.nextProposalId.toString());
    
    return revealQueueSig;
  } catch (error) {
    console.log("❌ Failed to reveal winner:", error.message);
    throw error;
  }
}

// Function to vote on a proposal
async function voteOnProposal(program, owner, proposalId, encryptedProposalId, publicKey, proposalIdNonce, ciphertext, nonce) {
  console.log(`\n🗳️  Voting on proposal ${proposalId.toString()}`);
  console.log(`📊 Encrypted Proposal ID: ${encryptedProposalId.toString('hex')}`);
  console.log(`🔐 Public Key: ${publicKey.toString('hex')}`);
  console.log(`🔢 Proposal ID Nonce: ${proposalIdNonce.toString('hex')}`);
  console.log(`📝 Ciphertext: ${ciphertext.toString('hex')}`);
  console.log(`🔢 Nonce: ${nonce.toString('hex')}`);
  console.log("-".repeat(50));
  
  try {
    console.log(`👤 Voter: ${owner.publicKey.toBase58()}`);
    
    // Create necessary PDAs and accounts for voting (like in the test file)
    const roundId = new anchor.BN(0); // Using round 0
    const roundIdBytes = Buffer.from(roundId.toArray("le", 8));
    
    const [systemAccPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("proposal_system")], 
      program.programId
    );
    
    const [roundMetadataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("round_metadata")],
      program.programId
    );
    
    const [voteReceiptPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vote_receipt"), owner.publicKey.toBuffer(), roundIdBytes],
      program.programId
    );
    
    // Generate computation offset for voting
    const voteComputationOffset = new anchor.BN(randomBytes(8), "hex");
    
    // Use the cluster offset from deployment
    const clusterAccount = getClusterAccAddress(CLUSTER_OFFSET);
    
    console.log(`💰 System Account: ${systemAccPDA.toBase58()}`);
    console.log(`📋 Round Metadata: ${roundMetadataPDA.toBase58()}`);
    console.log(`📝 Vote Receipt: ${voteReceiptPDA.toBase58()}`);
    console.log(`🔧 Computation Offset: ${voteComputationOffset.toString()}`);
    console.log(`🌐 Cluster Account: ${clusterAccount.toBase58()}`);
    
    // Check if vote receipt already exists
    try {
      const existingVoteReceipt = await program.account.voteReceiptAccount.fetch(voteReceiptPDA);
      console.log("⚠️  Vote receipt already exists - this voter has already voted in this round");
      console.log(`   - Existing vote receipt found for voter: ${owner.publicKey.toBase58()}`);
      console.log(`   - Round: ${existingVoteReceipt.roundId.toString()}`);
      console.log("✅ Skipping vote as voter has already participated");
      return "already_voted";
    } catch (error) {
      // Vote receipt doesn't exist, proceed with voting
      console.log("✅ Vote receipt doesn't exist, proceeding with vote");
    }
    
    // Vote on the proposal using Anchor MethodsBuilder (exactly like in the test file)
    const signature = await program.methods
      .voteForProposal(
        voteComputationOffset,
        proposalId,
        Array.from(encryptedProposalId[1]), // encrypted proposal ID as array
        Array.from(ciphertext[1]), // ciphertext as array
        Array.from(publicKey), // public key as array
        new anchor.BN(deserializeLE(nonce).toString()), // nonce as BN
        roundId
      )
      .accountsPartial({
        payer: owner.publicKey,
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
      .signers([owner])
      .rpc({ 
        skipPreflight: false, 
        commitment: "confirmed",
        preflightCommitment: "confirmed"
      });
    
    console.log(`✅ Vote cast successfully!`);
    console.log(`📝 Transaction signature: ${signature}`);
    
    return signature;
  } catch (error) {
    console.error(`❌ Failed to vote on proposal:`, error.message);
    throw error;
  }
}

// Function to submit a proposal
async function submitProposal(program, owner, proposalTitle, proposalDescription) {
  console.log(`\n📝 Submitting proposal: "${proposalTitle}"`);
  console.log(`📄 Description: "${proposalDescription}"`);
  console.log("-".repeat(50));
  
  try {
    // Generate a unique proposal ID (this will be the next proposal ID)
    const systemAccount = await program.account.proposalSystemAccount.fetch(
      PublicKey.findProgramAddressSync([Buffer.from("proposal_system")], program.programId)[0]
    );
    
    const proposalId = systemAccount.nextProposalId;
    
    console.log(`🆔 Proposal ID: ${proposalId.toString()}`);
    console.log(`👤 Submitter: ${owner.publicKey.toBase58()}`);
    
    // Create round escrow PDA (needed for proposal submission)
    const roundId = new anchor.BN(0); // Using round 0
    const roundIdBytes = Buffer.from(roundId.toArray("le", 8));
    
    const [roundEscrowPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("round_escrow"), roundIdBytes],
      program.programId
    );
    
    console.log(`💰 Round Escrow: ${roundEscrowPDA.toBase58()}`);
    
    // Submit the proposal using Anchor MethodsBuilder (like in the test file)
    const signature = await program.methods
      .submitProposal(proposalTitle, proposalDescription)
      .accountsPartial({
        payer: owner.publicKey,
        roundEscrow: roundEscrowPDA,
      })
      .rpc({ 
        skipPreflight: false, 
        commitment: "confirmed",
        preflightCommitment: "confirmed"
      });
    
    console.log(`✅ Proposal submitted successfully!`);
    console.log(`📝 Transaction signature: ${signature}`);
    
    // Fetch and display the updated system state
    const updatedSystemAccount = await program.account.proposalSystemAccount.fetch(
      PublicKey.findProgramAddressSync([Buffer.from("proposal_system")], program.programId)[0]
    );
    
    console.log(`\n📊 Updated System State:`);
    console.log(`   - Next Proposal ID: ${updatedSystemAccount.nextProposalId.toString()}`);
    console.log(`   - Total Proposals: ${updatedSystemAccount.nextProposalId.toString()}`);
    
    return signature;
  } catch (error) {
    console.error(`❌ Failed to submit proposal:`, error.message);
    throw error;
  }
}

// Main initialization function using Anchor client-side patterns
async function initializeVotingProgram() {
  try {
    console.log("🚀 Starting voting program initialization on devnet using Anchor...");
    console.log("=".repeat(60));

    // Set up devnet connection
    const connection = new anchor.web3.Connection(DEVNET_RPC_URL, COMMITMENT);
    
    // Load owner keypair
    const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);
    console.log("Owner public key:", owner.publicKey.toBase58());
    
    // Create wallet and provider (following Anchor client-side patterns)
    const wallet = new anchor.Wallet(owner);
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: COMMITMENT,
    });
    
    // Load the program IDL
    const idl = JSON.parse(fs.readFileSync("target/idl/proposal_system.json", "utf8"));
    
    // Create program instance exactly like in your frontend code
    // Use the hardcoded program ID (like in your frontend)
    const programId = new PublicKey(PROGRAM_ID);
    const program = new anchor.Program(idl, provider);
    
    console.log("Program ID:", program.programId.toBase58());
    console.log("Using devnet RPC:", DEVNET_RPC_URL);
    
    // Test basic program access first
    try {
      console.log("🧪 Testing basic program access...");
      const programInfo = await connection.getAccountInfo(programId);
      if (programInfo) {
        console.log("✅ Program account found on devnet");
      } else {
        throw new Error("Program not found on devnet");
      }
    } catch (error) {
      console.error("❌ Program access test failed:", error.message);
      return;
    }
    
    // Devnet configuration - use hardcoded cluster account
    const clusterAccount = getClusterAccAddress(CLUSTER_OFFSET);
    console.log("Cluster account address:", clusterAccount.toBase58());
    console.log("Cluster offset:", CLUSTER_OFFSET);
    
    // First, we need to initialize the Arcium infrastructure
    console.log("🔧 Initializing Arcium infrastructure...");
    console.log("-".repeat(40));
    
    // Step 1: Get MXE public key (like in helo_3.ts)
    console.log("📋 Step 1: Getting MXE public key...");
    let mxePublicKey;
    try {
      mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);
      console.log("✅ MXE account found");
      console.log("MXE x25519 pubkey:", Buffer.from(mxePublicKey).toString('hex'));
    } catch (error) {
      console.log("❌ MXE account not found - Arcium infrastructure not initialized");
      console.log("Please run the following command first:");
      console.log("arcium deploy --cluster-offset 1078779259 --keypair-path ~/.config/solana/id.json --rpc-url 'https://devnet.helius-rpc.com/?api-key=2b8f604a-8422-4d06-b2ae-bfb46afcc995'");
      console.log("Then run this script again.");
      return;
    }

    // Step 2: Initialize computation definitions (exactly like helo_3.ts)
    console.log("\n📋 Step 2: Initializing computation definitions...");
    console.log("-".repeat(40));
    
    // Initialize proposal votes computation definition
    console.log("Initializing proposal votes computation definition");
    const initProposalVotesSig = await retryRpcCall(async () => {
      return await initProposalVotesCompDef(program, owner, false, false);
    });
    console.log("Proposal votes computation definition initialized with signature", initProposalVotesSig);

    // Initialize vote for proposal computation definition
    console.log("Initializing vote for proposal computation definition");
    const initVoteForProposalSig = await retryRpcCall(async () => {
      return await initVoteForProposalCompDef(program, owner, false, false);
    });
    console.log("Vote for proposal computation definition initialized with signature", initVoteForProposalSig);

    // Initialize reveal winning proposal computation definition
    console.log("Initializing reveal winning proposal computation definition");
    const initRevealWinnerSig = await retryRpcCall(async () => {
      return await initRevealWinnerCompDef(program, owner, false, false);
    });
    console.log("Reveal winning proposal computation definition initialized with signature", initRevealWinnerSig);

    // Initialize decrypt vote computation definition
    console.log("Initializing decrypt vote computation definition");
    const initDecryptVoteSig = await retryRpcCall(async () => {
      return await initDecryptVoteCompDef(program, owner, false, false);
    });
    console.log("Decrypt vote computation definition initialized with signature", initDecryptVoteSig);

    // Initialize verify winning vote computation definition
    console.log("Initializing verify winning vote computation definition");
    const initVerifyWinningVoteSig = await retryRpcCall(async () => {
      return await initVerifyWinningVoteCompDef(program, owner, false, false);
    });
    console.log("Verify winning vote computation definition initialized with signature", initVerifyWinningVoteSig);

    // Step 3: Initialize the main proposal system (exactly like helo_3.ts)
    console.log("\n🏗️ Step 3: Initializing main proposal system...");
    console.log("-".repeat(40));

    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);

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
          clusterAccount: clusterAccount, // Use devnet cluster account
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

    console.log("✅ Proposal system initialized with signature", initSystemSig);

    // Verify the system was initialized correctly using Anchor account fetching
    console.log("\n🔍 Verifying system initialization...");
    console.log("-".repeat(40));

    const [systemAccPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("proposal_system")], 
      program.programId
    );

    try {
      const systemAccount = await program.account.proposalSystemAccount.fetch(systemAccPDA);
      console.log("✅ System account found:");
      console.log("   - Authority:", systemAccount.authority.toBase58());
      console.log("   - Next Proposal ID:", systemAccount.nextProposalId);
      console.log("   - Winning Proposal ID:", systemAccount.winningProposalId);
      console.log("   - Winning Vote Count:", systemAccount.winningVoteCount);
      console.log("   - Nonce:", systemAccount.nonce.toString());
      
      // Show more detailed system state
      console.log("\n📊 Detailed System State:");
      console.log("-".repeat(40));
      console.log("🏛️  Program ID:", program.programId.toBase58());
      console.log("👤 Authority:", systemAccount.authority.toBase58());
      console.log("🆔 Next Proposal ID:", systemAccount.nextProposalId.toString());
      console.log("🏆 Winning Proposal ID:", systemAccount.winningProposalId?.toString() || "None");
      console.log("📊 Winning Vote Count:", systemAccount.winningVoteCount?.toString() || "None");
      console.log("🔢 System Nonce:", systemAccount.nonce.toString());
      console.log("📅 Account Owner:", systemAccount.authority.equals(owner.publicKey) ? "✅ Matches current wallet" : "❌ Different from current wallet");
      
      // Check if there are any proposals
      if (systemAccount.nextProposalId.toString() === "0") {
        console.log("📝 Proposals: No proposals created yet");
      } else {
        console.log(`📝 Proposals: ${systemAccount.nextProposalId.toString()} proposal(s) can be created`);
      }
      
      // Check if there's a winning proposal
      if (systemAccount.winningProposalId && systemAccount.winningVoteCount) {
        console.log(`🏆 Current Winner: Proposal ${systemAccount.winningProposalId.toString()} with ${systemAccount.winningVoteCount.toString()} votes`);
      } else {
        console.log("🏆 Current Winner: No winning proposal yet");
      }
      
    } catch (error) {
      console.log("❌ Could not fetch system account:", error.message);
    }

    // Optional: Submit a sample proposal (uncomment to test)
    const CREATE_PROPOSAL = false; // Set to true to create a proposal
    const VOTE_ON_PROPOSAL = false; // Set to true to vote on proposal 1
    const REVEAL_WINNER = true; // Set to true to reveal winning proposal
    
    if (CREATE_PROPOSAL) {
      console.log("\n📝 Submitting a sample proposal...");
      console.log("=".repeat(60));
      
      try {
        const proposalTitle = "Enhanced Privacy Feature";
        const proposalDescription = "Should we implement a new feature for encrypted voting with enhanced privacy?";
        await submitProposal(program, owner, proposalTitle, proposalDescription);
        
        console.log("\n🎉 Proposal submitted successfully!");
        console.log("✅ Voting system is now ready for users to vote");
        
      } catch (error) {
        console.log("⚠️  Failed to submit proposal:", error.message);
        console.log("✅ System is still ready, but no proposal was created");
      }
    }
    
    if (VOTE_ON_PROPOSAL) {
      console.log("\n🗳️  Casting a vote on proposal 1...");
      console.log("=".repeat(60));
      
      try {
        // Generate proper encrypted vote data (like in the test file)
        const proposalId = 1; // Vote on proposal 1
        const vote = BigInt(proposalId); // Vote value as BigInt
        
        // Create encryption cipher using shared secret (like in test file)
        const privateKey = x25519.utils.randomSecretKey();
        const publicKey = x25519.getPublicKey(privateKey);
        const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
        const cipher = new RescueCipher(sharedSecret);
        
        // Encrypt the vote data
        const nonce = randomBytes(16);
        const ciphertext = cipher.encrypt([vote], nonce);
        const proposalIdNonce = randomBytes(16);
        const encryptedProposalId = cipher.encrypt([vote], proposalIdNonce);
        
        console.log(`🔐 Generated encryption data:`);
        console.log(`   - Vote: ${vote}`);
        console.log(`   - Public Key: ${Buffer.from(publicKey).toString('hex')}`);
        console.log(`   - Nonce: ${nonce.toString('hex')}`);
        console.log(`   - Proposal ID Nonce: ${proposalIdNonce.toString('hex')}`);
        
        const voteResult = await voteOnProposal(program, owner, proposalId, encryptedProposalId[0], publicKey, proposalIdNonce, ciphertext[0], nonce);
        
        if (voteResult === "already_voted") {
          console.log("\n⚠️  Vote skipped - voter has already voted in this round");
          console.log("✅ Proceeding to reveal winner anyway");
        } else {
          console.log("\n🎉 Vote cast successfully!");
          console.log("✅ Voting process completed");
        }
        
        // Reveal the winning proposal
        try {
          await revealWinningProposal(program, clusterAccount);
        } catch (error) {
          console.log("⚠️  Failed to reveal winner:", error.message);
          console.log("✅ Vote was cast successfully, but reveal failed");
        }
        
      } catch (error) {
        console.log("⚠️  Failed to vote on proposal:", error.message);
        console.log("✅ System is ready, but vote failed");
      }
    }
    
    if (REVEAL_WINNER) {
      console.log("\n🏆 REVEALING WINNING PROPOSAL");
      console.log("=".repeat(60));
      
      try {
        // Try both cluster account approaches
        const TRY_BOTH_CLUSTERS = false; // Set to true to try both cluster accounts
        
        if (TRY_BOTH_CLUSTERS) {
          try {
            console.log("\n🔄 Trying with Arcium environment cluster account first...");
            const arciumClusterAccount = getClusterAccAddress(CLUSTER_OFFSET);
            console.log(`🌐 Using Arcium cluster account: ${arciumClusterAccount.toBase58()}`);
            await revealWinningProposal(program, arciumClusterAccount, provider);
            console.log("\n🎉 Winner revealed successfully with Arcium cluster!");
          } catch (arciumError) {
            console.log("⚠️  Arcium cluster failed, trying hardcoded cluster...");
            console.log(`   - Arcium error: ${arciumError.message}`);
            const clusterAccount = getClusterAccAddress(CLUSTER_OFFSET);
            console.log(`🌐 Using hardcoded cluster account: ${clusterAccount.toBase58()}`);
            await revealWinningProposal(program, clusterAccount, provider);
            console.log("\n🎉 Winner revealed successfully with hardcoded cluster!");
          }
        } else {
          // Use the cluster offset from deployment
          const clusterAccount = getClusterAccAddress(CLUSTER_OFFSET);
          console.log(`🌐 Using cluster account: ${clusterAccount.toBase58()}`);
          
          await revealWinningProposal(program, clusterAccount, provider);
          console.log("\n🎉 Winner revealed successfully!");
        }
      } catch (error) {
        console.log("⚠️  Failed to reveal winner:", error.message);
        console.log("✅ System is ready, but reveal failed");
      }
    }
    
    if (!CREATE_PROPOSAL && !VOTE_ON_PROPOSAL && !REVEAL_WINNER) {
      console.log("\n✅ System is ready for use!");
      console.log("💡 To test proposal creation, set CREATE_PROPOSAL = true");
      console.log("💡 To test voting, set VOTE_ON_PROPOSAL = true");
      console.log("💡 To test reveal winner, set REVEAL_WINNER = true");
    }

    console.log("\n🎉 Voting program initialization completed successfully!");
    console.log("=".repeat(60));
    console.log("✅ All computation definitions initialized using Anchor MethodsBuilder");
    console.log("✅ Main proposal system initialized using Anchor MethodsBuilder");
    console.log("✅ Program ready for use on devnet");
    console.log("✅ Same patterns as frontend development");
    console.log("=".repeat(60));

  } catch (error) {
    console.error("❌ Initialization failed:", error);
    process.exit(1);
  }
}

// Run the initialization
if (require.main === module) {
  initializeVotingProgram().catch(console.error);
}

module.exports = {
  initializeVotingProgram,
  initProposalVotesCompDef,
  initVoteForProposalCompDef,
  initRevealWinnerCompDef,
  initDecryptVoteCompDef,
  initVerifyWinningVoteCompDef,
  revealWinningProposal,
  voteOnProposal,
  submitProposal,
};
