# Verify Winning Vote Implementation

## Overview
This document explains the implementation of the `verify_winning_vote` function, which decrypts a vote and verifies if it was cast for the winning proposal in a given round.

## Implementation Summary

### 1. **Function Purpose**
The `verify_winning_vote` function allows verification of whether a specific encrypted vote was cast for the winning proposal in a particular voting round, without revealing other votes or compromising ballot secrecy.

### 2. **Key Components**

#### **Solana Program Function** (`programs/helo_3/src/lib.rs`)
```rust
pub fn verify_winning_vote(
    ctx: Context<VerifyWinningVote>,
    computation_offset: u64,
    vote: [u8; 32],                    // Encrypted vote data
    vote_encryption_pubkey: [u8; 32], // Voter's public key
    vote_nonce: u128,                 // Nonce for vote encryption
    round_id: u64,                    // Round to check against
) -> Result<()>
```

**Process:**
1. Validates that the round exists (`round_id < current_round`)
2. Retrieves the winning proposal ID from the round history account
3. Queues MXE computation with:
   - Voter's encryption public key
   - Vote encryption nonce
   - Encrypted vote data
   - Winning proposal ID (plaintext)
4. MXE decrypts the vote and compares with winning proposal ID

#### **Encrypted Circuit** (`encrypted-ixs/src/lib.rs`)
```rust
pub fn verify_winning_vote(
    vote_ctxt: Enc<Shared, UserVote>, 
    winning_proposal_id: u8
) -> bool {
    let user_vote = vote_ctxt.to_arcis();
    let decrypted_proposal_id = user_vote.proposal_id.reveal();
    
    // Compare the decrypted proposal ID with the winning proposal ID
    (decrypted_proposal_id == winning_proposal_id).reveal()
}
```

**Process:**
1. Decrypts the vote to get the proposal ID
2. Compares it with the provided winning proposal ID
3. Returns boolean result (true if match, false otherwise)

#### **Callback Function**
```rust
pub fn verify_winning_vote_callback(
    ctx: Context<VerifyWinningVoteCallback>,
    output: ComputationOutputs<VerifyWinningVoteOutput>,
) -> Result<()> {
    let verification_result = match output {
        ComputationOutputs::Success(VerifyWinningVoteOutput { field_0 }) => field_0,
        _ => return Err(ErrorCode::AbortedComputation.into()),
    };

    // Emit event with the verification result
    emit!(VoteVerificationEvent {
        is_winning_vote: verification_result,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
```

### 3. **Account Structure**

The `VerifyWinningVote` account structure requires:
- Standard MXE computation accounts (payer, sign_pda, mxe_account, etc.)
- `system_acc`: ProposalSystemAccount
- `round_metadata`: RoundMetadataAccount
- `round_history`: VotingRoundHistoryAccount (for the specific round)

### 4. **Usage Example**

```typescript
// Verify if a vote was for the winning proposal in round 0
const verifyComputationOffset = new anchor.BN(randomBytes(8), "hex");

const verifySig = await program.methods
  .verifyWinningVote(
    verifyComputationOffset,
    Array.from(encryptedVote),      // Encrypted vote data
    Array.from(voterPublicKey),      // Voter's encryption public key
    new anchor.BN(voteNonce),        // Vote encryption nonce
    new BN(0)                        // round_id
  )
  .accounts({
    payer: owner.publicKey,
    systemAcc: systemAccPDA,
    computationAccount: getComputationAccAddress(...),
    clusterAccount: arciumEnv.arciumClusterPubkey,
    mxeAccount: getMXEAccAddress(...),
    mempoolAccount: getMempoolAccAddress(...),
    executingPool: getExecutingPoolAccAddress(...),
    compDefAccount: getCompDefAccAddress(...),
    roundMetadata: roundMetadataPDA,
    roundHistory: roundHistoryPDA,   // For specific round
  })
  .rpc();

// Wait for computation to finalize
await awaitComputationFinalization(...);

// Listen for verification event
const verifyEvent = await awaitEvent("voteVerificationEvent");
console.log(`Is winning vote: ${verifyEvent.isWinningVote}`);
```

### 5. **Design Decisions**

#### **Why Pass Winning Proposal ID as Plaintext?**
The winning proposal ID is passed as plaintext (not encrypted) because:
1. It's already public information (stored in round history)
2. The MXE circuit needs to compare it with the decrypted vote
3. No privacy concerns since it's already revealed

#### **Why Require Round History Account?**
The round history account ensures:
1. Verification can only happen after a round is completed
2. The winning proposal ID is sourced from immutable on-chain data
3. No tampering with verification results

#### **Minimal Changes from decrypt_vote**
The implementation follows the same pattern as `decrypt_vote`:
1. Same encryption scheme
2. Same MXE computation flow
3. Similar account structure
4. Only adds comparison logic

### 6. **Security Properties**

- **Ballot Secrecy**: Individual votes remain encrypted during processing
- **Verifiability**: Can verify if a vote was for the winning proposal without revealing other votes
- **Round Isolation**: Each round's results are checked independently
- **Immutability**: Uses on-chain round history for verification
- **Non-tampering**: Winning proposal ID sourced from immutable round history

### 7. **Testing**

The test (`tests/helo_3.ts`) covers:
1. System initialization
2. Proposal submission
3. Voting for a specific proposal
4. Revealing the winning proposal
5. Creating round history
6. Verifying that the vote was for the winning proposal

### 8. **Event Structure**

```rust
#[event]
pub struct VoteVerificationEvent {
    pub is_winning_vote: bool,
    pub timestamp: i64,
}
```

This event is emitted after verification completes, allowing clients to track verification results.

## Differences from decrypt_vote

| Feature | decrypt_vote | verify_winning_vote |
|---------|-------------|---------------------|
| Purpose | Decrypt vote to reveal proposal ID | Verify if vote was for winning proposal |
| Output | Proposal ID (u8) | Boolean (true/false) |
| Accounts | System account only | System + Round metadata + Round history |
| Round-aware | No | Yes (requires round_id) |
| Comparison | None | Compares with winning proposal |

## Use Cases

1. **Voter Verification**: Voters can verify their vote was for the winning proposal without revealing their identity
2. **Auditing**: System authorities can audit specific votes for compliance
3. **Dispute Resolution**: Can verify vote validity in case of disputes
4. **Statistical Analysis**: Can analyze voting patterns without compromising privacy

## Future Enhancements

Potential improvements:
1. Batch verification of multiple votes
2. Support for verifying votes against any proposal (not just winner)
3. Time-based verification restrictions
4. Verification receipts with cryptographic proofs

