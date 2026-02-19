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
- **Emergency controls**: Pause/unpause, round deactivation, admin transfer (2-step)
- **Claim deadline**: 365 days per round, after which admin can sweep unclaimed funds

## Deployment Checklist

See [audit preparation rules](/.claude/rules/audit-preparation.md) for the full pre-deployment checklist.

## License

MIT
