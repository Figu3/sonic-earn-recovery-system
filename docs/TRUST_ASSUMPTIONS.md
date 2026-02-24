# Trust Assumptions & Privilege Roles

## Architecture Overview

```
                    ┌─────────────────────┐
                    │     Admin (Safe)     │
                    │   Multi-sig wallet   │
                    └──────────┬──────────┘
                               │
                 ┌─────────────┼─────────────┐
                 │             │             │
                 ▼             ▼             ▼
           createRound   pause/unpause   sweepUnclaimed
           deactivate    rescueToken     transferAdmin
           updateRoots
                               │
                               ▼
                    ┌─────────────────────┐
                    │ StreamRecoveryClaim │
                    │   (non-upgradeable) │
                    └──────────┬──────────┘
                               │
                    ┌──────────┼──────────┐
                    ▼                     ▼
              USDC (ERC-20)         WETH (ERC-20)
              on Sonic              on Sonic
```

## Trust Assumptions

### 1. Admin is Trusted (Honest Operator)
The admin address controls all privileged operations. Users must trust that the admin:
- Sets correct Merkle roots matching the published distribution
- Allocates the correct token amounts per round
- Does not deactivate rounds to steal allocated funds (funds return to contract, not admin wallet — but admin could then create a new round and sweep)
- Does not pause the contract indefinitely to prevent claims

**Mitigation**: Admin will be a Gnosis Safe multi-sig requiring multiple signers. The contract is non-upgradeable, limiting the admin's power to the defined functions.

### 2. Merkle Trees are Generated Correctly Off-chain
The on-chain contract verifies Merkle proofs but cannot verify that the trees themselves are correct. Users trust that:
- The snapshot script accurately captures on-chain balances at the correct block
- Share calculations are proportional and fair
- No legitimate users are excluded from the trees
- Protocol redirects (Silo → designated recipient, etc.) are correct

**Mitigation**: Merkle trees and raw data are published for community verification before round creation. The `updateMerkleRoots` function allows fixing errors before any claims are made.

### 3. USDC and WETH on Sonic Are Standard ERC-20
The contract uses `SafeERC20` for all token operations but assumes:
- Both tokens implement standard ERC-20 `transfer`/`balanceOf`
- Neither token has fee-on-transfer, rebasing, or blocklist mechanisms that would break claim accounting
- Both tokens are available on Sonic chain

**Mitigation**: USDC (Circle) and WETH are well-established tokens. SafeERC20 handles non-standard return values.

### 4. EIP-712 Signature Security
The waiver mechanism assumes:
- Users control their private keys and can produce valid EIP-712 signatures
- The `WAIVER_MESSAGE` is immutable (hardcoded as `constant`)
- Smart contract wallets cannot sign (see Known Issues #3 — mitigated by protocol redirects)

### 5. Block Timestamps Are Reasonably Accurate
The claim deadline uses `block.timestamp`. Trust that:
- Sonic validators do not manipulate timestamps by more than a few seconds
- This is acceptable for a 365-day deadline window

---

## Privilege Roles

### Admin (`admin` state variable)

**Appointment**: Set in constructor. Transferred via two-step process (`transferAdmin` → `acceptAdmin`).

**Capabilities**:

| Function | What It Does | Risk Level |
|---|---|---|
| `createRound(...)` | Creates a new distribution round with Merkle roots and token allocations | **High** — defines who can claim what |
| `deactivateRound(roundId)` | Stops claims for a round, releases unallocated tokens back to pool | **High** — prevents users from claiming |
| `updateMerkleRoots(roundId, ...)` | Updates Merkle roots on a round with zero claims | **High** — can change who is eligible (only before any claims) |
| `sweepUnclaimed(roundId, to)` | Transfers unclaimed tokens after deadline to specified address | **Medium** — only after 365-day deadline |
| `pause()` | Stops all user-facing operations | **Medium** — temporary DoS on claims |
| `unpause()` | Resumes user-facing operations | **Low** — restores normal operation |
| `rescueToken(token, to, amount)` | Withdraws excess tokens (above allocated amounts) or non-USDC/WETH tokens | **Medium** — cannot touch allocated funds |
| `transferAdmin(newAdmin)` | Initiates admin transfer (requires `acceptAdmin` by new admin) | **Critical** — changes who controls the contract |

**Cannot do**:
- Upgrade the contract (non-upgradeable)
- Change the waiver message
- Modify claim amounts after claims have started (Merkle roots locked once claims begin)
- Withdraw allocated USDC/WETH (only excess above `totalAllocated`)
- Bypass the 365-day sweep deadline
- Claim on behalf of users

### Pending Admin (`pendingAdmin` state variable)

**Capabilities**:
| Function | What It Does |
|---|---|
| `acceptAdmin()` | Completes the two-step admin transfer |

### Users (Any Address)

**Capabilities**:
| Function | Requirement |
|---|---|
| `signWaiver(v, r, s)` | Must provide valid EIP-712 signature where signer == msg.sender |
| `claimUsdc(...)` | Must have signed waiver + valid Merkle proof + round active + not already claimed |
| `claimWeth(...)` | Same as claimUsdc but for WETH tree |
| `claimBoth(...)` | Convenience — claims both tokens from same round |
| `claimMultipleUsdc(...)` | Batch claim USDC from multiple rounds (max 50) |
| `claimMultipleWeth(...)` | Batch claim WETH from multiple rounds (max 50) |

---

## Invariants

### Critical
1. **No double claims**: `hasClaimedUsdc[roundId][user]` and `hasClaimedWeth[roundId][user]` are set before transfer and checked before each claim.
2. **Claims cannot exceed allocation**: `round.usdcClaimed + amount <= round.usdcTotal` (same for WETH).
3. **Allocated funds are protected**: `rescueToken` only allows withdrawal of `balance - totalAllocated` for USDC/WETH.
4. **Sweep only after deadline**: `sweepUnclaimed` reverts if `block.timestamp < claimDeadline`.

### Economic
5. **Share-based payout**: `amount = shareWad * roundTotal / WAD`. Total of all shareWad values should sum to ≤ 1e18 (100%).
6. **Allocation tracking**: `totalUsdcAllocated` / `totalWethAllocated` are incremented on round creation and decremented on deactivation or sweep.
