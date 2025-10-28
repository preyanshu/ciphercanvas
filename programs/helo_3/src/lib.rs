use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;
use anchor_lang::solana_program::rent::Rent;

const COMP_DEF_OFFSET_INIT_PROPOSAL_VOTES: u32 = comp_def_offset("init_proposal_votes");
const COMP_DEF_OFFSET_VOTE_FOR_PROPOSAL: u32 = comp_def_offset("vote_for_proposal");
const COMP_DEF_OFFSET_REVEAL_WINNER: u32 = comp_def_offset("reveal_winning_proposal");
const COMP_DEF_OFFSET_DECRYPT_VOTE: u32 = comp_def_offset("decrypt_vote");
const COMP_DEF_OFFSET_VERIFY_WINNING_VOTE: u32 = comp_def_offset("verify_winning_vote");

declare_id!("GnBSkvi8ZRCrtvz6huKMeZF7GrnDtHHyh73GWA2eXmuw");

#[arcium_program]
pub mod proposal_system {
    use super::*;

    pub fn init_proposal_votes_comp_def(ctx: Context<InitProposalVotesCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, true, 0, None, None)?;
        Ok(())
    }

    /// Creates a new proposal submission and voting system.
    ///
    /// This initializes the system with encrypted vote counters for all proposals.
    /// The vote tallies are stored in encrypted form and can only be revealed by the system authority.
    /// All individual votes remain completely confidential throughout the voting process.
    ///
    /// # Arguments
    /// * `nonce` - Cryptographic nonce for initializing encrypted vote counters
    pub fn init_proposal_system(
        ctx: Context<InitProposalSystem>,
        computation_offset: u64,
        nonce: u128,
    ) -> Result<()> {
        msg!("Initializing proposal voting system");

        // Initialize the system account with the provided parameters
        ctx.accounts.system_acc.bump = ctx.bumps.system_acc;
        ctx.accounts.system_acc.authority = ctx.accounts.payer.key();
        ctx.accounts.system_acc.nonce = nonce;
        ctx.accounts.system_acc.proposal_votes = [[0; 32]; 10]; // 10 proposals max
        ctx.accounts.system_acc.next_proposal_id = 0;
        ctx.accounts.system_acc.winning_proposal_id = None; // No winner yet
        ctx.accounts.system_acc.winning_vote_count = None; // No vote count yet
        ctx.accounts.system_acc.proposal_submission_fee = 1_000_000; // 0.001 SOL fee

        // Initialize the round metadata account (separate from system_acc to avoid MXE issues)
        ctx.accounts.round_metadata.bump = ctx.bumps.round_metadata;
        ctx.accounts.round_metadata.current_round = 0; // Start at round 0
        ctx.accounts.round_metadata.proposals_in_current_round = 0; // Start with 0 proposals
        ctx.accounts.round_metadata.total_voters = 0; // Start with 0 voters
        ctx.accounts.round_metadata.round_started = Clock::get()?.unix_timestamp; // Initialize with current timestamp

        let args = vec![Argument::PlaintextU128(nonce)];

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Initialize encrypted vote counters for all proposals through MPC
        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            None,
            vec![InitProposalVotesCallback::callback_ix(&[CallbackAccount {
                pubkey: ctx.accounts.system_acc.key(),
                is_writable: true,
            }])],
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "init_proposal_votes")]
    pub fn init_proposal_votes_callback(
        ctx: Context<InitProposalVotesCallback>,
        output: ComputationOutputs<InitProposalVotesOutput>,
    ) -> Result<()> {
        let o = match output {
            ComputationOutputs::Success(InitProposalVotesOutput { field_0 }) => field_0,
            _ => return Err(ErrorCode::AbortedComputation.into()),
        };

        ctx.accounts.system_acc.proposal_votes = o.ciphertexts;
        ctx.accounts.system_acc.nonce = o.nonce;

        Ok(())
    }

    /// Submits a new proposal to the system.
    ///
    /// This allows anyone to submit a proposal with a title, description, and URL.
    /// The proposal gets assigned a unique ID within the current round and can be voted on by users.
    ///
    /// # Arguments
    /// * `title` - Short title of the proposal (max 50 chars)
    /// * `description` - Detailed description of the proposal (max 200 chars)
    /// * `url` - URL associated with the proposal (max 200 chars)
    pub fn submit_proposal(
        ctx: Context<SubmitProposal>,
        title: String,
        description: String,
        url: String,
    ) -> Result<()> {
        // Check if we can add more proposals to this round
        require!(
            ctx.accounts.round_metadata.proposals_in_current_round < 10,
            ErrorCode::MaxProposalsReached
        );

        let proposal_id_in_round = ctx.accounts.round_metadata.proposals_in_current_round;
        let current_round = ctx.accounts.round_metadata.current_round;
        let fee = ctx.accounts.system_acc.proposal_submission_fee;
        
        // Check if payer has enough SOL for the fee
        require!(
            ctx.accounts.payer.lamports() >= fee,
            ErrorCode::InsufficientFunds
        );

        // Initialize round escrow if this is the first proposal in the round
        // Check if escrow is uninitialized by checking if round_id is 0 (default value)
        // Check if escrow is uninitialized by checking if it's a new account
if ctx.accounts.round_escrow.round_id == 0 && ctx.accounts.round_escrow.total_collected == 0 {
    // Only initialize if both round_id and total_collected are 0 (uninitialized)
    ctx.accounts.round_escrow.bump = ctx.bumps.round_escrow;
    ctx.accounts.round_escrow.round_id = current_round;
    ctx.accounts.round_escrow.total_collected = 0;
    ctx.accounts.round_escrow.total_distributed = 0;
    ctx.accounts.round_escrow.current_balance = 0;
    ctx.accounts.round_escrow.round_status = RoundStatus::Active;
    ctx.accounts.round_escrow.created_at = Clock::get()?.unix_timestamp;
}

        // Validate escrow is for the correct round
        require!(
            ctx.accounts.round_escrow.round_id == current_round,
            ErrorCode::InvalidEscrowRoundId
        );

        // Validate escrow is in active status
        require!(
            ctx.accounts.round_escrow.round_status == RoundStatus::Active,
            ErrorCode::RoundEscrowNotActive
        );

        // REAL SOL TRANSFER: Payer → Round Escrow Account
        let transfer_instruction = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.payer.key(),
            &ctx.accounts.round_escrow.key(),
            fee,
        );

        anchor_lang::solana_program::program::invoke(
            &transfer_instruction,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.round_escrow.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        // Update escrow balance
        ctx.accounts.round_escrow.total_collected += fee;
        ctx.accounts.round_escrow.current_balance += fee;

        msg!(
            "Proposal submission fee collected: {} lamports ({} SOL) for round {}",
            fee,
            fee as f64 / 1_000_000_000.0,
            current_round
        );
        
        // Initialize the proposal account
        ctx.accounts.proposal_acc.bump = ctx.bumps.proposal_acc;
        ctx.accounts.proposal_acc.id = proposal_id_in_round;
        ctx.accounts.proposal_acc.round_id = current_round;
        ctx.accounts.proposal_acc.title = title;
        ctx.accounts.proposal_acc.description = description;
        ctx.accounts.proposal_acc.url = url;
        ctx.accounts.proposal_acc.submitter = ctx.accounts.payer.key();
        ctx.accounts.proposal_acc.vote_count = 0;

        // Increment the round-specific proposal counter
        ctx.accounts.round_metadata.proposals_in_current_round += 1;
        
        // Also increment global counter for tracking
        ctx.accounts.system_acc.next_proposal_id += 1;

        emit!(ProposalSubmittedEvent {
            proposal_id: proposal_id_in_round,
            round_id: current_round,
            submitter: ctx.accounts.payer.key(),
        });

        Ok(())
    }

    pub fn init_vote_for_proposal_comp_def(ctx: Context<InitVoteForProposalCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, true, 0, None, None)?;
        Ok(())
    }

    /// Submits an encrypted vote for a specific proposal.
    ///
    /// This function allows a voter to cast their vote for a specific proposal in encrypted form.
    /// The vote is added to the running tally through MPC computation, ensuring
    /// that individual votes remain confidential while updating the overall count.
    /// A receipt account is created for the voter storing their vote details with encrypted proposal ID.
    /// Note: The proposal_id_nonce is kept client-side only for privacy.
    ///
    /// # Arguments
    /// * `proposal_id` - ID of the proposal being voted for (plaintext for validation)
    /// * `encrypted_proposal_id` - Encrypted proposal ID for ballot secrecy (nonce kept client-side)
    /// * `vote` - Encrypted vote containing the proposal ID
    /// * `vote_encryption_pubkey` - Voter's public key for encryption
    /// * `vote_nonce` - Cryptographic nonce for the vote encryption
    pub fn vote_for_proposal(
        ctx: Context<VoteForProposal>,
        computation_offset: u64,
        proposal_id: u8,
        encrypted_proposal_id: [u8; 32],
        vote: [u8; 32],
        vote_encryption_pubkey: [u8; 32],
        vote_nonce: u128,
        round_id: u64,
    ) -> Result<()> {
        msg!("vote_for_proposal called with round_id: {}", round_id);
        
        // Manually derive the vote_receipt PDA
        let round_id_bytes = round_id.to_le_bytes();
        let (expected_vote_receipt_pda, vote_receipt_bump) = Pubkey::find_program_address(
            &[b"vote_receipt", ctx.accounts.payer.key().as_ref(), &round_id_bytes],
            &crate::ID
        );
        
        // Log the PDA, program ID, and payer key
        msg!("Vote Receipt PDA: {}", expected_vote_receipt_pda);

        msg!("-------------------------------------------------------");
        msg!("vote_for_proposal called with round_id: {}", round_id);
        msg!("Program ID: {}", crate::ID);
        msg!("Payer Key: {}", ctx.accounts.payer.key());
        msg!("Vote Receipt Bump: {}", vote_receipt_bump);

        msg!("-------------------------------------------------------");
        
        // Log the PDA received from the client
        msg!("PDA received from client: {}", ctx.accounts.vote_receipt.key());
        
        // Manually verify the vote_receipt account
        require!(
            ctx.accounts.vote_receipt.key() == expected_vote_receipt_pda,
            ErrorCode::InvalidAuthority
        );
        
        // Check if the account is already initialized
        require!(
            ctx.accounts.vote_receipt.data_is_empty(),
            ErrorCode::AccountAlreadyInitialized
        );
        
        // Validate that the round_id matches the current active round
        require!(
            round_id == ctx.accounts.round_metadata.current_round,
            ErrorCode::InvalidRoundId
        );
        
        // For round-based proposals, we need to check if the proposal exists in the current round
        // We'll validate this by checking if the proposal_id is less than the proposals in current round
        require!(
            proposal_id < ctx.accounts.round_metadata.proposals_in_current_round,
            ErrorCode::InvalidProposalId
        );

        // Get current timestamp for the vote receipt
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        // Create the vote receipt account using system program
        let space = 8 + VoteReceiptAccount::INIT_SPACE;
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(space);
        
        let create_account_ix = anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.payer.key(),
            &expected_vote_receipt_pda,
            lamports,
            space as u64,
            &crate::ID,
        );
        
        anchor_lang::solana_program::program::invoke_signed(
            &create_account_ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.vote_receipt.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[&[b"vote_receipt", ctx.accounts.payer.key().as_ref(), &round_id_bytes, &[vote_receipt_bump]]],
        )?;

        // Manually initialize the vote receipt account
        let vote_receipt_account = VoteReceiptAccount {
            bump: vote_receipt_bump,
            voter: ctx.accounts.payer.key(),
            encrypted_proposal_id,
            timestamp: current_timestamp,
            vote_encryption_pubkey,
        };
        
        // DEBUG: Log what we're storing in the vote receipt
        msg!("=== VOTE RECEIPT STORAGE DEBUG ===");
        msg!("Storing encrypted_proposal_id (first 8 bytes): {:?}", &encrypted_proposal_id[0..8]);
        msg!("Storing encrypted_proposal_id (last 8 bytes): {:?}", &encrypted_proposal_id[24..32]);
        msg!("Storing encrypted_proposal_id (full): {:?}", &encrypted_proposal_id);
        msg!("Storing vote_encryption_pubkey (full): {:?}", &vote_encryption_pubkey);
        msg!("Storing nonce: {}", vote_nonce);
        msg!("Vote receipt account voter: {}", vote_receipt_account.voter);
        msg!("Vote receipt account timestamp: {}", vote_receipt_account.timestamp);
        msg!("===================================");
        
        // Serialize and write the account data
        let mut vote_receipt_data = ctx.accounts.vote_receipt.try_borrow_mut_data()?;
        let serialized = vote_receipt_account.try_to_vec()?;
        vote_receipt_data[0..serialized.len()].copy_from_slice(&serialized);

        // Emit event for vote receipt creation
        emit!(VoteReceiptCreatedEvent {
            voter: ctx.accounts.payer.key(),
            proposal_id,
            encrypted_proposal_id,
            timestamp: current_timestamp,
        });

        // Increment total voter count for this round
        ctx.accounts.round_metadata.total_voters += 1;

        let args = vec![
            Argument::ArcisPubkey(vote_encryption_pubkey),
            Argument::PlaintextU128(vote_nonce),
            Argument::EncryptedU8(vote), // This will be interpreted as UserVote.proposal_id
            Argument::PlaintextU128(ctx.accounts.system_acc.nonce),
            Argument::Account(
                ctx.accounts.system_acc.key(),
                // Offset calculation: 8 bytes (discriminator) + 1 byte (bump) + 32 bytes (authority) + 16 bytes (nonce) + 1 byte (next_proposal_id)
                8 + 1 + 32 + 16 + 1,
                32 * 10, // 10 proposal vote counters, each stored as 32-byte ciphertext
            ),
        ];

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            None,
            vec![VoteForProposalCallback::callback_ix(&[
                CallbackAccount {
                    pubkey: ctx.accounts.system_acc.key(),
                    is_writable: true,
                },
            ])],
        )?;
        Ok(())
    }

    pub fn init_decrypt_vote_comp_def(ctx: Context<InitDecryptVoteCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, true, 0, None, None)?;
        Ok(())
    }


    /// Decrypts an encrypted vote to reveal the plaintext proposal ID.
    ///
    /// This function allows the system authority to decrypt individual votes
    /// for auditing purposes or verification. The vote must have been previously
    /// encrypted using the same encryption scheme as the voting system.
    ///
    /// # Arguments
    /// * `vote` - The encrypted vote containing the proposal ID
    /// * `vote_encryption_pubkey` - The public key used to encrypt the vote
    /// * `vote_nonce` - The nonce used for vote encryption
    pub fn decrypt_vote(
        ctx: Context<DecryptVote>,
        computation_offset: u64,
        vote: [u8; 32],
        vote_encryption_pubkey: [u8; 32],
        vote_nonce: u128,
    ) -> Result<()> {
        msg!("Decrypting vote for verification/auditing purposes");

        let args = vec![
            Argument::ArcisPubkey(vote_encryption_pubkey),
            Argument::PlaintextU128(vote_nonce),
            Argument::EncryptedU8(vote),
        ];

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            None,
            vec![DecryptVoteCallback::callback_ix(&[
                CallbackAccount {
                    pubkey: ctx.accounts.system_acc.key(),
                    is_writable: true,
                },
            ])],
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "decrypt_vote")]
    pub fn decrypt_vote_callback(
        ctx: Context<DecryptVoteCallback>,
        output: ComputationOutputs<DecryptVoteOutput>,
    ) -> Result<()> {
        let decrypted_proposal_id = match output {
            ComputationOutputs::Success(DecryptVoteOutput { field_0 }) => field_0,
            _ => return Err(ErrorCode::AbortedComputation.into()),
        };

        // Emit event with the decrypted proposal ID
        emit!(VoteDecryptedEvent {
            decrypted_proposal_id,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    pub fn init_verify_winning_vote_comp_def(ctx: Context<InitVerifyWinningVoteCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, true, 0, None, None)?;
        Ok(())
    }

    /// Decrypts an encrypted vote and verifies if it was for the winning proposal in a given round.
    ///
    /// This function allows verification of whether a specific vote was cast for the winning proposal
    /// in a particular voting round. It decrypts the vote and compares it against the winning proposal
    /// stored in the round history. Requires a valid vote receipt to prevent fake vote verification.
    ///
    /// # Arguments
    /// * `vote` - The encrypted vote containing the proposal ID
    /// * `vote_encryption_pubkey` - The public key used to encrypt the vote
    /// * `vote_nonce` - The nonce used for vote encryption
    /// * `round_id` - The round ID to check against
    pub fn verify_winning_vote(
        ctx: Context<VerifyWinningVote>,
        computation_offset: u64,
        vote: [u8; 32],
        vote_encryption_pubkey: [u8; 32],
        vote_nonce: u128,
        round_id: u64,
    ) -> Result<()> {
        msg!("Verifying if vote was for winning proposal in round {}", round_id);
        
        // Log the seeds used to derive round_history account
        let round_id_bytes = round_id.to_le_bytes();

        // Manually derive the round_history PDA to verify
        let (_expected_round_history_pda, _round_history_bump) = Pubkey::find_program_address(
            &[
                b"voting_round_history",
                ctx.accounts.system_acc.key().as_ref(),
                &round_id_bytes,
            ],
            &crate::ID
        );

        // Manually derive the round_escrow PDA to verify
        let (expected_round_escrow_pda, _round_escrow_bump) = Pubkey::find_program_address(
            &[b"round_escrow", &round_id_bytes],
            &crate::ID
        );
        
        // Verify the round_escrow account
        require!(
            ctx.accounts.round_escrow.key() == expected_round_escrow_pda,
            ErrorCode::InvalidAuthority
        );
        
 

        // Verify that the round history exists for the given round
        require!(
            round_id < ctx.accounts.round_metadata.current_round,
            ErrorCode::InvalidRoundId
        );

        // SECURITY FIX: Verify the vote receipt exists and belongs to the caller
        let (expected_vote_receipt_pda, _) = Pubkey::find_program_address(
            &[b"vote_receipt", ctx.accounts.payer.key().as_ref(), &round_id_bytes],
            &crate::ID
        );
        
        // DEBUG: Log vote receipt PDA validation
      
        
        require!(
            ctx.accounts.vote_receipt.key() == expected_vote_receipt_pda,
            ErrorCode::InvalidVoteReceipt
        );
        
        // Verify the vote receipt contains the same encrypted proposal ID
        let vote_receipt_data = &ctx.accounts.vote_receipt.data.borrow();
        let account_data = vote_receipt_data; // No discriminator to skip
 
        
        // Extract encrypted_proposal_id from vote receipt
        // VoteReceiptAccount structure: bump(1) + voter(32) + encrypted_proposal_id(32) + timestamp(8) + vote_encryption_pubkey(32)
        let stored_encrypted_proposal_id: [u8; 32] = account_data[1 + 32..1 + 32 + 32].try_into().unwrap();
        
   
        
        // CRITICAL: Compare the vote parameter with the stored encrypted_proposal_id
        // This ensures the vote being verified is the same as what was actually cast
        require!(
            stored_encrypted_proposal_id == vote,
            ErrorCode::VoteMismatch
        );
        
        msg!("Vote receipt validation passed - vote matches stored encrypted proposal ID");

        // Manually deserialize the round history account data
        let round_history_data = &ctx.accounts.round_history.data.borrow();
        
        // Skip the discriminator (8 bytes) and deserialize the VotingRoundHistoryAccount
        let account_data = &round_history_data[8..];
        
        // Deserialize the winning_proposal_id (it's at offset 9 after discriminator: bump(1) + round_id(8) = 9)
        let winning_proposal_id = account_data[9];
        
        msg!("Winning proposal ID from round history: {}", winning_proposal_id);

        let args = vec![
            Argument::ArcisPubkey(vote_encryption_pubkey),
            Argument::PlaintextU128(vote_nonce),
            Argument::EncryptedU8(vote),
            Argument::PlaintextU8(winning_proposal_id),
        ];

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            None,
            vec![VerifyWinningVoteCallback::callback_ix(&[
                CallbackAccount {
                    pubkey: ctx.accounts.system_acc.key(),
                    is_writable: true,
                },
            ])],
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "verify_winning_vote")]
    pub fn verify_winning_vote_callback(
        ctx: Context<VerifyWinningVoteCallback>,
        output: ComputationOutputs<VerifyWinningVoteOutput>,
    ) -> Result<()> {
        let verification_result = match output {
            ComputationOutputs::Success(VerifyWinningVoteOutput { field_0 }) => field_0,
            _ => return Err(ErrorCode::AbortedComputation.into()),
        };

        // Log verification result
        if verification_result {
            msg!("✅ Vote was for winning proposal!");
        } else {
            msg!("❌ Vote was not for winning proposal");
        }

        // Emit event with the verification result
        emit!(VoteVerificationEvent {
            is_winning_vote: verification_result,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }



    #[arcium_callback(encrypted_ix = "vote_for_proposal")]
    pub fn vote_for_proposal_callback(
        ctx: Context<VoteForProposalCallback>,
        output: ComputationOutputs<VoteForProposalOutput>,
    ) -> Result<()> {
        let o = match output {
            ComputationOutputs::Success(VoteForProposalOutput { field_0 }) => field_0,
            _ => return Err(ErrorCode::AbortedComputation.into()),
        };

        ctx.accounts.system_acc.proposal_votes = o.ciphertexts;
        ctx.accounts.system_acc.nonce = o.nonce;

        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        emit!(VoteEvent {
            timestamp: current_timestamp,
        });

        Ok(())
    }

    pub fn init_reveal_winner_comp_def(ctx: Context<InitRevealWinnerCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, true, 0, None, None)?;
        Ok(())
    }

    /// Reveals the winning proposal with the most votes.
    ///
    /// Only the system authority can call this function to decrypt and reveal the vote tallies.
    /// The MPC computation finds the proposal with the maximum votes and returns its ID and vote count.
    /// Creates a voting round history account to permanently store the results.
    ///
    /// # Arguments
    /// * `system_id` - The system ID to reveal results for
    pub fn reveal_winning_proposal(
        ctx: Context<RevealWinningProposal>,
        computation_offset: u64,
        _system_id: u32,
    ) -> Result<()> {
        require!(
            ctx.accounts.payer.key() == ctx.accounts.system_acc.authority,
            ErrorCode::InvalidAuthority
        );

        msg!("Revealing winning proposal for round {}", ctx.accounts.round_metadata.current_round);

        let args = vec![
            Argument::PlaintextU128(ctx.accounts.system_acc.nonce),
            Argument::Account(
                ctx.accounts.system_acc.key(),
                // Offset calculation: 8 bytes (discriminator) + 1 byte (bump) + 32 bytes (authority) + 16 bytes (nonce) + 1 byte (next_proposal_id)
                8 + 1 + 32 + 16 + 1,
                32 * 10, // 10 encrypted proposal vote counters, 32 bytes each
            ),
        ];

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;


        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            None,
            vec![RevealWinningProposalCallback::callback_ix(&[
                CallbackAccount {
                    pubkey: ctx.accounts.system_acc.key(),
                    is_writable: true,
                },
                CallbackAccount {
                    pubkey: ctx.accounts.round_metadata.key(),
                    is_writable: true,
                },
            ])],
        )?;
        Ok(())
    }






    #[arcium_callback(encrypted_ix = "reveal_winning_proposal")]
    pub fn reveal_winning_proposal_callback(
        ctx: Context<RevealWinningProposalCallback>,
        output: ComputationOutputs<RevealWinningProposalOutput>,
    ) -> Result<()> {
        let result = match output {
            ComputationOutputs::Success(RevealWinningProposalOutput { field_0 }) => field_0,
            _ => return Err(ErrorCode::AbortedComputation.into()),
        };
        
        let winning_proposal_id = result.field_0;
        let winning_vote_count = result.field_1;

        // Debug: Log the results from the encrypted computation
        msg!("🔍 DEBUG: Encrypted computation results:");
        msg!("🔍 DEBUG: - Winning proposal ID: {}", winning_proposal_id);
        msg!("🔍 DEBUG: - Winning vote count: {}", winning_vote_count);

        // Store the winning proposal ID and vote count on-chain in the system account
        ctx.accounts.system_acc.winning_proposal_id = Some(winning_proposal_id);
        ctx.accounts.system_acc.winning_vote_count = Some(winning_vote_count);

        // Get current round before incrementing
        let current_round_id = ctx.accounts.round_metadata.current_round;

        // Note: Round history account will be created in a separate instruction

        // Increment the round counter for the next voting round
        ctx.accounts.round_metadata.current_round += 1;
        
        // Update the round start timestamp
        ctx.accounts.round_metadata.round_started = Clock::get()?.unix_timestamp;

        msg!(
            "Round {} completed - Winner: Proposal {} with {} votes", 
            current_round_id, 
            winning_proposal_id,
            winning_vote_count
        );

        emit!(WinningProposalEvent { 
            winning_proposal_id,
            winning_vote_count,
            round_id: current_round_id,
        });

        Ok(())
    }

    /// Creates a voting round history account after a winner has been revealed.
    /// This is called separately from the reveal callback to avoid MXE complexity.
    /// All data is read from the system state to prevent tampering.
    pub fn create_round_history(ctx: Context<CreateRoundHistory>) -> Result<()> {
        // Verify that the caller is the system authority
        require!(
            ctx.accounts.payer.key() == ctx.accounts.system_acc.authority,
            ErrorCode::InvalidAuthority
        );

        // Verify that a winner has been revealed
        require!(
            ctx.accounts.system_acc.winning_proposal_id.is_some(),
            ErrorCode::NoWinnerRevealed
        );

        // Get current timestamp
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        // Read all data from system state (not from parameters)
        let round_id = ctx.accounts.round_metadata.current_round - 1; // Previous round (since current_round was incremented)
        let winning_proposal_id = ctx.accounts.system_acc.winning_proposal_id.unwrap();
        let total_proposals = ctx.accounts.system_acc.next_proposal_id;

        // Initialize the round history account with verified data
        ctx.accounts.round_history.bump = ctx.bumps.round_history;
        ctx.accounts.round_history.round_id = round_id;
        ctx.accounts.round_history.winning_proposal_id = winning_proposal_id;
        ctx.accounts.round_history.revealed_at = current_timestamp;
        ctx.accounts.round_history.revealed_by = ctx.accounts.payer.key();
        ctx.accounts.round_history.total_proposals = total_proposals;

        // Reset system state for the next voting round
        // Note: We don't reset next_proposal_id to 0 because proposal accounts still exist
        // Instead, we keep the counter and let new proposals get new IDs
        ctx.accounts.system_acc.winning_proposal_id = None; // Clear winner
        ctx.accounts.system_acc.winning_vote_count = None; // Clear vote count
        ctx.accounts.system_acc.proposal_votes = [[0; 32]; 10]; // Reset encrypted vote counters
        ctx.accounts.system_acc.nonce = ctx.accounts.system_acc.nonce; // Increment nonce for new round
        
        // Reset the round proposal counter for the next round
        ctx.accounts.round_metadata.proposals_in_current_round = 0;
        // Reset the voter counter for the next round
        ctx.accounts.round_metadata.total_voters = 0;

        msg!(
            "Created round history for round {} - Winner: Proposal {}",
            round_id,
            winning_proposal_id
        );
        msg!(
            "System state reset for next round - Proposals: 0, Winner: None, Nonce: {}",
            ctx.accounts.system_acc.nonce
        );

        Ok(())
    }


}

