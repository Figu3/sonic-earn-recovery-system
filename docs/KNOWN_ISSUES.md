# Known Issues & Accepted Risks

## Known Limitations

### 1. Share Rounding Dust
**Description**: Payout computation `(shareWad * roundTotal) / WAD` truncates toward zero. The last claimer in a round may leave up to ~20 wei of dust unclaimed.

**Impact**: Negligible (<$0.01 total across all users).

**Accepted because**: The dust is economically irrelevant and does not affect any user's payout materially. The admin can sweep it after the claim deadline.

---

### 2. No Partial Claims
**Description**: A user must claim their full share in a single transaction per round per token. There is no mechanism to claim a partial amount.

**Impact**: Low. Users who want partial claims must wait for the full share to be available.

**Accepted because**: Partial claims add complexity to the Merkle tree structure and claim tracking. For a recovery distribution, single full claims are sufficient.

---

### 3. EIP-712 Waiver Requires EOA Signature
**Description**: The `signWaiver()` function requires `msg.sender == signer`, meaning smart contract wallets (Gnosis Safe, etc.) cannot sign the EIP-712 waiver via ERC-1271.

**Impact**: Smart contract wallets (multisigs) cannot claim directly. They must use an EOA or be redirected in the Merkle tree to an EOA that can sign.

**Accepted because**: The waiver is a legal requirement. Protocol-level contracts (Euler, Silo, Spectra, etc.) have their claims redirected to designated recipient EOAs during Merkle tree generation. Individual users using smart wallets are extremely rare in this user base.

---

### 4. Single Admin (No Timelock or Multi-sig Enforced On-chain)
**Description**: The contract uses a single `admin` address with a two-step transfer. No on-chain timelock or multi-sig requirement is enforced.

**Impact**: Medium. Admin has significant power (create/deactivate rounds, sweep funds, pause).

**Accepted because**: The admin will be a multi-sig in practice (Gnosis Safe). Enforcing this on-chain adds unnecessary complexity for a non-upgradeable distribution contract with a limited operational lifetime (~1 year). Two-step transfer prevents accidental admin loss.

---

### 5. PUSH0 Opcode Usage (Solidity 0.8.24)
**Description**: Solidity 0.8.24 with `evm_version = cancun` may emit `PUSH0` (introduced in Shanghai). Sonic is EVM-compatible and supports `PUSH0`.

**Impact**: None on Sonic. Would be an issue if deploying to chains that don't support Shanghai.

**Accepted because**: Deployment target is exclusively Sonic chain, which supports `PUSH0`.

---

### 6. Claim Deadline Is Fixed at Creation
**Description**: The claim deadline is set to `block.timestamp + 365 days` at round creation time and cannot be extended.

**Impact**: Low. Users who miss the 1-year window lose their claim.

**Accepted because**: 365 days provides ample time. The fixed deadline is simpler and more predictable than an extendable one. Extending deadlines could lock protocol funds indefinitely.

---

### 7. No On-chain View for All User Entitlements
**Description**: There is no on-chain function to enumerate which rounds a user is entitled to. Users must rely on off-chain Merkle data to know their shares.

**Impact**: Low. Frontend and off-chain tooling provide this information.

**Accepted because**: Enumerating entitlements on-chain would require storing the full Merkle tree, which is prohibitively expensive. The `canClaimUsdc` / `canClaimWeth` view functions allow verification of specific claims.

---

## Out of Scope

1. **Frontend vulnerabilities** — The claim UI is a separate codebase
2. **Off-chain Merkle tree generation** — TypeScript scripts are not part of the on-chain security model
3. **Third-party protocol sub-distributions** — Euler, Pendle, dLEND handle their own internal distributions to vault depositors
4. **Token contract risks** — USDC and WETH on Sonic are assumed to be standard ERC-20 implementations
5. **Sonic chain-level risks** — Block reorgs, chain halts, or RPC issues are outside contract scope
