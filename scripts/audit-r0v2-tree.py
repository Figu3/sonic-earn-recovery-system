#!/usr/bin/env python3
"""
Phase G — Group B: tree-content audit for Round 0v2 V2.1 merkle JSON.

This script audits the *data* in the V2.1 merkle trees against the source
inputs (V1 claim history, withdraw-queue resolved shares, 9mm LP
sub-distribution, V1 pot totals). It does NOT exercise the V2.1 contract —
that's Group A's job (test/ForkV21Waiver.t.sol).

Together, Group A + Group B cover the design doc's Phase G test plan.

──────────────────────────────────────────────────────────────────────────
HISTORY (important — read before modifying assertions)
──────────────────────────────────────────────────────────────────────────
The first version of this script (commit 606c6cd) reported 6 "failures"
that turned out to all be **audit-script bugs**, not data bugs:

  - The V1-claimer "leakage" check assumed V1 claimers must be totally
    absent from V2.1. This is wrong — `build-round0v2-v21.ts` Step 10/11
    INTENDS to re-add V1-claimers who are also Round1 protocol depositors,
    with their R1-only share. All 14 "leakers" were verified to be in
    `merkle-round1-{usdc,weth}.json` (the R1-merge source).

  - The WQ-ETH "missing user" 0x5877..089c is in
    `withdraw-queue-resolved.json#eth.perUser` BUT also in
    `round0-claimed.weth.claimedAddresses`. Step 10 correctly drops them
    because they V1-claimed their WETH. The audit was wrong to expect
    every WQ user to appear in V2.1 — V1-claimers must be excluded.

  - The G8/G9/G10 "amount mismatches" were caused by comparing against
    `wq-payouts.json`, which uses a *different* rate-derivation
    methodology (`"snapshot share / V1 pot ratio"`) than the build script
    (which uses `(share * pot / WAD)` directly from the V1 contract
    formula). The build script does NOT consume `wq-payouts.json` at all
    — it consumes `withdraw-queue-resolved.json` and `9mm-resolved.json`.
    Plus, Step 12 of the build applies a global Step-12 normalization
    (`scaled = raw * V1_TOTAL / rawTotal`) so that the tree's sum is
    exactly `V1_USDC` / `V1_WETH`. The audit's expected values would have
    needed to model the entire pipeline, which is the build script's job.

The correct way to audit a complex pipeline like this is via INVARIANTS,
not by re-implementing the math in the audit. This rewrite checks
invariants that hold regardless of intermediate normalization factors.

──────────────────────────────────────────────────────────────────────────
INVARIANTS (the actual checks performed)
──────────────────────────────────────────────────────────────────────────

INV1 (G1 + G11): every V1-claimer that appears in the V2.1 tree MUST
  also appear in the merkle-round1 tree for the same token. This proves
  the only re-entry path for V1-claimers is the intended R1-merge (Step
  11 of the build), and there are no orphan re-entries from R0.

INV2 (G8 + G9): every WQ user from withdraw-queue-resolved.json that did
  NOT also V1-claim the corresponding token MUST appear in the V2.1 tree.
  V1-claimers who are also in the WQ list are correctly dropped by Step
  10 because their WQ-pending portion was already settled by the V1
  claim. (The audit must not flag those as missing.)

INV3 (G10): every 9mm LP holder from 9mm-resolved.json#perUser that did
  NOT V1-claim WETH MUST appear in the V2.1 WETH tree.

INV4: sum of V2.1 USDC leaf amounts == V1_USDC EXACTLY.
  sum of V2.1 WETH leaf amounts == V1_WETH EXACTLY.
  Proves Step 12's normalization landed on the right total — every wei
  is accounted for and the pot is fully distributed.

INV5: every leaf has amount > 0. No griefable zero-amount slots.

INV6: leafCount metadata in the JSON matches the actual entries length.

INV7: payoutSum + payoutDustWei == sum(amount). The build emits both:
  payoutSum is what the contract will actually distribute via the
  shareWad → amount quantization (`shareWad * newTotal / WAD`), and
  payoutDustWei is the rounding loss from that quantization. Their sum
  must equal the raw normalized total.

──────────────────────────────────────────────────────────────────────────
WHAT THIS AUDIT DOES NOT CHECK
──────────────────────────────────────────────────────────────────────────
- Per-leaf amount math (e.g. "user X should get exactly Y USDC"). That's
  the build script's job. Auditing it would require porting the build's
  full pipeline, which is exactly the duplication this rewrite avoids.
  If you want byte-level reproducibility, re-run scripts/build-round0v2-v21.ts
  and diff the resulting JSON against the committed file.
- The Merkle root itself. Recomputing it requires the same hashing scheme
  the build uses (sorted-pair OZ MerkleProof). Out of scope for this audit.

Exit code: 0 on full pass, 1 if any invariant is violated.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "scripts" / "output"

# V2.1 target pot totals — must match build-round0v2-v21.ts TARGET_USDC / TARGET_WETH.
# These are the V1 pot MINUS what V2 paid out before being paused and wound
# down. Equal to the exact amounts the admin Safe rescued from V2.
TARGET_USDC = 348_888_033_588           # 6 decimals
TARGET_WETH = 326_023_604_484_012_050_420  # 18 decimals
# Legacy names for clarity in comments below. Not used directly.
V1_USDC = 370_052_027_675
V1_WETH = 342_400_797_390_971_049_123


def load(name: str) -> dict:
    return json.loads((OUT / name).read_text())


def index_entries(merkle: dict) -> dict[str, int]:
    """Map lowercase address -> integer payout amount from a V2.1 merkle JSON."""
    return {e["address"].lower(): int(e["amount"]) for e in merkle["entries"]}


def main() -> int:
    print("=" * 72)
    print("Phase G — Group B: Round 0v2 V2.1 merkle tree-content audit (v2)")
    print("=" * 72)

    usdc_merkle = load("merkle-round0v2-v2.1-usdc.json")
    weth_merkle = load("merkle-round0v2-v2.1-weth.json")
    r1u = load("merkle-round1-usdc.json")
    r1w = load("merkle-round1-weth.json")
    claimed_v1 = load("round0-claimed.json")
    claimed_v2 = load("round0-claimed-v2.json")
    wq_resolved = load("withdraw-queue-resolved.json")
    nine_mm = load("9mm-resolved.json")

    print(f"  USDC tree: {usdc_merkle['leafCount']} leaves, "
          f"target ${TARGET_USDC/1e6:,.2f}, declared total ${int(usdc_merkle['newTotal'])/1e6:,.2f}")
    print(f"  WETH tree: {weth_merkle['leafCount']} leaves, "
          f"target {TARGET_WETH/1e18:,.4f} WETH, declared total {int(weth_merkle['newTotal'])/1e18:,.4f} WETH")
    print()

    usdc_idx = index_entries(usdc_merkle)
    weth_idx = index_entries(weth_merkle)

    v1u_set = {a.lower() for a in claimed_v1["usdc"]["claimedAddresses"]}
    v1w_set = {a.lower() for a in claimed_v1["weth"]["claimedAddresses"]}
    v2u_set = {a.lower() for a in claimed_v2["usdc"]["claimedAddresses"]}
    v2w_set = {a.lower() for a in claimed_v2["weth"]["claimedAddresses"]}
    r1u_set = {e["address"].lower() for e in r1u["entries"]}
    r1w_set = {e["address"].lower() for e in r1w["entries"]}

    failures: list[str] = []

    def check(label: str, ok: bool, detail: str = "") -> None:
        if ok:
            print(f"  PASS  {label}")
        else:
            msg = f"FAIL  {label}{(' — ' + detail) if detail else ''}"
            print(f"  {msg}")
            failures.append(msg)

    # ─── INV1a: V1-claimers in V2.1 tree must also be in R1 tree ─────────
    print("INV1a (G1+G11): V1-claimers in V2.1 must come from the R1-merge path only")
    leak_u = (v1u_set & set(usdc_idx))
    leak_w = (v1w_set & set(weth_idx))
    orphan_u = sorted(leak_u - r1u_set)
    orphan_w = sorted(leak_w - r1w_set)
    check(
        f"USDC: {len(leak_u)} V1 claimers in V2.1, {len(leak_u & r1u_set)} also in R1 (no orphans)",
        len(orphan_u) == 0,
        f"orphans={orphan_u[:3]}",
    )
    check(
        f"WETH: {len(leak_w)} V1 claimers in V2.1, {len(leak_w & r1w_set)} also in R1 (no orphans)",
        len(orphan_w) == 0,
        f"orphans={orphan_w[:3]}",
    )
    print()

    # ─── INV1b: V2-claimers must be FULLY absent from V2.1 tree ──────────
    # Unlike V1 claimers, V2 already paid them BOTH R0 and R1 shares, so
    # there is no "re-entry via R1" carve-out. They must be zero.
    print("INV1b: V2-claimers must be fully absent from V2.1 (no R1 re-entry allowed)")
    leak_v2u = sorted(v2u_set & set(usdc_idx))
    leak_v2w = sorted(v2w_set & set(weth_idx))
    check(
        f"USDC: 0 of {len(v2u_set)} V2 claimers in V2.1 tree",
        len(leak_v2u) == 0,
        f"leaks={leak_v2u[:3]}",
    )
    check(
        f"WETH: 0 of {len(v2w_set)} V2 claimers in V2.1 tree",
        len(leak_v2w) == 0,
        f"leaks={leak_v2w[:3]}",
    )
    print()

    # ─── INV2 (G8 + G9): WQ users present, with V1/V2 claimer carve-outs ─
    print("INV2 (G8+G9): WQ users from withdraw-queue-resolved.json present in V2.1")
    print("              (V1 AND V2 claimers excluded — their WQ portion was already settled)")
    claimed_any_u = v1u_set | v2u_set
    claimed_any_w = v1w_set | v2w_set
    wq_eth = {a.lower() for a in wq_resolved["eth"]["perUser"].keys()}
    wq_usd = {a.lower() for a in wq_resolved["usd"]["perUser"].keys()}
    expected_wq_eth = wq_eth - claimed_any_w
    expected_wq_usd = wq_usd - claimed_any_u
    missing_wq_eth = sorted(expected_wq_eth - set(weth_idx))
    missing_wq_usd = sorted(expected_wq_usd - set(usdc_idx))
    excluded_wq_eth = wq_eth & claimed_any_w
    excluded_wq_usd = wq_usd & claimed_any_u
    check(
        f"WQ-ETH: {len(expected_wq_eth)} expected (of {len(wq_eth)} total, "
        f"{len(excluded_wq_eth)} V1/V2-claimer-excluded)",
        len(missing_wq_eth) == 0,
        f"missing={missing_wq_eth[:3]}",
    )
    check(
        f"WQ-USD: {len(expected_wq_usd)} expected (of {len(wq_usd)} total, "
        f"{len(excluded_wq_usd)} V1/V2-claimer-excluded)",
        len(missing_wq_usd) == 0,
        f"missing={missing_wq_usd[:3]}",
    )
    print()

    # ─── INV3 (G10): 9mm LP holders present, with V1/V2 claimer carve-outs
    print("INV3 (G10): 9mm LP holders from 9mm-resolved.json present in V2.1 WETH tree")
    nine_users = {a.lower() for a in nine_mm["perUser"].keys()}
    expected_nine = nine_users - claimed_any_w
    missing_nine = sorted(expected_nine - set(weth_idx))
    excluded_nine = nine_users & claimed_any_w
    check(
        f"9mm: {len(expected_nine)} expected (of {len(nine_users)} total, "
        f"{len(excluded_nine)} V1/V2-claimer-excluded)",
        len(missing_nine) == 0,
        f"missing={missing_nine[:3]}",
    )
    print()

    # ─── INV4: tree sums match V2.1 target totals exactly ────────────────
    print("INV4: tree sums match V2.1 target totals exactly (V2 wind-down amounts)")
    sum_u = sum(usdc_idx.values())
    sum_w = sum(weth_idx.values())
    check(
        f"sum(USDC leaves) == TARGET_USDC ({sum_u} vs {TARGET_USDC})",
        sum_u == TARGET_USDC,
        f"delta={sum_u - TARGET_USDC}",
    )
    check(
        f"sum(WETH leaves) == TARGET_WETH ({sum_w} vs {TARGET_WETH})",
        sum_w == TARGET_WETH,
        f"delta={sum_w - TARGET_WETH}",
    )
    print()

    # ─── INV5: no zero-amount leaves ─────────────────────────────────────
    print("INV5: no zero-amount leaves (no griefable slots)")
    zero_u = [a for a, v in usdc_idx.items() if v == 0]
    zero_w = [a for a, v in weth_idx.items() if v == 0]
    check(f"USDC: 0 zero-amount leaves", len(zero_u) == 0, f"zero_addrs={zero_u[:3]}")
    check(f"WETH: 0 zero-amount leaves", len(zero_w) == 0, f"zero_addrs={zero_w[:3]}")
    print()

    # ─── INV6: leafCount metadata matches actual ────────────────────────
    print("INV6: leafCount metadata == len(entries)")
    check(
        f"USDC leafCount == len(entries) ({usdc_merkle['leafCount']} vs {len(usdc_merkle['entries'])})",
        usdc_merkle['leafCount'] == len(usdc_merkle['entries']),
    )
    check(
        f"WETH leafCount == len(entries) ({weth_merkle['leafCount']} vs {len(weth_merkle['entries'])})",
        weth_merkle['leafCount'] == len(weth_merkle['entries']),
    )
    print()

    # ─── INV7: payoutSum + payoutDustWei == sum(amount) ───────────────────
    print("INV7: payoutSum + payoutDustWei == sum(amount)")
    print("      (payoutSum = post-shareWad-quantization; dust = rounding loss)")
    ps_u = int(usdc_merkle['payoutSum'])
    pd_u = int(usdc_merkle.get('payoutDustWei', 0))
    ps_w = int(weth_merkle['payoutSum'])
    pd_w = int(weth_merkle.get('payoutDustWei', 0))
    check(
        f"USDC: {ps_u} + {pd_u} == {sum_u}  (dust=${pd_u/1e6:.6f})",
        ps_u + pd_u == sum_u,
    )
    check(
        f"WETH: {ps_w} + {pd_w} == {sum_w}  (dust={pd_w/1e18:.18f} ETH)",
        ps_w + pd_w == sum_w,
    )
    print()

    # ─── Final ──────────────────────────────────────────────────────────
    print("=" * 72)
    if failures:
        print(f"GROUP B FAILED: {len(failures)} invariant(s) violated")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("GROUP B PASSED: all 7 invariants verified")
    print(f"  V2.1 USDC tree: {len(usdc_idx):4d} leaves, sum=${TARGET_USDC/1e6:,.2f} (exact)")
    print(f"  V2.1 WETH tree: {len(weth_idx):4d} leaves, sum={TARGET_WETH/1e18:,.6f} WETH (exact)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