#[queue_computation_accounts("init_proposal_votes", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct InitProposalSystem<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, SignerAccount>,
    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!()
    )]
    /// CHECK: mempool_account, checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!()
    )]
    /// CHECK: executing_pool, checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_PROPOSAL_VOTES)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(
        mut,
        address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS,
    )]
    pub pool_account: Account<'info, FeePool>,
    #[account(
        address = ARCIUM_CLOCK_ACCOUNT_ADDRESS,
    )]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        init,
        payer = payer,
        space = 8 + ProposalSystemAccount::INIT_SPACE,
        seeds = [b"proposal_system"],
        bump,
    )]
    pub system_acc: Account<'info, ProposalSystemAccount>,
    #[account(
        init,
        payer = payer,
        space = 8 + RoundMetadataAccount::INIT_SPACE,
        seeds = [b"round_metadata"],
        bump,
    )]
    pub round_metadata: Account<'info, RoundMetadataAccount>,
}

#[callback_accounts("init_proposal_votes")]
#[derive(Accounts)]
pub struct InitProposalVotesCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_PROPOSAL_VOTES)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    /// CHECK: system_acc, checked by the callback account key passed in queue_computation
    #[account(mut)]
    pub system_acc: Account<'info, ProposalSystemAccount>,
    
}

