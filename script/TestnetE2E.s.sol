// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {StreamRecoveryClaim} from "../src/StreamRecoveryClaim.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title End-to-end testnet exercise
/// @notice Deploys mocks + claim contract, creates a round with real Merkle roots,
///         and runs 20+ claim scenarios covering all paths.
/// @dev    Run against Anvil:
///         anvil &
///         forge script script/TestnetE2E.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract TestnetE2E is Script {
    uint256 constant WAD = 1e18;

    // Anvil default accounts (deterministic)
    uint256 constant ADMIN_PK    = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant USER1_PK    = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant USER2_PK    = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant USER3_PK    = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
    uint256 constant USER4_PK    = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;
    uint256 constant USER5_PK    = 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba;
    uint256 constant SWEEPER_PK  = 0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e;

    address admin;
    address user1;
    address user2;
    address user3;
    address user4;
    address user5;

    ERC20Mock usdc;
    ERC20Mock weth;
    StreamRecoveryClaim claim;

    uint256 passCount;
    uint256 failCount;

    function _check(bool ok, string memory label) internal {
        if (ok) {
            passCount++;
            console2.log(unicode"  ✅", label);
        } else {
            failCount++;
            console2.log(unicode"  ❌ FAIL:", label);
        }
    }

    function _signWaiver(uint256 pk) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        address signer = vm.addr(pk);
        bytes32 digest = claim.getWaiverDigest(signer);
        (v, r, s) = vm.sign(pk, digest);
    }

    /// @dev Double-hash leaf matching the contract's Merkle verification
    function _leaf(address user, uint256 shareWad) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(user, shareWad))));
    }

    /// @dev Minimal 2-leaf Merkle tree for testing
    function _root2(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        if (uint256(a) < uint256(b)) return keccak256(abi.encodePacked(a, b));
        return keccak256(abi.encodePacked(b, a));
    }

    /// @dev 3-leaf Merkle root (balanced: left pair + right leaf)
    function _root3(bytes32 a, bytes32 b, bytes32 c) internal pure returns (bytes32) {
        bytes32 left = _root2(a, b);
        return _root2(left, c);
    }

    /// @dev 4-leaf Merkle root
    function _root4(bytes32 a, bytes32 b, bytes32 c, bytes32 d) internal pure returns (bytes32) {
        bytes32 left = _root2(a, b);
        bytes32 right = _root2(c, d);
        return _root2(left, right);
    }

    /// @dev Proof for leaf a in a 2-leaf tree [a, b]
    function _proof2(bytes32 sibling) internal pure returns (bytes32[] memory) {
        bytes32[] memory p = new bytes32[](1);
        p[0] = sibling;
        return p;
    }

    /// @dev Proof for leaf in position 0 of a 3-leaf tree [a, b, c]
    function _proof3_pos0(bytes32 b, bytes32 c) internal pure returns (bytes32[] memory) {
        bytes32[] memory p = new bytes32[](2);
        p[0] = b;
        p[1] = c;
        return p;
    }

    /// @dev Proof for leaf in position 2 of a 3-leaf tree [a, b, c]
    function _proof3_pos2(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory) {
        bytes32[] memory p = new bytes32[](1);
        p[0] = _root2(a, b);
        return p;
    }

    function run() external {
        admin = vm.addr(ADMIN_PK);
        user1 = vm.addr(USER1_PK);
        user2 = vm.addr(USER2_PK);
        user3 = vm.addr(USER3_PK);
        user4 = vm.addr(USER4_PK);
        user5 = vm.addr(USER5_PK);

        console2.log("=========================================");
        console2.log("  Trevee Earn Recovery Distributor - Testnet E2E");
        console2.log("=========================================");
        console2.log("");

        // ──────────────────────────────────────────────────────────────────
        // Phase 1: Deploy
        // ──────────────────────────────────────────────────────────────────
        console2.log("Phase 1: Deploy");

        vm.startBroadcast(ADMIN_PK);
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        weth = new ERC20Mock("Wrapped Ether", "WETH", 18);
        claim = new StreamRecoveryClaim(admin, address(usdc), address(weth));
        vm.stopBroadcast();

        console2.log("  USDC:", address(usdc));
        console2.log("  WETH:", address(weth));
        console2.log("  Claim:", address(claim));
        _check(claim.admin() == admin, "Admin set correctly");
        _check(!claim.paused(), "Not paused on deploy");

        // ──────────────────────────────────────────────────────────────────
        // Phase 2: Waiver signing (5 users)
        // ──────────────────────────────────────────────────────────────────
        console2.log("");
        console2.log("Phase 2: Waiver signing");

        // User1 signs waiver
        {
            (uint8 v, bytes32 r, bytes32 s) = _signWaiver(USER1_PK);
            vm.broadcast(USER1_PK);
            claim.signWaiver(v, r, s);
            _check(claim.hasSignedWaiver(user1), "User1 waiver signed");
        }

        // User2 signs waiver
        {
            (uint8 v, bytes32 r, bytes32 s) = _signWaiver(USER2_PK);
            vm.broadcast(USER2_PK);
            claim.signWaiver(v, r, s);
            _check(claim.hasSignedWaiver(user2), "User2 waiver signed");
        }

        // User3 signs waiver
        {
            (uint8 v, bytes32 r, bytes32 s) = _signWaiver(USER3_PK);
            vm.broadcast(USER3_PK);
            claim.signWaiver(v, r, s);
            _check(claim.hasSignedWaiver(user3), "User3 waiver signed");
        }

        // User4 signs waiver
        {
            (uint8 v, bytes32 r, bytes32 s) = _signWaiver(USER4_PK);
            vm.broadcast(USER4_PK);
            claim.signWaiver(v, r, s);
            _check(claim.hasSignedWaiver(user4), "User4 waiver signed");
        }

        // User5 does NOT sign waiver (for revert test)
        _check(!claim.hasSignedWaiver(user5), "User5 waiver NOT signed (intentional)");

        // ──────────────────────────────────────────────────────────────────
        // Phase 3: Create Round 1
        // ──────────────────────────────────────────────────────────────────
        console2.log("");
        console2.log("Phase 3: Create Round 1");

        // Shares: user1=40%, user2=35%, user3=25% (USDC)
        //         user1=50%, user2=30%, user4=20% (WETH)
        uint256 u1UsdcShare = 4e17;  // 0.4 WAD = 40%
        uint256 u2UsdcShare = 35e16; // 0.35 WAD = 35%
        uint256 u3UsdcShare = 25e16; // 0.25 WAD = 25%

        uint256 u1WethShare = 5e17;  // 0.5 WAD = 50%
        uint256 u2WethShare = 3e17;  // 0.3 WAD = 30%
        uint256 u4WethShare = 2e17;  // 0.2 WAD = 20%

        bytes32 u1UsdcLeaf = _leaf(user1, u1UsdcShare);
        bytes32 u2UsdcLeaf = _leaf(user2, u2UsdcShare);
        bytes32 u3UsdcLeaf = _leaf(user3, u3UsdcShare);

        bytes32 u1WethLeaf = _leaf(user1, u1WethShare);
        bytes32 u2WethLeaf = _leaf(user2, u2WethShare);
        bytes32 u4WethLeaf = _leaf(user4, u4WethShare);

        bytes32 usdcRoot = _root3(u1UsdcLeaf, u2UsdcLeaf, u3UsdcLeaf);
        bytes32 wethRoot = _root3(u1WethLeaf, u2WethLeaf, u4WethLeaf);

        uint256 round1Usdc = 10_000e6;    // 10,000 USDC
        uint256 round1Weth = 5e18;         // 5 WETH

        vm.startBroadcast(ADMIN_PK);
        usdc.mint(address(claim), round1Usdc);
        weth.mint(address(claim), round1Weth);
        claim.createRound(usdcRoot, wethRoot, round1Usdc, round1Weth);
        vm.stopBroadcast();

        (,,uint256 r1UsdcTotal,,,,,) = claim.rounds(0);
        _check(r1UsdcTotal == round1Usdc, "Round 1 USDC total correct");

        // ──────────────────────────────────────────────────────────────────
        // Phase 4: Claim USDC (individual)
        // ──────────────────────────────────────────────────────────────────
        console2.log("");
        console2.log("Phase 4: USDC claims");

        // User1 claims USDC: 40% of 10,000 = 4,000
        {
            bytes32[] memory proof = _proof3_pos0(u2UsdcLeaf, u3UsdcLeaf);
            uint256 balBefore = usdc.balanceOf(user1);
            vm.broadcast(USER1_PK);
            claim.claimUsdc(0, u1UsdcShare, proof);
            uint256 got = usdc.balanceOf(user1) - balBefore;
            _check(got == 4_000e6, "User1 got 4,000 USDC");
        }

        // User2 claims USDC: 35% of 10,000 = 3,500
        {
            bytes32[] memory proof = _proof3_pos0(u1UsdcLeaf, u3UsdcLeaf);
            uint256 balBefore = usdc.balanceOf(user2);
            vm.broadcast(USER2_PK);
            claim.claimUsdc(0, u2UsdcShare, proof);
            uint256 got = usdc.balanceOf(user2) - balBefore;
            _check(got == 3_500e6, "User2 got 3,500 USDC");
        }

        // ──────────────────────────────────────────────────────────────────
        // Phase 5: Claim WETH (individual)
        // ──────────────────────────────────────────────────────────────────
        console2.log("");
        console2.log("Phase 5: WETH claims");

        // User1 claims WETH: 50% of 5 = 2.5
        {
            bytes32[] memory proof = _proof3_pos0(u2WethLeaf, u4WethLeaf);
            uint256 balBefore = weth.balanceOf(user1);
            vm.broadcast(USER1_PK);
            claim.claimWeth(0, u1WethShare, proof);
            uint256 got = weth.balanceOf(user1) - balBefore;
            _check(got == 25e17, "User1 got 2.5 WETH");
        }

        // User4 claims WETH: 20% of 5 = 1.0
        {
            bytes32[] memory proof = _proof3_pos2(u1WethLeaf, u2WethLeaf);
            uint256 balBefore = weth.balanceOf(user4);
            vm.broadcast(USER4_PK);
            claim.claimWeth(0, u4WethShare, proof);
            uint256 got = weth.balanceOf(user4) - balBefore;
            _check(got == 1e18, "User4 got 1.0 WETH");
        }

        // ──────────────────────────────────────────────────────────────────
        // Phase 6: Claim Both (single tx)
        // ──────────────────────────────────────────────────────────────────
        console2.log("");
        console2.log("Phase 6: claimBoth");

        // User2 claims WETH via claimBoth (already claimed USDC above, so only WETH should pay)
        // Actually User2 already claimed USDC, so claimBoth would revert. Let's use a fresh round.

        // ──────────────────────────────────────────────────────────────────
        // Phase 7: Revert tests
        // ──────────────────────────────────────────────────────────────────
        console2.log("");
        console2.log("Phase 7: Revert tests");

        // Double claim reverts
        {
            bytes32[] memory proof = _proof3_pos0(u2UsdcLeaf, u3UsdcLeaf);
            vm.broadcast(USER1_PK);
            try claim.claimUsdc(0, u1UsdcShare, proof) {
                _check(false, "Double USDC claim should revert");
            } catch {
                _check(true, "Double USDC claim reverts");
            }
        }

        // No waiver reverts (user5)
        {
            // user5 is not in the tree, but we test the waiver check first
            bytes32 fakeLeaf = _leaf(user5, 1e17);
            bytes32[] memory proof = new bytes32[](0);
            vm.broadcast(USER5_PK);
            try claim.claimUsdc(0, 1e17, proof) {
                _check(false, "No-waiver claim should revert");
            } catch {
                _check(true, "No-waiver claim reverts");
            }
        }

        // Wrong proof reverts
        {
            bytes32[] memory badProof = _proof3_pos0(u1UsdcLeaf, u3UsdcLeaf); // wrong sibling
            vm.broadcast(USER3_PK);
            try claim.claimUsdc(0, u3UsdcShare, badProof) {
                _check(false, "Wrong proof should revert");
            } catch {
                _check(true, "Wrong proof reverts");
            }
        }

        // Wrong share reverts
        {
            bytes32[] memory proof = _proof3_pos2(u1UsdcLeaf, u2UsdcLeaf);
            vm.broadcast(USER3_PK);
            try claim.claimUsdc(0, u3UsdcShare + 1, proof) {
                _check(false, "Wrong share should revert");
            } catch {
                _check(true, "Wrong share reverts");
            }
        }

        // ──────────────────────────────────────────────────────────────────
        // Phase 8: Pause / Unpause
        // ──────────────────────────────────────────────────────────────────
        console2.log("");
        console2.log("Phase 8: Pause / Unpause");

        vm.broadcast(ADMIN_PK);
        claim.pause();
        _check(claim.paused(), "Contract paused");

        // Claim while paused reverts
        {
            bytes32[] memory proof = _proof3_pos2(u1UsdcLeaf, u2UsdcLeaf);
            vm.broadcast(USER3_PK);
            try claim.claimUsdc(0, u3UsdcShare, proof) {
                _check(false, "Paused claim should revert");
            } catch {
                _check(true, "Paused claim reverts");
            }
        }

        // Waiver while paused reverts
        {
            (uint8 v, bytes32 r, bytes32 s) = _signWaiver(USER5_PK);
            vm.broadcast(USER5_PK);
            try claim.signWaiver(v, r, s) {
                _check(false, "Paused waiver should revert");
            } catch {
                _check(true, "Paused waiver reverts");
            }
        }

        vm.broadcast(ADMIN_PK);
        claim.unpause();
        _check(!claim.paused(), "Contract unpaused");

        // User3 can now claim USDC after unpause
        {
            bytes32[] memory proof = _proof3_pos2(u1UsdcLeaf, u2UsdcLeaf);
            uint256 balBefore = usdc.balanceOf(user3);
            vm.broadcast(USER3_PK);
            claim.claimUsdc(0, u3UsdcShare, proof);
            uint256 got = usdc.balanceOf(user3) - balBefore;
            _check(got == 2_500e6, "User3 got 2,500 USDC after unpause");
        }

        // ──────────────────────────────────────────────────────────────────
        // Phase 9: Round 2 (same Merkle roots, new funds)
        // ──────────────────────────────────────────────────────────────────
        console2.log("");
        console2.log("Phase 9: Round 2");

        uint256 round2Usdc = 5_000e6;
        uint256 round2Weth = 2e18;

        // NOTE: totalUsdcAllocated / totalWethAllocated are cumulative across
        // active rounds. Round 0 still holds its allocation even though tokens
        // have been claimed (claims reduce balance, NOT totalAllocated).
        // Only deactivateRound() releases unclaimed allocation.
        //
        // At this point:
        //   totalUsdcAllocated = 10,000  (round 0)
        //   totalWethAllocated = 5       (round 0)
        //   USDC balance ≈ 0   (all 10k claimed)
        //   WETH balance ≈ 1.5 (3.5 of 5 claimed)
        //
        // After createRound:
        //   totalUsdcAllocated = 15,000  → need balance >= 15,000
        //   totalWethAllocated = 7       → need balance >= 7
        //
        // So we must mint enough to cover the CUMULATIVE allocation.
        uint256 usdcNeeded = round1Usdc + round2Usdc; // 10k + 5k = 15k cumulative
        uint256 wethNeeded = round1Weth + round2Weth;  // 5 + 2 = 7 cumulative
        uint256 usdcBalance = usdc.balanceOf(address(claim));
        uint256 wethBalance = weth.balanceOf(address(claim));
        uint256 usdcToMint = usdcNeeded > usdcBalance ? usdcNeeded - usdcBalance : 0;
        uint256 wethToMint = wethNeeded > wethBalance ? wethNeeded - wethBalance : 0;

        vm.startBroadcast(ADMIN_PK);
        if (usdcToMint > 0) usdc.mint(address(claim), usdcToMint);
        if (wethToMint > 0) weth.mint(address(claim), wethToMint);
        claim.createRound(usdcRoot, wethRoot, round2Usdc, round2Weth);
        vm.stopBroadcast();

        (,,uint256 r2UsdcTotal,,,,,) = claim.rounds(1);
        _check(r2UsdcTotal == round2Usdc, "Round 2 created with correct USDC total");

        // User1 claims both from round 2
        {
            bytes32[] memory usdcProof = _proof3_pos0(u2UsdcLeaf, u3UsdcLeaf);
            bytes32[] memory wethProof = _proof3_pos0(u2WethLeaf, u4WethLeaf);

            uint256 usdcBefore = usdc.balanceOf(user1);
            uint256 wethBefore = weth.balanceOf(user1);

            vm.broadcast(USER1_PK);
            claim.claimBoth(1, u1UsdcShare, usdcProof, u1WethShare, wethProof);

            uint256 gotUsdc = usdc.balanceOf(user1) - usdcBefore;
            uint256 gotWeth = weth.balanceOf(user1) - wethBefore;

            _check(gotUsdc == 2_000e6, "User1 R2 claimBoth: 2,000 USDC");
            _check(gotWeth == 1e18, "User1 R2 claimBoth: 1.0 WETH");
        }

        // User2 claims WETH from round 1 (hasn't claimed WETH R1 yet) + USDC from round 2
        {
            bytes32[] memory wethProof = _proof3_pos0(u1WethLeaf, u4WethLeaf);
            uint256 balBefore = weth.balanceOf(user2);
            vm.broadcast(USER2_PK);
            claim.claimWeth(0, u2WethShare, wethProof);
            uint256 got = weth.balanceOf(user2) - balBefore;
            _check(got == 15e17, "User2 R1 WETH: 1.5 (30% of 5)");
        }
        {
            bytes32[] memory usdcProof = _proof3_pos0(u1UsdcLeaf, u3UsdcLeaf);
            uint256 balBefore = usdc.balanceOf(user2);
            vm.broadcast(USER2_PK);
            claim.claimUsdc(1, u2UsdcShare, usdcProof);
            uint256 got = usdc.balanceOf(user2) - balBefore;
            _check(got == 1_750e6, "User2 R2 USDC: 1,750 (35% of 5k)");
        }

        // ──────────────────────────────────────────────────────────────────
        // Phase 10: Deactivate round + Sweep unclaimed
        // ──────────────────────────────────────────────────────────────────
        console2.log("");
        console2.log("Phase 10: Deactivate + Sweep");

        vm.broadcast(ADMIN_PK);
        claim.deactivateRound(1);

        // Claiming deactivated round reverts
        {
            bytes32[] memory proof = _proof3_pos2(u1UsdcLeaf, u2UsdcLeaf);
            vm.broadcast(USER3_PK);
            try claim.claimUsdc(1, u3UsdcShare, proof) {
                _check(false, "Deactivated claim should revert");
            } catch {
                _check(true, "Deactivated round claim reverts");
            }
        }

        // Sweep before deadline reverts
        {
            vm.broadcast(ADMIN_PK);
            try claim.sweepUnclaimed(1, admin) {
                _check(false, "Early sweep should revert");
            } catch {
                _check(true, "Early sweep reverts");
            }
        }

        // Warp past deadline and sweep
        (,,,,,,uint256 deadline,) = claim.rounds(1);
        vm.warp(deadline + 1);

        uint256 adminUsdcBefore = usdc.balanceOf(admin);
        uint256 adminWethBefore = weth.balanceOf(admin);

        vm.broadcast(ADMIN_PK);
        claim.sweepUnclaimed(1, admin);

        uint256 sweptUsdc = usdc.balanceOf(admin) - adminUsdcBefore;
        uint256 sweptWeth = weth.balanceOf(admin) - adminWethBefore;

        // Round 2: 5000 USDC total, user1 claimed 2000, user2 claimed 1750. Remaining: 1250
        // Round 2: 2 WETH total, user1 claimed 1.0. Remaining: 1.0
        _check(sweptUsdc == 1_250e6, "Swept 1,250 USDC unclaimed");
        _check(sweptWeth == 1e18, "Swept 1.0 WETH unclaimed");

        // ──────────────────────────────────────────────────────────────────
        // Phase 11: Admin transfer (2-step)
        // ──────────────────────────────────────────────────────────────────
        console2.log("");
        console2.log("Phase 11: Admin transfer");

        address newAdmin = vm.addr(SWEEPER_PK);

        vm.broadcast(ADMIN_PK);
        claim.transferAdmin(newAdmin);
        _check(claim.admin() == admin, "Admin unchanged before accept");
        _check(claim.pendingAdmin() == newAdmin, "Pending admin set");

        vm.broadcast(SWEEPER_PK);
        claim.acceptAdmin();
        _check(claim.admin() == newAdmin, "New admin accepted");

        // ──────────────────────────────────────────────────────────────────
        // Summary
        // ──────────────────────────────────────────────────────────────────
        console2.log("");
        console2.log("=========================================");
        console2.log("  PASSED:", passCount);
        console2.log("  FAILED:", failCount);
        console2.log("=========================================");

        if (failCount > 0) {
            revert("E2E FAILED");
        }
    }
}
