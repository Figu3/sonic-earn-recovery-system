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

- [x] **0.1** Queue `v2.pause()` Safe tx
  - calldata: `0x8456cb59`
  - verify: `cast call $V2 "paused()(bool)" --rpc-url $RPC` → `true`

## Phase 1 — Wind down V2 funds into the admin Safe

**Goal:** after this phase, V2 holds zero USDC and zero WETH; the admin
Safe holds `348,899,406,347` extra USDC units and `326,024,027,675,757,771,426`
extra WETH wei (≈ $348,899.41 + 326.024 WETH).

- [ ] **1.1** Queue `v2.deactivateRound(0)` Safe tx
  - to: `0x6472D708cD88C7DD94e77A5c5023dA6FDc41Ad31`
  - value: `0`
  - calldata: `0xf16255340000000000000000000000000000000000000000000000000000000000000000`
  - post-verify:
    ```
    cast call $V2 "totalUsdcAllocated()(uint256)" --rpc-url $RPC  # == 0
    cast call $V2 "totalWethAllocated()(uint256)" --rpc-url $RPC  # == 0
    ```

- [ ] **1.2** Queue `v2.rescueToken(USDC, adminSafe, 348899406347)` Safe tx
  - to: `0x6472D708cD88C7DD94e77A5c5023dA6FDc41Ad31`
  - value: `0`
  - calldata:
    ```
    0xe5711e8b00000000000000000000000029219dd400f2bf60e5a23d13be72b486d40388940000000000000000000000002b93eb843a54fa3ecacb5a72a69dcb666b262069000000000000000000000000000000000000000000000000000000513c06720b
    ```

- [ ] **1.3** Queue `v2.rescueToken(WETH, adminSafe, 326024027675757771426)` Safe tx
  - to: `0x6472D708cD88C7DD94e77A5c5023dA6FDc41Ad31`
  - value: `0`
  - calldata:
    ```
    0xe5711e8b00000000000000000000000050c42deacd8fc9773493ed674b675be577f2634b0000000000000000000000002b93eb843a54fa3ecacb5a72a69dcb666b262069000000000000000000000000000000000000000000000011ac7e05d25fa9faa2
    ```

- [ ] **1.4** Post-phase-1 verification
  ```
  cast call $USDC "balanceOf(address)(uint256)" $V2        --rpc-url $RPC  # == 0
  cast call $WETH "balanceOf(address)(uint256)" $V2        --rpc-url $RPC  # == 0
  cast call $USDC "balanceOf(address)(uint256)" $ADMIN_SAFE --rpc-url $RPC  # prior + 348899406347
  cast call $WETH "balanceOf(address)(uint256)" $ADMIN_SAFE --rpc-url $RPC  # prior + 326024027675757771426
  ```

**Tip:** If your Safe supports batching, do 1.1 + 1.2 + 1.3 in a single
multi-send tx (one signing round instead of three).

---

## Phase 2 — Snapshot V2 claim state and rebuild the V2.1 tree

The currently committed V2.1 tree assumes the full V1 pot. After V2
claims (~$21,152 USDC + 16.38 WETH already paid out) and the Phase 1
wind-down, the new tree must:
  - drop every V2 claimer (to prevent double-claim), and
  - size the totals to the actual funds the admin Safe will redeposit.

- [ ] **2.1** Write `scripts/snapshot-v2-claims.ts`
  - Pull `UsdcClaimed(uint256,address,uint256)` and
    `WethClaimed(uint256,address,uint256)` events from V2 between its
    deploy block and latest.
  - Write `scripts/output/round0-claimed-v2.json` matching the shape of
    `round0-claimed.json`: `{ v2, paused, usdc: { total, claimedOnChain,
    claimedAddresses[] }, weth: { ... } }`.
  - Sanity: sum of event amounts MUST equal `v2.rounds(0).usdcClaimed`
    and `v2.rounds(0).wethClaimed` exactly. If not, the event scan
    missed something — do not proceed.

- [ ] **2.2** Patch `scripts/build-round0v2-v21.ts`
  - Change the pot constants to the V2 wind-down balances:
    ```ts
    const V1_USDC = 348_899_406_347n;          // V2 balance post-claims, pre-wind-down
    const V1_WETH = 326_024_027_675_757_771_426n;
    ```
    (Consider renaming `V1_*` → `TARGET_*` for clarity.)
  - In Step 10, union `round0-claimed.json.{usdc,weth}.claimedAddresses`
    with `round0-claimed-v2.json.{usdc,weth}.claimedAddresses`.

- [ ] **2.3** Re-run the build
  ```
  cd scripts && npx tsx build-round0v2-v21.ts
  ```
  Record the new merkle roots here:
  - USDC root: `________________________________________________________________`
  - WETH root: `________________________________________________________________`
  - USDC leaves: `_____`
  - WETH leaves: `_____`

- [ ] **2.4** Extend `scripts/audit-r0v2-tree.py`
  - INV1 must union V1 + V2 claimers when checking the no-orphan
    re-entry invariant.

- [ ] **2.5** Re-run the audit
  ```
  python3 scripts/audit-r0v2-tree.py
  ```
  Expected: `GROUP B PASSED: all 7 invariants verified`

- [ ] **2.6** Re-run Phase G Group A (regression check)
  ```
  forge test --match-contract ForkV21Waiver --skip script
  ```
  Expected: `8 passed; 0 failed; 0 skipped`

- [ ] **2.7** Commit & push the new trees, build-script diff, audit-script
      diff, and new snapshot output.

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