#[init_computation_definition_accounts("init_proposal_votes", payer)]
#[derive(Accounts)]
pub struct InitProposalVotesCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    /// Can't check it here as it's not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitProposal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"proposal_system"],
        bump = system_acc.bump
    )]
    pub system_acc: Account<'info, ProposalSystemAccount>,
    #[account(
        mut,
        seeds = [b"round_metadata"],
        bump = round_metadata.bump
    )]
    pub round_metadata: Account<'info, RoundMetadataAccount>,
    #[account(
        init,
        payer = payer,
        space = 8 + ProposalAccount::INIT_SPACE,
        seeds = [
            b"proposal", 
            system_acc.key().as_ref(), 
            round_metadata.current_round.to_le_bytes().as_ref(),
            round_metadata.proposals_in_current_round.to_le_bytes().as_ref()
        ],
        bump,
    )]
    pub proposal_acc: Account<'info, ProposalAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + RoundEscrowAccount::INIT_SPACE,
        seeds = [b"round_escrow", round_metadata.current_round.to_le_bytes().as_ref()],
        bump,
    )]
    pub round_escrow: Account<'info, RoundEscrowAccount>,
    pub system_program: Program<'info, System>,
}

#[queue_computation_accounts("vote_for_proposal", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, proposal_id: u8)]
pub struct VoteForProposal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, SignerAccount>,
    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!()
    )]
    /// CHECK: mempool_account, checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!()
    )]
    /// CHECK: executing_pool, checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_VOTE_FOR_PROPOSAL)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(
        mut,
        address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS,
    )]
    pub pool_account: Account<'info, FeePool>,
    #[account(
        address = ARCIUM_CLOCK_ACCOUNT_ADDRESS,
    )]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        mut,
        seeds = [b"proposal_system"],
        bump = system_acc.bump
    )]
    pub system_acc: Account<'info, ProposalSystemAccount>,
    /// CHECK: Manually verified vote_receipt PDA
    #[account(mut)]
    pub vote_receipt: UncheckedAccount<'info>,
    /// CHECK: Manually verified round_metadata PDA
    #[account(
        mut,
        seeds = [b"round_metadata"],
        bump = round_metadata.bump
    )]
    pub round_metadata: Account<'info, RoundMetadataAccount>,
}

