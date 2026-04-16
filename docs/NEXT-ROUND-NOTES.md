# Next Round — Open Items & Lessons

Things we should NOT forget before starting a Round 1 recovery or any successor
distribution. Captured while the context is still warm.

---

## 1. Unresolved V2.1 allocations (partial recovery expected via sweep)

These are funds sitting in V2.1 that **cannot be claimed** by the leaf holder,
either because the holder is a contract with no claim mechanism, or because the
sub-distribution was wrong. All of these will sweep back to the admin Safe
after the 365-day deadline (claimDeadline ≈ 2027-04-15) and should be manually
redistributed.

### 1a. Eliteness Equalizer sub-distribution error — **$23,502 total, $6,790 already lost**

**What went wrong:** `0xb0c855a7fb3716ebc1c4505218de4bf2186125ba` (Eliteness
Equalizer) was put in `ROUND1_RESOLVED_PROTOCOL_CONTRACTS` and its $23.5K
entitlement was sub-distributed to 497 individual veUSD depositors. Per
pre-snapshot agreement with 543/Eliteness, the Equalizer contract was supposed
to be treated as a **simple holder** — the contract itself claims, the USDC
sits as backing for the ongoing veUSD token.

**Status at time of writing:**
- 8 depositors claimed $6,790.14 (already gone from V2.1 — cannot recover from contract)
- 189 unclaimed contract addresses hold $12,771.86 (will sweep at deadline)
- 312 unclaimed EOAs hold $10,913.74 (at risk of claiming before deadline)

**Full per-address breakdown:** `scripts/output/equalizer-exposure-report.json`

**Action items for next round:**
1. After the V2.1 deadline sweep, transfer the swept Equalizer residual to the
   Equalizer contract (`0xb0c855a7fb3716ebc1c4505218de4bf2186125ba`) directly.
2. Write off the $6,790 already claimed by depositors — 543 says "maybe"
   for recovery from frens; treat as lost.
3. Decide whether to compensate the ~$6K delta from treasury.

**Lesson:** Before the next snapshot, ask each affected protocol explicitly:
"sub-distribute to your depositors, or treat you as a simple holder?" Get it
in writing. Don't bulk-label "LP-like contracts" as `ROUND1_RESOLVED`.

### 1b. Eliteness Thena Adapter — **same issue, $13,253 exposure**

`0x6328a2ff2e6bb164f1be2479af209a88295f54d5` (Eliteness Thena Adapter) held
212,240,991,919 stkscUSD at snapshot (~$13,253 USDC entitlement at the R0 rate).
Same ROUND1_RESOLVED treatment. Same 543 pre-agreement: treat as simple holder.

Wasn't explicitly flagged by 543 but almost certainly applies the same way.
**Figue confirmed:** "I created a redirect for all your users, unsure why i did
it for USD and not ETH". Both Eliteness contracts need correction in the next
round.

### 1c. Unhandled protocol contracts (likely SwapX or similar) — **~$37K stuck**

Contract addresses that hold V2.1 allocations but aren't in any
PROTOCOL_REDIRECTS / SUB_DISTRIBUTIONS / ROUND1_RESOLVED / SHADOW / 9mm list.
Can't claim (no ERC-1271, no approveHash). Will sweep at deadline.

| Address | V2.1 USDC | V2.1 WETH | $ @ $2,022 | Notes |
|---|---:|---:|---:|---|
| `0xb82beb0860bde0838e7b721d747528f24a258825` | $0 | 14.7466 | **$29,818** | proxy → `0x09e6c1ed…`, unknown protocol |
| `0x60f126d6eac8971ed0a755e9a72d1b9532bb5b99` | $0 | 2.5579 | $5,172 | 30 KB contract, non-standard interface |
| `0x93148918047d0953d34ae1376031492d0dd472ec` | $388 | 0.8202 | $2,046 | small contract |

**Action:** Before the next round, identify what these are (ask 543 / ask the
Shadow/SwapX/9mm teams). If they're LP vaults with known depositors, we should
sub-distribute. If they're protocol treasuries, redirect. If unknown, let sweep.

---

## 2. V2.1 contract findings we accepted but should revisit

### 2a. Phase H hardening accidentally blocks Safe Apps SDK flow (inherited)

V2.1 line 291: `if (signature.length == 0) revert InvalidSignature();`

This was added during Phase H adversarial review to close a low-severity
"finding" that wasn't actually a vulnerability. The side effect is that the
canonical Safe Apps SDK `sdk.safe.signMessage(message)` flow cannot be used
directly — that flow relies on `signedMessages[hash] = 1` and an empty
signature argument. Frontends must use either:
- (Path A) Collect threshold off-chain ECDSA sigs → bundle → submit
- (Path B) On-chain `approveHash` dance → `v=1` pre-approved bundle

**If we do a V3 / Round 1 redeploy, drop the length==0 check.** It gives Safe
users a much cleaner UX. The "attack" it was defending against (smart wallets
returning the ERC-1271 magic value for arbitrary input) is the wallet's own
design choice and not our job to police.

