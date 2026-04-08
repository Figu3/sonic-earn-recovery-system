# V2.1 Deploy + V2 Wind-Down — Tracking Checklist

Update the `[ ]` → `[x]` boxes as you complete each item. Each phase ends
with a verification step that must produce the expected on-chain state
before moving on.

**Latest code commit:** `96111f9`
**V1:** `0xda7805AdbEfa29b9e3Ba1d24B96C71aAE696745b` (paused; waiver-migration source only)
**V2:** `0x6472D708cD88C7DD94e77A5c5023dA6FDc41Ad31`
**Admin Safe:** `0x2b93eb843a54FA3ecAcb5A72a69DcB666B262069`
**USDC:** `0x29219dd400f2Bf60E5a23d13Be72B486D4038894`
**WETH:** `0x50c42dEAcD8Fc9773493ED674b675bE577f2634b` *(canonical Sonic WETH)*
**RPC:** `https://rpc.soniclabs.com`

---

## Phase 0 — Freeze V2 state

- [x] **0.1** `v2.pause()` — confirmed on-chain, `paused() == true`

## Phase 1 — Wind down V2 funds into the admin Safe

**Goal:** after this phase, V2 holds zero USDC and zero WETH; the admin
Safe holds `348,888,033,588` extra USDC units and `326,023,604,484,012,050,420`
extra WETH wei (≈ $348,888.03 + 326.0236 WETH). Note: amounts are slightly
lower than the initial quote because some users claimed on V2 between
Phase 0 pause queueing and the pause actually landing. The snapshot in
Phase 2 captured the final state.

- [x] **1.1** `v2.deactivateRound(0)` — confirmed on-chain
  - `totalUsdcAllocated == 0`, `totalWethAllocated == 0`
  - `round.active == false`

- [ ] **1.2** Queue `v2.rescueToken(USDC, adminSafe, 348888033588)` Safe tx
  *(SIGNING IN PROGRESS — waiting for co-signers)*
  - to: `0x6472D708cD88C7DD94e77A5c5023dA6FDc41Ad31`
  - value: `0`
  - calldata:
    ```
    0xe5711e8b00000000000000000000000029219dd400f2bf60e5a23d13be72b486d40388940000000000000000000000002b93eb843a54fa3ecacb5a72a69dcb666b262069000000000000000000000000000000000000000000000000000000513b58e934
    ```

- [ ] **1.3** Queue `v2.rescueToken(WETH, adminSafe, 326023604484012050420)` Safe tx
  *(SIGNING IN PROGRESS — waiting for co-signers)*
  - to: `0x6472D708cD88C7DD94e77A5c5023dA6FDc41Ad31`
  - value: `0`
  - calldata:
    ```
    0xe5711e8b00000000000000000000000050c42deacd8fc9773493ed674b675be577f2634b0000000000000000000000002b93eb843a54fa3ecacb5a72a69dcb666b262069000000000000000000000000000000000000000000000011ac7c84ee5dfd07f4
    ```

- [ ] **1.4** Post-phase-1 verification
  ```
  cast call $USDC "balanceOf(address)(uint256)" $V2        --rpc-url $RPC  # == 0
  cast call $WETH "balanceOf(address)(uint256)" $V2        --rpc-url $RPC  # == 0
  cast call $USDC "balanceOf(address)(uint256)" $ADMIN_SAFE --rpc-url $RPC  # prior + 348888033588
  cast call $WETH "balanceOf(address)(uint256)" $ADMIN_SAFE --rpc-url $RPC  # prior + 326023604484012050420
  ```

---

## Phase 2 — Snapshot V2 claim state and rebuild the V2.1 tree

- [x] **2.1** `scripts/snapshot-v2-claims.ts` written and run
  - **43 USDC claimers** + **9 WETH claimers** captured from V2
  - Reconciliation delta = **0** on both sides (sum of computed amounts
    == `v2.rounds(0).{usdcClaimed,wethClaimed}` exactly)
  - Output: `scripts/output/round0-claimed-v2.json`

- [x] **2.2** `scripts/build-round0v2-v21.ts` patched
  - Added `TARGET_USDC = 348_888_033_588` and
    `TARGET_WETH = 326_023_604_484_012_050_420`
  - Step 10 (V1 claimer drop, before R1 merge) — unchanged
  - **Step 11b (NEW)** — V2 claimer drop, **after** R1 merge, full
    exclusion. Design rationale: V2 already paid V2-claimers both
    their R0 direct share AND their R1 protocol share, so there is no
    R1 re-entry carve-out (unlike V1 claimers).
  - `buildTree` now uses `TARGET_*` totals

