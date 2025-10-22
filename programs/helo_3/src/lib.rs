use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;
use anchor_lang::solana_program::rent::Rent;

const COMP_DEF_OFFSET_INIT_PROPOSAL_VOTES: u32 = comp_def_offset("init_proposal_votes");
const COMP_DEF_OFFSET_VOTE_FOR_PROPOSAL: u32 = comp_def_offset("vote_for_proposal");
const COMP_DEF_OFFSET_REVEAL_WINNER: u32 = comp_def_offset("reveal_winning_proposal");

declare_id!("G5QxLUHK6fMzRWWevU5GMCEZCfnUEzMZZuqUCpjVf8EX");

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

        // Initialize the round metadata account (separate from system_acc to avoid MXE issues)
        ctx.accounts.round_metadata.bump = ctx.bumps.round_metadata;
        ctx.accounts.round_metadata.current_round = 0; // Start at round 0

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
    /// This allows anyone to submit a proposal with a title and description.
    /// The proposal gets assigned a unique ID and can be voted on by users.
    ///
    /// # Arguments
    /// * `title` - Short title of the proposal (max 50 chars)
    /// * `description` - Detailed description of the proposal (max 200 chars)
    pub fn submit_proposal(
        ctx: Context<SubmitProposal>,
        title: String,
        description: String,
    ) -> Result<()> {
        require!(
            ctx.accounts.system_acc.next_proposal_id < 10,
            ErrorCode::MaxProposalsReached
        );

        let proposal_id = ctx.accounts.system_acc.next_proposal_id;
        
        // Initialize the proposal account
        ctx.accounts.proposal_acc.bump = ctx.bumps.proposal_acc;
        ctx.accounts.proposal_acc.id = proposal_id;
        ctx.accounts.proposal_acc.title = title;
        ctx.accounts.proposal_acc.description = description;
        ctx.accounts.proposal_acc.submitter = ctx.accounts.payer.key();
        ctx.accounts.proposal_acc.vote_count = 0;

        // Increment the next proposal ID
        ctx.accounts.system_acc.next_proposal_id += 1;

        emit!(ProposalSubmittedEvent {
            proposal_id,
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
        
        // Manually verify and deserialize round_metadata
        let (expected_round_pda, _bump) = Pubkey::find_program_address(&[b"round_metadata"], &crate::ID);
        require!(
            ctx.accounts.round_metadata.key() == expected_round_pda,
            ErrorCode::InvalidAuthority
        );
        
        // Deserialize the round_metadata account
        let round_metadata_data = ctx.accounts.round_metadata.try_borrow_data()?;
        let round_metadata: RoundMetadataAccount = AnchorDeserialize::deserialize(&mut &round_metadata_data[8..])?;
        
        // Validate that the round_id matches the current active round
        require!(
            round_id == round_metadata.current_round,
            ErrorCode::InvalidRoundId
        );
        
        require!(
            proposal_id < ctx.accounts.system_acc.next_proposal_id,
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

        let args = vec![
            Argument::ArcisPubkey(vote_encryption_pubkey),
            Argument::PlaintextU128(vote_nonce),
            Argument::EncryptedU8(vote),
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
        let winning_proposal_id = match output {
            ComputationOutputs::Success(RevealWinningProposalOutput { field_0 }) => field_0,
            _ => return Err(ErrorCode::AbortedComputation.into()),
        };

        // Store the winning proposal ID on-chain in the system account
        ctx.accounts.system_acc.winning_proposal_id = Some(winning_proposal_id);

        // Get current round before incrementing
        let current_round_id = ctx.accounts.round_metadata.current_round;

        // Note: Round history account will be created in a separate instruction

        // Increment the round counter for the next voting round
        ctx.accounts.round_metadata.current_round += 1;

        msg!(
            "Round {} completed - Winner: Proposal {}", 
            current_round_id, 
            winning_proposal_id
        );

        emit!(WinningProposalEvent { 
            winning_proposal_id,
            round_id: current_round_id,
        });

        Ok(())
    }

    /// Creates a voting round history account after a winner has been revealed.
    /// This is called separately from the reveal callback to avoid MXE complexity.
    pub fn create_round_history(
        ctx: Context<CreateRoundHistory>,
        round_id: u64,
        winning_proposal_id: u8,
        total_proposals: u8,
    ) -> Result<()> {
        // Get current timestamp
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        // Initialize the round history account
        ctx.accounts.round_history.bump = ctx.bumps.round_history;
        ctx.accounts.round_history.round_id = round_id;
        ctx.accounts.round_history.winning_proposal_id = winning_proposal_id;
        ctx.accounts.round_history.revealed_at = current_timestamp;
        ctx.accounts.round_history.revealed_by = ctx.accounts.payer.key();
        ctx.accounts.round_history.total_proposals = total_proposals;

        msg!(
            "Created round history for round {} - Winner: Proposal {}",
            round_id,
            winning_proposal_id
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
        init,
        payer = payer,
        space = 8 + ProposalAccount::INIT_SPACE,
        seeds = [b"proposal", system_acc.key().as_ref(), system_acc.next_proposal_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub proposal_acc: Account<'info, ProposalAccount>,
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
    pub round_metadata: UncheckedAccount<'info>,
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
#[instruction(round_id: u64)]
pub struct CreateRoundHistory<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [b"proposal_system"],
        bump = system_acc.bump
    )]
    pub system_acc: Account<'info, ProposalSystemAccount>,
    #[account(
        init,
        payer = payer,
        space = 8 + VotingRoundHistoryAccount::INIT_SPACE,
        seeds = [b"voting_round_history", system_acc.key().as_ref(), round_id.to_le_bytes().as_ref()],
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
}

/// Represents a single proposal submitted to the system.
#[account]
#[derive(InitSpace)]
pub struct ProposalAccount {
    /// PDA bump seed
    pub bump: u8,
    /// Unique identifier for this proposal
    pub id: u8,
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
}

#[event]
pub struct VoteEvent {
    pub timestamp: i64,
}

#[event]
pub struct ProposalSubmittedEvent {
    pub proposal_id: u8,
    pub submitter: Pubkey,
}

#[event]
pub struct WinningProposalEvent {
    pub winning_proposal_id: u8,
    pub round_id: u64,
}

#[event]
pub struct VoteReceiptCreatedEvent {
    pub voter: Pubkey,
    pub proposal_id: u8,
    pub encrypted_proposal_id: [u8; 32],
    pub timestamp: i64,
}