#[callback_accounts("vote_for_proposal")]
#[derive(Accounts)]
pub struct VoteForProposalCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_VOTE_FOR_PROPOSAL)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub system_acc: Account<'info, ProposalSystemAccount>,
}

#[init_computation_definition_accounts("vote_for_proposal", payer)]
#[derive(Accounts)]
pub struct InitVoteForProposalCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    /// Can't check it here as it's not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[queue_computation_accounts("reveal_winning_proposal", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, _system_id: u32)]
pub struct RevealWinningProposal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, SignerAccount>,
    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!()
    )]
    /// CHECK: mempool_account, checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!()
    )]
    /// CHECK: executing_pool, checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_WINNER)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(
        mut,
        address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS,
    )]
    pub pool_account: Account<'info, FeePool>,
    #[account(
        address = ARCIUM_CLOCK_ACCOUNT_ADDRESS,
    )]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        seeds = [b"proposal_system"],
        bump = system_acc.bump
    )]
    pub system_acc: Account<'info, ProposalSystemAccount>,
    #[account(
        mut,
        seeds = [b"round_metadata"],
        bump = round_metadata.bump
    )]
    pub round_metadata: Account<'info, RoundMetadataAccount>,
}

#[callback_accounts("reveal_winning_proposal")]
#[derive(Accounts)]
pub struct RevealWinningProposalCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_WINNER)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub system_acc: Account<'info, ProposalSystemAccount>,
    #[account(mut)]
    pub round_metadata: Account<'info, RoundMetadataAccount>,
}