### 2b. V2-inherited `deactivateRound` → `rescueToken` admin asymmetry

`deactivateRound` decrements `totalAllocated` without transferring tokens out,
so the unclaimed amount instantly becomes "excess" for `rescueToken` and
bypasses the sweep deadline. Reported by Phase H as a $75-confidence finding.
Not introduced by V2.1, not currently exploitable by non-admin, but the
asymmetry exists. Fix in a future version: only free allocation inside
`sweepUnclaimed`, not in `deactivateRound`.

### 2c. Per-entry drift between JSON `amount` and live payout

Shareway quantization (`shareWad = (amt*WAD + total/2) / total`) can produce
per-entry drift of a few wei (max observed: 2,794 wei on SAFE_2 WETH, the Step
12 dust recipient). Total is preserved exactly, but individual recipients may
receive slightly more or less than their "intended" amount. Frontends should
use `canClaimUsdc` / `canClaimWeth` as the source of truth, not the JSON
`amount` field. Already documented in `docs/DEPLOY-CHECKLIST.md` and
`ForkV21Live.t.sol`.

---

## 3. Frontend integration gaps

### 3a. Path A (multi-sig Safe waiver signing) not in main UI

The main claim frontend only handles EOA signing. For the 24 affected multi-sig
Safes ($316K combined value), users must use `docs/v21-waiver-helper.html`
manually, or do the approveHash dance by hand.

Empirically confirmed: **0% of the 24 affected Safes hit any technical edge
case** (see `scripts/scan-affected-safes.ts` — all owners are plain EOAs, all
Safes are v1.3.0/v1.4.x with standard CompatibilityFallbackHandler). So Path A
integration would work for all of them.

**For next round: bake Path A into the main UI from day one.** Reference
implementation: `docs/v21-waiver-helper.html`.

### 3b. Contract wallets (ERC-1271) work — confirmed by Eliteness 2026-04-09

543/Eliteness independently verified V2.1's ERC-1271 fallback works for their
contract wallet. So the contract is correct for contract-wallet claimants
generally. The only missing piece is the frontend orchestration for
threshold Safes (Path A above).

---

## 4. Lessons for the next round

- **Double-check token addresses on-chain before shipping.** We almost
  deployed Phase G tests with Wrapped Sonic (wS, `0x039e2fB…`) as the "WETH"
  constant. Actual Sonic WETH is `0x50c42d…634b`. Always
  `v21.weth()` / `v21.usdc()` after deploy.
- **Explicitly ask affected protocols** whether to sub-distribute or treat as
  simple holders BEFORE the snapshot. Don't infer from protocol type.
- **Pause before wind-down.** V2's rescue had a rolling target because claims
  landed between when we computed the rescue amount and when the tx executed.
  Pause → confirm pause landed on-chain → THEN compute the rescue amount
  from the current balance.
- **Don't bundle deploy + fund + createRound into one Safe batch.** Separating
  them is an extra signing round but gives kill-switches between steps.
- **Verify the `priorWaivers` target** at deploy time. For successor contracts,
  point at the LATEST contract (which has the union of all prior signers),
  not the original V1.
- **Audit agents produce false positives.** Phase H's empty-signature
  hardening was accepted in the moment but broke a legitimate Safe flow. Push
  back on audit findings that don't include a concrete exploit path.
- **Keep the trees reproducible.** `build-round0v2-v21.ts` is fully
  deterministic from `snapshot-*.json` + `round0-claimed*.json` +
  `withdraw-queue-resolved.json` + `9mm-resolved.json`. Anyone can rebuild
  and verify the on-chain merkle roots.

---

## 5. Addresses with "I can't claim" reports that were working as intended

For future reference, these cases came in during the V2.1 rollout and turned
out NOT to be contract bugs:

| Address | Report | Actual status |
|---|---|---|
| `0x5BC19020c5E4BBa928226e36AE5BDba782e4A216` | "can't claim USDC" | Already claimed — $6,227 is in the Safe |
| `0x13cCDb2080483d7cf9545f496457d393994B7Da6` | "can't claim" | EOA with WQ-ETH leaf (0.2308 WETH) — needs to sign V2.1 waiver first |
| `0x97079F7E04B535FE7cD3f972Ce558412dFb33946` | "no USDC to claim" | Not in tree — never held stkscUSD at snapshot. Confused their addresses |
| `0xB0C855A7FB3716EBC1c4505218De4bF2186125Ba` | "claim not included" | Eliteness Equalizer — sub-distributed (item 1a above) |
| `0xAF1bff74708098dB603e48aaEbEC1BBAe03Dcf11` | "not in merkle" | Actually IS in V2.1 USDC tree at $254.35 via R1 merge |

Pattern: most "can't claim" reports are (a) user already claimed, (b) user has
the wrong address, (c) user is a Safe and needs Path A signing, or (d) user
wasn't affected by the incident at all. Only the Equalizer case (1a) was an
actual allocation error.
