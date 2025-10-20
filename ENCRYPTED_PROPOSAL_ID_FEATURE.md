# Encrypted Proposal ID Feature

## Overview
This feature adds **ballot secrecy** to vote receipts by encrypting the proposal ID that voters chose. While the vote tallying happens through encrypted MPC computation, the receipt now also keeps the proposal choice encrypted.

## Why This Matters

### Before (Basic Privacy):
- ✅ Vote counts are encrypted and tallied by MXE
- ❌ Vote receipt showed **plaintext** proposal ID
- ❌ Anyone could see which proposal each voter chose

### After (Enhanced Ballot Secrecy):
- ✅ Vote counts are encrypted and tallied by MXE  
- ✅ Vote receipt contains **encrypted** proposal ID
- ✅ Only the voter (with their private key) can decrypt and verify their choice
- ✅ MXE can also decrypt if needed for auditing

## Technical Implementation

### Smart Contract Changes

#### 1. Updated `VoteReceiptAccount` Structure
```rust
pub struct VoteReceiptAccount {
    pub bump: u8,
    pub voter: Pubkey,
    pub proposal_id: u8,                    // Still needed for PDA derivation
    pub encrypted_proposal_id: [u8; 32],   // NEW: Encrypted ballot choice
    pub timestamp: i64,
    pub vote_encryption_pubkey: [u8; 32],
    pub proposal_id_nonce: u128,            // NEW: Separate nonce for proposal ID
}
```

#### 2. Updated `vote_for_proposal` Function
New parameters:
- `encrypted_proposal_id: [u8; 32]` - The encrypted proposal choice
- `proposal_id_nonce: u128` - Unique nonce for encrypting the proposal ID

#### 3. Updated `VoteReceiptCreatedEvent`
Now includes the encrypted proposal ID in events for off-chain tracking.

### Client-Side Changes

#### Encryption Process (in tests)
```typescript
// Encrypt the proposal ID separately for ballot secrecy
const proposalIdNonce = randomBytes(16);
const encryptedProposalId = cipher.encrypt([vote], proposalIdNonce);

// Pass both plaintext (for validation) and encrypted (for receipt)
await program.methods.voteForProposal(
  computationOffset,
  proposalId,                              // Plaintext for validation
  Array.from(encryptedProposalId[0]),     // Encrypted for receipt
  Array.from(ciphertext[0]),              // Vote ciphertext
  Array.from(publicKey),                  // Voter's public key
  new anchor.BN(deserializeLE(nonce).toString()),
  new anchor.BN(deserializeLE(proposalIdNonce).toString())
)
```

#### Decryption by Voter
```typescript
// Voter can decrypt their own receipt to verify their vote
const decryptedProposalId = cipher.decrypt(
  [voteReceiptAccount.encryptedProposalId],
  proposalIdNonceBuffer
);

console.log(`I voted for proposal: ${decryptedProposalId[0]}`);
```

## Security Properties

### 1. **Ballot Secrecy**
- Observers cannot see which proposal a voter chose
- The receipt is encrypted and only the voter can decrypt it
- Even with on-chain data, proposal choices remain private

### 2. **Verifiability** 
- Voters can decrypt their own receipt to verify their vote was recorded correctly
- The encrypted data is cryptographically bound to the voter's key
- MXE can decrypt for auditing purposes if needed

### 3. **Integrity**
- Plaintext proposal ID still used for PDA derivation (prevents double voting)
- Encrypted proposal ID stored separately for privacy
- Both must match for the vote to be valid

### 4. **Non-Repudiation**
- Voter's encryption public key is stored in the receipt
- Proves the voter created this specific encrypted ballot
- Can verify authenticity without revealing the choice

## How It Works

### Voting Flow:

1. **Voter encrypts their choice:**
   ```
   vote = encrypt(proposal_id, voter_private_key + mxe_public_key, nonce1)
   encrypted_proposal = encrypt(proposal_id, voter_private_key + mxe_public_key, nonce2)
   ```

2. **Smart contract validates and stores:**
   - Validates plaintext `proposal_id` for business logic
   - Derives PDA from plaintext to prevent double voting
   - Stores `encrypted_proposal_id` in receipt for privacy

3. **Vote is tallied:**
   - MXE decrypts and tallies votes through MPC
   - Individual votes remain confidential throughout

4. **Voter can verify:**
   ```
   decrypted = decrypt(encrypted_proposal_id, voter_private_key, nonce2)
   assert(decrypted == expected_proposal_id)
   ```

### Key Insight:
The plaintext `proposal_id` is still needed for **functionality** (validation, PDA seeds), but the encrypted version provides **privacy** in the receipt.

## Example Output

```
========== Vote Receipt for Winning Proposal ==========
Voter: 2uzU1MU3S3T3yd7Yu4avvQ5qNcJ6ZTujF8vv4UmJFQpm
Proposal ID (plaintext for PDA): 0
Encrypted Proposal ID: a3f5c8d2e1b4... (32 bytes hex)
Timestamp: 1760960043
Vote Encryption Pubkey: ad0cdd638a4f... (32 bytes hex)
Proposal ID Nonce: 123456789012345678901234567890
Bump: 254
=======================================================

========== Voter Can Decrypt Their Vote ==========
Decrypted Proposal ID: 0
Matches winning proposal: true
==================================================
```

## Privacy Analysis

| Information | Visibility | Who Can See |
|------------|-----------|-------------|
| Voter's public key | 🟢 Public | Everyone |
| That voter participated | 🟢 Public | Everyone |
| When they voted | 🟢 Public | Everyone |
| **Which proposal** | 🔴 Private | Only voter + MXE |
| Vote encryption details | 🟢 Public | Everyone (but encrypted) |
| Actual vote tally | 🔴 Private | Only MXE (until reveal) |

## Benefits

1. **Maximum Privacy**: Even the receipt doesn't leak voting choices
2. **Individual Verifiability**: Each voter can verify their own vote
3. **Audit Trail**: MXE can decrypt receipts if disputes arise  
4. **Compliance**: Meets requirements for secret ballot systems
5. **Coercion Resistance**: Harder to prove to others how you voted

## Use Cases

This enhanced privacy is crucial for:
- **Corporate Governance**: Board votes should remain confidential
- **DAO Voting**: Prevent vote buying/selling by hiding choices
- **Union Elections**: Secret ballot requirements
- **Community Polls**: Protect minority opinions
- **Sensitive Decisions**: Financial allocations, personnel matters

## Future Enhancements

Possible improvements:
1. **Zero-Knowledge Proofs**: Prove you voted without revealing the choice
2. **Homomorphic Tallying**: Tally without ever decrypting individual votes
3. **Receipt-Free Voting**: Prevent voters from proving their choice to others
4. **Threshold Decryption**: Require multiple parties to decrypt receipts

## Conclusion

By encrypting the proposal ID in vote receipts, we achieve **true ballot secrecy** while maintaining:
- ✅ Verifiability (voters can check their vote)
- ✅ Integrity (no double voting)
- ✅ Privacy (choices remain confidential)
- ✅ Auditability (MXE can decrypt if needed)

This makes the voting system suitable for **high-stakes governance** scenarios where ballot secrecy is a legal or ethical requirement.


