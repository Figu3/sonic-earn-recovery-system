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
/// @dev Uses share-based Merkle leaves: each user's leaf encodes their proportional
///      share (in WAD = 1e18) of the stkscUSD and stkscETH pools. The same Merkle
///      root is reused across all distribution rounds; actual payouts are computed
///      on-chain as `share * roundTotal / WAD`.
///      Users must sign an EIP-712 waiver before claiming.
contract StreamRecoveryClaim is EIP712 {
    using SafeERC20 for IERC20;

    // ─── Constants ──────────────────────────────────────────────────────
    uint256 private constant WAD = 1e18;

    bytes32 public constant WAIVER_TYPEHASH =
        keccak256("Waiver(address claimant,string message)");

    string public constant WAIVER_MESSAGE =
        "I acknowledge that I am claiming recovered assets from the Stream Trading "
        "incident affecting Trevee's stkscUSD/stkscETH vaults. I understand this is "
        "a partial recovery and I release Trevee and Veda from further claims related "
        "to this distribution.";

    uint256 public constant CLAIM_DEADLINE_DURATION = 365 days;

    // ─── Storage ────────────────────────────────────────────────────────
    address public admin;
    address public pendingAdmin;

    IERC20 public immutable usdc;
    IERC20 public immutable weth;

    uint256 public roundCount;

    struct Round {
        bytes32 merkleRoot;
        uint256 usdcTotal;       // Total USDC allocated to this round
        uint256 wethTotal;       // Total WETH allocated to this round
        uint256 usdcClaimed;     // USDC already claimed
        uint256 wethClaimed;     // WETH already claimed
        uint256 claimDeadline;   // Timestamp after which unclaimed funds can be swept
        bool active;
    }

    /// @notice roundId => Round data
    mapping(uint256 => Round) public rounds;

    /// @notice roundId => user => claimed
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    /// @notice user => has signed the waiver
    mapping(address => bool) public hasSignedWaiver;

    bool public paused;

    // ─── Events ─────────────────────────────────────────────────────────
    event RoundCreated(uint256 indexed roundId, bytes32 merkleRoot, uint256 usdcTotal, uint256 wethTotal);
    event Claimed(uint256 indexed roundId, address indexed user, uint256 usdcAmount, uint256 wethAmount);
    event WaiverSigned(address indexed user);
    event RoundDeactivated(uint256 indexed roundId);
    event UnclaimedSwept(uint256 indexed roundId, uint256 usdcAmount, uint256 wethAmount);
    event AdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

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
    /// @param merkleRoot The Merkle root encoding per-user shares (WAD-based).
    /// @param usdcTotal Total USDC allocated to this round.
    /// @param wethTotal Total WETH allocated to this round.
    function createRound(
        bytes32 merkleRoot,
        uint256 usdcTotal,
        uint256 wethTotal
    ) external onlyAdmin {
        uint256 roundId = roundCount++;

        rounds[roundId] = Round({
            merkleRoot: merkleRoot,
            usdcTotal: usdcTotal,
            wethTotal: wethTotal,
            usdcClaimed: 0,
            wethClaimed: 0,
            claimDeadline: block.timestamp + CLAIM_DEADLINE_DURATION,
            active: true
        });

        emit RoundCreated(roundId, merkleRoot, usdcTotal, wethTotal);
    }

    /// @notice Deactivate a round (emergency only).
    function deactivateRound(uint256 roundId) external onlyAdmin {
        rounds[roundId].active = false;
        emit RoundDeactivated(roundId);
    }

    // ─── User: Waiver ───────────────────────────────────────────────────

    /// @notice Sign the liability waiver using EIP-712 typed data.
    /// @param v Signature v component.
    /// @param r Signature r component.
    /// @param s Signature s component.
    function signWaiver(uint8 v, bytes32 r, bytes32 s) external whenNotPaused {
        bytes32 structHash = keccak256(
            abi.encode(
                WAIVER_TYPEHASH,
                msg.sender,
                keccak256(bytes(WAIVER_MESSAGE))
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, v, r, s);

        if (signer != msg.sender) revert InvalidSignature();

        hasSignedWaiver[msg.sender] = true;
        emit WaiverSigned(msg.sender);
    }

    // ─── User: Claim ────────────────────────────────────────────────────

    /// @notice Claim recovered assets for a single round.
    /// @param roundId The round to claim from.
    /// @param usdcShareWad User's pro-rata share of the USDC pool (in WAD).
    /// @param wethShareWad User's pro-rata share of the WETH pool (in WAD).
    /// @param proof Merkle proof.
    function claim(
        uint256 roundId,
        uint256 usdcShareWad,
        uint256 wethShareWad,
        bytes32[] calldata proof
    ) external whenNotPaused {
        _claim(roundId, usdcShareWad, wethShareWad, proof);
    }

    /// @notice Claim from multiple rounds in a single transaction.
    /// @dev All rounds use the same shares and proof since the Merkle root is share-based.
    /// @param roundIds Array of round IDs.
    /// @param usdcShareWad User's pro-rata share of the USDC pool (in WAD).
    /// @param wethShareWad User's pro-rata share of the WETH pool (in WAD).
    /// @param proof Merkle proof (same for all rounds if same Merkle root).
    function claimMultiple(
        uint256[] calldata roundIds,
        uint256 usdcShareWad,
        uint256 wethShareWad,
        bytes32[] calldata proof
    ) external whenNotPaused {
        uint256 len = roundIds.length;
        for (uint256 i; i < len; ++i) {
            _claim(roundIds[i], usdcShareWad, wethShareWad, proof);
        }
    }

    function _claim(
        uint256 roundId,
        uint256 usdcShareWad,
        uint256 wethShareWad,
        bytes32[] calldata proof
    ) internal {
        if (!hasSignedWaiver[msg.sender]) revert WaiverNotSigned();

        Round storage round = rounds[roundId];
        if (!round.active) revert RoundNotActive();
        if (hasClaimed[roundId][msg.sender]) revert AlreadyClaimed();

        // Verify Merkle proof against share-based leaf
        bytes32 leaf = keccak256(
            bytes.concat(
                keccak256(abi.encode(msg.sender, usdcShareWad, wethShareWad))
            )
        );
        if (!MerkleProof.verify(proof, round.merkleRoot, leaf)) revert InvalidProof();

        // Compute actual payout: share * roundTotal / WAD
        uint256 usdcAmount = (usdcShareWad * round.usdcTotal) / WAD;
        uint256 wethAmount = (wethShareWad * round.wethTotal) / WAD;

        // Effects
        hasClaimed[roundId][msg.sender] = true;
        round.usdcClaimed += usdcAmount;
        round.wethClaimed += wethAmount;

        // Interactions
        if (usdcAmount > 0) {
            usdc.safeTransfer(msg.sender, usdcAmount);
        }
        if (wethAmount > 0) {
            weth.safeTransfer(msg.sender, wethAmount);
        }

        emit Claimed(roundId, msg.sender, usdcAmount, wethAmount);
    }

    // ─── Admin: Sweep Unclaimed ─────────────────────────────────────────

    /// @notice Sweep unclaimed funds after the claim deadline has passed.
    /// @param roundId The round to sweep.
    /// @param to Recipient of unclaimed funds.
    function sweepUnclaimed(uint256 roundId, address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        Round storage round = rounds[roundId];
        if (block.timestamp < round.claimDeadline) revert DeadlineNotReached();

        uint256 usdcRemaining = round.usdcTotal - round.usdcClaimed;
        uint256 wethRemaining = round.wethTotal - round.wethClaimed;

        // Mark round as fully claimed to prevent further claims
        round.active = false;
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

    /// @notice Check if a user can claim a specific round and preview the payout.
    function canClaim(
        uint256 roundId,
        address user,
        uint256 usdcShareWad,
        uint256 wethShareWad,
        bytes32[] calldata proof
    ) external view returns (bool eligible, uint256 usdcAmount, uint256 wethAmount) {
        Round storage round = rounds[roundId];
        if (!round.active) return (false, 0, 0);
        if (hasClaimed[roundId][user]) return (false, 0, 0);
        if (!hasSignedWaiver[user]) return (false, 0, 0);

        bytes32 leaf = keccak256(
            bytes.concat(
                keccak256(abi.encode(user, usdcShareWad, wethShareWad))
            )
        );
        if (!MerkleProof.verify(proof, round.merkleRoot, leaf)) return (false, 0, 0);

        usdcAmount = (usdcShareWad * round.usdcTotal) / WAD;
        wethAmount = (wethShareWad * round.wethTotal) / WAD;
        eligible = true;
    }

    /// @notice Get the EIP-712 domain separator.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Get the waiver digest that a user needs to sign.
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
