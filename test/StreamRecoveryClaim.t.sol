// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {StreamRecoveryClaim} from "../src/StreamRecoveryClaim.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Merkle} from "./utils/Merkle.sol";

contract StreamRecoveryClaimTest is Test {
    StreamRecoveryClaim public claimContract;
    ERC20Mock public usdc;
    ERC20Mock public weth;

    address admin = makeAddr("admin");
    uint256 user1Pk;
    address user1;
    uint256 user2Pk;
    address user2;
    uint256 user3Pk;
    address user3;
    uint256 user4Pk;
    address user4;

    uint256 constant WAD = 1e18;

    function setUp() public {
        (user1, user1Pk) = makeAddrAndKey("user1");
        (user2, user2Pk) = makeAddrAndKey("user2");
        (user3, user3Pk) = makeAddrAndKey("user3");
        (user4, user4Pk) = makeAddrAndKey("user4");

        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        weth = new ERC20Mock("Wrapped Ether", "WETH", 18);

        claimContract = new StreamRecoveryClaim(admin, address(usdc), address(weth));
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _signWaiver(uint256 pk) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        address signer = vm.addr(pk);
        bytes32 digest = claimContract.getWaiverDigest(signer);
        (v, r, s) = vm.sign(pk, digest);
    }

    function _executeSignWaiver(uint256 pk) internal {
        address signer = vm.addr(pk);
        (uint8 v, bytes32 r, bytes32 s) = _signWaiver(pk);
        vm.prank(signer);
        claimContract.signWaiver(v, r, s);
    }

    /// @dev Single-share leaf: keccak256(bytes.concat(keccak256(abi.encode(address, shareWad))))
    function _createLeaf(address user, uint256 shareWad) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(user, shareWad))));
    }

    struct UsdcShare {
        address user;
        uint256 shareWad;
    }

    struct WethShare {
        address user;
        uint256 shareWad;
    }

    /// @dev Build two separate trees and create a round.
    function _setupRound(
        UsdcShare[] memory usdcShares,
        WethShare[] memory wethShares,
        uint256 totalUsdc,
        uint256 totalWeth
    )
        internal
        returns (
            uint256 roundId,
            bytes32[] memory usdcLeaves,
            bytes32[] memory wethLeaves
        )
    {
        usdcLeaves = new bytes32[](usdcShares.length);
        for (uint256 i; i < usdcShares.length; i++) {
            usdcLeaves[i] = _createLeaf(usdcShares[i].user, usdcShares[i].shareWad);
        }

        wethLeaves = new bytes32[](wethShares.length);
        for (uint256 i; i < wethShares.length; i++) {
            wethLeaves[i] = _createLeaf(wethShares[i].user, wethShares[i].shareWad);
        }

        bytes32 usdcRoot = Merkle.getRoot(usdcLeaves);
        bytes32 wethRoot = Merkle.getRoot(wethLeaves);

        // Fund the contract
        usdc.mint(address(claimContract), totalUsdc);
        weth.mint(address(claimContract), totalWeth);

        // Create round
        vm.prank(admin);
        claimContract.createRound(usdcRoot, wethRoot, totalUsdc, totalWeth);

        roundId = claimContract.roundCount() - 1;
    }

    // ─── Constructor ────────────────────────────────────────────────────

    function test_constructor() public view {
        assertEq(claimContract.admin(), admin);
        assertEq(address(claimContract.usdc()), address(usdc));
        assertEq(address(claimContract.weth()), address(weth));
        assertEq(claimContract.roundCount(), 0);
        assertEq(claimContract.paused(), false);
    }

    function test_constructor_revert_zeroAdmin() public {
        vm.expectRevert(StreamRecoveryClaim.ZeroAddress.selector);
        new StreamRecoveryClaim(address(0), address(usdc), address(weth));
    }

    function test_constructor_revert_zeroUsdc() public {
        vm.expectRevert(StreamRecoveryClaim.ZeroAddress.selector);
        new StreamRecoveryClaim(admin, address(0), address(weth));
    }

    function test_constructor_revert_zeroWeth() public {
        vm.expectRevert(StreamRecoveryClaim.ZeroAddress.selector);
        new StreamRecoveryClaim(admin, address(usdc), address(0));
    }

    // ─── Waiver ─────────────────────────────────────────────────────────

    function test_signWaiver() public {
        assertEq(claimContract.hasSignedWaiver(user1), false);

        _executeSignWaiver(user1Pk);

        assertEq(claimContract.hasSignedWaiver(user1), true);
    }

    function test_signWaiver_revert_wrongSigner() public {
        // user1 signs but user2 tries to submit
        (uint8 v, bytes32 r, bytes32 s) = _signWaiver(user1Pk);

        vm.prank(user2);
        vm.expectRevert(StreamRecoveryClaim.InvalidSignature.selector);
        claimContract.signWaiver(v, r, s);
    }

    function test_signWaiver_revert_paused() public {
        vm.prank(admin);
        claimContract.pause();

        (uint8 v, bytes32 r, bytes32 s) = _signWaiver(user1Pk);
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.IsPaused.selector);
        claimContract.signWaiver(v, r, s);
    }

    // ─── Round Creation ─────────────────────────────────────────────────

    function test_createRound() public {
        bytes32 usdcRoot = bytes32(uint256(1));
        bytes32 wethRoot = bytes32(uint256(2));
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(usdcRoot, wethRoot, 1000e6, 1e18);

        (
            bytes32 usdcMerkleRoot,
            bytes32 wethMerkleRoot,
            uint256 usdcTotal,
            uint256 wethTotal,
            uint256 usdcClaimed,
            uint256 wethClaimed,
            uint256 claimDeadline,
            bool active
        ) = claimContract.rounds(0);

        assertEq(usdcMerkleRoot, usdcRoot);
        assertEq(wethMerkleRoot, wethRoot);
        assertEq(usdcTotal, 1000e6);
        assertEq(wethTotal, 1e18);
        assertEq(usdcClaimed, 0);
        assertEq(wethClaimed, 0);
        assertEq(claimDeadline, block.timestamp + 365 days);
        assertTrue(active);
        assertEq(claimContract.roundCount(), 1);
    }

    function test_createRound_revert_notAdmin() public {
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.NotAdmin.selector);
        claimContract.createRound(bytes32(0), bytes32(0), 0, 0);
    }

    function test_createRound_revert_insufficientUsdc() public {
        // No tokens minted — should revert
        vm.prank(admin);
        vm.expectRevert(StreamRecoveryClaim.InsufficientBalance.selector);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 0);
    }

    function test_createRound_revert_insufficientWeth() public {
        usdc.mint(address(claimContract), 1000e6);
        vm.prank(admin);
        vm.expectRevert(StreamRecoveryClaim.InsufficientBalance.selector);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);
    }

    function test_createRound_revert_overallocation() public {
        // Fund 1000 USDC total
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 2e18);

        // Round 0: allocate 600 USDC, 1 WETH — OK
        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 600e6, 1e18);

        assertEq(claimContract.totalUsdcAllocated(), 600e6);
        assertEq(claimContract.totalWethAllocated(), 1e18);

        // Round 1: try to allocate 600 more USDC (total = 1200 > 1000) — REVERT
        vm.prank(admin);
        vm.expectRevert(StreamRecoveryClaim.InsufficientBalance.selector);
        claimContract.createRound(bytes32(uint256(3)), bytes32(uint256(4)), 600e6, 0.5e18);
    }

    function test_allocationTracking_acrossRounds() public {
        usdc.mint(address(claimContract), 2000e6);
        weth.mint(address(claimContract), 4e18);

        // Round 0: 1000 USDC, 2 WETH
        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 2e18);

        assertEq(claimContract.totalUsdcAllocated(), 1000e6);
        assertEq(claimContract.totalWethAllocated(), 2e18);

        // Round 1: 1000 USDC, 2 WETH — exactly uses up remaining balance
        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(3)), bytes32(uint256(4)), 1000e6, 2e18);

        assertEq(claimContract.totalUsdcAllocated(), 2000e6);
        assertEq(claimContract.totalWethAllocated(), 4e18);
    }

    function test_deactivateRound_releasesAllocation() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 2e18);

        // Create round
        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 2e18);

        assertEq(claimContract.totalUsdcAllocated(), 1000e6);
        assertEq(claimContract.totalWethAllocated(), 2e18);

        // Deactivate — should release allocation
        vm.prank(admin);
        claimContract.deactivateRound(0);

        assertEq(claimContract.totalUsdcAllocated(), 0);
        assertEq(claimContract.totalWethAllocated(), 0);

        // Now can create a new round with the same funds
        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(5)), bytes32(uint256(6)), 1000e6, 2e18);

        assertEq(claimContract.totalUsdcAllocated(), 1000e6);
    }

    function test_deactivateRound_revert_alreadyDeactivated() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        vm.prank(admin);
        claimContract.deactivateRound(0);

        vm.prank(admin);
        vm.expectRevert(StreamRecoveryClaim.RoundNotActive.selector);
        claimContract.deactivateRound(0);
    }

    function test_deactivateRound_partialClaim_releasesRemainder() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](2);
        usdcShares[0] = UsdcShare(user1, 0.6e18);
        usdcShares[1] = UsdcShare(user2, 0.4e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId, bytes32[] memory usdcLeaves,) =
            _setupRound(usdcShares, wethShares, 1000e6, 2e18);

        // user1 claims USDC (60%)
        _executeSignWaiver(user1Pk);
        bytes32[] memory proof = Merkle.getProof(usdcLeaves, 0);
        vm.prank(user1);
        claimContract.claimUsdc(roundId, 0.6e18, proof);

        assertEq(claimContract.totalUsdcAllocated(), 1000e6);

        // Deactivate — should only release unclaimed portion
        vm.prank(admin);
        claimContract.deactivateRound(roundId);

        // 600 USDC was claimed, 400 released; 2 WETH was unclaimed, 2 released
        assertEq(claimContract.totalUsdcAllocated(), 600e6);
        assertEq(claimContract.totalWethAllocated(), 0);
    }

    function test_sweepUnclaimed_releasesAllocation() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 2e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 2e18);

        assertEq(claimContract.totalUsdcAllocated(), 1000e6);

        // Warp past deadline and sweep
        vm.warp(block.timestamp + 366 days);
        address treasury = makeAddr("treasury");
        vm.prank(admin);
        claimContract.sweepUnclaimed(0, treasury);

        // All allocation released since nobody claimed
        assertEq(claimContract.totalUsdcAllocated(), 0);
        assertEq(claimContract.totalWethAllocated(), 0);
    }

    // ─── Claiming USDC ──────────────────────────────────────────────────

    function test_claimUsdc() public {
        // user1: 60% USDC share, user2: 40% USDC share
        UsdcShare[] memory usdcShares = new UsdcShare[](2);
        usdcShares[0] = UsdcShare(user1, 0.6e18);
        usdcShares[1] = UsdcShare(user2, 0.4e18);

        // Dummy WETH tree (user1: 100%)
        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId, bytes32[] memory usdcLeaves,) = _setupRound(usdcShares, wethShares, 1000e6, 2e18);

        _executeSignWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(usdcLeaves, 0);

        vm.prank(user1);
        claimContract.claimUsdc(roundId, 0.6e18, proof);

        // user1 gets: 60% of 1000 USDC = 600 USDC
        assertTrue(claimContract.hasClaimedUsdc(roundId, user1));
        assertFalse(claimContract.hasClaimedWeth(roundId, user1)); // WETH not claimed
        assertEq(usdc.balanceOf(user1), 600e6);
        assertEq(weth.balanceOf(user1), 0); // No WETH claimed
    }

    function test_claimWeth() public {
        // Dummy USDC tree (user1: 100%)
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        // user1: 40% WETH, user2: 60% WETH
        WethShare[] memory wethShares = new WethShare[](2);
        wethShares[0] = WethShare(user1, 0.4e18);
        wethShares[1] = WethShare(user2, 0.6e18);

        (uint256 roundId,, bytes32[] memory wethLeaves) = _setupRound(usdcShares, wethShares, 1000e6, 5e18);

        _executeSignWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(wethLeaves, 0);

        vm.prank(user1);
        claimContract.claimWeth(roundId, 0.4e18, proof);

        // user1 gets: 40% of 5 WETH = 2 WETH
        assertTrue(claimContract.hasClaimedWeth(roundId, user1));
        assertFalse(claimContract.hasClaimedUsdc(roundId, user1)); // USDC not claimed
        assertEq(weth.balanceOf(user1), 2e18);
        assertEq(usdc.balanceOf(user1), 0); // No USDC claimed
    }

    // ─── Claim Both (convenience) ───────────────────────────────────────

    function test_claimBoth() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](2);
        usdcShares[0] = UsdcShare(user1, 0.6e18);
        usdcShares[1] = UsdcShare(user2, 0.4e18);

        WethShare[] memory wethShares = new WethShare[](2);
        wethShares[0] = WethShare(user1, 0.3e18);
        wethShares[1] = WethShare(user2, 0.7e18);

        (uint256 roundId, bytes32[] memory usdcLeaves, bytes32[] memory wethLeaves) =
            _setupRound(usdcShares, wethShares, 1000e6, 5e18);

        _executeSignWaiver(user1Pk);

        bytes32[] memory usdcProof = Merkle.getProof(usdcLeaves, 0);
        bytes32[] memory wethProof = Merkle.getProof(wethLeaves, 0);

        vm.prank(user1);
        claimContract.claimBoth(roundId, 0.6e18, usdcProof, 0.3e18, wethProof);

        assertTrue(claimContract.hasClaimedUsdc(roundId, user1));
        assertTrue(claimContract.hasClaimedWeth(roundId, user1));
        assertEq(usdc.balanceOf(user1), 600e6);   // 60% of 1000 USDC
        assertEq(weth.balanceOf(user1), 1.5e18);    // 30% of 5 WETH
    }

    // ─── Independent Claim Tracking ─────────────────────────────────────

    function test_independentClaimTracking() public {
        // user1 is in both trees; claiming USDC should NOT block WETH claim
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId, bytes32[] memory usdcLeaves, bytes32[] memory wethLeaves) =
            _setupRound(usdcShares, wethShares, 1000e6, 2e18);

        _executeSignWaiver(user1Pk);

        // Claim USDC first
        bytes32[] memory usdcProof = Merkle.getProof(usdcLeaves, 0);
        vm.prank(user1);
        claimContract.claimUsdc(roundId, 1e18, usdcProof);

        assertTrue(claimContract.hasClaimedUsdc(roundId, user1));
        assertFalse(claimContract.hasClaimedWeth(roundId, user1));
        assertEq(usdc.balanceOf(user1), 1000e6);

        // Now claim WETH — should succeed
        bytes32[] memory wethProof = Merkle.getProof(wethLeaves, 0);
        vm.prank(user1);
        claimContract.claimWeth(roundId, 1e18, wethProof);

        assertTrue(claimContract.hasClaimedWeth(roundId, user1));
        assertEq(weth.balanceOf(user1), 2e18);
    }

    // ─── USDC-only user cannot claim WETH ───────────────────────────────

    function test_usdcOnlyUser_cannotClaimWeth() public {
        // user1 is in USDC tree only, user2 is in WETH tree only
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user2, 1e18);

        (uint256 roundId, bytes32[] memory usdcLeaves, bytes32[] memory wethLeaves) =
            _setupRound(usdcShares, wethShares, 1000e6, 2e18);

        _executeSignWaiver(user1Pk);

        // user1 can claim USDC
        bytes32[] memory usdcProof = Merkle.getProof(usdcLeaves, 0);
        vm.prank(user1);
        claimContract.claimUsdc(roundId, 1e18, usdcProof);
        assertEq(usdc.balanceOf(user1), 1000e6);

        // user1 tries to claim WETH — should fail (not in WETH tree)
        bytes32[] memory wethProof = Merkle.getProof(wethLeaves, 0);
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.InvalidProof.selector);
        claimContract.claimWeth(roundId, 1e18, wethProof);
    }

    // ─── Claim Reverts ──────────────────────────────────────────────────

    function test_claimUsdc_revert_noWaiver() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 0.5e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 0.5e18);

        (uint256 roundId, bytes32[] memory usdcLeaves,) = _setupRound(usdcShares, wethShares, 500e6, 0.5e18);

        bytes32[] memory proof = Merkle.getProof(usdcLeaves, 0);

        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.WaiverNotSigned.selector);
        claimContract.claimUsdc(roundId, 0.5e18, proof);
    }

    function test_claimUsdc_revert_alreadyClaimed() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 0.5e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 0.5e18);

        (uint256 roundId, bytes32[] memory usdcLeaves,) = _setupRound(usdcShares, wethShares, 500e6, 0.5e18);
        _executeSignWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(usdcLeaves, 0);
        vm.prank(user1);
        claimContract.claimUsdc(roundId, 0.5e18, proof);

        // Try again
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.AlreadyClaimed.selector);
        claimContract.claimUsdc(roundId, 0.5e18, proof);
    }

    function test_claimWeth_revert_alreadyClaimed() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId,, bytes32[] memory wethLeaves) = _setupRound(usdcShares, wethShares, 500e6, 1e18);
        _executeSignWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(wethLeaves, 0);
        vm.prank(user1);
        claimContract.claimWeth(roundId, 1e18, proof);

        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.AlreadyClaimed.selector);
        claimContract.claimWeth(roundId, 1e18, proof);
    }

    function test_claimUsdc_revert_invalidProof() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](2);
        usdcShares[0] = UsdcShare(user1, 0.6e18);
        usdcShares[1] = UsdcShare(user2, 0.4e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId, bytes32[] memory usdcLeaves,) = _setupRound(usdcShares, wethShares, 800e6, 0.8e18);
        _executeSignWaiver(user1Pk);

        // Use proof for user2 but claim as user1
        bytes32[] memory proof = Merkle.getProof(usdcLeaves, 1);

        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.InvalidProof.selector);
        claimContract.claimUsdc(roundId, 0.6e18, proof);
    }

    function test_claimUsdc_revert_wrongShare() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 0.5e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId, bytes32[] memory usdcLeaves,) = _setupRound(usdcShares, wethShares, 500e6, 0.5e18);
        _executeSignWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(usdcLeaves, 0);

        // Try to claim with inflated share
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.InvalidProof.selector);
        claimContract.claimUsdc(roundId, 0.9e18, proof);
    }

    function test_claimUsdc_revert_roundDeactivated() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 0.5e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId, bytes32[] memory usdcLeaves,) = _setupRound(usdcShares, wethShares, 500e6, 0.5e18);
        _executeSignWaiver(user1Pk);

        vm.prank(admin);
        claimContract.deactivateRound(roundId);

        bytes32[] memory proof = Merkle.getProof(usdcLeaves, 0);
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.RoundNotActive.selector);
        claimContract.claimUsdc(roundId, 0.5e18, proof);
    }

    function test_claimUsdc_revert_paused() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 0.5e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId, bytes32[] memory usdcLeaves,) = _setupRound(usdcShares, wethShares, 500e6, 0.5e18);
        _executeSignWaiver(user1Pk);

        vm.prank(admin);
        claimContract.pause();

        bytes32[] memory proof = Merkle.getProof(usdcLeaves, 0);
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.IsPaused.selector);
        claimContract.claimUsdc(roundId, 0.5e18, proof);
    }

    // ─── Share math ──────────────────────────────────────────────────────

    function test_shareMath_twoUsers() public {
        // user1: 30% USDC, 70% WETH
        // user2: 70% USDC, 30% WETH
        UsdcShare[] memory usdcShares = new UsdcShare[](2);
        usdcShares[0] = UsdcShare(user1, 0.3e18);
        usdcShares[1] = UsdcShare(user2, 0.7e18);

        WethShare[] memory wethShares = new WethShare[](2);
        wethShares[0] = WethShare(user1, 0.7e18);
        wethShares[1] = WethShare(user2, 0.3e18);

        (uint256 roundId, bytes32[] memory usdcLeaves, bytes32[] memory wethLeaves) =
            _setupRound(usdcShares, wethShares, 10_000e6, 5e18);

        _executeSignWaiver(user1Pk);
        _executeSignWaiver(user2Pk);

        // user1 claims both
        bytes32[] memory usdcProof1 = Merkle.getProof(usdcLeaves, 0);
        bytes32[] memory wethProof1 = Merkle.getProof(wethLeaves, 0);
        vm.prank(user1);
        claimContract.claimBoth(roundId, 0.3e18, usdcProof1, 0.7e18, wethProof1);

        assertEq(usdc.balanceOf(user1), 3000e6);  // 30% of 10,000
        assertEq(weth.balanceOf(user1), 3.5e18);   // 70% of 5

        // user2 claims both
        bytes32[] memory usdcProof2 = Merkle.getProof(usdcLeaves, 1);
        bytes32[] memory wethProof2 = Merkle.getProof(wethLeaves, 1);
        vm.prank(user2);
        claimContract.claimBoth(roundId, 0.7e18, usdcProof2, 0.3e18, wethProof2);

        assertEq(usdc.balanceOf(user2), 7000e6);  // 70% of 10,000
        assertEq(weth.balanceOf(user2), 1.5e18);   // 30% of 5
    }

    // ─── Multi-Claim (same proof, different rounds) ──────────────────────

    function test_claimMultipleUsdc_sameRoot() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 0.5e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        bytes32[] memory usdcLeaves = new bytes32[](1);
        usdcLeaves[0] = _createLeaf(user1, 0.5e18);
        bytes32 usdcRoot = Merkle.getRoot(usdcLeaves);

        bytes32[] memory wethLeaves = new bytes32[](1);
        wethLeaves[0] = _createLeaf(user1, 1e18);
        bytes32 wethRoot = Merkle.getRoot(wethLeaves);

        // Round 0: 1000 USDC, 1 WETH
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);
        vm.prank(admin);
        claimContract.createRound(usdcRoot, wethRoot, 1000e6, 1e18);

        // Round 1: 2000 USDC, 3 WETH (second recovery)
        usdc.mint(address(claimContract), 2000e6);
        weth.mint(address(claimContract), 3e18);
        vm.prank(admin);
        claimContract.createRound(usdcRoot, wethRoot, 2000e6, 3e18);

        _executeSignWaiver(user1Pk);

        uint256[] memory roundIds = new uint256[](2);
        roundIds[0] = 0;
        roundIds[1] = 1;

        bytes32[] memory proof = Merkle.getProof(usdcLeaves, 0);

        vm.prank(user1);
        claimContract.claimMultipleUsdc(roundIds, 0.5e18, proof);

        // Round 0: 50% of 1000 USDC = 500
        // Round 1: 50% of 2000 USDC = 1000
        // Total: 1500 USDC
        assertEq(usdc.balanceOf(user1), 1500e6);
        assertTrue(claimContract.hasClaimedUsdc(0, user1));
        assertTrue(claimContract.hasClaimedUsdc(1, user1));
        // WETH still unclaimed
        assertFalse(claimContract.hasClaimedWeth(0, user1));
        assertFalse(claimContract.hasClaimedWeth(1, user1));
    }

    function test_claimMultipleWeth_sameRoot() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 0.5e18);

        bytes32[] memory usdcLeaves = new bytes32[](1);
        usdcLeaves[0] = _createLeaf(user1, 1e18);
        bytes32 usdcRoot = Merkle.getRoot(usdcLeaves);

        bytes32[] memory wethLeaves = new bytes32[](1);
        wethLeaves[0] = _createLeaf(user1, 0.5e18);
        bytes32 wethRoot = Merkle.getRoot(wethLeaves);

        // Round 0: 500 USDC, 2 WETH
        usdc.mint(address(claimContract), 500e6);
        weth.mint(address(claimContract), 2e18);
        vm.prank(admin);
        claimContract.createRound(usdcRoot, wethRoot, 500e6, 2e18);

        // Round 1: 500 USDC, 4 WETH
        usdc.mint(address(claimContract), 500e6);
        weth.mint(address(claimContract), 4e18);
        vm.prank(admin);
        claimContract.createRound(usdcRoot, wethRoot, 500e6, 4e18);

        _executeSignWaiver(user1Pk);

        uint256[] memory roundIds = new uint256[](2);
        roundIds[0] = 0;
        roundIds[1] = 1;

        bytes32[] memory proof = Merkle.getProof(wethLeaves, 0);

        vm.prank(user1);
        claimContract.claimMultipleWeth(roundIds, 0.5e18, proof);

        // Round 0: 50% of 2 WETH = 1 WETH
        // Round 1: 50% of 4 WETH = 2 WETH
        // Total: 3 WETH
        assertEq(weth.balanceOf(user1), 3e18);
        assertTrue(claimContract.hasClaimedWeth(0, user1));
        assertTrue(claimContract.hasClaimedWeth(1, user1));
        // USDC still unclaimed
        assertFalse(claimContract.hasClaimedUsdc(0, user1));
    }

    // ─── Sweep ──────────────────────────────────────────────────────────

    function test_sweepUnclaimed() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](2);
        usdcShares[0] = UsdcShare(user1, 0.6e18);
        usdcShares[1] = UsdcShare(user2, 0.4e18);

        WethShare[] memory wethShares = new WethShare[](2);
        wethShares[0] = WethShare(user1, 0.6e18);
        wethShares[1] = WethShare(user2, 0.4e18);

        (uint256 roundId,,) = _setupRound(usdcShares, wethShares, 800e6, 0.8e18);

        // Warp past deadline
        vm.warp(block.timestamp + 366 days);

        address treasury = makeAddr("treasury");
        vm.prank(admin);
        claimContract.sweepUnclaimed(roundId, treasury);

        // All funds swept since nobody claimed
        assertEq(usdc.balanceOf(treasury), 800e6);
        assertEq(weth.balanceOf(treasury), 0.8e18);
    }

    function test_sweepUnclaimed_partial() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](2);
        usdcShares[0] = UsdcShare(user1, 0.6e18);
        usdcShares[1] = UsdcShare(user2, 0.4e18);

        WethShare[] memory wethShares = new WethShare[](2);
        wethShares[0] = WethShare(user1, 0.6e18);
        wethShares[1] = WethShare(user2, 0.4e18);

        (uint256 roundId, bytes32[] memory usdcLeaves, bytes32[] memory wethLeaves) =
            _setupRound(usdcShares, wethShares, 1000e6, 1e18);

        // User1 claims both (60%)
        _executeSignWaiver(user1Pk);
        bytes32[] memory usdcProof = Merkle.getProof(usdcLeaves, 0);
        bytes32[] memory wethProof = Merkle.getProof(wethLeaves, 0);
        vm.prank(user1);
        claimContract.claimBoth(roundId, 0.6e18, usdcProof, 0.6e18, wethProof);

        assertEq(usdc.balanceOf(user1), 600e6);
        assertEq(weth.balanceOf(user1), 0.6e18);

        // Warp past deadline
        vm.warp(block.timestamp + 366 days);

        address treasury = makeAddr("treasury");
        vm.prank(admin);
        claimContract.sweepUnclaimed(roundId, treasury);

        // User2's unclaimed portion swept (40%)
        assertEq(usdc.balanceOf(treasury), 400e6);
        assertEq(weth.balanceOf(treasury), 0.4e18);
    }

    function test_sweepUnclaimed_revert_beforeDeadline() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId,,) = _setupRound(usdcShares, wethShares, 500e6, 0.5e18);

        address treasury = makeAddr("treasury");
        vm.prank(admin);
        vm.expectRevert(StreamRecoveryClaim.DeadlineNotReached.selector);
        claimContract.sweepUnclaimed(roundId, treasury);
    }

    // ─── Admin Transfer ─────────────────────────────────────────────────

    function test_transferAdmin() public {
        address newAdmin = makeAddr("newAdmin");

        vm.prank(admin);
        claimContract.transferAdmin(newAdmin);

        assertEq(claimContract.pendingAdmin(), newAdmin);
        assertEq(claimContract.admin(), admin); // Not changed yet

        vm.prank(newAdmin);
        claimContract.acceptAdmin();

        assertEq(claimContract.admin(), newAdmin);
        assertEq(claimContract.pendingAdmin(), address(0));
    }

    // ─── canClaimUsdc / canClaimWeth Views ──────────────────────────────

    function test_canClaimUsdc() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 0.5e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId, bytes32[] memory usdcLeaves,) = _setupRound(usdcShares, wethShares, 1000e6, 2e18);
        bytes32[] memory proof = Merkle.getProof(usdcLeaves, 0);

        // Before signing waiver
        (bool eligible,) = claimContract.canClaimUsdc(roundId, user1, 0.5e18, proof);
        assertFalse(eligible);

        // After signing waiver
        _executeSignWaiver(user1Pk);
        (bool eligible2, uint256 usdcAmt) = claimContract.canClaimUsdc(roundId, user1, 0.5e18, proof);
        assertTrue(eligible2);
        assertEq(usdcAmt, 500e6);   // 50% of 1000 USDC

        // After claiming
        vm.prank(user1);
        claimContract.claimUsdc(roundId, 0.5e18, proof);
        (bool eligible3,) = claimContract.canClaimUsdc(roundId, user1, 0.5e18, proof);
        assertFalse(eligible3);
    }

    function test_canClaimWeth() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 0.5e18);

        (uint256 roundId,, bytes32[] memory wethLeaves) = _setupRound(usdcShares, wethShares, 1000e6, 4e18);
        bytes32[] memory proof = Merkle.getProof(wethLeaves, 0);

        _executeSignWaiver(user1Pk);
        (bool eligible, uint256 wethAmt) = claimContract.canClaimWeth(roundId, user1, 0.5e18, proof);
        assertTrue(eligible);
        assertEq(wethAmt, 2e18);   // 50% of 4 WETH

        // After claiming
        vm.prank(user1);
        claimContract.claimWeth(roundId, 0.5e18, proof);
        (bool eligible2,) = claimContract.canClaimWeth(roundId, user1, 0.5e18, proof);
        assertFalse(eligible2);
    }

    // ─── WETH Claim Reverts (parity with USDC) ──────────────────────────

    function test_claimWeth_revert_noWaiver() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 0.5e18);

        (uint256 roundId,, bytes32[] memory wethLeaves) = _setupRound(usdcShares, wethShares, 500e6, 0.5e18);

        bytes32[] memory proof = Merkle.getProof(wethLeaves, 0);

        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.WaiverNotSigned.selector);
        claimContract.claimWeth(roundId, 0.5e18, proof);
    }

    function test_claimWeth_revert_roundDeactivated() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 0.5e18);

        (uint256 roundId,, bytes32[] memory wethLeaves) = _setupRound(usdcShares, wethShares, 500e6, 0.5e18);
        _executeSignWaiver(user1Pk);

        vm.prank(admin);
        claimContract.deactivateRound(roundId);

        bytes32[] memory proof = Merkle.getProof(wethLeaves, 0);
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.RoundNotActive.selector);
        claimContract.claimWeth(roundId, 0.5e18, proof);
    }

    function test_claimWeth_revert_paused() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 0.5e18);

        (uint256 roundId,, bytes32[] memory wethLeaves) = _setupRound(usdcShares, wethShares, 500e6, 0.5e18);
        _executeSignWaiver(user1Pk);

        vm.prank(admin);
        claimContract.pause();

        bytes32[] memory proof = Merkle.getProof(wethLeaves, 0);
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.IsPaused.selector);
        claimContract.claimWeth(roundId, 0.5e18, proof);
    }

    // ─── Access Control Reverts ──────────────────────────────────────────

    function test_deactivateRound_revert_notAdmin() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.NotAdmin.selector);
        claimContract.deactivateRound(0);
    }

    function test_sweepUnclaimed_revert_notAdmin() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        vm.warp(block.timestamp + 366 days);

        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.NotAdmin.selector);
        claimContract.sweepUnclaimed(0, user1);
    }

    function test_sweepUnclaimed_revert_zeroAddress() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        vm.warp(block.timestamp + 366 days);

        vm.prank(admin);
        vm.expectRevert(StreamRecoveryClaim.ZeroAddress.selector);
        claimContract.sweepUnclaimed(0, address(0));
    }

    function test_sweepUnclaimed_afterDeactivate() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        // Deactivate first — releases allocation
        vm.prank(admin);
        claimContract.deactivateRound(0);
        assertEq(claimContract.totalUsdcAllocated(), 0);
        assertEq(claimContract.totalWethAllocated(), 0);

        // Sweep past deadline — should succeed and transfer the tokens
        vm.warp(block.timestamp + 366 days);
        address treasury = makeAddr("treasury");
        vm.prank(admin);
        claimContract.sweepUnclaimed(0, treasury);

        assertEq(usdc.balanceOf(treasury), 1000e6);
        assertEq(weth.balanceOf(treasury), 1e18);
        assertTrue(claimContract.swept(0));
    }

    function test_pause_revert_notAdmin() public {
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.NotAdmin.selector);
        claimContract.pause();
    }

    function test_unpause_revert_notAdmin() public {
        vm.prank(admin);
        claimContract.pause();

        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.NotAdmin.selector);
        claimContract.unpause();
    }

    function test_transferAdmin_revert_notAdmin() public {
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.NotAdmin.selector);
        claimContract.transferAdmin(user1);
    }

    function test_transferAdmin_revert_zeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(StreamRecoveryClaim.ZeroAddress.selector);
        claimContract.transferAdmin(address(0));
    }

    function test_acceptAdmin_revert_notPending() public {
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.NotAdmin.selector);
        claimContract.acceptAdmin();
    }

    // ─── Event Emission Tests ────────────────────────────────────────────

    function test_event_RoundCreated() public {
        bytes32 usdcRoot = bytes32(uint256(1));
        bytes32 wethRoot = bytes32(uint256(2));
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.expectEmit(true, false, false, true);
        emit StreamRecoveryClaim.RoundCreated(0, usdcRoot, wethRoot, 1000e6, 1e18);

        vm.prank(admin);
        claimContract.createRound(usdcRoot, wethRoot, 1000e6, 1e18);
    }

    function test_event_WaiverSigned() public {
        vm.expectEmit(true, false, false, false);
        emit StreamRecoveryClaim.WaiverSigned(user1);

        _executeSignWaiver(user1Pk);
    }

    function test_event_UsdcClaimed() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId, bytes32[] memory usdcLeaves,) =
            _setupRound(usdcShares, wethShares, 1000e6, 1e18);

        _executeSignWaiver(user1Pk);
        bytes32[] memory proof = Merkle.getProof(usdcLeaves, 0);

        vm.expectEmit(true, true, false, true);
        emit StreamRecoveryClaim.UsdcClaimed(roundId, user1, 1000e6);

        vm.prank(user1);
        claimContract.claimUsdc(roundId, 1e18, proof);
    }

    function test_event_WethClaimed() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId,, bytes32[] memory wethLeaves) =
            _setupRound(usdcShares, wethShares, 1000e6, 2e18);

        _executeSignWaiver(user1Pk);
        bytes32[] memory proof = Merkle.getProof(wethLeaves, 0);

        vm.expectEmit(true, true, false, true);
        emit StreamRecoveryClaim.WethClaimed(roundId, user1, 2e18);

        vm.prank(user1);
        claimContract.claimWeth(roundId, 1e18, proof);
    }

    function test_event_RoundDeactivated() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        vm.expectEmit(true, false, false, false);
        emit StreamRecoveryClaim.RoundDeactivated(0);

        vm.prank(admin);
        claimContract.deactivateRound(0);
    }

    function test_event_UnclaimedSwept() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        vm.warp(block.timestamp + 366 days);
        address treasury = makeAddr("treasury");

        vm.expectEmit(true, false, false, true);
        emit StreamRecoveryClaim.UnclaimedSwept(0, 1000e6, 1e18);

        vm.prank(admin);
        claimContract.sweepUnclaimed(0, treasury);
    }

    function test_event_AdminTransferStarted() public {
        address newAdmin = makeAddr("newAdmin");

        vm.expectEmit(true, true, false, false);
        emit StreamRecoveryClaim.AdminTransferStarted(admin, newAdmin);

        vm.prank(admin);
        claimContract.transferAdmin(newAdmin);
    }

    function test_event_AdminTransferred() public {
        address newAdmin = makeAddr("newAdmin");

        vm.prank(admin);
        claimContract.transferAdmin(newAdmin);

        vm.expectEmit(true, true, false, false);
        emit StreamRecoveryClaim.AdminTransferred(admin, newAdmin);

        vm.prank(newAdmin);
        claimContract.acceptAdmin();
    }

    function test_event_Paused() public {
        vm.expectEmit(true, false, false, false);
        emit StreamRecoveryClaim.Paused(admin);

        vm.prank(admin);
        claimContract.pause();
    }

    function test_event_Unpaused() public {
        vm.prank(admin);
        claimContract.pause();

        vm.expectEmit(true, false, false, false);
        emit StreamRecoveryClaim.Unpaused(admin);

        vm.prank(admin);
        claimContract.unpause();
    }

    // ─── Invariant-style Tests ───────────────────────────────────────────

    /// @dev totalAllocated must never exceed contract balance
    function test_invariant_allocatedNeverExceedsBalance() public {
        usdc.mint(address(claimContract), 3000e6);
        weth.mint(address(claimContract), 6e18);

        // Create 3 rounds
        vm.startPrank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 2e18);
        claimContract.createRound(bytes32(uint256(3)), bytes32(uint256(4)), 1000e6, 2e18);
        claimContract.createRound(bytes32(uint256(5)), bytes32(uint256(6)), 1000e6, 2e18);
        vm.stopPrank();

        assertEq(claimContract.totalUsdcAllocated(), 3000e6);
        assertEq(claimContract.totalWethAllocated(), 6e18);

        // Invariant: allocated <= balance
        assertLe(claimContract.totalUsdcAllocated(), usdc.balanceOf(address(claimContract)));
        assertLe(claimContract.totalWethAllocated(), weth.balanceOf(address(claimContract)));

        // Deactivate round 1 — should reduce allocation
        vm.prank(admin);
        claimContract.deactivateRound(1);

        assertEq(claimContract.totalUsdcAllocated(), 2000e6);
        assertLe(claimContract.totalUsdcAllocated(), usdc.balanceOf(address(claimContract)));
        assertLe(claimContract.totalWethAllocated(), weth.balanceOf(address(claimContract)));
    }

    /// @dev claimed must never exceed total for any round (4 users, power-of-2 tree)
    function test_invariant_claimedNeverExceedsTotal() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](4);
        usdcShares[0] = UsdcShare(user1, 0.25e18);
        usdcShares[1] = UsdcShare(user2, 0.25e18);
        usdcShares[2] = UsdcShare(user3, 0.25e18);
        usdcShares[3] = UsdcShare(user4, 0.25e18);

        WethShare[] memory wethShares = new WethShare[](4);
        wethShares[0] = WethShare(user1, 0.25e18);
        wethShares[1] = WethShare(user2, 0.25e18);
        wethShares[2] = WethShare(user3, 0.25e18);
        wethShares[3] = WethShare(user4, 0.25e18);

        (uint256 roundId, bytes32[] memory usdcLeaves, bytes32[] memory wethLeaves) =
            _setupRound(usdcShares, wethShares, 1000e6, 4e18);

        _executeSignWaiver(user1Pk);
        _executeSignWaiver(user2Pk);
        _executeSignWaiver(user3Pk);
        _executeSignWaiver(user4Pk);

        // user1 claims
        vm.prank(user1);
        claimContract.claimBoth(
            roundId,
            0.25e18,
            Merkle.getProof(usdcLeaves, 0),
            0.25e18,
            Merkle.getProof(wethLeaves, 0)
        );

        (,,, , uint256 usdcClaimed1, uint256 wethClaimed1,,) = claimContract.rounds(roundId);
        assertLe(usdcClaimed1, 1000e6);
        assertLe(wethClaimed1, 4e18);

        // user2 claims
        vm.prank(user2);
        claimContract.claimBoth(
            roundId,
            0.25e18,
            Merkle.getProof(usdcLeaves, 1),
            0.25e18,
            Merkle.getProof(wethLeaves, 1)
        );

        (,,,, uint256 usdcClaimed2, uint256 wethClaimed2,,) = claimContract.rounds(roundId);
        assertLe(usdcClaimed2, 1000e6);
        assertLe(wethClaimed2, 4e18);

        // user3 claims
        vm.prank(user3);
        claimContract.claimBoth(
            roundId,
            0.25e18,
            Merkle.getProof(usdcLeaves, 2),
            0.25e18,
            Merkle.getProof(wethLeaves, 2)
        );

        (,,,, uint256 usdcClaimed3, uint256 wethClaimed3,,) = claimContract.rounds(roundId);
        assertLe(usdcClaimed3, 1000e6);
        assertLe(wethClaimed3, 4e18);

        // user4 claims
        vm.prank(user4);
        claimContract.claimBoth(
            roundId,
            0.25e18,
            Merkle.getProof(usdcLeaves, 3),
            0.25e18,
            Merkle.getProof(wethLeaves, 3)
        );

        (,,,, uint256 usdcClaimed4, uint256 wethClaimed4,,) = claimContract.rounds(roundId);
        assertLe(usdcClaimed4, 1000e6);
        assertLe(wethClaimed4, 4e18);

        // All claimed — verify totals
        uint256 totalUsdcUsers = usdc.balanceOf(user1) + usdc.balanceOf(user2)
            + usdc.balanceOf(user3) + usdc.balanceOf(user4);
        uint256 totalWethUsers = weth.balanceOf(user1) + weth.balanceOf(user2)
            + weth.balanceOf(user3) + weth.balanceOf(user4);
        assertEq(totalUsdcUsers, usdcClaimed4);
        assertEq(totalWethUsers, wethClaimed4);
    }

    // ─── Sweep: Double-Sweep Prevention ─────────────────────────────────

    function test_sweepUnclaimed_revert_alreadySwept() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        vm.warp(block.timestamp + 366 days);
        address treasury = makeAddr("treasury");

        vm.prank(admin);
        claimContract.sweepUnclaimed(0, treasury);

        // Second sweep should revert
        vm.prank(admin);
        vm.expectRevert(StreamRecoveryClaim.AlreadySwept.selector);
        claimContract.sweepUnclaimed(0, treasury);
    }

    // ─── Sweep: Deactivate then sweep with partial claims ─────────────

    function test_sweepUnclaimed_afterDeactivate_partialClaim() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](2);
        usdcShares[0] = UsdcShare(user1, 0.6e18);
        usdcShares[1] = UsdcShare(user2, 0.4e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId, bytes32[] memory usdcLeaves,) =
            _setupRound(usdcShares, wethShares, 1000e6, 2e18);

        // user1 claims USDC (60%)
        _executeSignWaiver(user1Pk);
        bytes32[] memory proof = Merkle.getProof(usdcLeaves, 0);
        vm.prank(user1);
        claimContract.claimUsdc(roundId, 0.6e18, proof);

        // Deactivate
        vm.prank(admin);
        claimContract.deactivateRound(roundId);

        // Sweep past deadline — should transfer only unclaimed portions
        vm.warp(block.timestamp + 366 days);
        address treasury = makeAddr("treasury");
        vm.prank(admin);
        claimContract.sweepUnclaimed(roundId, treasury);

        // user1 got 600 USDC, treasury gets remaining 400 USDC + 2 WETH
        assertEq(usdc.balanceOf(user1), 600e6);
        assertEq(usdc.balanceOf(treasury), 400e6);
        assertEq(weth.balanceOf(treasury), 2e18);
    }

    // ─── Rescue Token ────────────────────────────────────────────────────

    function test_rescueToken_excessUsdc() public {
        usdc.mint(address(claimContract), 2000e6);
        weth.mint(address(claimContract), 1e18);

        // Allocate 1000 USDC in a round
        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        // Rescue the 1000 excess USDC
        address treasury = makeAddr("treasury");
        vm.prank(admin);
        claimContract.rescueToken(address(usdc), treasury, 1000e6);

        assertEq(usdc.balanceOf(treasury), 1000e6);
        // Allocated funds remain
        assertEq(usdc.balanceOf(address(claimContract)), 1000e6);
    }

    function test_rescueToken_excessWeth() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 5e18);

        // Allocate 2 WETH in a round
        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 2e18);

        // Rescue the 3 excess WETH
        address treasury = makeAddr("treasury");
        vm.prank(admin);
        claimContract.rescueToken(address(weth), treasury, 3e18);

        assertEq(weth.balanceOf(treasury), 3e18);
        assertEq(weth.balanceOf(address(claimContract)), 2e18);
    }

    function test_rescueToken_otherToken() public {
        ERC20Mock randomToken = new ERC20Mock("Random", "RND", 18);
        randomToken.mint(address(claimContract), 100e18);

        address treasury = makeAddr("treasury");
        vm.prank(admin);
        claimContract.rescueToken(address(randomToken), treasury, 100e18);

        assertEq(randomToken.balanceOf(treasury), 100e18);
        assertEq(randomToken.balanceOf(address(claimContract)), 0);
    }

    function test_rescueToken_revert_exceedsRescuableUsdc() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        // Try to rescue allocated USDC — should revert
        vm.prank(admin);
        vm.expectRevert("Exceeds rescuable USDC");
        claimContract.rescueToken(address(usdc), admin, 1);
    }

    function test_rescueToken_revert_exceedsRescuableWeth() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        // Try to rescue allocated WETH — should revert
        vm.prank(admin);
        vm.expectRevert("Exceeds rescuable WETH");
        claimContract.rescueToken(address(weth), admin, 1);
    }

    function test_rescueToken_revert_notAdmin() public {
        usdc.mint(address(claimContract), 1000e6);

        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.NotAdmin.selector);
        claimContract.rescueToken(address(usdc), user1, 1000e6);
    }

    function test_rescueToken_revert_zeroAddress() public {
        usdc.mint(address(claimContract), 1000e6);

        vm.prank(admin);
        vm.expectRevert(StreamRecoveryClaim.ZeroAddress.selector);
        claimContract.rescueToken(address(usdc), address(0), 1000e6);
    }

    function test_event_TokenRescued() public {
        ERC20Mock randomToken = new ERC20Mock("Random", "RND", 18);
        randomToken.mint(address(claimContract), 50e18);

        address treasury = makeAddr("treasury");

        vm.expectEmit(true, true, false, true);
        emit StreamRecoveryClaim.TokenRescued(address(randomToken), treasury, 50e18);

        vm.prank(admin);
        claimContract.rescueToken(address(randomToken), treasury, 50e18);
    }

    // ─── Batch Claim: Bounds Check ───────────────────────────────────────

    function test_claimMultipleUsdc_revert_emptyArray() public {
        _executeSignWaiver(user1Pk);

        uint256[] memory roundIds = new uint256[](0);
        bytes32[] memory proof = new bytes32[](0);

        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.NoRounds.selector);
        claimContract.claimMultipleUsdc(roundIds, 0.5e18, proof);
    }

    function test_claimMultipleWeth_revert_emptyArray() public {
        _executeSignWaiver(user1Pk);

        uint256[] memory roundIds = new uint256[](0);
        bytes32[] memory proof = new bytes32[](0);

        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.NoRounds.selector);
        claimContract.claimMultipleWeth(roundIds, 0.5e18, proof);
    }

    function test_claimMultipleUsdc_revert_tooManyRounds() public {
        _executeSignWaiver(user1Pk);

        uint256[] memory roundIds = new uint256[](51);
        bytes32[] memory proof = new bytes32[](0);

        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.TooManyRounds.selector);
        claimContract.claimMultipleUsdc(roundIds, 0.5e18, proof);
    }

    function test_claimMultipleWeth_revert_tooManyRounds() public {
        _executeSignWaiver(user1Pk);

        uint256[] memory roundIds = new uint256[](51);
        bytes32[] memory proof = new bytes32[](0);

        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.TooManyRounds.selector);
        claimContract.claimMultipleWeth(roundIds, 0.5e18, proof);
    }

    /// @dev Asset conservation: contract balance must decrease by exactly claimed amounts
    function test_invariant_assetConservation() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](2);
        usdcShares[0] = UsdcShare(user1, 0.6e18);
        usdcShares[1] = UsdcShare(user2, 0.4e18);

        WethShare[] memory wethShares = new WethShare[](2);
        wethShares[0] = WethShare(user1, 0.6e18);
        wethShares[1] = WethShare(user2, 0.4e18);

        (uint256 roundId, bytes32[] memory usdcLeaves, bytes32[] memory wethLeaves) =
            _setupRound(usdcShares, wethShares, 1000e6, 2e18);

        uint256 usdcBefore = usdc.balanceOf(address(claimContract));
        uint256 wethBefore = weth.balanceOf(address(claimContract));

        _executeSignWaiver(user1Pk);
        bytes32[] memory usdcProof = Merkle.getProof(usdcLeaves, 0);
        bytes32[] memory wethProof = Merkle.getProof(wethLeaves, 0);

        vm.prank(user1);
        claimContract.claimBoth(roundId, 0.6e18, usdcProof, 0.6e18, wethProof);

        uint256 usdcAfter = usdc.balanceOf(address(claimContract));
        uint256 wethAfter = weth.balanceOf(address(claimContract));

        // Contract lost exactly what user1 gained
        assertEq(usdcBefore - usdcAfter, usdc.balanceOf(user1));
        assertEq(wethBefore - wethAfter, weth.balanceOf(user1));

        // Sweep remaining
        vm.warp(block.timestamp + 366 days);
        address treasury = makeAddr("treasury");
        vm.prank(admin);
        claimContract.sweepUnclaimed(roundId, treasury);

        // All funds accounted for
        assertEq(
            usdc.balanceOf(user1) + usdc.balanceOf(treasury),
            usdcBefore
        );
        assertEq(
            weth.balanceOf(user1) + weth.balanceOf(treasury),
            wethBefore
        );
    }

    // ─── P0 Fix: Zero Merkle Root Validation ─────────────────────────────

    function test_createRound_revert_zeroUsdcMerkleRoot() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        vm.expectRevert(StreamRecoveryClaim.ZeroMerkleRoot.selector);
        claimContract.createRound(bytes32(0), bytes32(uint256(2)), 1000e6, 1e18);
    }

    function test_createRound_revert_zeroWethMerkleRoot() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        vm.expectRevert(StreamRecoveryClaim.ZeroMerkleRoot.selector);
        claimContract.createRound(bytes32(uint256(1)), bytes32(0), 1000e6, 1e18);
    }

    function test_createRound_zeroRoot_allowed_when_zeroTotal() public {
        // Zero root is fine when that token has zero allocation (e.g. USDC-only round)
        usdc.mint(address(claimContract), 1000e6);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(0), 1000e6, 0);

        (,,uint256 usdcTotal, uint256 wethTotal,,,,) = claimContract.rounds(0);
        assertEq(usdcTotal, 1000e6);
        assertEq(wethTotal, 0);
    }

    function test_createRound_bothZeroRoots_bothZeroTotals() public {
        // Degenerate case: fully empty round (no funds)
        vm.prank(admin);
        claimContract.createRound(bytes32(0), bytes32(0), 0, 0);
        assertEq(claimContract.roundCount(), 1);
    }

    // ─── P0 Fix: updateMerkleRoots ──────────────────────────────────────

    function test_updateMerkleRoots_success() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        bytes32 newUsdcRoot = bytes32(uint256(10));
        bytes32 newWethRoot = bytes32(uint256(20));

        vm.prank(admin);
        claimContract.updateMerkleRoots(0, newUsdcRoot, newWethRoot);

        (bytes32 usdcRoot, bytes32 wethRoot,,,,,,) = claimContract.rounds(0);
        assertEq(usdcRoot, newUsdcRoot);
        assertEq(wethRoot, newWethRoot);
    }

    function test_updateMerkleRoots_emitsEvent() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        bytes32 newUsdcRoot = bytes32(uint256(10));
        bytes32 newWethRoot = bytes32(uint256(20));

        vm.expectEmit(true, false, false, true);
        emit StreamRecoveryClaim.MerkleRootsUpdated(0, newUsdcRoot, newWethRoot);

        vm.prank(admin);
        claimContract.updateMerkleRoots(0, newUsdcRoot, newWethRoot);
    }

    function test_updateMerkleRoots_revert_notAdmin() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.NotAdmin.selector);
        claimContract.updateMerkleRoots(0, bytes32(uint256(10)), bytes32(uint256(20)));
    }

    function test_updateMerkleRoots_revert_invalidRound() public {
        vm.prank(admin);
        vm.expectRevert(StreamRecoveryClaim.InvalidRound.selector);
        claimContract.updateMerkleRoots(0, bytes32(uint256(10)), bytes32(uint256(20)));
    }

    function test_updateMerkleRoots_revert_deactivatedRound() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.startPrank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);
        claimContract.deactivateRound(0);

        vm.expectRevert(StreamRecoveryClaim.RoundNotActive.selector);
        claimContract.updateMerkleRoots(0, bytes32(uint256(10)), bytes32(uint256(20)));
        vm.stopPrank();
    }

    function test_updateMerkleRoots_revert_afterClaims() public {
        // Setup a round with real Merkle trees
        UsdcShare[] memory usdcShares = new UsdcShare[](2);
        usdcShares[0] = UsdcShare(user1, 0.5e18);
        usdcShares[1] = UsdcShare(user2, 0.5e18);

        WethShare[] memory wethShares = new WethShare[](2);
        wethShares[0] = WethShare(user1, 0.5e18);
        wethShares[1] = WethShare(user2, 0.5e18);

        (uint256 roundId, bytes32[] memory usdcLeaves,) =
            _setupRound(usdcShares, wethShares, 1000e6, 1e18);

        // User1 claims USDC
        _executeSignWaiver(user1Pk);
        bytes32[] memory proof = Merkle.getProof(usdcLeaves, 0);
        vm.prank(user1);
        claimContract.claimUsdc(roundId, 0.5e18, proof);

        // Now admin cannot update roots
        vm.prank(admin);
        vm.expectRevert(StreamRecoveryClaim.RoundHasClaims.selector);
        claimContract.updateMerkleRoots(roundId, bytes32(uint256(10)), bytes32(uint256(20)));
    }

    function test_updateMerkleRoots_revert_zeroUsdcRoot() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        vm.prank(admin);
        vm.expectRevert(StreamRecoveryClaim.ZeroMerkleRoot.selector);
        claimContract.updateMerkleRoots(0, bytes32(0), bytes32(uint256(20)));
    }

    function test_updateMerkleRoots_revert_zeroWethRoot() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        vm.prank(admin);
        vm.expectRevert(StreamRecoveryClaim.ZeroMerkleRoot.selector);
        claimContract.updateMerkleRoots(0, bytes32(uint256(10)), bytes32(0));
    }

    function test_updateMerkleRoots_thenClaimWithNewRoot() public {
        // Setup round with initial roots
        UsdcShare[] memory usdcShares = new UsdcShare[](2);
        usdcShares[0] = UsdcShare(user1, 0.6e18);
        usdcShares[1] = UsdcShare(user2, 0.4e18);

        WethShare[] memory wethShares = new WethShare[](2);
        wethShares[0] = WethShare(user1, 0.7e18);
        wethShares[1] = WethShare(user2, 0.3e18);

        // Build new trees (the "corrected" ones)
        bytes32[] memory newUsdcLeaves = new bytes32[](2);
        newUsdcLeaves[0] = _createLeaf(user1, 0.6e18);
        newUsdcLeaves[1] = _createLeaf(user2, 0.4e18);

        bytes32[] memory newWethLeaves = new bytes32[](2);
        newWethLeaves[0] = _createLeaf(user1, 0.7e18);
        newWethLeaves[1] = _createLeaf(user2, 0.3e18);

        bytes32 newUsdcRoot = Merkle.getRoot(newUsdcLeaves);
        bytes32 newWethRoot = Merkle.getRoot(newWethLeaves);

        // Fund and create round with WRONG roots
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);
        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(999)), bytes32(uint256(888)), 1000e6, 1e18);

        // Update to correct roots
        vm.prank(admin);
        claimContract.updateMerkleRoots(0, newUsdcRoot, newWethRoot);

        // Now user1 can claim with the new roots
        _executeSignWaiver(user1Pk);
        bytes32[] memory usdcProof = Merkle.getProof(newUsdcLeaves, 0);
        vm.prank(user1);
        claimContract.claimUsdc(0, 0.6e18, usdcProof);

        assertEq(usdc.balanceOf(user1), 600e6);
    }

    // ─── P1 Fix: AlreadySigned Guard ────────────────────────────────────

    function test_signWaiver_revert_alreadySigned() public {
        _executeSignWaiver(user1Pk);
        assertTrue(claimContract.hasSignedWaiver(user1));

        // Signing again should revert
        (uint8 v, bytes32 r, bytes32 s) = _signWaiver(user1Pk);
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.AlreadySigned.selector);
        claimContract.signWaiver(v, r, s);
    }

    // ─── Branch Coverage: canClaimUsdc view early returns ─────────────

    function test_canClaimUsdc_invalidRoundId() public {
        // roundId >= roundCount → (false, 0)
        bytes32[] memory proof = new bytes32[](0);
        (bool eligible, uint256 amount) = claimContract.canClaimUsdc(999, user1, 0.5e18, proof);
        assertFalse(eligible);
        assertEq(amount, 0);
    }

    function test_canClaimUsdc_deactivatedRound() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        vm.prank(admin);
        claimContract.deactivateRound(0);

        bytes32[] memory proof = new bytes32[](0);
        (bool eligible, uint256 amount) = claimContract.canClaimUsdc(0, user1, 0.5e18, proof);
        assertFalse(eligible);
        assertEq(amount, 0);
    }

    function test_canClaimUsdc_invalidProof() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 0.5e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId,,) = _setupRound(usdcShares, wethShares, 1000e6, 2e18);
        _executeSignWaiver(user1Pk);

        // Use empty proof (wrong)
        bytes32[] memory badProof = new bytes32[](1);
        badProof[0] = bytes32(uint256(0xdead));
        (bool eligible, uint256 amount) = claimContract.canClaimUsdc(roundId, user1, 0.5e18, badProof);
        assertFalse(eligible);
        assertEq(amount, 0);
    }

    // ─── Branch Coverage: canClaimWeth view early returns ─────────────

    function test_canClaimWeth_invalidRoundId() public {
        bytes32[] memory proof = new bytes32[](0);
        (bool eligible, uint256 amount) = claimContract.canClaimWeth(999, user1, 0.5e18, proof);
        assertFalse(eligible);
        assertEq(amount, 0);
    }

    function test_canClaimWeth_deactivatedRound() public {
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 1000e6, 1e18);

        vm.prank(admin);
        claimContract.deactivateRound(0);

        bytes32[] memory proof = new bytes32[](0);
        (bool eligible, uint256 amount) = claimContract.canClaimWeth(0, user1, 0.5e18, proof);
        assertFalse(eligible);
        assertEq(amount, 0);
    }

    function test_canClaimWeth_invalidProof() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 0.5e18);

        (uint256 roundId,,) = _setupRound(usdcShares, wethShares, 1000e6, 2e18);
        _executeSignWaiver(user1Pk);

        bytes32[] memory badProof = new bytes32[](1);
        badProof[0] = bytes32(uint256(0xdead));
        (bool eligible, uint256 amount) = claimContract.canClaimWeth(roundId, user1, 0.5e18, badProof);
        assertFalse(eligible);
        assertEq(amount, 0);
    }

    function test_canClaimWeth_alreadyClaimed() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId,, bytes32[] memory wethLeaves) = _setupRound(usdcShares, wethShares, 1000e6, 2e18);
        _executeSignWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(wethLeaves, 0);

        // Claim first
        vm.prank(user1);
        claimContract.claimWeth(roundId, 1e18, proof);

        // canClaimWeth should now return false
        (bool eligible, uint256 amount) = claimContract.canClaimWeth(roundId, user1, 1e18, proof);
        assertFalse(eligible);
        assertEq(amount, 0);
    }

    function test_canClaimWeth_noWaiver() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 0.5e18);

        (uint256 roundId,, bytes32[] memory wethLeaves) = _setupRound(usdcShares, wethShares, 1000e6, 2e18);

        bytes32[] memory proof = Merkle.getProof(wethLeaves, 0);
        (bool eligible, uint256 amount) = claimContract.canClaimWeth(roundId, user1, 0.5e18, proof);
        assertFalse(eligible);
        assertEq(amount, 0);
    }

    // ─── Branch Coverage: ClaimExceedsTotal ──────────────────────────

    function test_claimUsdc_revert_claimExceedsTotal() public {
        // Create a malicious tree where shares sum > 100%
        // user1: 60%, user2: 60% → total 120%
        UsdcShare[] memory usdcShares = new UsdcShare[](2);
        usdcShares[0] = UsdcShare(user1, 0.6e18);
        usdcShares[1] = UsdcShare(user2, 0.6e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId, bytes32[] memory usdcLeaves,) =
            _setupRound(usdcShares, wethShares, 1000e6, 1e18);

        _executeSignWaiver(user1Pk);
        _executeSignWaiver(user2Pk);

        // user1 claims 60% = 600 USDC (OK, 600 <= 1000)
        bytes32[] memory proof1 = Merkle.getProof(usdcLeaves, 0);
        vm.prank(user1);
        claimContract.claimUsdc(roundId, 0.6e18, proof1);
        assertEq(usdc.balanceOf(user1), 600e6);

        // user2 claims 60% = 600 USDC → claimed (600+600=1200 > 1000) → REVERT
        bytes32[] memory proof2 = Merkle.getProof(usdcLeaves, 1);
        vm.prank(user2);
        vm.expectRevert(StreamRecoveryClaim.ClaimExceedsTotal.selector);
        claimContract.claimUsdc(roundId, 0.6e18, proof2);
    }

    function test_claimWeth_revert_claimExceedsTotal() public {
        // Malicious tree where WETH shares sum > 100%
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](2);
        wethShares[0] = WethShare(user1, 0.7e18);
        wethShares[1] = WethShare(user2, 0.7e18);

        (uint256 roundId,, bytes32[] memory wethLeaves) =
            _setupRound(usdcShares, wethShares, 1000e6, 2e18);

        _executeSignWaiver(user1Pk);
        _executeSignWaiver(user2Pk);

        // user1 claims 70% = 1.4 WETH (OK, 1.4 <= 2)
        bytes32[] memory proof1 = Merkle.getProof(wethLeaves, 0);
        vm.prank(user1);
        claimContract.claimWeth(roundId, 0.7e18, proof1);
        assertEq(weth.balanceOf(user1), 1.4e18);

        // user2 claims 70% = 1.4 WETH → claimed (1.4+1.4=2.8 > 2) → REVERT
        bytes32[] memory proof2 = Merkle.getProof(wethLeaves, 1);
        vm.prank(user2);
        vm.expectRevert(StreamRecoveryClaim.ClaimExceedsTotal.selector);
        claimContract.claimWeth(roundId, 0.7e18, proof2);
    }

    // ─── Branch Coverage: Zero-share claims (amount = 0, no transfer) ─

    function test_claimUsdc_zeroShareWad() public {
        // User has 0 share — valid proof but amount = 0, no transfer
        UsdcShare[] memory usdcShares = new UsdcShare[](2);
        usdcShares[0] = UsdcShare(user1, 0);       // 0% share
        usdcShares[1] = UsdcShare(user2, 1e18);    // 100% share

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId, bytes32[] memory usdcLeaves,) =
            _setupRound(usdcShares, wethShares, 1000e6, 1e18);

        _executeSignWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(usdcLeaves, 0);
        vm.prank(user1);
        claimContract.claimUsdc(roundId, 0, proof);

        // Claim recorded but zero amount transferred
        assertTrue(claimContract.hasClaimedUsdc(roundId, user1));
        assertEq(usdc.balanceOf(user1), 0);
    }

    function test_claimWeth_zeroShareWad() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](2);
        wethShares[0] = WethShare(user1, 0);       // 0% WETH share
        wethShares[1] = WethShare(user2, 1e18);    // 100% share

        (uint256 roundId,, bytes32[] memory wethLeaves) =
            _setupRound(usdcShares, wethShares, 1000e6, 2e18);

        _executeSignWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(wethLeaves, 0);
        vm.prank(user1);
        claimContract.claimWeth(roundId, 0, proof);

        assertTrue(claimContract.hasClaimedWeth(roundId, user1));
        assertEq(weth.balanceOf(user1), 0);
    }

    // ─── Branch Coverage: sweepUnclaimed with zero-remaining ─────────

    function test_sweepUnclaimed_allUsdcClaimed_wethUnclaimed() public {
        // All USDC claimed (usdcRemaining = 0), WETH unclaimed (wethRemaining > 0)
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId, bytes32[] memory usdcLeaves,) =
            _setupRound(usdcShares, wethShares, 1000e6, 2e18);

        _executeSignWaiver(user1Pk);

        // Claim all USDC but NOT WETH
        bytes32[] memory proof = Merkle.getProof(usdcLeaves, 0);
        vm.prank(user1);
        claimContract.claimUsdc(roundId, 1e18, proof);

        assertEq(usdc.balanceOf(user1), 1000e6);

        // Warp past deadline and sweep
        vm.warp(block.timestamp + 366 days);
        address treasury = makeAddr("treasury");
        vm.prank(admin);
        claimContract.sweepUnclaimed(roundId, treasury);

        // Treasury gets 0 USDC (all claimed) + 2 WETH (unclaimed)
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(weth.balanceOf(treasury), 2e18);
    }

    function test_sweepUnclaimed_allWethClaimed_usdcUnclaimed() public {
        // WETH fully claimed, USDC unclaimed
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId,, bytes32[] memory wethLeaves) =
            _setupRound(usdcShares, wethShares, 1000e6, 2e18);

        _executeSignWaiver(user1Pk);

        // Claim all WETH but NOT USDC
        bytes32[] memory proof = Merkle.getProof(wethLeaves, 0);
        vm.prank(user1);
        claimContract.claimWeth(roundId, 1e18, proof);

        assertEq(weth.balanceOf(user1), 2e18);

        // Warp past deadline and sweep
        vm.warp(block.timestamp + 366 days);
        address treasury = makeAddr("treasury");
        vm.prank(admin);
        claimContract.sweepUnclaimed(roundId, treasury);

        // Treasury gets 1000 USDC (unclaimed) + 0 WETH (all claimed)
        assertEq(usdc.balanceOf(treasury), 1000e6);
        assertEq(weth.balanceOf(treasury), 0);
    }

    function test_sweepUnclaimed_allClaimed_nothingToSweep() public {
        // Both tokens fully claimed — sweep transfers nothing
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId, bytes32[] memory usdcLeaves, bytes32[] memory wethLeaves) =
            _setupRound(usdcShares, wethShares, 1000e6, 2e18);

        _executeSignWaiver(user1Pk);

        // Claim everything
        bytes32[] memory usdcProof = Merkle.getProof(usdcLeaves, 0);
        bytes32[] memory wethProof = Merkle.getProof(wethLeaves, 0);
        vm.prank(user1);
        claimContract.claimBoth(roundId, 1e18, usdcProof, 1e18, wethProof);

        // Warp past deadline and sweep
        vm.warp(block.timestamp + 366 days);
        address treasury = makeAddr("treasury");
        vm.prank(admin);
        claimContract.sweepUnclaimed(roundId, treasury);

        // Nothing swept
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(weth.balanceOf(treasury), 0);
        assertTrue(claimContract.swept(roundId));
    }

    // ─── Branch Coverage: updateMerkleRoots after WETH-only claim ────

    function test_updateMerkleRoots_revert_afterWethClaims() public {
        // Ensure the wethClaimed > 0 branch of the RoundHasClaims check is hit
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 1e18);

        (uint256 roundId,, bytes32[] memory wethLeaves) =
            _setupRound(usdcShares, wethShares, 1000e6, 2e18);

        // User1 claims only WETH (not USDC)
        _executeSignWaiver(user1Pk);
        bytes32[] memory wethProof = Merkle.getProof(wethLeaves, 0);
        vm.prank(user1);
        claimContract.claimWeth(roundId, 1e18, wethProof);

        // Admin cannot update roots (wethClaimed > 0 even though usdcClaimed == 0)
        vm.prank(admin);
        vm.expectRevert(StreamRecoveryClaim.RoundHasClaims.selector);
        claimContract.updateMerkleRoots(roundId, bytes32(uint256(10)), bytes32(uint256(20)));
    }

    // ─── Branch Coverage: createRound zero WETH root with zero USDC total ─

    function test_createRound_wethOnlyRound_zeroUsdcRoot() public {
        // WETH-only round: zero USDC root is fine when usdcTotal = 0
        weth.mint(address(claimContract), 5e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(0), bytes32(uint256(1)), 0, 5e18);

        (bytes32 usdcRoot,, uint256 usdcTotal, uint256 wethTotal,,,,) = claimContract.rounds(0);
        assertEq(usdcRoot, bytes32(0));
        assertEq(usdcTotal, 0);
        assertEq(wethTotal, 5e18);
    }

    // ─── Branch Coverage: updateMerkleRoots zero roots with zero totals ──

    function test_updateMerkleRoots_zeroUsdcRoot_zeroUsdcTotal() public {
        // When usdcTotal = 0, zero USDC root is acceptable
        weth.mint(address(claimContract), 2e18);

        vm.prank(admin);
        claimContract.createRound(bytes32(0), bytes32(uint256(1)), 0, 2e18);

        // Update: zero USDC root stays OK since usdcTotal = 0
        vm.prank(admin);
        claimContract.updateMerkleRoots(0, bytes32(0), bytes32(uint256(99)));

        (bytes32 usdcRoot, bytes32 wethRoot,,,,,,) = claimContract.rounds(0);
        assertEq(usdcRoot, bytes32(0));
        assertEq(wethRoot, bytes32(uint256(99)));
    }

    function test_updateMerkleRoots_zeroWethRoot_zeroWethTotal() public {
        // When wethTotal = 0, zero WETH root is acceptable
        usdc.mint(address(claimContract), 1000e6);

        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(0), 1000e6, 0);

        // Update: zero WETH root stays OK since wethTotal = 0
        vm.prank(admin);
        claimContract.updateMerkleRoots(0, bytes32(uint256(99)), bytes32(0));

        (bytes32 usdcRoot, bytes32 wethRoot,,,,,,) = claimContract.rounds(0);
        assertEq(usdcRoot, bytes32(uint256(99)));
        assertEq(wethRoot, bytes32(0));
    }

    // ─── Branch Coverage: sweepUnclaimed on already-deactivated round skips allocation release ─

    function test_sweepUnclaimed_deactivatedRound_skipsAllocationRelease() public {
        // Create and immediately deactivate round 0 (no claims)
        usdc.mint(address(claimContract), 500e6);
        weth.mint(address(claimContract), 1e18);
        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(1)), bytes32(uint256(2)), 500e6, 1e18);
        assertEq(claimContract.totalUsdcAllocated(), 500e6);
        assertEq(claimContract.totalWethAllocated(), 1e18);

        // Deactivate round 0 → releases full allocation
        vm.prank(admin);
        claimContract.deactivateRound(0);
        assertEq(claimContract.totalUsdcAllocated(), 0);
        assertEq(claimContract.totalWethAllocated(), 0);

        // Create round 1 using freed capacity (tokens still in contract)
        vm.prank(admin);
        claimContract.createRound(bytes32(uint256(11)), bytes32(uint256(22)), 500e6, 1e18);
        assertEq(claimContract.totalUsdcAllocated(), 500e6);
        assertEq(claimContract.totalWethAllocated(), 1e18);

        // Sweep round 0 past deadline — round is already deactivated,
        // so sweep should NOT subtract from allocation again
        vm.warp(block.timestamp + 366 days);
        address treasury = makeAddr("treasury");
        vm.prank(admin);
        claimContract.sweepUnclaimed(0, treasury);

        // Round 1 allocation should be completely unaffected
        assertEq(claimContract.totalUsdcAllocated(), 500e6);
        assertEq(claimContract.totalWethAllocated(), 1e18);
    }

    // ─── Branch Coverage: WETH claim invalid proof ──────────────────

    function test_claimWeth_revert_invalidProof() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](2);
        wethShares[0] = WethShare(user1, 0.6e18);
        wethShares[1] = WethShare(user2, 0.4e18);

        (uint256 roundId,, bytes32[] memory wethLeaves) = _setupRound(usdcShares, wethShares, 800e6, 2e18);
        _executeSignWaiver(user1Pk);

        // Use proof for user2 but claim as user1
        bytes32[] memory proof = Merkle.getProof(wethLeaves, 1);

        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.InvalidProof.selector);
        claimContract.claimWeth(roundId, 0.6e18, proof);
    }

    function test_claimWeth_revert_wrongShare() public {
        UsdcShare[] memory usdcShares = new UsdcShare[](1);
        usdcShares[0] = UsdcShare(user1, 1e18);

        WethShare[] memory wethShares = new WethShare[](1);
        wethShares[0] = WethShare(user1, 0.5e18);

        (uint256 roundId,, bytes32[] memory wethLeaves) = _setupRound(usdcShares, wethShares, 500e6, 1e18);
        _executeSignWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(wethLeaves, 0);

        // Try to claim with inflated share
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.InvalidProof.selector);
        claimContract.claimWeth(roundId, 0.9e18, proof);
    }
}