- [x] **2.3** Build re-run — **NEW MERKLE ROOTS**:
  - **USDC root:** `0x21ab37dc48d1d13fe9dafc04db13be01f628cbf7dbbfcb5fdbfc3ddd3d539fe0`
  - **WETH root:** `0x7be1d2af458a586617ce6b56f46df727b68c022729aaf3b11a553b004941c14b`
  - **USDC leaves:** 5,745
  - **WETH leaves:** 1,118
  - **USDC total:** `348,888,033,588` ($348,888.03) — matches target delta=0
  - **WETH total:** `326,023,604,484,012,050,420` (326.0236 WETH) — matches target delta=0

- [x] **2.4** `scripts/audit-r0v2-tree.py` extended
  - New **INV1b**: V2 claimers must be fully absent from V2.1 (no R1 re-entry)
  - **INV2 / INV3** use `v1 ∪ v2` claimer set for WQ / 9mm carve-outs
  - **INV4** uses `TARGET_USDC / TARGET_WETH` not V1 pot

- [x] **2.5** Audit re-run — **7/7 invariants PASS**
  - INV1a USDC: 13 V1 claimers in tree (all in R1, no orphans) ✓
  - INV1a WETH: 1 V1 claimer in tree (in R1, no orphans) ✓
  - INV1b USDC: 0/43 V2 claimers in tree ✓
  - INV1b WETH: 0/9 V2 claimers in tree ✓
  - INV2 WQ-ETH: 10/10, WQ-USD: 28/28 present ✓
  - INV3 9mm: 7/7 present ✓
  - INV4 USDC sum == 348,888,033,588 (delta=0) ✓
  - INV4 WETH sum == 326,023,604,484,012,050,420 (delta=0) ✓
  - INV5: 0 zero-amount leaves on both sides ✓
  - INV6: leafCount metadata matches (5745 / 1118) ✓
  - INV7: `payoutSum + dust == sum(amount)` both sides ✓

- [x] **2.6** Phase G Group A re-run — **8/8 PASS** (G2, G3, G4, G5, G6, G7, G12, PH)

- [ ] **2.7** Commit & push Phase 2 changes

---

## Phase 3 — Fresh-eyes review *(Migration Checklist Step 6)*

- [ ] **3.1** Read `src/StreamRecoveryClaimV21.sol` end-to-end with
      `docs/v2.1-design.md` open side by side. For each of the 12
      preconditions in F3, point at the code line that satisfies it.
- [ ] **3.2** Cross-check Phase G test Safe addresses against
      `scripts/output/safe-threshold-breakdown.json`
      (`SAFE_2 = 0x4d62…ff1d`, `SAFE_3 = 0x7D1C…6676`,
      `SAFE_4 = 0x6a15…6567`, `SAFE_1 = 0x697F…2DE8`).

---

## Phase 4 — Deploy V2.1 (isolated, no funds yet)

- [ ] **4.1** Prepare deploy params:
  - `_admin` = `0x2b93eb843a54FA3ecAcb5A72a69DcB666B262069` (admin Safe)
  - `_usdc`  = `0x29219dd400f2Bf60E5a23d13Be72B486D4038894`
  - `_weth`  = `0x50c42dEAcD8Fc9773493ED674b675bE577f2634b`
  - `_priorWaivers` = `0x6472D708cD88C7DD94e77A5c5023dA6FDc41Ad31` ← **V2**, not V1 (V2 carries the union of V1 migrants + V2-direct signers)

- [ ] **4.2** Deploy via Foundry script. Derive deployer address with
      `vm.addr(vm.envUint("PRIVATE_KEY"))` (per `rules/solidity-security.md`
      §3 — never `msg.sender` inside a Foundry script).

- [ ] **4.3** Record the deployed address:
  - V2.1 = `________________________________________________________________`

- [ ] **4.4** Post-deploy verification (all on-chain)
  ```
  V21=<deployed>
  cast call $V21 "admin()(address)"          --rpc-url $RPC  # == 0x2b93eb8...
  cast call $V21 "usdc()(address)"           --rpc-url $RPC  # == 0x29219dd4...
  cast call $V21 "weth()(address)"           --rpc-url $RPC  # == 0x50c42dEA...
  cast call $V21 "priorWaivers()(address)"   --rpc-url $RPC  # == 0x6472D708... (V2)
  cast call $V21 "roundCount()(uint256)"     --rpc-url $RPC  # == 0
  cast call $V21 "paused()(bool)"            --rpc-url $RPC  # == false
  cast call $V21 "domainSeparator()(bytes32)" --rpc-url $RPC  # record for frontend
  ```

