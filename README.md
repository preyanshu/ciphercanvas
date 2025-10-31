# CipherCanvas

<img width="952" height="644" alt="image" src="https://github.com/user-attachments/assets/09f02c16-bb79-438b-b27e-c92709f4c0f3" />


**CipherCanvas** is a fun, community-driven art contest where users create and vote on unique AI-generated artworks, with privacy-preserving encrypted voting and rewards for both creators and voters.

**GitHub Repo:** [CipherCanvas Project GitHub](https://github.com/preyanshu/ciphercanvas)

**Demo Link Web:** [CipherCanvas Web App](https://canvas.preyanshu.me)

**Technical Demo:** [CipherCanvas Tech Demo](https://www.youtube.com/watch?v=6b3a0b4RcqA)

**Pitch Demo:** [CipherCanvas Pitch Video](https://www.loom.com/share/392a83ae61184f4c9dba5a25c1c6bf03)

**Pitch Deck:** [CipherCanvas Pitch Deck](https://www.canva.com/design/DAGcx1O1CQk/br5wq6L4Bhr5qTigY2qGlw/view?utm_content=DAGcx1O1CQk&utm_campaign=designshare&utm_medium=link2&utm_source=uniquelinks&utlId=h01b4b09764)



## How It Works

### Daily Theme
Each day introduces a new art theme to inspire creativity. Themes can reflect moods, genres, or cultural trends, ensuring fresh and exciting challenges for participants.

### Generate Art
Users create unique artworks by submitting creative prompts based on the daily theme. The platform uses AI image generation tools (via OpenRouter/Gemini) to produce a visual artwork for each prompt.

### Community Voting
After submissions are closed, the community votes for their favorite artworks. **Votes are encrypted using Multi-Party Computation (MPC)** to maintain ballot secrecy—no one can see what you voted for until the winner is revealed.

### Win and Earn
At the end of the day, submissions with the highest votes are declared winners.

**Voters Win Too:** Users who voted for the winning artworks earn a share of the rewards, encouraging thoughtful and strategic voting.

**NFT Mural Minting:** The winning artwork is minted as a unique NFT, forming part of a living, community-curated art mural. However, only the users who voted for the winning artwork are eligible to mint this NFT—making their choice both impactful and collectible.

## Features

### Privacy-Preserving Voting (Encrypted with MPC)
All votes are encrypted using **Arcium MXE (Multi-Party Computation)** before being submitted on-chain. Your vote remains private until the winner is revealed, ensuring fair and unbiased voting without coercion or vote-buying.

### Blockchain Transparency:
All submissions, votes (encrypted), and reward distributions are securely recorded on the Solana blockchain, ensuring users can trust the platform's fairness and transparency while maintaining individual privacy.

### Decentralized Engagement:
The decentralized nature of the platform empowers users, promoting fair participation and community-driven decision-making. No central authority can manipulate votes or results.

### Trustworthy Automation:
Automated keepers handle key processes such as starting new themes, closing contests, and distributing rewards. This automation ensures reliability and eliminates any possibility of human interference, fostering user trust.

### Fair Reward Distribution:
Smart contracts autonomously manage the reward distribution process, ensuring prizes are allocated based on objective voting outcomes.

## Prize Distribution Logic

**Simple Distribution:**
The prize pool is distributed as follows:

- **Winner:** 50% of the prize pool goes to the creator of the winning artwork
- **Voters:** 45% of the prize pool is distributed equally among all voters who voted for the winning artwork
- **Platform Fee:** 5% of the prize pool goes to the platform owner

**Example:**
If the prize pool is 100 SOL:
- Winner receives 50 SOL
- Voters split 45 SOL equally among all who voted for the winner
- Platform receives 5 SOL

This simple and fair distribution encourages both creativity and thoughtful voting, as voters who correctly identify the winning artwork are rewarded.

## Demo for CipherCanvas

**Create Art:** Submit a prompt based on the day's theme.
<img width="1635" height="878" alt="image" src="https://github.com/user-attachments/assets/67826572-4a7c-4c34-bb7e-cd2043176989" />
<img width="1635" height="878" alt="image" src="https://github.com/user-attachments/assets/b2163680-8aa4-4789-b8e8-a6cb5b0655fc" />


**Vote for Artworks:** Community votes on the submitted artworks. Your vote is encrypted and remains private until the winner is revealed.
<img width="1635" height="878" alt="image" src="https://github.com/user-attachments/assets/5ccb6255-d0e2-44ed-803e-fda9990ed70c" />


**See Top Artworks:** Check out the community's favorite artworks from previous days.

<img width="1635" height="878" alt="image" src="https://github.com/user-attachments/assets/ac893bae-a29f-4b4d-8267-8d6f2a38f203" />


**Track Your Wins & Mint Your NFT:**
Come back the next day to see if your vote made a difference! If the artwork you voted for wins, you can mint an exclusive NFT, forever captured in the daily art mural—only available to winning voters.

<img width="1635" height="878" alt="image" src="https://github.com/user-attachments/assets/ad03020c-6d53-4190-bbf5-7a1490e88acc" />


**See If You Got Featured:**
If you submitted an artwork, check back to see if it won the day and got pinned to the mural. Winning artworks become part of a permanent, community-curated collection—immortalized as unique art NFTs.

## Business Model

### Revenue Streams

**Platform Fee:**
A small percentage of each reward pool is taken as a platform fee to sustain operations and future developments. (Currently Implemented)

**Premium Features:**
Introduce a subscription model where users can unlock exclusive themes, advanced AI image generation tools, or additional voting power. (To Be Added)

**Sponsored Themes:**
Brands or organizations can sponsor daily themes to promote their products or causes, creating a new avenue for monetization. (To Be Added)

**NFT Marketplace:**
Mint winning artworks as NFTs and enable buying, selling, or trading on a dedicated marketplace. A commission fee will be charged for each transaction. (To Be Added)

**Community Crowdfunding:**
Allow users to contribute to prize pools or fund specific features, earning recognition or exclusive rewards in return. (To Be Added)

## Target Audience

**Art Enthusiasts:**
People who enjoy creating, sharing, and discovering new visual art.

**Creators and Artists:**
Artists looking for an innovative way to showcase their talent and earn rewards.

**Blockchain and Crypto Enthusiasts:**
Users who appreciate transparency, decentralization, and privacy-preserving technologies.

**Privacy Advocates:**
Users who value ballot secrecy and want to participate in governance without revealing their choices.

**Brands and Sponsors:**
Companies aiming to reach creative, blockchain-savvy audiences through sponsored campaigns.

## Value Proposition

**For Users:** Fun, engaging, and rewarding art contests that celebrate creativity and community collaboration, with complete privacy in voting.

**For Sponsors:** A unique opportunity to engage with a creative, blockchain-savvy audience.

**For Creators:** A platform to gain recognition, grow their audience, and earn rewards.

## Progress During Hackathon

Built the core features of CipherCanvas including AI image generation prompt submission, privacy-preserving encrypted community voting with Arcium MXE (Multi-Party Computation), image NFT minting, and automated reward distribution through Solana smart contracts. Implemented encrypted voting system that keeps individual votes private while maintaining on-chain verifiability. Automated daily theme updates and showcased everything in a live demo video, and deployed on Solana Devnet.

## Tech Stack

- **React** - Frontend framework
- **Next.js** - Full-stack React framework with API routes
- **Solana Web3.js** - Solana blockchain interaction
- **Anchor Framework** - Solana smart contract development
- **Arcium MXE** - Multi-Party Computation for encrypted voting
- **OpenRouter API** - AI image generation via Gemini
- **TypeScript** - Type-safe development
- **Tailwind CSS** - Styling

## Privacy Features

### Encrypted Voting with MPC
- Votes are encrypted client-side before submission
- Multi-Party Computation (Arcium MXE) processes encrypted votes
- Individual vote choices remain private until winner reveal
- On-chain verification ensures vote authenticity
- Deterministic key derivation for vote decryption

### End-to-End Privacy
- **Ballot Secrecy:** No one can see your vote until the round ends
- **Individual Verifiability:** You can verify your own vote was counted correctly
- **Audit Trail:** All encrypted votes are stored on-chain for transparency
- **No Vote Buying:** Encrypted votes prevent coercion and vote manipulation

## Installation

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (latest stable version)
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools)
- [Anchor](https://www.anchor-lang.com/docs/installation)
- [Arcium CLI](https://docs.arcium.com/getting-started/installation)
- [Node.js](https://nodejs.org/) (v18 or later)
- [Yarn](https://yarnpkg.com/getting-started/install)

### Setup

```bash
# Clone the repository
git clone https://github.com/preyanshu/ciphercanvas.git
cd ciphercanvas

# Install Node.js dependencies
yarn install

# Build the Anchor program
anchor build

# Build encrypted circuits
anchor build --encrypted-ixs

# Run tests
arcium test
```

### Environment Variables

Create a `.env.local` file in the root directory with the following variables:

```bash
# OpenRouter API key for AI image generation
OPENROUTER_API_KEY=your-api-key-here

# Solana cluster (optional, defaults to localnet)
SOLANA_CLUSTER=localnet

# Arcium cluster offset (optional)
ARCIUM_CLUSTER_OFFSET=1078779259
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License

