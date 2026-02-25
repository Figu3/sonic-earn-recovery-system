# Emergency Procedures

## Quick Reference

| Scenario | Action | Function | Reversible? |
|---|---|---|---|
| Active exploit / bug found | Pause immediately | `pause()` | Yes (`unpause()`) |
| Wrong Merkle root deployed | Update roots (if 0 claims) or deactivate | `updateMerkleRoots()` / `deactivateRound()` | Roots: Yes (before claims). Deactivate: No |
| User reports incorrect claim amount | Verify off-chain, fix in next round if needed | N/A (off-chain) | N/A |
| Admin key compromised | Transfer admin to secure address | `transferAdmin()` + `acceptAdmin()` | Two-step required |
| Token stuck in contract | Rescue excess tokens | `rescueToken()` | N/A |
| Claim deadline approaching | Communicate to remaining claimants | Off-chain comms | N/A |

---

## Scenario 1: Active Exploit or Bug Discovery

### Immediate Response (< 5 minutes)
1. **Pause the contract**:
   ```
   cast send <CONTRACT> "pause()" --private-key <ADMIN_KEY> --rpc-url <SONIC_RPC>
   ```
2. **Verify pause is active**:
   ```
   cast call <CONTRACT> "paused()(bool)" --rpc-url <SONIC_RPC>
   ```
   Expected: `true`

### Assessment (< 1 hour)
3. Check recent claims for anomalies:
   - Query `UsdcClaimed` and `WethClaimed` events
   - Compare claimed amounts against expected Merkle data
4. Check contract balances:
   ```
   cast call <USDC> "balanceOf(address)(uint256)" <CONTRACT> --rpc-url <SONIC_RPC>
   cast call <WETH> "balanceOf(address)(uint256)" <CONTRACT> --rpc-url <SONIC_RPC>
   ```
5. Verify `totalUsdcAllocated` and `totalWethAllocated` match expectations:
   ```
   cast call <CONTRACT> "totalUsdcAllocated()(uint256)" --rpc-url <SONIC_RPC>
   cast call <CONTRACT> "totalWethAllocated()(uint256)" --rpc-url <SONIC_RPC>
   ```

### Resolution
- **If bug is in Merkle tree data**: Deactivate affected round, create corrected round
- **If bug is in contract logic**: Contract is non-upgradeable. Options:
  - Deactivate all active rounds
  - Deploy new contract with fix
  - Migrate funds via `rescueToken` (only excess) + `sweepUnclaimed` (after deadline)
- **If false alarm**: Unpause the contract:
  ```
  cast send <CONTRACT> "unpause()" --private-key <ADMIN_KEY> --rpc-url <SONIC_RPC>
  ```

---

## Scenario 2: Wrong Merkle Root Published

### If No Claims Have Been Made on the Round
1. Update the roots directly:
   ```
   cast send <CONTRACT> "updateMerkleRoots(uint256,bytes32,bytes32)" \
     <ROUND_ID> <CORRECT_USDC_ROOT> <CORRECT_WETH_ROOT> \
     --private-key <ADMIN_KEY> --rpc-url <SONIC_RPC>
   ```
2. Verify:
   ```
   cast call <CONTRACT> "rounds(uint256)" <ROUND_ID> --rpc-url <SONIC_RPC>
   ```

### If Claims Have Already Been Made
The `updateMerkleRoots` function will revert with `RoundHasClaims()`. Options:
1. **Deactivate the round** (users who already claimed keep their tokens):
   ```
   cast send <CONTRACT> "deactivateRound(uint256)" <ROUND_ID> \
     --private-key <ADMIN_KEY> --rpc-url <SONIC_RPC>
   ```
2. **Create a new corrected round** with adjusted allocations accounting for already-claimed amounts.

---

## Scenario 3: Admin Key Compromise

### Immediate Response
1. From the compromised admin, initiate transfer to a secure backup address:
   ```
   cast send <CONTRACT> "transferAdmin(address)" <BACKUP_SAFE> \
     --private-key <COMPROMISED_KEY> --rpc-url <SONIC_RPC>
   ```