#[derive(Accounts)]
pub struct CreateRoundHistory<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"proposal_system"],
        bump = system_acc.bump
    )]
    pub system_acc: Account<'info, ProposalSystemAccount>,
    #[account(
        mut,
        seeds = [b"round_metadata"],
        bump = round_metadata.bump
    )]
    pub round_metadata: Account<'info, RoundMetadataAccount>,
    #[account(
        init,
        payer = payer,
        space = 8 + VotingRoundHistoryAccount::INIT_SPACE,
        seeds = [b"voting_round_history", system_acc.key().as_ref(), (round_metadata.current_round - 1).to_le_bytes().as_ref()],
        bump,
    )]
    pub round_history: Account<'info, VotingRoundHistoryAccount>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("reveal_winning_proposal", payer)]
#[derive(Accounts)]
pub struct InitRevealWinnerCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    /// Can't check it here as it's not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

/// Represents the proposal voting system with encrypted vote tallies for all proposals.
/// NOTE: This account is passed to MXE - DO NOT modify its structure!
#[account]
#[derive(InitSpace)]
pub struct ProposalSystemAccount {
    /// PDA bump seed
    pub bump: u8,
    /// Public key of the system authority (only they can reveal results)
    pub authority: Pubkey,
    /// Cryptographic nonce for the encrypted vote counters
    pub nonce: u128,
    /// Next proposal ID to be assigned
    pub next_proposal_id: u8,
    /// Encrypted vote counters for all proposals (up to 10) as 32-byte ciphertexts
    pub proposal_votes: [[u8; 32]; 10],
    /// Winning proposal ID after reveal (None = not revealed yet)
    pub winning_proposal_id: Option<u8>,
    /// Number of votes the winning proposal received (None = not revealed yet)
    pub winning_vote_count: Option<u64>,
    /// Fixed fee for proposal submission (in lamports)
    pub proposal_submission_fee: u64,
}

