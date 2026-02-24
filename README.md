# Stream Recovery Claim System

Merkle-proof-based distribution contract for recovering assets from the Stream Trading incident affecting Trevee's stkscUSD and stkscETH vaults on Sonic chain.

## Architecture

```
StreamRecoveryClaim.sol
├── Two Merkle trees per round (USDC + WETH)
├── EIP-712 waiver signing (legal liability)
├── Multi-round support (progressive recoveries)
├── Allocation tracking (prevents over-commitment)
└── Admin controls (pause, sweep, deactivate)
```

### Key Design Decisions

- **Dual Merkle trees**: ~85% of users hold only stkscUSD. Separate trees let USDC-only users claim without touching the WETH tree.
- **Waiver-gated claims**: Users must sign an EIP-712 typed data waiver before claiming. The waiver is signed once and applies across all rounds.
- **Share-based payouts**: Each leaf encodes `(address, shareWad)` where `shareWad` is the user's pro-rata share in WAD (1e18 = 100%). Payout = `shareWad * roundTotal / 1e18`.
- **Double-hash leaves**: `keccak256(bytes.concat(keccak256(abi.encode(address, shareWad))))` — prevents second preimage attacks on Merkle trees.

## Contracts

| Contract | Description |
|----------|-------------|
| `StreamRecoveryClaim.sol` | Main claim contract (Merkle proofs, EIP-712 waiver, multi-round) |

### Key Functions

| Function | Description |
|----------|-------------|
| `signWaiver(v, r, s)` | Sign the EIP-712 liability waiver (required before any claim) |
| `claimUsdc(roundId, shareWad, proof)` | Claim USDC from a single round |
| `claimWeth(roundId, shareWad, proof)` | Claim WETH from a single round |
| `claimBoth(...)` | Claim both USDC and WETH from a single round in one tx |
| `claimMultipleUsdc(roundIds, shareWad, proof)` | Batch claim USDC across multiple rounds (max 50) |
| `claimMultipleWeth(roundIds, shareWad, proof)` | Batch claim WETH across multiple rounds (max 50) |
| `canClaimUsdc(roundId, user, shareWad, proof)` | View: check eligibility and payout amount for USDC |
| `canClaimWeth(roundId, user, shareWad, proof)` | View: check eligibility and payout amount for WETH |
| `getWaiverDigest(claimant)` | View: get the EIP-712 digest for frontend signing |
| `createRound(...)` | Admin: create a new distribution round with Merkle roots and token totals |
| `updateMerkleRoots(roundId, usdcRoot, wethRoot)` | Admin: fix Merkle roots before any claims are made |
| `deactivateRound(roundId)` | Admin: deactivate a round and release its allocation |
| `sweepUnclaimed(roundId, to)` | Admin: sweep unclaimed funds after the claim deadline (365 days) |
| `rescueToken(token, to, amount)` | Admin: rescue accidentally-sent tokens (protects allocated funds) |

### Dependencies

- OpenZeppelin v5: MerkleProof, SafeERC20, EIP712, ECDSA
- Solidity 0.8.24 (pinned)

## Scripts

| Script | Description |
|--------|-------------|
| `snapshot.ts` | Takes on-chain snapshot of stkscUSD/stkscETH holders at a given block, resolves Trevee wrapper contracts recursively |
| `fix-snapshot.ts` | Corrects dust absorption bug where shortfall was assigned to Silo instead of actual depositors |
| `merkle.ts` | Generates dual Merkle trees (USDC + WETH) with proofs from snapshot data |
| `verify-address.ts` | Community tool to check if an address is in the snapshot and view entitlements |
| `test-merkle.ts` | Validates Merkle tree integrity against on-chain verification |

## Development

```bash
# Build contracts
forge build

# Run tests
forge test

# Coverage
forge coverage --ir-minimum --report summary

# Run snapshot (requires Sonic RPC)
cd scripts && npx tsx snapshot.ts --block 62788943
```

## Security

- **CEI pattern**: All state changes before external calls
- **SafeERC20**: Used for all token operations
- **Drain guard**: Claims cannot exceed round totals
- **Allocation tracking**: Prevents over-committing tokens across rounds
- **Zero Merkle root validation**: Rejects bytes32(0) roots when tokens are allocated
- **Root correction**: `updateMerkleRoots` allows fixing wrong roots before any claims
- **Idempotent waiver**: `signWaiver` reverts if already signed (prevents replay confusion)
- **Emergency controls**: Pause/unpause, round deactivation, admin transfer (2-step)
- **Claim deadline**: 365 days per round, after which admin can sweep unclaimed funds
- **Static analysis**: Slither clean (0 findings in user code)

## Deployment Checklist

See [audit preparation rules](/.claude/rules/audit-preparation.md) for the full pre-deployment checklist.

## License

MIT
