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

    uint256 constant WAD = 1e18;

    function setUp() public {
        (user1, user1Pk) = makeAddrAndKey("user1");
        (user2, user2Pk) = makeAddrAndKey("user2");
        (user3, user3Pk) = makeAddrAndKey("user3");

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
}
