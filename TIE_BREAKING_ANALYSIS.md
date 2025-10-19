# Tie-Breaking Behavior Analysis

## Current Implementation

### Code Logic (lines 70-84 in `encrypted-ixs/src/lib.rs`)
```rust
pub fn reveal_winning_proposal(proposal_votes_ctxt: Enc<Mxe, ProposalVotes>) -> u8 {
    let proposal_votes = proposal_votes_ctxt.to_arcis();
    
    let mut max_votes = 0u64;
    let mut winning_proposal = 0u8;  // Default: Proposal 0
    
    for (i, &votes) in proposal_votes.proposal_votes.iter().enumerate() {
        if votes > max_votes {  // STRICTLY GREATER (not >=)
            max_votes = votes;
            winning_proposal = i as u8;
        }
    }
    
    winning_proposal.reveal()
}
```

## Tie-Breaking Rule

**In case of equal votes, the proposal with the LOWEST ID wins.**

### Why?
1. Loop iterates from proposal 0 → 9
2. Uses `>` (strictly greater), not `>=`  
3. When votes are equal, `winning_proposal` is NOT updated
4. First proposal to reach max_votes stays as winner

## Example Scenarios

### Scenario 1: All Proposals Have 0 Votes
```
Proposal 0: 0 votes
Proposal 1: 0 votes
Proposal 2: 0 votes
...
Proposal 9: 0 votes

Winner: Proposal 0 (default initialization)
```

### Scenario 2: Two Proposals Tied
```
Proposal 0: 2 votes
Proposal 1: 5 votes  ← max_votes = 5, winning_proposal = 1
Proposal 2: 1 vote
Proposal 3: 5 votes  ← votes == max_votes (not >), no update
Proposal 4: 3 votes
...

Winner: Proposal 1 (first to reach 5 votes)
```

### Scenario 3: Multiple Ties
```
Proposal 0: 3 votes  ← max_votes = 3, winning_proposal = 0
Proposal 1: 1 vote
Proposal 2: 3 votes  ← votes == max_votes (not >), no update
Proposal 3: 2 votes
Proposal 4: 3 votes  ← votes == max_votes (not >), no update
...

Winner: Proposal 0 (lowest ID among tied proposals)
```

### Scenario 4: Higher ID Has More Votes Later
```
Proposal 0: 2 votes  ← max_votes = 2, winning_proposal = 0
Proposal 1: 1 vote
Proposal 2: 4 votes  ← max_votes = 4, winning_proposal = 2
Proposal 3: 4 votes  ← votes == max_votes (not >), no update
Proposal 4: 4 votes  ← votes == max_votes (not >), no update
...

Winner: Proposal 2 (first to reach 4 votes)
```

## Implications

### ✅ Pros
- **Deterministic** - Same inputs always produce same output
- **Simple** - Easy to understand and verify
- **Gas Efficient** - No additional logic needed
- **Fair** - Lower proposal IDs submitted earlier have slight advantage

### ⚠️ Cons
- **Not Truly Random** - In ties, always favors lower IDs
- **Potentially Unfair** - Proposals submitted first have advantage
- **No Equal Treatment** - Tied proposals not treated equally

## Alternative Approaches

### Option 1: Return All Tied Winners
```rust
// Would need to change return type to Vec<u8> or bitmask
// More complex but fairer
```

### Option 2: Use Hash-Based Tiebreaker
```rust
// Use blockhash or some randomness to break ties
// More complex, requires additional inputs
```

### Option 3: Explicitly Use >= for "Latest Wins"
```rust
if votes >= max_votes {  // Change > to >=
    max_votes = votes;
    winning_proposal = i as u8;
}
// Now HIGHEST ID wins in ties (last submitted)
```

## Recommendation

**Current implementation is ACCEPTABLE for MVP** because:
1. Behavior is deterministic and predictable
2. Simple and gas-efficient
3. Clearly documented

**For production, consider:**
- Documenting this tie-breaking rule in user-facing docs
- Adding a test that explicitly validates tie-breaking behavior
- Potentially adding random tie-breaking if fairness is critical

## Test Case Needed

```typescript
it("should break ties by selecting lowest proposal ID", async () => {
  // Submit 3 proposals
  // Cast equal votes for proposals 1, 2, 3
  // Verify proposal 1 wins (lowest ID)
  // This test is currently MISSING from our test suite
});
```

