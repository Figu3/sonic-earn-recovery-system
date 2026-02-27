// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {StreamRecoveryClaim} from "../src/StreamRecoveryClaim.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {Merkle} from "./utils/Merkle.sol";

/// @title Fuzz tests for Trevee Earn Recovery Distributor (StreamRecoveryClaim)
/// @dev Targets payout computation, allocation tracking, and share/total boundaries.
contract StreamRecoveryFuzzTest is Test {
    StreamRecoveryClaim public claim;
    ERC20Mock public usdc;
    ERC20Mock public weth;

    address admin = makeAddr("admin");
    uint256 user1Pk;
    address user1;
    uint256 user2Pk;
    address user2;

    uint256 constant WAD = 1e18;

    function setUp() public {
        (user1, user1Pk) = makeAddrAndKey("user1");
        (user2, user2Pk) = makeAddrAndKey("user2");

        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        weth = new ERC20Mock("Wrapped Ether", "WETH", 18);

        claim = new StreamRecoveryClaim(admin, address(usdc), address(weth));
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    function _signAndSubmitWaiver(uint256 pk) internal {
        address signer = vm.addr(pk);
        bytes32 digest = claim.getWaiverDigest(signer);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        vm.prank(signer);
        claim.signWaiver(v, r, s);
    }

    function _createLeaf(address user, uint256 shareWad) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(user, shareWad))));
    }

    // ─── Fuzz: Payout computation never exceeds round total ──────────

    /// @dev For any valid shareWad ∈ [0, WAD], payout = shareWad * total / WAD <= total.
    function testFuzz_payoutNeverExceedsTotal(
        uint256 shareWad,
        uint256 roundTotal
    ) public pure {
        // Bound inputs to realistic ranges
        shareWad = bound(shareWad, 0, WAD);
        roundTotal = bound(roundTotal, 0, type(uint128).max); // Avoid overflow

        uint256 payout = (shareWad * roundTotal) / WAD;
        assertLe(payout, roundTotal, "Payout exceeds round total");
    }

    /// @dev Two complementary shares should sum to at most the total (accounting for rounding dust).
    function testFuzz_twoSharesNeverExceedTotal(
        uint256 share1,
        uint256 roundTotal
    ) public pure {
        share1 = bound(share1, 0, WAD);
        roundTotal = bound(roundTotal, 0, type(uint128).max);
        uint256 share2 = WAD - share1;

        uint256 payout1 = (share1 * roundTotal) / WAD;
        uint256 payout2 = (share2 * roundTotal) / WAD;

        assertLe(payout1 + payout2, roundTotal, "Combined payouts exceed total");
    }

    /// @dev The maximum rounding dust for N users is at most N-1 wei.
    function testFuzz_roundingDustBounded(
        uint256 share1,
        uint256 roundTotal
    ) public pure {
        share1 = bound(share1, 1, WAD - 1);
        roundTotal = bound(roundTotal, 1, type(uint128).max);
        uint256 share2 = WAD - share1;

        uint256 payout1 = (share1 * roundTotal) / WAD;
        uint256 payout2 = (share2 * roundTotal) / WAD;
        uint256 dust = roundTotal - payout1 - payout2;

        // With 2 users, dust is at most 1 wei
        assertLe(dust, 1, "Rounding dust exceeds 1 wei for 2 users");
    }

    // ─── Fuzz: Allocation tracking is consistent ─────────────────────

    /// @dev Creating and deactivating a round should return allocation to zero.
    function testFuzz_createDeactivateReleasesAllocation(
        uint256 usdcTotal,
        uint256 wethTotal
    ) public {
        usdcTotal = bound(usdcTotal, 0, 100_000_000e6);  // Up to 100M USDC
        wethTotal = bound(wethTotal, 0, 100_000e18);       // Up to 100K WETH

        // Fund contract
        usdc.mint(address(claim), usdcTotal);
        weth.mint(address(claim), wethTotal);

        // Need at least one valid merkle root if total > 0
        bytes32 dummyRoot = keccak256("dummy");
        bytes32 usdcRoot = usdcTotal > 0 ? dummyRoot : bytes32(0);
        bytes32 wethRoot = wethTotal > 0 ? dummyRoot : bytes32(0);

        vm.prank(admin);
        claim.createRound(usdcRoot, wethRoot, usdcTotal, wethTotal);

        assertEq(claim.totalUsdcAllocated(), usdcTotal);
        assertEq(claim.totalWethAllocated(), wethTotal);

        vm.prank(admin);
        claim.deactivateRound(0);

        assertEq(claim.totalUsdcAllocated(), 0, "USDC allocation not released");
        assertEq(claim.totalWethAllocated(), 0, "WETH allocation not released");
    }

    // ─── Fuzz: Full claim flow with arbitrary share and total ────────

    /// @dev Single user with 100% share should receive the full roundTotal.
    function testFuzz_fullShareClaimsAll(
        uint256 usdcTotal,
        uint256 wethTotal
    ) public {
        usdcTotal = bound(usdcTotal, 1, 100_000_000e6);
        wethTotal = bound(wethTotal, 1, 100_000e18);

        // Build single-user trees
        bytes32[] memory usdcLeaves = new bytes32[](1);
        usdcLeaves[0] = _createLeaf(user1, WAD); // 100% share

        bytes32[] memory wethLeaves = new bytes32[](1);
        wethLeaves[0] = _createLeaf(user1, WAD);

        bytes32 usdcRoot = Merkle.getRoot(usdcLeaves);
        bytes32 wethRoot = Merkle.getRoot(wethLeaves);

        // Fund & create
        usdc.mint(address(claim), usdcTotal);
        weth.mint(address(claim), wethTotal);

        vm.prank(admin);
        claim.createRound(usdcRoot, wethRoot, usdcTotal, wethTotal);

        // Sign waiver & claim
        _signAndSubmitWaiver(user1Pk);

        bytes32[] memory usdcProof = Merkle.getProof(usdcLeaves, 0);
        bytes32[] memory wethProof = Merkle.getProof(wethLeaves, 0);

        vm.prank(user1);
        claim.claimBoth(0, WAD, usdcProof, WAD, wethProof);

        assertEq(usdc.balanceOf(user1), usdcTotal, "Did not receive full USDC");
        assertEq(weth.balanceOf(user1), wethTotal, "Did not receive full WETH");
    }

    /// @dev Arbitrary share (0, WAD] → user receives exactly (shareWad * total / WAD).
    function testFuzz_arbitrarySharePayout(
        uint256 shareWad,
        uint256 usdcTotal
    ) public {
        shareWad = bound(shareWad, 1, WAD);
        usdcTotal = bound(usdcTotal, 1, 100_000_000e6);

        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = _createLeaf(user1, shareWad);

        bytes32 root = Merkle.getRoot(leaves);

        usdc.mint(address(claim), usdcTotal);

        vm.prank(admin);
        claim.createRound(root, bytes32(0), usdcTotal, 0);

        _signAndSubmitWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(leaves, 0);
        vm.prank(user1);
        claim.claimUsdc(0, shareWad, proof);

        uint256 expectedPayout = (shareWad * usdcTotal) / WAD;
        assertEq(usdc.balanceOf(user1), expectedPayout, "Payout mismatch");
    }

    // ─── Fuzz: Rescue token math ─────────────────────────────────────

    /// @dev rescueToken should only allow withdrawing excess above allocated amounts.
    function testFuzz_rescueOnlyExcess(
        uint256 allocated,
        uint256 excess
    ) public {
        allocated = bound(allocated, 1, 50_000_000e6);
        excess = bound(excess, 1, 10_000_000e6);

        uint256 totalFunded = allocated + excess;

        usdc.mint(address(claim), totalFunded);

        bytes32 dummyRoot = keccak256("root");
        vm.prank(admin);
        claim.createRound(dummyRoot, bytes32(0), allocated, 0);

        // Should succeed: rescue up to excess
        vm.prank(admin);
        claim.rescueToken(address(usdc), admin, excess);
        assertEq(usdc.balanceOf(admin), excess);

        // Should fail: trying to rescue more than excess (now 0 excess left)
        vm.prank(admin);
        vm.expectRevert("Exceeds rescuable USDC");
        claim.rescueToken(address(usdc), admin, 1);
    }

    // ─── Fuzz: Sweep after deadline ──────────────────────────────────

    /// @dev Sweep returns exactly (total - claimed) to recipient.
    function testFuzz_sweepReturnsUnclaimed(
        uint256 shareWad,
        uint256 usdcTotal
    ) public {
        shareWad = bound(shareWad, 1, WAD - 1); // Partial share so there's unclaimed
        usdcTotal = bound(usdcTotal, 1e6, 100_000_000e6); // At least 1 USDC

        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = _createLeaf(user1, shareWad);

        bytes32 root = Merkle.getRoot(leaves);

        usdc.mint(address(claim), usdcTotal);

        vm.prank(admin);
        claim.createRound(root, bytes32(0), usdcTotal, 0);

        _signAndSubmitWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(leaves, 0);
        vm.prank(user1);
        claim.claimUsdc(0, shareWad, proof);

        uint256 claimed = usdc.balanceOf(user1);
        uint256 expectedUnclaimed = usdcTotal - claimed;

        // Warp past deadline
        vm.warp(block.timestamp + 366 days);

        address sweepRecipient = makeAddr("sweepRecipient");
        vm.prank(admin);
        claim.sweepUnclaimed(0, sweepRecipient);

        assertEq(
            usdc.balanceOf(sweepRecipient),
            expectedUnclaimed,
            "Sweep amount mismatch"
        );
    }

    // ─── Fuzz: Multiple rounds allocation tracking ───────────────────

    /// @dev Creating N rounds and deactivating all should zero out allocation.
    function testFuzz_multiRoundAllocationTracking(
        uint8 roundCountRaw
    ) public {
        uint256 nRounds = bound(uint256(roundCountRaw), 1, 10);
        uint256 perRound = 1_000_000e6;

        usdc.mint(address(claim), perRound * nRounds);

        bytes32 dummyRoot = keccak256("root");

        for (uint256 i; i < nRounds; i++) {
            vm.prank(admin);
            claim.createRound(dummyRoot, bytes32(0), perRound, 0);
        }

        assertEq(claim.totalUsdcAllocated(), perRound * nRounds);

        for (uint256 i; i < nRounds; i++) {
            vm.prank(admin);
            claim.deactivateRound(i);
        }

        assertEq(claim.totalUsdcAllocated(), 0, "Allocation not fully released");
    }
}
