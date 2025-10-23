use arcis_imports::*;

#[encrypted]
mod circuits {
    use arcis_imports::*;

    /// Tracks the encrypted vote counts for all proposals.
    /// Each proposal has a unique ID and vote count.
    pub struct ProposalVotes {
        proposal_votes: [u64; 10], // Support up to 10 proposals
    }

    /// Represents a single encrypted vote for a specific proposal.
    pub struct UserVote {
        proposal_id: u8, // Which proposal is being voted for (0-9)
    }

    /// Initializes encrypted vote counters for all proposals.
    ///
    /// Creates a ProposalVotes structure with zero counts for all proposals.
    /// The counters remain encrypted and can only be updated through MPC operations.
    #[instruction]
    pub fn init_proposal_votes(mxe: Mxe) -> Enc<Mxe, ProposalVotes> {
        let proposal_votes = ProposalVotes { 
            proposal_votes: [0; 10] 
        };
        mxe.from_arcis(proposal_votes)
    }

    /// Processes an encrypted vote for a specific proposal.
    ///
    /// Takes an individual vote and adds it to the appropriate proposal's counter
    /// without revealing which proposal was voted for. The updated vote statistics 
    /// remain encrypted and can only be revealed by the system authority.
    ///
    /// # Arguments
    /// * `vote_ctxt` - The encrypted vote containing proposal ID
    /// * `proposal_votes_ctxt` - Current encrypted vote tallies for all proposals
    ///
    /// # Returns
    /// Updated encrypted vote statistics with the new vote included
    #[instruction]
    pub fn vote_for_proposal(
        vote_ctxt: Enc<Shared, UserVote>,
        proposal_votes_ctxt: Enc<Mxe, ProposalVotes>,
    ) -> Enc<Mxe, ProposalVotes> {
        let user_vote = vote_ctxt.to_arcis();
        let mut proposal_votes = proposal_votes_ctxt.to_arcis();

        // Increment the counter for the specific proposal
        let proposal_id = user_vote.proposal_id as usize;
        if proposal_id < 10 {
            proposal_votes.proposal_votes[proposal_id] += 1;
        }

        proposal_votes_ctxt.owner.from_arcis(proposal_votes)
    }

    /// Reveals the winning proposal by finding the one with maximum votes.
    ///
    /// Decrypts the vote counters and determines which proposal has the most votes.
    /// Returns both the winning proposal ID and its vote count.
    ///
    /// # Arguments
    /// * `proposal_votes_ctxt` - Encrypted vote tallies for all proposals
    ///
    /// # Returns
    /// A tuple containing (winning_proposal_id, vote_count)
    #[instruction]
    pub fn reveal_winning_proposal(proposal_votes_ctxt: Enc<Mxe, ProposalVotes>) -> (u8, u64) {
        let proposal_votes = proposal_votes_ctxt.to_arcis();
        
        let mut max_votes = 0u64;
        let mut winning_proposal = 0u8;
        
        for (i, &votes) in proposal_votes.proposal_votes.iter().enumerate() {
            if votes > max_votes {
                max_votes = votes;
                winning_proposal = i as u8;
            }
        }
        
        (winning_proposal, max_votes).reveal()
    }

    /// Decrypts an encrypted vote and returns the plaintext proposal ID.
    ///
    /// This function takes an encrypted vote and decrypts it to reveal which proposal
    /// the voter chose. This is useful for verification purposes or when the system
    /// authority needs to audit individual votes.
    ///
    /// # Arguments
    /// * `vote_ctxt` - The encrypted vote containing proposal ID
    ///
    /// # Returns
    /// The decrypted proposal ID as a plaintext value
    #[instruction]
    pub fn decrypt_vote(vote_ctxt: Enc<Shared, UserVote>) -> u8 {
        let user_vote = vote_ctxt.to_arcis();
        user_vote.proposal_id.reveal()
    }

    /// Decrypts an encrypted vote and verifies if it was for the winning proposal in a given round.
    ///
    /// This function decrypts a vote and compares it against the winning proposal ID
    /// for a specific round. It returns true if the vote was cast for the winning proposal.
    ///
    /// # Arguments
    /// * `vote_ctxt` - The encrypted vote containing proposal ID
    /// * `winning_proposal_id` - The winning proposal ID for the round
    ///
    /// # Returns
    /// True if the vote was for the winning proposal, false otherwise
    #[instruction]
    pub fn verify_winning_vote(vote_ctxt: Enc<Shared, UserVote>, winning_proposal_id: u8) -> bool {
        let user_vote = vote_ctxt.to_arcis();
        let decrypted_proposal_id = user_vote.proposal_id.reveal();
        
        // Compare the decrypted proposal ID with the winning proposal ID
        (decrypted_proposal_id == winning_proposal_id).reveal()
    }

}