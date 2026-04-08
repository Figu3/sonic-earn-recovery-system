// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice Minimal interface for reading waiver state from a previous version
///         of the recovery distributor (V1 or V2). Only `hasSignedWaiver` is needed
///         for migration — V2.1 does not replay any other prior state.
interface IPriorWaiverRegistry {
    function hasSignedWaiver(address user) external view returns (bool);
}

/// @title Trevee Earn Recovery Distributor V2.1 (StreamRecoveryClaimV21)
/// @notice V2.1 of the Stream Trading incident recovery distributor. Functionally
///         identical to V2 except for the signature-verification path in
///         `signWaiver`, which is rebuilt to support:
///           (a) multi-sig Gnosis Safes with threshold ≥ 2 (N×65-byte bundles),
///           (b) EIP-7702-delegated EOAs whose `code.length > 0`, and
///           (c) non-Safe ERC-1271 smart wallets.
///
/// @dev The fix has three parts:
///   1. `signWaiver` takes `bytes calldata signature` (variable length) instead of
///      the V2 `(uint8 v, bytes32 r, bytes32 s)` tuple. This lifts the hard 65-byte
///      cap that physically excluded any Safe with threshold ≥ 2.
///   2. Verification attempts ECDSA recovery FIRST. If the signature is exactly
///      65 bytes and `ecrecover` returns `msg.sender`, we accept without ever
///      inspecting `msg.sender.code.length`. This is the critical path for
///      EIP-7702-delegated EOAs, which have non-empty code but still hold a
///      real ECDSA key.
///   3. Only if the ECDSA path does not resolve to `msg.sender` (wrong length, or
///      recovered address differs) do we fall back to
///      `SignatureChecker.isValidERC1271SignatureNow`. That covers true smart
///      wallets (Safe, Argent, Coinbase Smart Wallet, etc.).
///
///      The EIP-712 domain version is bumped from "2" to "2.1" so that V2
///      signatures cannot be replayed on V2.1 and vice versa.
///
///      `priorWaivers` (optional, address(0) if fresh) points at the previous
///      version of this distributor. Users who already signed the waiver there
///      can call `migrateWaiverFromPrior` to skip re-signing on V2.1.
contract StreamRecoveryClaimV21 is EIP712 {
    using SafeERC20 for IERC20;

    // ─── Constants ──────────────────────────────────────────────────────
    uint256 private constant WAD = 1e18;

    bytes32 public constant WAIVER_TYPEHASH =
        keccak256("Waiver(address claimant,string message)");

    string public constant WAIVER_MESSAGE =
        "By submitting this claim, I understand and agree that: "
        "I am receiving a partial recovery related to the Stream Trading incident "
        "that affected Trevee's stkscUSD and/or stkscETH vaults. "
        "This payment might not represent a full recovery of my original deposit. "
        "In exchange for receiving this distribution, I agree not to bring further "
        "claims against Trevee or Veda Labs (or their teams or affiliates) relating to: "
        "the Stream Trading incident, the operation of the affected vaults, "
        "how this distribution was calculated or allocated, or "
        "the timing or process of this distribution. "
        "I understand that by claiming these funds, I waive the right to bring legal "
        "action against Trevee or Veda relating to the matters above. "
        "I confirm that I am authorized to claim on behalf of this wallet or account.";

    uint256 public constant CLAIM_DEADLINE_DURATION = 365 days;
    uint256 public constant MAX_BATCH_SIZE = 50;

    // ─── Storage ────────────────────────────────────────────────────────
    address public admin;
    address public pendingAdmin;

    IERC20 public immutable usdc;
    IERC20 public immutable weth;

    /// @notice Previous-version distributor (V1 or V2) used for waiver migration.
    ///         Zero address if this is a standalone / fresh deploy.
    IPriorWaiverRegistry public immutable priorWaivers;

    uint256 public roundCount;

    uint256 public totalUsdcAllocated;
    uint256 public totalWethAllocated;

    struct Round {
        bytes32 usdcMerkleRoot;
        bytes32 wethMerkleRoot;
        uint256 usdcTotal;
        uint256 wethTotal;
        uint256 usdcClaimed;
        uint256 wethClaimed;
        uint256 claimDeadline;
        bool active;
    }

    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => bool)) public hasClaimedUsdc;
    mapping(uint256 => mapping(address => bool)) public hasClaimedWeth;
    mapping(address => bool) public hasSignedWaiver;
    mapping(uint256 => bool) public swept;

    bool public paused;

    // ─── Events ─────────────────────────────────────────────────────────
    event RoundCreated(
        uint256 indexed roundId,
        bytes32 usdcMerkleRoot,
        bytes32 wethMerkleRoot,
        uint256 usdcTotal,
        uint256 wethTotal
    );
    event UsdcClaimed(uint256 indexed roundId, address indexed user, uint256 amount);
    event WethClaimed(uint256 indexed roundId, address indexed user, uint256 amount);
    event WaiverSigned(address indexed user);
    event RoundDeactivated(uint256 indexed roundId);
    event UnclaimedSwept(uint256 indexed roundId, uint256 usdcAmount, uint256 wethAmount);
    event AdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event MerkleRootsUpdated(uint256 indexed roundId, bytes32 usdcMerkleRoot, bytes32 wethMerkleRoot);

    // ─── Errors ─────────────────────────────────────────────────────────
    error NotAdmin();
    error ZeroAddress();
    error IsPaused();
    error RoundNotActive();
    error AlreadyClaimed();
    error WaiverNotSigned();
    error InvalidProof();
    error DeadlineNotReached();
    error NoRounds();
    error InvalidSignature();
    error InsufficientBalance();
    error ClaimExceedsTotal();
    error AlreadySwept();
    error TooManyRounds();
    error ZeroMerkleRoot();
    error AlreadySigned();
    error RoundHasClaims();
    error InvalidRound();
    error NoPriorWaiverRegistry();

    // ─── Modifiers ──────────────────────────────────────────────────────
    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    // ─── Constructor ────────────────────────────────────────────────────
    /// @param _admin Admin address for round management.
    /// @param _usdc USDC token address.
    /// @param _weth WETH token address.
    /// @param _priorWaivers Previous-version distributor address (V1 or V2) for
    ///                      waiver migration. Pass address(0) if no prior deploy.
    constructor(
        address _admin,
        address _usdc,
        address _weth,
        address _priorWaivers
    ) EIP712("StreamRecoveryClaim", "2.1") {
        if (_admin == address(0)) revert ZeroAddress();
        if (_usdc == address(0)) revert ZeroAddress();
        if (_weth == address(0)) revert ZeroAddress();

        admin = _admin;
        usdc = IERC20(_usdc);
        weth = IERC20(_weth);
        priorWaivers = IPriorWaiverRegistry(_priorWaivers);
    }

    // ─── Admin: Round Management ────────────────────────────────────────

    function createRound(
        bytes32 usdcMerkleRoot,
        bytes32 wethMerkleRoot,
        uint256 usdcTotal,
        uint256 wethTotal
    ) external onlyAdmin {
        if (usdcTotal > 0 && usdcMerkleRoot == bytes32(0)) revert ZeroMerkleRoot();
        if (wethTotal > 0 && wethMerkleRoot == bytes32(0)) revert ZeroMerkleRoot();

        totalUsdcAllocated += usdcTotal;
        totalWethAllocated += wethTotal;

        if (usdc.balanceOf(address(this)) < totalUsdcAllocated) revert InsufficientBalance();
        if (weth.balanceOf(address(this)) < totalWethAllocated) revert InsufficientBalance();

        uint256 roundId = roundCount++;

        rounds[roundId] = Round({
            usdcMerkleRoot: usdcMerkleRoot,
            wethMerkleRoot: wethMerkleRoot,
            usdcTotal: usdcTotal,
            wethTotal: wethTotal,
            usdcClaimed: 0,
            wethClaimed: 0,
            claimDeadline: block.timestamp + CLAIM_DEADLINE_DURATION,
            active: true
        });

        emit RoundCreated(roundId, usdcMerkleRoot, wethMerkleRoot, usdcTotal, wethTotal);
    }

    function deactivateRound(uint256 roundId) external onlyAdmin {
        Round storage round = rounds[roundId];
        if (!round.active) revert RoundNotActive();

        round.active = false;

        uint256 usdcUnclaimed = round.usdcTotal - round.usdcClaimed;
        uint256 wethUnclaimed = round.wethTotal - round.wethClaimed;
        totalUsdcAllocated -= usdcUnclaimed;
        totalWethAllocated -= wethUnclaimed;

        round.usdcTotal = round.usdcClaimed;
        round.wethTotal = round.wethClaimed;

        emit RoundDeactivated(roundId);
    }

    function updateMerkleRoots(
        uint256 roundId,
        bytes32 usdcMerkleRoot,
        bytes32 wethMerkleRoot
    ) external onlyAdmin {
        if (roundId >= roundCount) revert InvalidRound();

        Round storage round = rounds[roundId];
        if (!round.active) revert RoundNotActive();
        if (round.usdcClaimed > 0 || round.wethClaimed > 0) revert RoundHasClaims();

        if (round.usdcTotal > 0 && usdcMerkleRoot == bytes32(0)) revert ZeroMerkleRoot();
        if (round.wethTotal > 0 && wethMerkleRoot == bytes32(0)) revert ZeroMerkleRoot();

        round.usdcMerkleRoot = usdcMerkleRoot;
        round.wethMerkleRoot = wethMerkleRoot;

        emit MerkleRootsUpdated(roundId, usdcMerkleRoot, wethMerkleRoot);
    }

    // ─── User: Waiver ───────────────────────────────────────────────────

    /// @notice Migrate waiver from the previous version of this distributor
    ///         (V1 or V2). If the caller already has `hasSignedWaiver == true`
    ///         on the prior contract, they are auto-approved on V2.1 with no
    ///         signature required.
    function migrateWaiverFromPrior() external whenNotPaused {
        if (hasSignedWaiver[msg.sender]) revert AlreadySigned();
        if (address(priorWaivers) == address(0)) revert NoPriorWaiverRegistry();
        if (!priorWaivers.hasSignedWaiver(msg.sender)) revert InvalidSignature();

        hasSignedWaiver[msg.sender] = true;
        emit WaiverSigned(msg.sender);
    }

    /// @notice Sign the liability waiver using EIP-712 typed data.
    ///         Accepts any variable-length signature payload:
    ///           • 65-byte ECDSA signatures from EOAs (including EIP-7702-delegated EOAs)
    ///           • N×65-byte Gnosis Safe multi-sig bundles
    ///           • Arbitrary ERC-1271 payloads from smart wallets (Argent, Coinbase SW, …)
    /// @param signature The full signature payload. May be any length ≥ 0.
    /// @dev Resolution order (critical — do NOT reorder):
    ///        1. If `signature.length == 65`, attempt `ECDSA.tryRecover`. If the
    ///           recovered address matches `msg.sender`, accept. This path does
    ///           not consult `msg.sender.code.length` at all, which is why
    ///           EIP-7702-delegated EOAs (non-empty code, valid ECDSA key) work.
    ///        2. Otherwise, fall back to `SignatureChecker.isValidERC1271SignatureNowCalldata`,
    ///           which ABI-encodes and calls `msg.sender.isValidSignature(digest, signature)`.
    ///           This path covers Gnosis Safe multi-sig bundles and other smart wallets.
    ///      If neither path validates the signature against the caller, the
    ///      function reverts `InvalidSignature`. `msg.sender` is always the
    ///      claimant — there is no delegated-signer path, matching V2 semantics.
    function signWaiver(bytes calldata signature) external whenNotPaused {
        if (hasSignedWaiver[msg.sender]) revert AlreadySigned();
        // Reject empty payloads explicitly. There is no legitimate use case
        // for a 0-byte waiver signature in this contract: the ECDSA path
        // requires exactly 65 bytes, and the ERC-1271 fallback should always
        // receive a real signature blob (not a degenerate "approve via empty
        // bytes" path). Phase H hardening — closes the only finding that
        // touched the V2.1 diff itself.
        if (signature.length == 0) revert InvalidSignature();

        bytes32 digest = _waiverDigest(msg.sender);

        bool ok;

        // Path 1: try ECDSA first for any 65-byte payload.
        // This MUST run before the ERC-1271 fallback so that EIP-7702-delegated
        // EOAs (which have non-empty `code` but still hold a real ECDSA key)
        // can sign as EOAs without being misrouted to an ERC-1271 call that
        // their delegation target does not implement.
        if (signature.length == 65) {
            (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, signature);
            if (err == ECDSA.RecoverError.NoError && recovered == msg.sender) {
                ok = true;
            }
        }

        // Path 2: ERC-1271 fallback for everything else — multi-sig Safes with
        // threshold ≥ 2 (bundles of N×65 bytes), non-Safe smart wallets, and
        // any 65-byte payload that is not a valid ECDSA signature from the
        // caller (e.g. a Safe 1-of-1 passing an owner's raw ECDSA sig that
        // does not equal the Safe address).
        if (!ok) {
            ok = SignatureChecker.isValidERC1271SignatureNowCalldata(msg.sender, digest, signature);
        }

        if (!ok) revert InvalidSignature();

        hasSignedWaiver[msg.sender] = true;
        emit WaiverSigned(msg.sender);
    }

    // ─── User: Claim ────────────────────────────────────────────────────

    function claimUsdc(
        uint256 roundId,
        uint256 shareWad,
        bytes32[] calldata proof
    ) external whenNotPaused {
        _claimUsdc(roundId, shareWad, proof);
    }

    function claimWeth(
        uint256 roundId,
        uint256 shareWad,
        bytes32[] calldata proof
    ) external whenNotPaused {
        _claimWeth(roundId, shareWad, proof);
    }

    function claimBoth(
        uint256 roundId,
        uint256 usdcShareWad,
        bytes32[] calldata usdcProof,
        uint256 wethShareWad,
        bytes32[] calldata wethProof
    ) external whenNotPaused {
        _claimUsdc(roundId, usdcShareWad, usdcProof);
        _claimWeth(roundId, wethShareWad, wethProof);
    }

    function claimMultipleUsdc(
        uint256[] calldata roundIds,
        uint256 shareWad,
        bytes32[] calldata proof
    ) external whenNotPaused {
        uint256 len = roundIds.length;
        if (len == 0) revert NoRounds();
        if (len > MAX_BATCH_SIZE) revert TooManyRounds();
        for (uint256 i; i < len; ++i) {
            _claimUsdc(roundIds[i], shareWad, proof);
        }
    }

    function claimMultipleWeth(
        uint256[] calldata roundIds,
        uint256 shareWad,
        bytes32[] calldata proof
    ) external whenNotPaused {
        uint256 len = roundIds.length;
        if (len == 0) revert NoRounds();
        if (len > MAX_BATCH_SIZE) revert TooManyRounds();
        for (uint256 i; i < len; ++i) {
            _claimWeth(roundIds[i], shareWad, proof);
        }
    }

    // ─── Internal Claim Logic ───────────────────────────────────────────

    function _claimUsdc(
        uint256 roundId,
        uint256 shareWad,
        bytes32[] calldata proof
    ) internal {
        if (!hasSignedWaiver[msg.sender]) revert WaiverNotSigned();

        Round storage round = rounds[roundId];
        if (!round.active) revert RoundNotActive();
        if (hasClaimedUsdc[roundId][msg.sender]) revert AlreadyClaimed();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, shareWad))));
        if (!MerkleProof.verify(proof, round.usdcMerkleRoot, leaf)) revert InvalidProof();

        uint256 amount = (shareWad * round.usdcTotal) / WAD;
        if (round.usdcClaimed + amount > round.usdcTotal) revert ClaimExceedsTotal();

        hasClaimedUsdc[roundId][msg.sender] = true;
        round.usdcClaimed += amount;
        totalUsdcAllocated -= amount;

        if (amount > 0) {
            usdc.safeTransfer(msg.sender, amount);
        }

        emit UsdcClaimed(roundId, msg.sender, amount);
    }

    function _claimWeth(
        uint256 roundId,
        uint256 shareWad,
        bytes32[] calldata proof
    ) internal {
        if (!hasSignedWaiver[msg.sender]) revert WaiverNotSigned();

        Round storage round = rounds[roundId];
        if (!round.active) revert RoundNotActive();
        if (hasClaimedWeth[roundId][msg.sender]) revert AlreadyClaimed();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, shareWad))));
        if (!MerkleProof.verify(proof, round.wethMerkleRoot, leaf)) revert InvalidProof();

        uint256 amount = (shareWad * round.wethTotal) / WAD;
        if (round.wethClaimed + amount > round.wethTotal) revert ClaimExceedsTotal();

        hasClaimedWeth[roundId][msg.sender] = true;
        round.wethClaimed += amount;
        totalWethAllocated -= amount;

        if (amount > 0) {
            weth.safeTransfer(msg.sender, amount);
        }

        emit WethClaimed(roundId, msg.sender, amount);
    }

    // ─── Admin: Sweep Unclaimed ─────────────────────────────────────────

    function sweepUnclaimed(uint256 roundId, address to) external onlyAdmin {
        if (roundId >= roundCount) revert InvalidRound();
        if (to == address(0)) revert ZeroAddress();
        if (swept[roundId]) revert AlreadySwept();

        Round storage round = rounds[roundId];
        if (block.timestamp < round.claimDeadline) revert DeadlineNotReached();

        uint256 usdcRemaining = round.usdcTotal - round.usdcClaimed;
        uint256 wethRemaining = round.wethTotal - round.wethClaimed;

        swept[roundId] = true;

        if (round.active) {
            round.active = false;
            totalUsdcAllocated -= usdcRemaining;
            totalWethAllocated -= wethRemaining;
        }

        round.usdcClaimed = round.usdcTotal;
        round.wethClaimed = round.wethTotal;

        if (usdcRemaining > 0) {
            usdc.safeTransfer(to, usdcRemaining);
        }
        if (wethRemaining > 0) {
            weth.safeTransfer(to, wethRemaining);
        }

        emit UnclaimedSwept(roundId, usdcRemaining, wethRemaining);
    }

    // ─── Admin: Emergency ───────────────────────────────────────────────

    function pause() external onlyAdmin {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyAdmin {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ─── Admin: Rescue Tokens ────────────────────────────────────────────

    function rescueToken(address token, address to, uint256 amount) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();

        if (token == address(usdc)) {
            uint256 excess = usdc.balanceOf(address(this)) - totalUsdcAllocated;
            require(amount <= excess, "Exceeds rescuable USDC");
            usdc.safeTransfer(to, amount);
        } else if (token == address(weth)) {
            uint256 excess = weth.balanceOf(address(this)) - totalWethAllocated;
            require(amount <= excess, "Exceeds rescuable WETH");
            weth.safeTransfer(to, amount);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }

        emit TokenRescued(token, to, amount);
    }

    // ─── Admin: Transfer ────────────────────────────────────────────────

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    // ─── View ───────────────────────────────────────────────────────────

    function canClaimUsdc(
        uint256 roundId,
        address user,
        uint256 shareWad,
        bytes32[] calldata proof
    ) external view returns (bool eligible, uint256 amount) {
        if (paused) return (false, 0);
        if (roundId >= roundCount) return (false, 0);
        Round storage round = rounds[roundId];
        if (!round.active) return (false, 0);
        if (hasClaimedUsdc[roundId][user]) return (false, 0);
        if (!hasSignedWaiver[user]) return (false, 0);

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(user, shareWad))));
        if (!MerkleProof.verify(proof, round.usdcMerkleRoot, leaf)) return (false, 0);

        amount = (shareWad * round.usdcTotal) / WAD;
        eligible = true;
    }

    function canClaimWeth(
        uint256 roundId,
        address user,
        uint256 shareWad,
        bytes32[] calldata proof
    ) external view returns (bool eligible, uint256 amount) {
        if (paused) return (false, 0);
        if (roundId >= roundCount) return (false, 0);
        Round storage round = rounds[roundId];
        if (!round.active) return (false, 0);
        if (hasClaimedWeth[roundId][user]) return (false, 0);
        if (!hasSignedWaiver[user]) return (false, 0);

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(user, shareWad))));
        if (!MerkleProof.verify(proof, round.wethMerkleRoot, leaf)) return (false, 0);

        amount = (shareWad * round.wethTotal) / WAD;
        eligible = true;
    }

    /// @notice Get the EIP-712 domain separator (V2.1 uses version "2.1").
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Get the waiver digest a user needs to sign under V2.1's domain.
    function getWaiverDigest(address claimant) external view returns (bytes32) {
        return _waiverDigest(claimant);
    }

    function _waiverDigest(address claimant) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                WAIVER_TYPEHASH,
                claimant,
                keccak256(bytes(WAIVER_MESSAGE))
            )
        );
        return _hashTypedDataV4(structHash);
    }
}