/// Represents the escrow account for a specific voting round.
#[account]
#[derive(InitSpace)]
pub struct RoundEscrowAccount {
    /// PDA bump seed
    pub bump: u8,
    /// Round ID this escrow belongs to
    pub round_id: u64,
    /// Total fees collected in this round
    pub total_collected: u64,
    /// Total distributed from this round
    pub total_distributed: u64,
    /// Current available balance
    pub current_balance: u64,
    /// Status of this round's escrow
    pub round_status: RoundStatus,
    /// Timestamp when this round escrow was created
    pub created_at: i64,
}

/// Status of a round's escrow account.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum RoundStatus {
    /// Round is ongoing, collecting fees
    Active,
    /// Round ended, escrow available for distribution
    Completed,
    /// Escrow fully distributed or closed
    Closed,
}

impl anchor_lang::Space for RoundStatus {
    const INIT_SPACE: usize = 1; // 1 byte for the enum discriminant
}

/// Represents a single proposal submitted to the system.
#[account]
#[derive(InitSpace)]
pub struct ProposalAccount {
    /// PDA bump seed
    pub bump: u8,
    /// Unique identifier for this proposal within the round
    pub id: u8,
    /// Round ID this proposal belongs to
    pub round_id: u64,
    /// Public key of the proposal submitter
    pub submitter: Pubkey,
    /// Number of votes this proposal has received (public count)
    pub vote_count: u64,
    /// Short title of the proposal (max 50 characters)
    #[max_len(50)]
    pub title: String,
    /// Detailed description of the proposal (max 200 characters)
    #[max_len(200)]
    pub description: String,
    /// URL associated with the proposal (max 200 characters)
    #[max_len(200)]
    pub url: String,
}

