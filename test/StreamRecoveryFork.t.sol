// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {StreamRecoveryClaim} from "../src/StreamRecoveryClaim.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Merkle} from "./utils/Merkle.sol";

/// @title Fork integration test against Sonic mainnet
/// @dev Run with: forge test --match-contract StreamRecoveryForkTest --fork-url $SONIC_RPC -vvv
///      Requires SONIC_RPC env var pointing to a Sonic chain RPC endpoint.
///      Validates the contract works correctly with real on-chain USDC and WETH tokens.
contract StreamRecoveryForkTest is Test {
    // ─── Sonic Mainnet Addresses ─────────────────────────────────────────
    address constant USDC_SONIC = 0x29219dd400f2Bf60E5a23d13Be72B486D4038894;
    address constant WETH_SONIC = 0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38;

    StreamRecoveryClaim public claim;
    IERC20 public usdc;
    IERC20 public weth;

    address admin;
    uint256 user1Pk;
    address user1;
    uint256 user2Pk;
    address user2;

    uint256 constant WAD = 1e18;

    // Realistic distribution amounts matching the recovery (~$15M total)
    uint256 constant USDC_ROUND_TOTAL = 10_000_000e6;   // 10M USDC
    uint256 constant WETH_ROUND_TOTAL = 2_000e18;        // 2,000 WETH

    /// @dev Skip all tests when not running against a Sonic fork.
    modifier onlyFork() {
        if (USDC_SONIC.code.length == 0) {
            return; // No fork — skip test silently
        }
        _;
    }

    function setUp() public {
        admin = makeAddr("admin");
        (user1, user1Pk) = makeAddrAndKey("user1");
        (user2, user2Pk) = makeAddrAndKey("user2");

        usdc = IERC20(USDC_SONIC);
        weth = IERC20(WETH_SONIC);

        // Only deploy when running on a fork (real tokens have bytecode)
        if (USDC_SONIC.code.length > 0) {
            claim = new StreamRecoveryClaim(admin, USDC_SONIC, WETH_SONIC);
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

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

    /// @dev Fund the contract by dealing real tokens via vm.deal / deal cheatcode
    function _fundContract(uint256 usdcAmount, uint256 wethAmount) internal {
        deal(USDC_SONIC, address(claim), usdcAmount);
        deal(WETH_SONIC, address(claim), wethAmount);
    }

    // ─── Test: Real tokens are ERC-20 compliant ──────────────────────────

    /// @dev Sanity check: verify USDC and WETH on Sonic behave as standard ERC-20.
    function test_fork_tokensAreStandardERC20() public view onlyFork {
        // USDC should have 6 decimals, non-zero total supply
        (bool s1, bytes memory d1) = USDC_SONIC.staticcall(
            abi.encodeWithSignature("decimals()")
        );
        assertTrue(s1, "USDC decimals() call failed");
        uint8 usdcDecimals = abi.decode(d1, (uint8));
        assertEq(usdcDecimals, 6, "USDC decimals != 6");

        // WETH should have 18 decimals
        (bool s2, bytes memory d2) = WETH_SONIC.staticcall(
            abi.encodeWithSignature("decimals()")
        );
        assertTrue(s2, "WETH decimals() call failed");
        uint8 wethDecimals = abi.decode(d2, (uint8));
        assertEq(wethDecimals, 18, "WETH decimals != 18");

        // Both should have non-zero total supply on live chain
        assertTrue(usdc.totalSupply() > 0, "USDC total supply is 0");
        assertTrue(weth.totalSupply() > 0, "WETH total supply is 0");
    }

    // ─── Test: Deploy and create round with real tokens ──────────────────

    /// @dev Full E2E: deploy → fund → create round → sign waiver → claim → verify.
    function test_fork_fullClaimFlowUSDC() public onlyFork {
        // Fund contract with real USDC
        _fundContract(USDC_ROUND_TOTAL, 0);

        // Build single-user tree (100% share)
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = _createLeaf(user1, WAD);
        bytes32 root = Merkle.getRoot(leaves);

        // Admin creates round
        vm.prank(admin);
        claim.createRound(root, bytes32(0), USDC_ROUND_TOTAL, 0);

        // Verify round was created
        (
            bytes32 usdcRoot, , uint256 usdcTotal, ,
            uint256 usdcClaimed, , uint256 deadline, bool active
        ) = claim.rounds(0);
        assertEq(usdcRoot, root);
        assertEq(usdcTotal, USDC_ROUND_TOTAL);
        assertEq(usdcClaimed, 0);
        assertTrue(active);
        assertEq(deadline, block.timestamp + 365 days);

        // User signs waiver and claims
        _signAndSubmitWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(leaves, 0);
        vm.prank(user1);
        claim.claimUsdc(0, WAD, proof);

        // Verify USDC was transferred to user
        assertEq(usdc.balanceOf(user1), USDC_ROUND_TOTAL, "User did not receive USDC");
        assertEq(usdc.balanceOf(address(claim)), 0, "Contract still holds USDC");
    }

    /// @dev Full E2E for WETH claims
    function test_fork_fullClaimFlowWETH() public onlyFork {
        _fundContract(0, WETH_ROUND_TOTAL);

        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = _createLeaf(user1, WAD);
        bytes32 root = Merkle.getRoot(leaves);

        vm.prank(admin);
        claim.createRound(bytes32(0), root, 0, WETH_ROUND_TOTAL);

        _signAndSubmitWaiver(user1Pk);

        bytes32[] memory proof = Merkle.getProof(leaves, 0);
        vm.prank(user1);
        claim.claimWeth(0, WAD, proof);

        assertEq(weth.balanceOf(user1), WETH_ROUND_TOTAL, "User did not receive WETH");
    }

    // ─── Test: Dual-token claim (claimBoth) ──────────────────────────────

    /// @dev E2E: claim both USDC and WETH in a single transaction.
    function test_fork_claimBothTokens() public onlyFork {
        _fundContract(USDC_ROUND_TOTAL, WETH_ROUND_TOTAL);

        // Build trees
        bytes32[] memory usdcLeaves = new bytes32[](1);
        usdcLeaves[0] = _createLeaf(user1, WAD);

        bytes32[] memory wethLeaves = new bytes32[](1);
        wethLeaves[0] = _createLeaf(user1, WAD);

        bytes32 usdcRoot = Merkle.getRoot(usdcLeaves);
        bytes32 wethRoot = Merkle.getRoot(wethLeaves);

        vm.prank(admin);
        claim.createRound(usdcRoot, wethRoot, USDC_ROUND_TOTAL, WETH_ROUND_TOTAL);

        _signAndSubmitWaiver(user1Pk);

        bytes32[] memory usdcProof = Merkle.getProof(usdcLeaves, 0);
        bytes32[] memory wethProof = Merkle.getProof(wethLeaves, 0);

        vm.prank(user1);
        claim.claimBoth(0, WAD, usdcProof, WAD, wethProof);

        assertEq(usdc.balanceOf(user1), USDC_ROUND_TOTAL, "USDC not received");
        assertEq(weth.balanceOf(user1), WETH_ROUND_TOTAL, "WETH not received");
    }

    // ─── Test: Multi-user proportional distribution ──────────────────────

    /// @dev Two users split 60/40 — verify exact proportional payouts with real tokens.
    function test_fork_proportionalDistribution() public onlyFork {
        _fundContract(USDC_ROUND_TOTAL, WETH_ROUND_TOTAL);

        uint256 share1 = 0.6e18; // 60%
        uint256 share2 = 0.4e18; // 40%

        // Build 2-user trees
        bytes32[] memory usdcLeaves = new bytes32[](2);
        usdcLeaves[0] = _createLeaf(user1, share1);
        usdcLeaves[1] = _createLeaf(user2, share2);

        bytes32[] memory wethLeaves = new bytes32[](2);
        wethLeaves[0] = _createLeaf(user1, share1);
        wethLeaves[1] = _createLeaf(user2, share2);

        bytes32 usdcRoot = Merkle.getRoot(usdcLeaves);
        bytes32 wethRoot = Merkle.getRoot(wethLeaves);

        vm.prank(admin);
        claim.createRound(usdcRoot, wethRoot, USDC_ROUND_TOTAL, WETH_ROUND_TOTAL);

        // Both users sign waivers
        _signAndSubmitWaiver(user1Pk);
        _signAndSubmitWaiver(user2Pk);

        // User1 claims (60%)
        bytes32[] memory proof1Usdc = Merkle.getProof(usdcLeaves, 0);
        bytes32[] memory proof1Weth = Merkle.getProof(wethLeaves, 0);
        vm.prank(user1);
        claim.claimBoth(0, share1, proof1Usdc, share1, proof1Weth);

        // User2 claims (40%)
        bytes32[] memory proof2Usdc = Merkle.getProof(usdcLeaves, 1);
        bytes32[] memory proof2Weth = Merkle.getProof(wethLeaves, 1);
        vm.prank(user2);
        claim.claimBoth(0, share2, proof2Usdc, share2, proof2Weth);

        // Verify payouts
        uint256 expectedUsdc1 = (share1 * USDC_ROUND_TOTAL) / WAD; // 6,000,000 USDC
        uint256 expectedUsdc2 = (share2 * USDC_ROUND_TOTAL) / WAD; // 4,000,000 USDC
        uint256 expectedWeth1 = (share1 * WETH_ROUND_TOTAL) / WAD; // 1,200 WETH
        uint256 expectedWeth2 = (share2 * WETH_ROUND_TOTAL) / WAD; //   800 WETH

        assertEq(usdc.balanceOf(user1), expectedUsdc1, "User1 USDC mismatch");
        assertEq(usdc.balanceOf(user2), expectedUsdc2, "User2 USDC mismatch");
        assertEq(weth.balanceOf(user1), expectedWeth1, "User1 WETH mismatch");
        assertEq(weth.balanceOf(user2), expectedWeth2, "User2 WETH mismatch");

        // Combined should equal total (no dust for 60/40 split)
        assertEq(
            usdc.balanceOf(user1) + usdc.balanceOf(user2),
            USDC_ROUND_TOTAL,
            "USDC not fully distributed"
        );
    }

    // ─── Test: Rescue excess real tokens ──────────────────────────────────

    /// @dev Fund contract with more than allocated, rescue the excess.
    function test_fork_rescueExcessTokens() public onlyFork {
        uint256 excess = 500_000e6; // 500K USDC excess
        _fundContract(USDC_ROUND_TOTAL + excess, 0);

        bytes32 dummyRoot = keccak256("root");
        vm.prank(admin);
        claim.createRound(dummyRoot, bytes32(0), USDC_ROUND_TOTAL, 0);

        // Rescue excess
        address treasury = makeAddr("treasury");
        vm.prank(admin);
        claim.rescueToken(USDC_SONIC, treasury, excess);

        assertEq(usdc.balanceOf(treasury), excess, "Excess not rescued");
        assertEq(
            usdc.balanceOf(address(claim)),
            USDC_ROUND_TOTAL,
            "Allocated funds touched"
        );

        // Verify cannot rescue allocated funds
        vm.prank(admin);
        vm.expectRevert("Exceeds rescuable USDC");
        claim.rescueToken(USDC_SONIC, treasury, 1);
    }

    // ─── Test: Sweep after deadline with real tokens ──────────────────────

    /// @dev Partial claim → wait 365 days → sweep remainder.
    function test_fork_sweepUnclaimedAfterDeadline() public onlyFork {
        _fundContract(USDC_ROUND_TOTAL, WETH_ROUND_TOTAL);

        uint256 share1 = 0.3e18; // User1 has 30% share

        bytes32[] memory usdcLeaves = new bytes32[](1);
        usdcLeaves[0] = _createLeaf(user1, share1);
        bytes32[] memory wethLeaves = new bytes32[](1);
        wethLeaves[0] = _createLeaf(user1, share1);

        bytes32 usdcRoot = Merkle.getRoot(usdcLeaves);
        bytes32 wethRoot = Merkle.getRoot(wethLeaves);

        vm.prank(admin);
        claim.createRound(usdcRoot, wethRoot, USDC_ROUND_TOTAL, WETH_ROUND_TOTAL);

        // User1 claims their 30%
        _signAndSubmitWaiver(user1Pk);
        bytes32[] memory usdcProof = Merkle.getProof(usdcLeaves, 0);
        bytes32[] memory wethProof = Merkle.getProof(wethLeaves, 0);

        vm.prank(user1);
        claim.claimBoth(0, share1, usdcProof, share1, wethProof);

        uint256 user1Usdc = usdc.balanceOf(user1);
        uint256 user1Weth = weth.balanceOf(user1);

        // Sweep should fail before deadline
        address treasury = makeAddr("treasury");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSignature("DeadlineNotReached()"));
        claim.sweepUnclaimed(0, treasury);

        // Warp past deadline
        vm.warp(block.timestamp + 366 days);

        // Sweep succeeds
        vm.prank(admin);
        claim.sweepUnclaimed(0, treasury);

        // Treasury gets the unclaimed 70%
        uint256 expectedUsdcSweep = USDC_ROUND_TOTAL - user1Usdc;
        uint256 expectedWethSweep = WETH_ROUND_TOTAL - user1Weth;

        assertEq(usdc.balanceOf(treasury), expectedUsdcSweep, "USDC sweep mismatch");
        assertEq(weth.balanceOf(treasury), expectedWethSweep, "WETH sweep mismatch");

        // Contract should have zero balance (all allocated, all distributed/swept)
        assertEq(usdc.balanceOf(address(claim)), 0, "Contract still holds USDC");
        assertEq(weth.balanceOf(address(claim)), 0, "Contract still holds WETH");
    }

    // ─── Test: EIP-712 domain separator is chain-aware ───────────────────

    /// @dev Verify the domain separator includes the correct chain ID (Sonic = 146).
    function test_fork_domainSeparatorIncludesChainId() public view onlyFork {
        bytes32 separator = claim.domainSeparator();
        assertTrue(separator != bytes32(0), "Domain separator is zero");

        // Recompute expected separator
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("StreamRecoveryClaim")),
                keccak256(bytes("1")),
                block.chainid,
                address(claim)
            )
        );
        assertEq(separator, expected, "Domain separator mismatch");
    }

    // ─── Test: Pause blocks claims with real tokens ──────────────────────

    /// @dev Pause → attempt claim → should revert → unpause → claim succeeds.
    function test_fork_pauseBlocksClaims() public onlyFork {
        _fundContract(USDC_ROUND_TOTAL, 0);

        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = _createLeaf(user1, WAD);
        bytes32 root = Merkle.getRoot(leaves);

        vm.prank(admin);
        claim.createRound(root, bytes32(0), USDC_ROUND_TOTAL, 0);

        _signAndSubmitWaiver(user1Pk);

        // Pause
        vm.prank(admin);
        claim.pause();

        // Claim should revert
        bytes32[] memory proof = Merkle.getProof(leaves, 0);
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSignature("IsPaused()"));
        claim.claimUsdc(0, WAD, proof);

        // Unpause
        vm.prank(admin);
        claim.unpause();

        // Claim should succeed
        vm.prank(user1);
        claim.claimUsdc(0, WAD, proof);

        assertEq(usdc.balanceOf(user1), USDC_ROUND_TOTAL, "Claim failed after unpause");
    }

    // ─── Test: View functions work on fork ────────────────────────────────

    /// @dev canClaimUsdc / canClaimWeth return correct values with real tokens.
    function test_fork_viewFunctionsAccurate() public onlyFork {
        _fundContract(USDC_ROUND_TOTAL, WETH_ROUND_TOTAL);

        uint256 share = 0.25e18; // 25%

        bytes32[] memory usdcLeaves = new bytes32[](1);
        usdcLeaves[0] = _createLeaf(user1, share);
        bytes32[] memory wethLeaves = new bytes32[](1);
        wethLeaves[0] = _createLeaf(user1, share);

        bytes32 usdcRoot = Merkle.getRoot(usdcLeaves);
        bytes32 wethRoot = Merkle.getRoot(wethLeaves);

        vm.prank(admin);
        claim.createRound(usdcRoot, wethRoot, USDC_ROUND_TOTAL, WETH_ROUND_TOTAL);

        bytes32[] memory usdcProof = Merkle.getProof(usdcLeaves, 0);
        bytes32[] memory wethProof = Merkle.getProof(wethLeaves, 0);

        // Before waiver: not eligible
        {
            (bool eligible, ) = claim.canClaimUsdc(0, user1, share, usdcProof);
            assertFalse(eligible, "Eligible before waiver");
        }

        // Sign waiver
        _signAndSubmitWaiver(user1Pk);

        // After waiver: eligible for USDC
        {
            (bool eligible, uint256 amount) = claim.canClaimUsdc(0, user1, share, usdcProof);
            assertTrue(eligible, "Not eligible after waiver");
            assertEq(amount, (share * USDC_ROUND_TOTAL) / WAD, "USDC amount mismatch");
        }

        // After waiver: eligible for WETH
        {
            (bool eligible, uint256 amount) = claim.canClaimWeth(0, user1, share, wethProof);
            assertTrue(eligible, "WETH not eligible");
            assertEq(amount, (share * WETH_ROUND_TOTAL) / WAD, "WETH amount mismatch");
        }

        // After claim: not eligible
        vm.prank(user1);
        claim.claimUsdc(0, share, usdcProof);

        {
            (bool eligible, ) = claim.canClaimUsdc(0, user1, share, usdcProof);
            assertFalse(eligible, "Still eligible after claim");
        }
    }

    // ─── Test: SafeERC20 works with real tokens ──────────────────────────

    /// @dev Verify that SafeERC20.safeTransfer handles real USDC/WETH correctly.
    ///      Some tokens have non-standard return values — this test catches regressions.
    function test_fork_safeTransferWorksWithRealTokens() public onlyFork {
        _fundContract(1_000e6, 1e18);

        bytes32[] memory usdcLeaves = new bytes32[](1);
        usdcLeaves[0] = _createLeaf(user1, WAD);
        bytes32[] memory wethLeaves = new bytes32[](1);
        wethLeaves[0] = _createLeaf(user1, WAD);

        vm.prank(admin);
        claim.createRound(
            Merkle.getRoot(usdcLeaves),
            Merkle.getRoot(wethLeaves),
            1_000e6,
            1e18
        );

        _signAndSubmitWaiver(user1Pk);

        // Claim small amounts — validates SafeERC20 doesn't revert with real token
        vm.prank(user1);
        claim.claimBoth(
            0,
            WAD,
            Merkle.getProof(usdcLeaves, 0),
            WAD,
            Merkle.getProof(wethLeaves, 0)
        );

        assertEq(usdc.balanceOf(user1), 1_000e6, "SafeTransfer USDC failed");
        assertEq(weth.balanceOf(user1), 1e18, "SafeTransfer WETH failed");
    }
}