- [ ] **4.5** Verify source on SonicScan
  ```
  forge verify-contract $V21 StreamRecoveryClaimV21 --chain sonic \
    --etherscan-api-key $SONICSCAN_API_KEY
  ```

---

## Phase 5 — Fund V2.1 and open Round 0

- [ ] **5.1** Queue `usdc.transfer(V21, 348899406347)` from admin Safe
- [ ] **5.2** Queue `weth.transfer(V21, 326024027675757771426)` from admin Safe
      *(or exactly the new tree totals from 2.3 — they should equal these
      numbers, since the admin Safe received exactly the V2 wind-down
      amount in Phase 1)*

- [ ] **5.3** Post-funding verification
  ```
  cast call $USDC "balanceOf(address)(uint256)" $V21 --rpc-url $RPC  # == tree usdcTotal
  cast call $WETH "balanceOf(address)(uint256)" $V21 --rpc-url $RPC  # == tree wethTotal
  ```

- [ ] **5.4** Queue `v21.createRound(usdcRoot, wethRoot, usdcTotal, wethTotal)` Safe tx
  - roots from 2.3
  - totals from 2.3 (should equal the Phase 5 funding amounts)
  - will revert `InsufficientBalance` if 5.1 / 5.2 didn't transfer enough

- [ ] **5.5** Post-createRound verification
  ```
  cast call $V21 "roundCount()(uint256)"             --rpc-url $RPC  # == 1
  cast call $V21 "rounds(uint256)(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,bool)" 0 --rpc-url $RPC
  # must match: usdcRoot, wethRoot, usdcTotal, wethTotal, 0, 0, deadline, true
  cast call $V21 "totalUsdcAllocated()(uint256)"     --rpc-url $RPC  # == usdcTotal
  cast call $V21 "totalWethAllocated()(uint256)"     --rpc-url $RPC  # == wethTotal
  ```

---

## Phase 6 — Post-deploy verification on a fork *(Migration Checklist Step 7)*

**Before announcing anything publicly**, simulate the full claim flow
against the deployed V2.1 bytecode on a Sonic fork at the latest block.

- [ ] **6.1** Run Phase G Group A smoke test against the deployed address
      (modify the test to use `v21 = StreamRecoveryClaimV21($DEPLOYED)`
      instead of `new StreamRecoveryClaimV21(...)`)

- [ ] **6.2** Simulate real Safe claim for each threshold tier on a fork
      using the **real** merkle proofs from 2.3:
  - [ ] `SAFE_1 = 0x697F…2DE8` (1-of-1)
  - [ ] `SAFE_2 = 0x4d62…ff1d` (2-of-N)
  - [ ] `SAFE_3 = 0x7D1C…6676` (3-of-N)
  - [ ] `SAFE_4 = 0x6a15…6567` (4-of-N)

- [ ] **6.3** Simulate V1 waiver migration via `priorWaivers = V2`
      for a real V1-signer: call `v21.migrateWaiverFromPrior()` and
      assert `v21.hasSignedWaiver(addr) == true`.

- [ ] **6.4** Simulate one 7702 EOA claim using a real 7702 address
      from `scripts/output/7702-scan.json#users`.

**If any 6.x fails: do not announce. Diagnose, fix, repeat.**

---

## Phase 7 — Announce

- [ ] **7.1** Publish V2.1 address, new merkle roots, and claim
      instructions (Discord / Twitter / docs).
- [ ] **7.2** Monitor on-chain claim events for the first 24h.
      If any claim reverts, pause V2.1 and investigate before more users try.

---

## Rollback plan (if anything goes wrong)

| Stage | If things break, do this |
|---|---|
| After Phase 0 | `v2.unpause()` — fully reversible |
| After Phase 1 | Admin Safe holds the funds. Can send back to V2 via `usdc.transfer`/`weth.transfer`, then `v2.unpause()`. Round 0 is deactivated though — would need to rebuild. Keep V2 paused until decision. |
| After Phase 4 (V2.1 deployed, no funds yet) | V2.1 is an empty contract with an admin. No user funds at risk. Can pause and ignore. |
| After Phase 5 (createRound) | Admin can call `v21.pause()` to block further claims, then `v21.deactivateRound(0)` + `v21.rescueToken(...)` to wind down exactly the way we did for V2. Same playbook. |
| After Phase 7 (announced) | Worst case. Pause, diagnose, communicate publicly. |
