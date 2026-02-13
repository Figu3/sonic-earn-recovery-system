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

    /// @dev Leaf encodes shares in WAD (not absolute amounts).
    function _createLeaf(address user, uint256 usdcShareWad, uint256 wethShareWad) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(user, usdcShareWad, wethShareWad))));
    }

    struct ShareData {
        address user;
        uint256 usdcShareWad; // Share of USDC pool in WAD (e.g. 0.5e18 = 50%)
        uint256 wethShareWad; // Share of WETH pool in WAD
    }

    function _setupRound(
        ShareData[] memory shares,
        uint256 totalUsdc,
        uint256 totalWeth
    ) internal returns (uint256 roundId, bytes32[] memory leaves) {
        leaves = new bytes32[](shares.length);
        for (uint256 i; i < shares.length; i++) {
            leaves[i] = _createLeaf(shares[i].user, shares[i].usdcShareWad, shares[i].wethShareWad);
        }

        bytes32 root = Merkle.getRoot(leaves);

        // Fund the contract
        usdc.mint(address(claimContract), totalUsdc);
        weth.mint(address(claimContract), totalWeth);

        // Create round
        vm.prank(admin);
        claimContract.createRound(root, totalUsdc, totalWeth);

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
        bytes32 root = bytes32(uint256(1));
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);

        vm.prank(admin);
        claimContract.createRound(root, 1000e6, 1e18);

        (
            bytes32 merkleRoot,
            uint256 usdcTotal,
            uint256 wethTotal,
            uint256 usdcClaimed,
            uint256 wethClaimed,
            uint256 claimDeadline,
            bool active
        ) = claimContract.rounds(0);

        assertEq(merkleRoot, root);
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
        claimContract.createRound(bytes32(0), 0, 0);
    }

    // ─── Claiming (share-based) ──────────────────────────────────────────

    function test_claim_single() public {
        // user1: 60% USDC share, 40% WETH share
        // user2: 40% USDC share, 60% WETH share
        ShareData[] memory shares = new ShareData[](2);
        shares[0] = ShareData(user1, 0.6e18, 0.4e18);
        shares[1] = ShareData(user2, 0.4e18, 0.6e18);

        // Round total: 1000 USDC, 2 WETH
        (uint256 roundId, bytes32[] memory leaves) = _setupRound(shares, 1000e6, 2e18);

        _executeSignWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(leaves, 0);

        vm.prank(user1);
        claimContract.claim(roundId, 0.6e18, 0.4e18, proof);

        // user1 gets: 60% of 1000 USDC = 600 USDC, 40% of 2 WETH = 0.8 WETH
        assertTrue(claimContract.hasClaimed(roundId, user1));
        assertEq(usdc.balanceOf(user1), 600e6);
        assertEq(weth.balanceOf(user1), 0.8e18);
    }

    function test_claim_usdcOnly() public {
        // user1: 100% USDC, 0% WETH
        ShareData[] memory shares = new ShareData[](1);
        shares[0] = ShareData(user1, 1e18, 0);

        (uint256 roundId, bytes32[] memory leaves) = _setupRound(shares, 1000e6, 0);

        _executeSignWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(leaves, 0);
        vm.prank(user1);
        claimContract.claim(roundId, 1e18, 0, proof);

        assertEq(usdc.balanceOf(user1), 1000e6);
        assertEq(weth.balanceOf(user1), 0);
    }

    function test_claim_wethOnly() public {
        // user1: 0% USDC, 100% WETH
        ShareData[] memory shares = new ShareData[](1);
        shares[0] = ShareData(user1, 0, 1e18);

        (uint256 roundId, bytes32[] memory leaves) = _setupRound(shares, 0, 2e18);

        _executeSignWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(leaves, 0);
        vm.prank(user1);
        claimContract.claim(roundId, 0, 1e18, proof);

        assertEq(usdc.balanceOf(user1), 0);
        assertEq(weth.balanceOf(user1), 2e18);
    }

    function test_claim_revert_noWaiver() public {
        ShareData[] memory shares = new ShareData[](1);
        shares[0] = ShareData(user1, 0.5e18, 0.5e18);

        (uint256 roundId, bytes32[] memory leaves) = _setupRound(shares, 500e6, 0.5e18);

        bytes32[] memory proof = Merkle.getProof(leaves, 0);

        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.WaiverNotSigned.selector);
        claimContract.claim(roundId, 0.5e18, 0.5e18, proof);
    }

    function test_claim_revert_alreadyClaimed() public {
        ShareData[] memory shares = new ShareData[](1);
        shares[0] = ShareData(user1, 0.5e18, 0.5e18);

        (uint256 roundId, bytes32[] memory leaves) = _setupRound(shares, 500e6, 0.5e18);
        _executeSignWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(leaves, 0);
        vm.prank(user1);
        claimContract.claim(roundId, 0.5e18, 0.5e18, proof);

        // Try again
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.AlreadyClaimed.selector);
        claimContract.claim(roundId, 0.5e18, 0.5e18, proof);
    }

    function test_claim_revert_invalidProof() public {
        ShareData[] memory shares = new ShareData[](2);
        shares[0] = ShareData(user1, 0.6e18, 0.6e18);
        shares[1] = ShareData(user2, 0.4e18, 0.4e18);

        (uint256 roundId, bytes32[] memory leaves) = _setupRound(shares, 800e6, 0.8e18);
        _executeSignWaiver(user1Pk);

        // Use proof for user2 but claim as user1
        bytes32[] memory proof = Merkle.getProof(leaves, 1);

        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.InvalidProof.selector);
        claimContract.claim(roundId, 0.6e18, 0.6e18, proof);
    }

    function test_claim_revert_wrongShare() public {
        ShareData[] memory shares = new ShareData[](1);
        shares[0] = ShareData(user1, 0.5e18, 0.5e18);

        (uint256 roundId, bytes32[] memory leaves) = _setupRound(shares, 500e6, 0.5e18);
        _executeSignWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(leaves, 0);

        // Try to claim with inflated share
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.InvalidProof.selector);
        claimContract.claim(roundId, 0.9e18, 0.5e18, proof);
    }

    function test_claim_revert_roundDeactivated() public {
        ShareData[] memory shares = new ShareData[](1);
        shares[0] = ShareData(user1, 0.5e18, 0.5e18);

        (uint256 roundId, bytes32[] memory leaves) = _setupRound(shares, 500e6, 0.5e18);
        _executeSignWaiver(user1Pk);

        vm.prank(admin);
        claimContract.deactivateRound(roundId);

        bytes32[] memory proof = Merkle.getProof(leaves, 0);
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.RoundNotActive.selector);
        claimContract.claim(roundId, 0.5e18, 0.5e18, proof);
    }

    function test_claim_revert_paused() public {
        ShareData[] memory shares = new ShareData[](1);
        shares[0] = ShareData(user1, 0.5e18, 0.5e18);

        (uint256 roundId, bytes32[] memory leaves) = _setupRound(shares, 500e6, 0.5e18);
        _executeSignWaiver(user1Pk);

        vm.prank(admin);
        claimContract.pause();

        bytes32[] memory proof = Merkle.getProof(leaves, 0);
        vm.prank(user1);
        vm.expectRevert(StreamRecoveryClaim.IsPaused.selector);
        claimContract.claim(roundId, 0.5e18, 0.5e18, proof);
    }

    // ─── Share math ──────────────────────────────────────────────────────

    function test_claim_shareMath_twoUsers() public {
        // user1: 30% USDC, 70% WETH
        // user2: 70% USDC, 30% WETH
        ShareData[] memory shares = new ShareData[](2);
        shares[0] = ShareData(user1, 0.3e18, 0.7e18);
        shares[1] = ShareData(user2, 0.7e18, 0.3e18);

        // Round: 10,000 USDC, 5 WETH
        (uint256 roundId, bytes32[] memory leaves) = _setupRound(shares, 10_000e6, 5e18);

        _executeSignWaiver(user1Pk);
        _executeSignWaiver(user2Pk);

        // user1 claims
        bytes32[] memory proof1 = Merkle.getProof(leaves, 0);
        vm.prank(user1);
        claimContract.claim(roundId, 0.3e18, 0.7e18, proof1);

        assertEq(usdc.balanceOf(user1), 3000e6);  // 30% of 10,000
        assertEq(weth.balanceOf(user1), 3.5e18);   // 70% of 5

        // user2 claims
        bytes32[] memory proof2 = Merkle.getProof(leaves, 1);
        vm.prank(user2);
        claimContract.claim(roundId, 0.7e18, 0.3e18, proof2);

        assertEq(usdc.balanceOf(user2), 7000e6);  // 70% of 10,000
        assertEq(weth.balanceOf(user2), 1.5e18);   // 30% of 5
    }

    // ─── Multi-Claim (same proof, different rounds) ──────────────────────

    function test_claimMultiple_sameRoot() public {
        // Both rounds use the same Merkle root (same shares)
        ShareData[] memory shares = new ShareData[](1);
        shares[0] = ShareData(user1, 0.5e18, 0.5e18);

        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = _createLeaf(user1, 0.5e18, 0.5e18);
        bytes32 root = Merkle.getRoot(leaves);

        // Round 0: 1000 USDC, 1 WETH
        usdc.mint(address(claimContract), 1000e6);
        weth.mint(address(claimContract), 1e18);
        vm.prank(admin);
        claimContract.createRound(root, 1000e6, 1e18);

        // Round 1: 2000 USDC, 3 WETH (second recovery)
        usdc.mint(address(claimContract), 2000e6);
        weth.mint(address(claimContract), 3e18);
        vm.prank(admin);
        claimContract.createRound(root, 2000e6, 3e18);

        _executeSignWaiver(user1Pk);

        uint256[] memory roundIds = new uint256[](2);
        roundIds[0] = 0;
        roundIds[1] = 1;

        bytes32[] memory proof = Merkle.getProof(leaves, 0);

        vm.prank(user1);
        claimContract.claimMultiple(roundIds, 0.5e18, 0.5e18, proof);

        // Round 0: 50% of 1000 USDC = 500, 50% of 1 WETH = 0.5
        // Round 1: 50% of 2000 USDC = 1000, 50% of 3 WETH = 1.5
        // Total: 1500 USDC, 2 WETH
        assertEq(usdc.balanceOf(user1), 1500e6);
        assertEq(weth.balanceOf(user1), 2e18);
        assertTrue(claimContract.hasClaimed(0, user1));
        assertTrue(claimContract.hasClaimed(1, user1));
    }

    // ─── Sweep ──────────────────────────────────────────────────────────

    function test_sweepUnclaimed() public {
        ShareData[] memory shares = new ShareData[](2);
        shares[0] = ShareData(user1, 0.6e18, 0.6e18);
        shares[1] = ShareData(user2, 0.4e18, 0.4e18);

        (uint256 roundId,) = _setupRound(shares, 800e6, 0.8e18);

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
        // user1: 60%, user2: 40%
        ShareData[] memory shares = new ShareData[](2);
        shares[0] = ShareData(user1, 0.6e18, 0.6e18);
        shares[1] = ShareData(user2, 0.4e18, 0.4e18);

        (uint256 roundId, bytes32[] memory leaves) = _setupRound(shares, 1000e6, 1e18);

        // User1 claims (60%)
        _executeSignWaiver(user1Pk);
        bytes32[] memory proof = Merkle.getProof(leaves, 0);
        vm.prank(user1);
        claimContract.claim(roundId, 0.6e18, 0.6e18, proof);

        // Verify user1 got 60%
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
        ShareData[] memory shares = new ShareData[](1);
        shares[0] = ShareData(user1, 1e18, 1e18);

        (uint256 roundId,) = _setupRound(shares, 500e6, 0.5e18);

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

    // ─── canClaim View ──────────────────────────────────────────────────

    function test_canClaim() public {
        ShareData[] memory shares = new ShareData[](1);
        shares[0] = ShareData(user1, 0.5e18, 0.5e18);

        (uint256 roundId, bytes32[] memory leaves) = _setupRound(shares, 1000e6, 2e18);
        bytes32[] memory proof = Merkle.getProof(leaves, 0);

        // Before signing waiver
        (bool eligible,,) = claimContract.canClaim(roundId, user1, 0.5e18, 0.5e18, proof);
        assertFalse(eligible);

        // After signing waiver
        _executeSignWaiver(user1Pk);
        (bool eligible2, uint256 usdcAmt, uint256 wethAmt) = claimContract.canClaim(roundId, user1, 0.5e18, 0.5e18, proof);
        assertTrue(eligible2);
        assertEq(usdcAmt, 500e6);   // 50% of 1000 USDC
        assertEq(wethAmt, 1e18);     // 50% of 2 WETH

        // After claiming
        vm.prank(user1);
        claimContract.claim(roundId, 0.5e18, 0.5e18, proof);
        (bool eligible3,,) = claimContract.canClaim(roundId, user1, 0.5e18, 0.5e18, proof);
        assertFalse(eligible3);
    }
}