2. Accept from the backup address:
   ```
   cast send <CONTRACT> "acceptAdmin()" \
     --private-key <BACKUP_KEY> --rpc-url <SONIC_RPC>
   ```

### If Attacker Acts First
If the attacker calls `transferAdmin` to their own address:
- They still need to call `acceptAdmin` from the pending address
- If admin hasn't been transferred yet, the legitimate admin can call `transferAdmin` again to overwrite `pendingAdmin`

### Worst Case
If the attacker completes the admin transfer:
- They can pause/unpause but cannot directly steal allocated funds
- They can deactivate rounds (blocking claims) and then sweep after deadline
- **Mitigation**: This is why admin should always be a multi-sig (Gnosis Safe)

---

## Scenario 4: Rescuing Stuck Tokens

### Excess USDC/WETH (Above Allocated)
If extra USDC or WETH is accidentally sent to the contract:
```
# Check rescuable amount
cast call <CONTRACT> "totalUsdcAllocated()(uint256)" --rpc-url <SONIC_RPC>
cast call <USDC> "balanceOf(address)(uint256)" <CONTRACT> --rpc-url <SONIC_RPC>
# excess = balance - totalAllocated

cast send <CONTRACT> "rescueToken(address,address,uint256)" \
  <USDC_ADDRESS> <RECIPIENT> <EXCESS_AMOUNT> \
  --private-key <ADMIN_KEY> --rpc-url <SONIC_RPC>
```

### Non-USDC/WETH Tokens
Any other ERC-20 sent to the contract can be fully rescued:
```
cast send <CONTRACT> "rescueToken(address,address,uint256)" \
  <TOKEN_ADDRESS> <RECIPIENT> <FULL_AMOUNT> \
  --private-key <ADMIN_KEY> --rpc-url <SONIC_RPC>
```

---

## Scenario 5: Post-Deadline Sweep

After 365 days from round creation:
```
cast send <CONTRACT> "sweepUnclaimed(uint256,address)" \
  <ROUND_ID> <TREASURY_ADDRESS> \
  --private-key <ADMIN_KEY> --rpc-url <SONIC_RPC>
```

**Pre-sweep checklist**:
- [ ] Confirm `block.timestamp >= round.claimDeadline`
- [ ] Review unclaimed addresses — attempt final outreach
- [ ] Verify sweep recipient is correct
- [ ] Check both USDC and WETH unclaimed amounts

---

## Deployment & Verification

### Deploy + Auto-Verify
```bash
source .env && forge script script/Deploy.s.sol \
  --rpc-url sonic \
  --broadcast \
  --verify \
  --private-key $PRIVATE_KEY
```

### Verify an Already-Deployed Contract
```bash
forge verify-contract <DEPLOYED_ADDRESS> StreamRecoveryClaim \
  --chain 146 \
  --verifier etherscan \
  --verifier-url "https://api.etherscan.io/v2/api?chainid=146" \
  --etherscan-api-key $SONICSCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" $ADMIN $USDC $WETH) \
  --watch
```

### Post-Deployment Checklist
- [ ] Contract verified on [SonicScan](https://sonicscan.org) (green checkmark on contract tab)
- [ ] Update contract address in this document (below)
- [ ] Update contract registry (`contracts.json`)
- [ ] Fund contract with USDC + WETH for first round
- [ ] Create first distribution round via `createRound()`
- [ ] Announce deployment address on Discord

---

## Contract Addresses (To Be Filled Post-Deployment)

| Contract | Address | Chain |
|---|---|---|
| StreamRecoveryClaim | `0x155F8e841505d4Be029938647b509639eAFe6c87` | Sonic |
| USDC | `0x29219dd400f2Bf60E5a23d13Be72B486D4038894` | Sonic |
| WETH | `0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38` | Sonic |
| Admin | `0x0792dCb7080466e4Bbc678Bdb873FE7D969832B8` | Sonic |

## Communication Channels

- **Trevee Discord** — Primary user communication
- **On-chain events** — All admin actions emit events for transparency
- **Published Merkle data** — CSV and JSON files for independent verification