/// Represents a vote receipt for a voter.
/// This account stores the details of a vote cast by a specific voter.
/// The proposal ID is encrypted for ballot secrecy - only the voter (who has the nonce) or MXE can decrypt it.
/// Note: PDA is derived from voter only - each voter can only vote ONCE total (not once per proposal).
/// The plaintext proposal_id is NOT stored to maintain complete ballot secrecy.
#[account]
#[derive(InitSpace)]
pub struct VoteReceiptAccount {
    /// PDA bump seed
    pub bump: u8,
    /// Public key of the voter
    pub voter: Pubkey,
    /// Encrypted proposal ID - only decryptable by voter (with their nonce) or MXE
    pub encrypted_proposal_id: [u8; 32],
    /// Timestamp when the vote was cast
    pub timestamp: i64,
    /// Voter's encryption public key used for the vote
    pub vote_encryption_pubkey: [u8; 32],
}

/// Represents the history of a completed voting round.
/// This account is created after a winner is revealed and stores the results permanently.
/// Note: Vote counts are NOT stored here - they can be calculated on the frontend from the state.
#[account]
#[derive(InitSpace)]
pub struct VotingRoundHistoryAccount {
    /// PDA bump seed
    pub bump: u8,
    /// Round identifier (incremented for each voting round)
    pub round_id: u64,
    /// ID of the winning proposal
    pub winning_proposal_id: u8,
    /// Timestamp when the winner was revealed
    pub revealed_at: i64,
    /// Authority who revealed the results
    pub revealed_by: Pubkey,
    /// Total number of proposals in this round
    pub total_proposals: u8,
}

