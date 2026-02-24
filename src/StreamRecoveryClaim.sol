// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title StreamRecoveryClaim
/// @notice Distributes recovered assets from the Stream Trading incident to affected
///         stkscUSD and stkscETH users on a pro-rata basis via Merkle proofs.
/// @dev Uses TWO separate Merkle trees per round — one for USDC shares and one for WETH
///      shares. Each leaf encodes: keccak256(bytes.concat(keccak256(abi.encode(address, shareWad)))).
///      This allows ~85% of users (USDC-only) to claim without touching the WETH tree,
///      and enables independent distribution rounds per token.
///      Users must sign an EIP-712 waiver before claiming.
contract StreamRecoveryClaim is EIP712 {
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

    uint256 public roundCount;

    /// @notice Total USDC allocated across all active rounds (prevents over-commitment).
    uint256 public totalUsdcAllocated;
    /// @notice Total WETH allocated across all active rounds (prevents over-commitment).
    uint256 public totalWethAllocated;

    struct Round {
        bytes32 usdcMerkleRoot;  // Merkle root for USDC share tree
        bytes32 wethMerkleRoot;  // Merkle root for WETH share tree
        uint256 usdcTotal;       // Total USDC allocated to this round
        uint256 wethTotal;       // Total WETH allocated to this round
        uint256 usdcClaimed;     // USDC already claimed
        uint256 wethClaimed;     // WETH already claimed
        uint256 claimDeadline;   // Timestamp after which unclaimed funds can be swept
        bool active;
    }

    /// @notice roundId => Round data
    mapping(uint256 => Round) public rounds;

    /// @notice roundId => user => has claimed USDC
    mapping(uint256 => mapping(address => bool)) public hasClaimedUsdc;

    /// @notice roundId => user => has claimed WETH
    mapping(uint256 => mapping(address => bool)) public hasClaimedWeth;

    /// @notice user => has signed the waiver
    mapping(address => bool) public hasSignedWaiver;

    /// @notice roundId => has been swept
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
    constructor(
        address _admin,
        address _usdc,
        address _weth
    ) EIP712("StreamRecoveryClaim", "1") {
        if (_admin == address(0)) revert ZeroAddress();
        if (_usdc == address(0)) revert ZeroAddress();
        if (_weth == address(0)) revert ZeroAddress();

        admin = _admin;
        usdc = IERC20(_usdc);
        weth = IERC20(_weth);
    }

    // ─── Admin: Round Management ────────────────────────────────────────

    /// @notice Create a new distribution round. Tokens must already be in the contract.
    /// @param usdcMerkleRoot The Merkle root for the USDC share tree.
    /// @param wethMerkleRoot The Merkle root for the WETH share tree.
    /// @param usdcTotal Total USDC allocated to this round.
    /// @param wethTotal Total WETH allocated to this round.
    function createRound(
        bytes32 usdcMerkleRoot,
        bytes32 wethMerkleRoot,
        uint256 usdcTotal,
        uint256 wethTotal
    ) external onlyAdmin {
        // Reject zero Merkle roots when tokens are allocated
        if (usdcTotal > 0 && usdcMerkleRoot == bytes32(0)) revert ZeroMerkleRoot();
        if (wethTotal > 0 && wethMerkleRoot == bytes32(0)) revert ZeroMerkleRoot();

        // Track cumulative allocation and verify contract holds enough tokens
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

    /// @notice Deactivate a round (emergency only). Releases unallocated funds.
    function deactivateRound(uint256 roundId) external onlyAdmin {
        Round storage round = rounds[roundId];
        if (!round.active) revert RoundNotActive();

        round.active = false;

        // Release unclaimed allocation back to the pool
        uint256 usdcUnclaimed = round.usdcTotal - round.usdcClaimed;
        uint256 wethUnclaimed = round.wethTotal - round.wethClaimed;
        totalUsdcAllocated -= usdcUnclaimed;
        totalWethAllocated -= wethUnclaimed;

        emit RoundDeactivated(roundId);
    }

    /// @notice Update Merkle roots for a round that has zero claims.
    ///         Allows admin to fix wrong or swapped roots before any user claims.
    /// @param roundId The round to update.
    /// @param usdcMerkleRoot The new USDC Merkle root.
    /// @param wethMerkleRoot The new WETH Merkle root.
    function updateMerkleRoots(
        uint256 roundId,
        bytes32 usdcMerkleRoot,
        bytes32 wethMerkleRoot
    ) external onlyAdmin {
        if (roundId >= roundCount) revert InvalidRound();

        Round storage round = rounds[roundId];
        if (!round.active) revert RoundNotActive();
        if (round.usdcClaimed > 0 || round.wethClaimed > 0) revert RoundHasClaims();

        // Reject zero roots when tokens are allocated
        if (round.usdcTotal > 0 && usdcMerkleRoot == bytes32(0)) revert ZeroMerkleRoot();
        if (round.wethTotal > 0 && wethMerkleRoot == bytes32(0)) revert ZeroMerkleRoot();

        round.usdcMerkleRoot = usdcMerkleRoot;
        round.wethMerkleRoot = wethMerkleRoot;

        emit MerkleRootsUpdated(roundId, usdcMerkleRoot, wethMerkleRoot);
    }

    // ─── User: Waiver ───────────────────────────────────────────────────

    /// @notice Sign the liability waiver using EIP-712 typed data.
    /// @param v Signature v component.
    /// @param r Signature r component.
    /// @param s Signature s component.
    function signWaiver(uint8 v, bytes32 r, bytes32 s) external whenNotPaused {
        if (hasSignedWaiver[msg.sender]) revert AlreadySigned();

        bytes32 structHash = keccak256(
            abi.encode(
                WAIVER_TYPEHASH,
                msg.sender,
                keccak256(bytes(WAIVER_MESSAGE))
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);

        // Use bytes signature overload — OZ's ECDSA performs malleability checks
        address signer = ECDSA.recover(digest, abi.encodePacked(r, s, v));

        if (signer != msg.sender) revert InvalidSignature();

        hasSignedWaiver[msg.sender] = true;
        emit WaiverSigned(msg.sender);
    }

    // ─── User: Claim ────────────────────────────────────────────────────

    /// @notice Claim USDC from a single round.
    /// @param roundId The round to claim from.
    /// @param shareWad User's pro-rata share of the USDC pool (in WAD).
    /// @param proof Merkle proof against the USDC tree.
    function claimUsdc(
        uint256 roundId,
        uint256 shareWad,
        bytes32[] calldata proof
    ) external whenNotPaused {
        _claimUsdc(roundId, shareWad, proof);
    }

    /// @notice Claim WETH from a single round.
    /// @param roundId The round to claim from.
    /// @param shareWad User's pro-rata share of the WETH pool (in WAD).
    /// @param proof Merkle proof against the WETH tree.
    function claimWeth(
        uint256 roundId,
        uint256 shareWad,
        bytes32[] calldata proof
    ) external whenNotPaused {
        _claimWeth(roundId, shareWad, proof);
    }

    /// @notice Convenience: claim both USDC and WETH from a single round.
    /// @param roundId The round to claim from.
    /// @param usdcShareWad User's USDC share (WAD).
    /// @param usdcProof Merkle proof for USDC tree.
    /// @param wethShareWad User's WETH share (WAD).
    /// @param wethProof Merkle proof for WETH tree.
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

    /// @notice Claim USDC from multiple rounds in a single transaction.
    /// @param roundIds Array of round IDs.
    /// @param shareWad User's USDC share (WAD) — same for all rounds with same root.
    /// @param proof Merkle proof for the USDC tree.
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

    /// @notice Claim WETH from multiple rounds in a single transaction.
    /// @param roundIds Array of round IDs.
    /// @param shareWad User's WETH share (WAD) — same for all rounds with same root.
    /// @param proof Merkle proof for the WETH tree.
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

        // Verify Merkle proof against USDC tree
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, shareWad))));
        if (!MerkleProof.verify(proof, round.usdcMerkleRoot, leaf)) revert InvalidProof();

        // Compute payout
        uint256 amount = (shareWad * round.usdcTotal) / WAD;
        if (round.usdcClaimed + amount > round.usdcTotal) revert ClaimExceedsTotal();

        // Effects
        hasClaimedUsdc[roundId][msg.sender] = true;
        round.usdcClaimed += amount;

        // Interactions
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

        // Verify Merkle proof against WETH tree
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, shareWad))));
        if (!MerkleProof.verify(proof, round.wethMerkleRoot, leaf)) revert InvalidProof();

        // Compute payout
        uint256 amount = (shareWad * round.wethTotal) / WAD;
        if (round.wethClaimed + amount > round.wethTotal) revert ClaimExceedsTotal();

        // Effects
        hasClaimedWeth[roundId][msg.sender] = true;
        round.wethClaimed += amount;

        // Interactions
        if (amount > 0) {
            weth.safeTransfer(msg.sender, amount);
        }

        emit WethClaimed(roundId, msg.sender, amount);
    }

    // ─── Admin: Sweep Unclaimed ─────────────────────────────────────────

    /// @notice Sweep unclaimed funds after the claim deadline has passed.
    ///         Works on both active and deactivated rounds.
    /// @param roundId The round to sweep.
    /// @param to Recipient of unclaimed funds.
    function sweepUnclaimed(uint256 roundId, address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        if (swept[roundId]) revert AlreadySwept();

        Round storage round = rounds[roundId];
        if (block.timestamp < round.claimDeadline) revert DeadlineNotReached();

        uint256 usdcRemaining = round.usdcTotal - round.usdcClaimed;
        uint256 wethRemaining = round.wethTotal - round.wethClaimed;

        // Mark as swept to prevent double-sweep
        swept[roundId] = true;

        // If round is still active, deactivate it and release allocation
        if (round.active) {
            round.active = false;
            totalUsdcAllocated -= usdcRemaining;
            totalWethAllocated -= wethRemaining;
        }
        // If already deactivated, allocation was already released by deactivateRound

        // Mark round as fully claimed
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

    /// @notice Pause all user-facing claim operations. Only callable by admin.
    /// @dev Sets `paused = true`, blocking `signWaiver`, `claimUsdc`, `claimWeth`,
    ///      `claimBoth`, `claimMultipleUsdc`, and `claimMultipleWeth`.
    function pause() external onlyAdmin {
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Resume all user-facing claim operations after a pause. Only callable by admin.
    function unpause() external onlyAdmin {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ─── Admin: Rescue Tokens ────────────────────────────────────────────

    /// @notice Rescue tokens accidentally sent to this contract.
    ///         For USDC/WETH: only allows withdrawing the excess above totalAllocated.
    ///         For other tokens: allows full withdrawal.
    /// @param token The token to rescue.
    /// @param to Recipient of rescued tokens.
    /// @param amount Amount to rescue.
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

    /// @notice Check if a user can claim USDC from a specific round.
    /// @param roundId The round to check.
    /// @param user The address to check eligibility for.
    /// @param shareWad The pro-rata share (WAD) to verify.
    /// @param proof Merkle proof against the USDC tree.
    /// @return eligible True if the user can claim right now.
    /// @return amount The USDC amount the user would receive.
    function canClaimUsdc(
        uint256 roundId,
        address user,
        uint256 shareWad,
        bytes32[] calldata proof
    ) external view returns (bool eligible, uint256 amount) {
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

    /// @notice Check if a user can claim WETH from a specific round.
    /// @param roundId The round to check.
    /// @param user The address to check eligibility for.
    /// @param shareWad The pro-rata share (WAD) to verify.
    /// @param proof Merkle proof against the WETH tree.
    /// @return eligible True if the user can claim right now.
    /// @return amount The WETH amount the user would receive.
    function canClaimWeth(
        uint256 roundId,
        address user,
        uint256 shareWad,
        bytes32[] calldata proof
    ) external view returns (bool eligible, uint256 amount) {
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

    /// @notice Get the EIP-712 domain separator.
    /// @return The EIP-712 domain separator hash.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Get the waiver digest that a user needs to sign.
    /// @param claimant The address of the user who will sign.
    /// @return The EIP-712 typed data hash to be signed.
    function getWaiverDigest(address claimant) external view returns (bytes32) {
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
