use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

const COMP_DEF_OFFSET_INIT_PROPOSAL_VOTES: u32 = comp_def_offset("init_proposal_votes");
const COMP_DEF_OFFSET_VOTE_FOR_PROPOSAL: u32 = comp_def_offset("vote_for_proposal");
const COMP_DEF_OFFSET_REVEAL_WINNER: u32 = comp_def_offset("reveal_winning_proposal");

declare_id!("AtAC7Xh946P8LNKdcKFWyrZnQjeCid3M8fvDu1zS5UHk");

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
    ) -> Result<()> {
        require!(
            proposal_id < ctx.accounts.system_acc.next_proposal_id,
            ErrorCode::InvalidProposalId
        );

        // Get current timestamp for the vote receipt
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        // Initialize the vote receipt for this voter
        ctx.accounts.vote_receipt.bump = ctx.bumps.vote_receipt;
        ctx.accounts.vote_receipt.voter = ctx.accounts.payer.key();
        ctx.accounts.vote_receipt.encrypted_proposal_id = encrypted_proposal_id;
        ctx.accounts.vote_receipt.vote_encryption_pubkey = vote_encryption_pubkey;
        ctx.accounts.vote_receipt.timestamp = current_timestamp;

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
    /// The MPC computation finds the proposal with the maximum votes and returns its ID.
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

        msg!("Revealing winning proposal");

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
            vec![RevealWinningProposalCallback::callback_ix(&[CallbackAccount {
                pubkey: ctx.accounts.system_acc.key(),
                is_writable: true,
            }])],
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "reveal_winning_proposal")]
    pub fn reveal_winning_proposal_callback(
        ctx: Context<RevealWinningProposalCallback>,
        output: ComputationOutputs<RevealWinningProposalOutput>,
    ) -> Result<()> {
        let o = match output {
            ComputationOutputs::Success(RevealWinningProposalOutput { field_0 }) => field_0,
            _ => return Err(ErrorCode::AbortedComputation.into()),
        };

        // Store the winning proposal ID on-chain
        ctx.accounts.system_acc.winning_proposal_id = Some(o);

        emit!(WinningProposalEvent { winning_proposal_id: o });

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
    #[account(
        init,
        payer = payer,
        space = 8 + VoteReceiptAccount::INIT_SPACE,
        seeds = [b"vote_receipt", payer.key().as_ref()],
        bump,
    )]
    pub vote_receipt: Account<'info, VoteReceiptAccount>,
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
}

#[event]
pub struct VoteReceiptCreatedEvent {
    pub voter: Pubkey,
    pub proposal_id: u8,
    pub encrypted_proposal_id: [u8; 32],
    pub timestamp: i64,
}