/// Metadata account for tracking round information.
/// This is separate from ProposalSystemAccount to avoid modifying accounts passed to MXE.
#[account]
#[derive(InitSpace)]
pub struct RoundMetadataAccount {
    /// PDA bump seed
    pub bump: u8,
    /// Current voting round number (incremented each time a winner is revealed)
    pub current_round: u64,
    /// Number of proposals submitted in the current round
    pub proposals_in_current_round: u8,
    /// Total number of voters in the current round
    pub total_voters: u64,
    /// Unix timestamp when the current round started
    pub round_started: i64,
}

#[queue_computation_accounts("decrypt_vote", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct DecryptVote<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, SignerAccount>,
    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!()
    )]
    /// CHECK: mempool_account, checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!()
    )]
    /// CHECK: executing_pool, checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_DECRYPT_VOTE)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(
        mut,
        address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS,
    )]
    pub pool_account: Account<'info, FeePool>,
    #[account(
        address = ARCIUM_CLOCK_ACCOUNT_ADDRESS,
    )]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        seeds = [b"proposal_system"],
        bump = system_acc.bump
    )]
    pub system_acc: Account<'info, ProposalSystemAccount>,
}

#[callback_accounts("decrypt_vote")]
#[derive(Accounts)]
pub struct DecryptVoteCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_DECRYPT_VOTE)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub system_acc: Account<'info, ProposalSystemAccount>,
}

#[init_computation_definition_accounts("decrypt_vote", payer)]
#[derive(Accounts)]
pub struct InitDecryptVoteCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    /// Can't check it here as it's not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[queue_computation_accounts("verify_winning_vote", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, round_id: u64)]
pub struct VerifyWinningVote<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, SignerAccount>,
    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!()
    )]
    /// CHECK: mempool_account, checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!()
    )]
    /// CHECK: executing_pool, checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_VERIFY_WINNING_VOTE)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(
        mut,
        address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS,
    )]
    pub pool_account: Account<'info, FeePool>,
    #[account(
        address = ARCIUM_CLOCK_ACCOUNT_ADDRESS,
    )]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        seeds = [b"proposal_system"],
        bump = system_acc.bump
    )]
    pub system_acc: Account<'info, ProposalSystemAccount>,
    #[account(
        seeds = [b"round_metadata"],
        bump = round_metadata.bump
    )]
    pub round_metadata: Account<'info, RoundMetadataAccount>,
    /// CHECK: round_history, manually verified in the function
    pub round_history: UncheckedAccount<'info>,
    /// CHECK: vote_receipt, manually verified in the function
    pub vote_receipt: UncheckedAccount<'info>,
    /// CHECK: round_escrow, manually verified in the function
    #[account(mut)]
    pub round_escrow: UncheckedAccount<'info>,
}

#[callback_accounts("verify_winning_vote")]
#[derive(Accounts)]
pub struct VerifyWinningVoteCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_VERIFY_WINNING_VOTE)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub system_acc: Account<'info, ProposalSystemAccount>,
}

#[init_computation_definition_accounts("verify_winning_vote", payer)]
#[derive(Accounts)]
pub struct InitVerifyWinningVoteCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    /// Can't check it here as it's not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}





#[error_code]
pub enum ErrorCode {
    #[msg("Invalid authority")]
    InvalidAuthority,
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
    #[msg("Maximum number of proposals reached")]
    MaxProposalsReached,
    #[msg("Invalid proposal ID")]
    InvalidProposalId,
    #[msg("Voter has already voted - only one vote per voter allowed")]
    AlreadyVoted,
    #[msg("Account is already initialized")]
    AccountAlreadyInitialized,
    #[msg("Invalid round ID - can only vote in current active round")]
    InvalidRoundId,
    #[msg("No winner has been revealed yet")]
    NoWinnerRevealed,
    #[msg("Invalid vote receipt - must provide actual vote receipt account")]
    InvalidVoteReceipt,
    #[msg("Vote does not match stored vote in receipt")]
    VoteMismatch,
    #[msg("Insufficient funds for proposal submission fee")]
    InsufficientFunds,
    #[msg("Round escrow is not in active status")]
    RoundEscrowNotActive,
    #[msg("Invalid escrow round ID")]
    InvalidEscrowRoundId,
}

#[event]
pub struct VoteEvent {
    pub timestamp: i64,
}

#[event]
pub struct ProposalSubmittedEvent {
    pub proposal_id: u8,
    pub round_id: u64,
    pub submitter: Pubkey,
}

#[event]
pub struct WinningProposalEvent {
    pub winning_proposal_id: u8,
    pub winning_vote_count: u64,
    pub round_id: u64,
}

#[event]
pub struct VoteReceiptCreatedEvent {
    pub voter: Pubkey,
    pub proposal_id: u8,
    pub encrypted_proposal_id: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct VoteDecryptedEvent {
    pub decrypted_proposal_id: u8,
    pub timestamp: i64,
}

#[event]
pub struct VoteVerificationEvent {
    pub is_winning_vote: bool,
    pub timestamp: i64,
}



