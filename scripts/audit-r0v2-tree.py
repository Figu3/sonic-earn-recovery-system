#!/usr/bin/env python3
"""
Phase G — Group B: tree-content audits for Round 0v2 V2.1 merkle JSON.

These checks audit the *data* in the V2.1 merkle trees against the source
inputs (V1 claim history, withdraw-queue payouts, 9mm LP sub-distribution).
They do NOT exercise the V2.1 contract — that's Group A's job
(test/ForkV21Waiver.t.sol). Together, Group A + Group B cover the design
doc's Phase G test plan.

Maps to design-doc cell IDs:
  - G1  : addresses already claimed on V1 are ABSENT from the V2.1 tree
  - G8  : every WQ-ETH pending user has a leaf in V2.1 WETH tree matching
          wq-payouts.json#wq_eth_payouts (±1 wei)
  - G9  : every WQ-USD pending user has a leaf in V2.1 USDC tree matching
          wq-payouts.json#wq_usd_payouts (±1 wei)
  - G10 : every 9mm LP holder has a leaf in V2.1 WETH tree at their
          pro-rata stkscETH share (9mm-resolved.json#perUser, ±1 wei)
  - G11 : same as G1 (the design doc lists both as separate test cells)

Exit code: 0 on full pass, 1 if any check fails.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "scripts" / "output"

# Tolerance for ±1 wei rounding mismatches (Merkle math is integer-exact, but
# upstream rate calculations can introduce single-wei drift).
TOLERANCE = 1


def load(name: str) -> dict:
    return json.loads((OUT / name).read_text())


def index_entries(merkle: dict) -> dict[str, int]:
    """Map lowercase address -> integer payout amount from a V2.1 merkle JSON."""
    out: dict[str, int] = {}
    for e in merkle["entries"]:
        addr = e["address"].lower()
        amount = int(e["amount"])
        out[addr] = amount
    return out


def fail(msg: str) -> None:
    print(f"  FAIL: {msg}")


def main() -> int:
    print("=" * 72)
    print("Phase G — Group B: Round 0v2 V2.1 merkle tree-content audit")
    print("=" * 72)

    usdc_merkle = load("merkle-round0v2-v2.1-usdc.json")
    weth_merkle = load("merkle-round0v2-v2.1-weth.json")
    claimed = load("round0-claimed.json")
    wq_payouts = load("wq-payouts.json")
    nine_mm = load("9mm-resolved.json")

    print(f"  USDC tree: {usdc_merkle['leafCount']} leaves, total ${int(usdc_merkle['newTotal'])/1e6:,.2f}")
    print(f"  WETH tree: {weth_merkle['leafCount']} leaves, total {int(weth_merkle['newTotal'])/1e18:,.4f} WETH")
    print()

    usdc_idx = index_entries(usdc_merkle)
    weth_idx = index_entries(weth_merkle)

    failures: list[str] = []

    # ─── G1 + G11: V1-claimed addresses absent from V2.1 trees ───────────
    print("G1+G11: V1-claimed addresses MUST be absent from V2.1 trees")
    usdc_claimed_v1 = {a.lower() for a in claimed["usdc"]["claimedAddresses"]}
    weth_claimed_v1 = {a.lower() for a in claimed["weth"]["claimedAddresses"]}
    print(f"  V1 USDC claimers: {len(usdc_claimed_v1)}")
    print(f"  V1 WETH claimers: {len(weth_claimed_v1)}")

    bad_usdc = sorted(usdc_claimed_v1 & set(usdc_idx))
    bad_weth = sorted(weth_claimed_v1 & set(weth_idx))
    if bad_usdc:
        msg = f"G1/G11 USDC: {len(bad_usdc)} V1 claimers still in V2.1 USDC tree (e.g. {bad_usdc[:3]})"
        fail(msg)
        failures.append(msg)
    else:
        print(f"  PASS: 0 of {len(usdc_claimed_v1)} V1 USDC claimers leak into V2.1 USDC tree")
    if bad_weth:
        msg = f"G1/G11 WETH: {len(bad_weth)} V1 claimers still in V2.1 WETH tree (e.g. {bad_weth[:3]})"
        fail(msg)
        failures.append(msg)
    else:
        print(f"  PASS: 0 of {len(weth_claimed_v1)} V1 WETH claimers leak into V2.1 WETH tree")
    print()

    # ─── G8: WQ-ETH pending users present + amounts match ─────────────────
    print("G8: WQ-ETH pending users MUST be in V2.1 WETH tree at exact rate-derived payout")
    wq_eth = {addr.lower(): int(amt) for addr, amt in wq_payouts["wq_eth_payouts"].items()}
    print(f"  WQ-ETH pending entries: {len(wq_eth)}")
    g8_missing = []
    g8_mismatch = []
    for addr, expected in wq_eth.items():
        actual = weth_idx.get(addr)
        if actual is None:
            g8_missing.append(addr)
        elif abs(actual - expected) > TOLERANCE:
            g8_mismatch.append((addr, expected, actual))
    if g8_missing:
        msg = f"G8: {len(g8_missing)} WQ-ETH addresses absent from V2.1 WETH tree (e.g. {g8_missing[:3]})"
        fail(msg); failures.append(msg)
    if g8_mismatch:
        msg = f"G8: {len(g8_mismatch)} WQ-ETH amount mismatches > {TOLERANCE} wei (e.g. {g8_mismatch[:3]})"
        fail(msg); failures.append(msg)
    if not g8_missing and not g8_mismatch:
        print(f"  PASS: all {len(wq_eth)} WQ-ETH addrs present with correct amounts (±{TOLERANCE} wei)")
    print()

    # ─── G9: WQ-USD pending users present + amounts match ─────────────────
    print("G9: WQ-USD pending users MUST be in V2.1 USDC tree at exact rate-derived payout")
    wq_usd = {addr.lower(): int(amt) for addr, amt in wq_payouts["wq_usd_payouts"].items()}
    print(f"  WQ-USD pending entries: {len(wq_usd)}")
    g9_missing = []
    g9_mismatch = []
    for addr, expected in wq_usd.items():
        actual = usdc_idx.get(addr)
        if actual is None:
            g9_missing.append(addr)
        elif abs(actual - expected) > TOLERANCE:
            g9_mismatch.append((addr, expected, actual))
    if g9_missing:
        msg = f"G9: {len(g9_missing)} WQ-USD addresses absent from V2.1 USDC tree (e.g. {g9_missing[:3]})"
        fail(msg); failures.append(msg)
    if g9_mismatch:
        msg = f"G9: {len(g9_mismatch)} WQ-USD amount mismatches > {TOLERANCE} unit (e.g. {g9_mismatch[:3]})"
        fail(msg); failures.append(msg)
    if not g9_missing and not g9_mismatch:
        print(f"  PASS: all {len(wq_usd)} WQ-USD addrs present with correct amounts (±{TOLERANCE} unit)")
    print()

    # ─── G10: 9mm LP holders present in V2.1 WETH tree ────────────────────
    # 9mm pool is stkscETH-paired, so the LP sub-distribution credit goes to
    # the WETH side. We check presence + that each holder receives at least
    # their pro-rata share. We do NOT assert exact equality because the V2.1
    # tree may bundle the LP sub-distribution with other allocations for the
    # same address (e.g. LP holder also held vault shares directly).
    print("G10: 9mm LP holders MUST be present in V2.1 WETH tree (>= pro-rata share)")
    nine_mm_users = {addr.lower(): int(amt) for addr, amt in nine_mm["perUser"].items()}
    print(f"  9mm LP holders: {len(nine_mm_users)}")
    g10_missing = []
    g10_under = []
    for addr, share in nine_mm_users.items():
        actual = weth_idx.get(addr)
        if actual is None:
            g10_missing.append(addr)
        elif actual + TOLERANCE < share:
            g10_under.append((addr, share, actual))
    if g10_missing:
        msg = f"G10: {len(g10_missing)} 9mm LP holders absent from V2.1 WETH tree (e.g. {g10_missing[:3]})"
        fail(msg); failures.append(msg)
    if g10_under:
        msg = f"G10: {len(g10_under)} 9mm LP holders receive LESS than their pro-rata share (e.g. {g10_under[:3]})"
        fail(msg); failures.append(msg)
    if not g10_missing and not g10_under:
        print(f"  PASS: all {len(nine_mm_users)} 9mm LP holders present with >= pro-rata share")
    print()

    print("=" * 72)
    if failures:
        print(f"GROUP B FAILED: {len(failures)} check(s) did not pass")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("GROUP B PASSED: all 5 cells (G1, G8, G9, G10, G11) verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
