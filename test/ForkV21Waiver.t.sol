// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StreamRecoveryClaimV21} from "../src/StreamRecoveryClaimV21.sol";
import {Merkle} from "./utils/Merkle.sol";

/// @notice Phase G — fork tests for V2.1's variable-length signWaiver path.
///
/// Group A (this file): proves every signing primitive V2.1 must accept actually
/// works end-to-end against a freshly deployed V2.1 on a Sonic fork. Uses a small
/// controlled merkle tree (we own the leaves) so we can sign with test private
/// keys and exercise positive `claim*` paths.
///
/// Tests covered here:
///   - G2  EOA          : vm.sign 65-byte ECDSA → ECDSA-first path
///   - G7  7702 EOA     : vm.etch delegation code + vm.sign 65-byte ECDSA →
///                         ECDSA-first path MUST win over ERC-1271 even though
///                         msg.sender.code.length > 0
///   - G12 1271 wallet  : minimal Mock1271 returns 0x1626ba7e for the digest →
///                         ERC-1271 fallback path
///   - G4  2-of-N Safe  : real on-chain Safe (0x4d62…ff1d, the largest stuck
///                         recipient by USDC) → 2×65-byte pre-approved bundle
///   - G5  3-of-N Safe  : real on-chain Safe (0x7D1C…6676) → 3×65-byte bundle
///   - G6  4-of-N Safe  : real on-chain Safe (0x6a15…6567) → 4×65-byte bundle
///
/// G3 (1-of-1 Safe) is intentionally omitted: 158 of the stuck Safes are
/// threshold-1 and behave identically to a threshold-≥2 Safe under V2.1's
/// fallback path — thresholds 2/3/4 already prove the variable-length code
/// path works for any N.
///
/// Group B (G1, G8, G9, G10, G11) — merkle tree-content audits — are NOT in
/// this file. They cross-reference real V2.1 merkle JSON against
/// wq-payouts.json / 9mm-resolved.json / round0-claimed.json and don't depend
/// on the V2.1 contract diff. They live with Phase E artifacts.
contract ForkV21WaiverTest is Test {
    using Merkle for bytes32[];

    // ─── Sonic mainnet token addresses ──────────────────────────────────
    address constant USDC_SONIC = 0x29219dd400f2Bf60E5a23d13Be72B486D4038894;
    address constant WETH_SONIC = 0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38;

    // ─── Real on-chain Safe targets from Phase A ─────────────────────────
    address constant SAFE_2 = 0x4d62b6E166767988106cF7Ee8fE23E480E76FF1d; // 2-of-N
    address constant SAFE_3 = 0x7D1C5910C1d82A4874fAC4EDfe80eb3C2b706676; // 3-of-N
    address constant SAFE_4 = 0x6a150370626bB338e921b59e78AF991e6B416567; // 4-of-N

    // ─── 7702 delegation prefix ─────────────────────────────────────────
    // Real target observed on Sonic (from Fork7702Waiver.t.sol)
    address constant DELEGATION_TARGET = 0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B;

    // ─── Pool sizing ────────────────────────────────────────────────────
    // 7 claimants, each gets ~14.28% — round down to 14% so the sum stays
    // strictly under the pool total (V2.1 enforces ClaimExceedsTotal).
    uint256 constant SHARE_WAD = 0.14e18;
    uint256 constant USDC_TOTAL = 10_000e6;     // 10k USDC, 6 dec
    uint256 constant WETH_TOTAL = 10e18;        // 10 WETH

    // ─── Test actors ────────────────────────────────────────────────────
    address admin;

    address aliceEoa;     uint256 alicePk;     // G2
    address bob7702;      uint256 bobPk;       // G7
    Mock1271Wallet erc1271;                    // G12 (deployed in setUp)
    // SAFE_3 is on-chain (real)              // G5
    address spareEoa;     uint256 sparePk;     // padding (5th leaf so tree is balanced)

    // ─── Contract under test ────────────────────────────────────────────
    StreamRecoveryClaimV21 v21;

    // ─── Merkle data (built in setUp) ───────────────────────────────────
    bytes32 usdcRoot;
    bytes32 wethRoot;
    bytes32[] leaves;            // ordered: alice, bob7702, erc1271, SAFE_2, SAFE_3, SAFE_4, spare
    bytes32[][] proofs;          // proofs[i] = proof for leaves[i]
    uint256 constant IDX_ALICE   = 0;
    uint256 constant IDX_BOB7702 = 1;
    uint256 constant IDX_1271    = 2;
    uint256 constant IDX_SAFE_2  = 3;
    uint256 constant IDX_SAFE_3  = 4;
    uint256 constant IDX_SAFE_4  = 5;
    uint256 constant IDX_SPARE   = 6;

    // ─── Setup ──────────────────────────────────────────────────────────
    function setUp() public {
        vm.createSelectFork("https://rpc.soniclabs.com");

        admin = makeAddr("admin");
        (aliceEoa, alicePk)   = makeAddrAndKey("alice");
        (bob7702, bobPk)      = makeAddrAndKey("bob7702");
        (spareEoa, sparePk)   = makeAddrAndKey("spare");

        // Install 7702 delegation code on bob: 0xef0100 || delegationTarget(20)
        bytes memory delegationCode = abi.encodePacked(hex"ef0100", DELEGATION_TARGET);
        vm.etch(bob7702, delegationCode);
        assertEq(bob7702.code.length, 23, "7702 delegation code should be 23 bytes");

        // Deploy mock 1271 wallet
        erc1271 = new Mock1271Wallet();

        // Build the controlled merkle tree
        // Leaf encoding MUST match V2.1: keccak256(bytes.concat(keccak256(abi.encode(addr, shareWad))))
        leaves = new bytes32[](7);
        leaves[IDX_ALICE]   = _leaf(aliceEoa,         SHARE_WAD);
        leaves[IDX_BOB7702] = _leaf(bob7702,          SHARE_WAD);
        leaves[IDX_1271]    = _leaf(address(erc1271), SHARE_WAD);
        leaves[IDX_SAFE_2]  = _leaf(SAFE_2,           SHARE_WAD);
        leaves[IDX_SAFE_3]  = _leaf(SAFE_3,           SHARE_WAD);
        leaves[IDX_SAFE_4]  = _leaf(SAFE_4,           SHARE_WAD);
        leaves[IDX_SPARE]   = _leaf(spareEoa,         SHARE_WAD);

        usdcRoot = Merkle.getRoot(leaves);
        wethRoot = usdcRoot; // same tree for both for simplicity

        // Pre-compute proofs
        proofs = new bytes32[][](7);
        for (uint256 i = 0; i < 7; i++) {
            proofs[i] = Merkle.getProof(leaves, i);
        }

        // Deploy V2.1 fresh — no prior waiver registry
        v21 = new StreamRecoveryClaimV21(admin, USDC_SONIC, WETH_SONIC, address(0));

        // Fund the contract
        deal(USDC_SONIC, address(v21), USDC_TOTAL);
        deal(WETH_SONIC, address(v21), WETH_TOTAL);

        // Create Round 0
        vm.prank(admin);
        v21.createRound(usdcRoot, wethRoot, USDC_TOTAL, WETH_TOTAL);
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _leaf(address user, uint256 shareWad) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(user, shareWad))));
    }

    function _expectedUsdc() internal pure returns (uint256) {
        return (SHARE_WAD * USDC_TOTAL) / 1e18;
    }

    function _expectedWeth() internal pure returns (uint256) {
        return (SHARE_WAD * WETH_TOTAL) / 1e18;
    }

    /// @dev Sign the V2.1 waiver digest with `pk` and return the 65-byte sig.
    function _signEoa(uint256 pk, address claimant) internal view returns (bytes memory) {
        bytes32 digest = v21.getWaiverDigest(claimant);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v); // 65 bytes: r(32) || s(32) || v(1)
    }

    /// @dev End-to-end claim assertion: balance of `claimant` increases by exactly
    ///      the leaf's USDC and WETH amounts.
    function _claimAndAssert(address claimant, uint256 leafIdx) internal {
        uint256 usdcBefore = IERC20(USDC_SONIC).balanceOf(claimant);
        uint256 wethBefore = IERC20(WETH_SONIC).balanceOf(claimant);

        vm.prank(claimant);
        v21.claimBoth(0, SHARE_WAD, proofs[leafIdx], SHARE_WAD, proofs[leafIdx]);

        assertEq(
            IERC20(USDC_SONIC).balanceOf(claimant) - usdcBefore,
            _expectedUsdc(),
            "USDC delta mismatch"
        );
        assertEq(
            IERC20(WETH_SONIC).balanceOf(claimant) - wethBefore,
            _expectedWeth(),
            "WETH delta mismatch"
        );
    }

    // ─── G2: fresh EOA, ECDSA-first path ────────────────────────────────
    function test_G2_eoa_fresh_sign_then_claim() public {
        bytes memory sig = _signEoa(alicePk, aliceEoa);
        assertEq(sig.length, 65, "EOA sig must be 65 bytes");

        vm.prank(aliceEoa);
        v21.signWaiver(sig);
        assertTrue(v21.hasSignedWaiver(aliceEoa), "alice waiver must be set");

        _claimAndAssert(aliceEoa, IDX_ALICE);
        emit log_string("  G2 PASS: fresh EOA 65-byte ECDSA -> claim succeeds");
    }

    // ─── G7: 7702-delegated EOA, ECDSA path MUST beat ERC-1271 ──────────
    function test_G7_7702_eoa_sign_then_claim() public {
        // Sanity: bob has 7702 delegation code installed
        assertGt(bob7702.code.length, 0, "bob must have 7702 code");

        bytes memory sig = _signEoa(bobPk, bob7702);
        assertEq(sig.length, 65, "7702 EOA sig must be 65 bytes");

        // V2 would route this to ERC-1271 (broken). V2.1 tries ECDSA FIRST,
        // which returns bob7702, never inspects code.length, accepts.
        vm.prank(bob7702);
        v21.signWaiver(sig);
        assertTrue(v21.hasSignedWaiver(bob7702), "7702 bob waiver must be set");

        _claimAndAssert(bob7702, IDX_BOB7702);
        emit log_string("  G7 PASS: 7702 EOA ECDSA path beats ERC-1271 -> claim succeeds");
    }

    // ─── G12: minimal ERC-1271 wallet, fallback path ────────────────────
    function test_G12_erc1271_wallet_sign_then_claim() public {
        bytes32 digest = v21.getWaiverDigest(address(erc1271));
        erc1271.approve(digest);

        // Any non-65-byte payload (or one that fails ECDSA recovery) routes to
        // the ERC-1271 fallback. We use a non-empty dummy payload — Mock1271
        // ignores the signature contents and only checks `approved[digest]`.
        // V2.1 explicitly rejects 0-byte payloads (Phase H hardening), so the
        // payload must be at least 1 byte.
        bytes memory sig = hex"deadbeef";

        vm.prank(address(erc1271));
        v21.signWaiver(sig);
        assertTrue(v21.hasSignedWaiver(address(erc1271)), "1271 wallet waiver must be set");

        _claimAndAssert(address(erc1271), IDX_1271);
        emit log_string("  G12 PASS: ERC-1271 wallet fallback path -> claim succeeds");
    }

    /// @dev Run the full Safe approveHash + bundle + signWaiver + claim flow
    ///      against an arbitrary on-chain Safe whose leaf lives at `leafIdx`
    ///      with the expected `threshold`.
    function _runSafeCase(address safeAddr, uint256 expectedThreshold, uint256 leafIdx) internal {
        ISafe safe = ISafe(safeAddr);
        uint256 threshold = safe.getThreshold();
        assertEq(threshold, expectedThreshold, "threshold mismatch");
        address[] memory owners = safe.getOwners();
        assertGe(owners.length, threshold, "owners >= threshold");

        // Safe v1.4 CompatibilityFallbackHandler wraps the dataHash V2.1 passes
        // (= the V2.1 EIP-712 digest) into the Safe's own SafeMessage envelope
        // and yields a `messageHash`. Owners must approveHash that messageHash
        // for the v=1 pre-approved-signature path to validate.
        bytes32 digest = v21.getWaiverDigest(safeAddr);
        bytes32 messageHash = ICompatibilityFallback(safeAddr).getMessageHash(abi.encode(digest));

        // Pick the first `threshold` owners and have each approveHash().
        address[] memory signers = new address[](threshold);
        for (uint256 i = 0; i < threshold; i++) {
            signers[i] = owners[i];
            vm.prank(owners[i]);
            safe.approveHash(messageHash);
        }

        // Sort signers ascending by address — Safe.checkSignatures requires it.
        for (uint256 i = 0; i < threshold; i++) {
            for (uint256 j = i + 1; j < threshold; j++) {
                if (uint160(signers[i]) > uint160(signers[j])) {
                    (signers[i], signers[j]) = (signers[j], signers[i]);
                }
            }
        }

        // Pre-approved-hash bundle: per owner, 65 bytes laid out as
        //   r = owner address (left-padded to bytes32)
        //   s = 0
        //   v = 1
        bytes memory sig = new bytes(threshold * 65);
        for (uint256 i = 0; i < threshold; i++) {
            bytes32 r = bytes32(uint256(uint160(signers[i])));
            uint8 v = 1;
            assembly {
                let o := add(add(sig, 32), mul(i, 65))
                mstore(o, r)
                mstore(add(o, 32), 0)
                mstore8(add(o, 64), v)
            }
        }

        emit log_named_uint("safe bundle length", sig.length);

        vm.prank(safeAddr);
        v21.signWaiver(sig);
        assertTrue(v21.hasSignedWaiver(safeAddr), "safe waiver must be set");

        _claimAndAssert(safeAddr, leafIdx);
    }

    // ─── G4: real on-chain 2-of-N Safe ──────────────────────────────────
    function test_G4_safe_2ofN_sign_then_claim() public {
        _runSafeCase(SAFE_2, 2, IDX_SAFE_2);
        emit log_string("  G4 PASS: 2-of-N Safe variable-length bundle -> claim succeeds");
    }

    // ─── G5: real on-chain 3-of-N Safe ──────────────────────────────────
    function test_G5_safe_3ofN_sign_then_claim() public {
        _runSafeCase(SAFE_3, 3, IDX_SAFE_3);
        emit log_string("  G5 PASS: 3-of-N Safe variable-length bundle -> claim succeeds");
    }

    // ─── G6: real on-chain 4-of-N Safe ──────────────────────────────────
    function test_G6_safe_4ofN_sign_then_claim() public {
        _runSafeCase(SAFE_4, 4, IDX_SAFE_4);
        emit log_string("  G6 PASS: 4-of-N Safe variable-length bundle -> claim succeeds");
    }

    // ─── PH: Phase H hardening — empty signature must revert ───────────
    function test_PH_empty_signature_reverts() public {
        bytes memory sig = "";
        vm.prank(aliceEoa);
        vm.expectRevert(StreamRecoveryClaimV21.InvalidSignature.selector);
        v21.signWaiver(sig);
        assertFalse(v21.hasSignedWaiver(aliceEoa), "waiver must NOT be set");
        emit log_string("  PH PASS: empty signature rejected by Phase H hardening");
    }
}

// ─── Test fixtures ──────────────────────────────────────────────────────

interface ISafe {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function approveHash(bytes32 hashToApprove) external;
}

interface ICompatibilityFallback {
    /// @notice Safe v1.4 CompatibilityFallbackHandler exposes this through the
    ///         Safe's fallback. Returns the Safe-domain-scoped messageHash that
    ///         owners must approve for the v=1 pre-approved-signature path.
    function getMessageHash(bytes memory message) external view returns (bytes32);
}

/// @notice Minimal ERC-1271 wallet for Phase G G12.
///         Returns the magic value iff the digest has been pre-approved via
///         `approve(digest)`. Ignores the signature payload contents — Phase G
///         only needs to prove that V2.1 routes through the ERC-1271 fallback,
///         not that any particular wallet implementation is correct.
contract Mock1271Wallet {
    bytes4 constant MAGIC = 0x1626ba7e;
    mapping(bytes32 => bool) public approved;

    function approve(bytes32 hash) external {
        approved[hash] = true;
    }

    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
        if (approved[hash]) return MAGIC;
        return 0xffffffff;
    }
}
