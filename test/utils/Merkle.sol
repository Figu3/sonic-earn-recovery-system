// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal Merkle tree library for testing.
///         Builds a standard binary Merkle tree from an array of leaf hashes.
library Merkle {
    /// @notice Compute the Merkle root from an array of leaves.
    function getRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        require(leaves.length > 0, "Merkle: empty leaves");
        uint256 n = leaves.length;

        // Copy leaves so we don't mutate the input
        bytes32[] memory nodes = new bytes32[](n);
        for (uint256 i; i < n; i++) {
            nodes[i] = leaves[i];
        }

        while (n > 1) {
            uint256 half = (n + 1) / 2;
            for (uint256 i; i < half; i++) {
                if (2 * i + 1 < n) {
                    nodes[i] = _hashPair(nodes[2 * i], nodes[2 * i + 1]);
                } else {
                    nodes[i] = nodes[2 * i];
                }
            }
            n = half;
        }
        return nodes[0];
    }

    /// @notice Generate a Merkle proof for the leaf at `index`.
    function getProof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory) {
        require(leaves.length > 0, "Merkle: empty leaves");
        require(index < leaves.length, "Merkle: index out of bounds");

        // Calculate proof length
        uint256 proofLen;
        {
            uint256 n = leaves.length;
            while (n > 1) {
                proofLen++;
                n = (n + 1) / 2;
            }
        }

        bytes32[] memory proof = new bytes32[](proofLen);
        uint256 n = leaves.length;

        // Copy leaves
        bytes32[] memory nodes = new bytes32[](n);
        for (uint256 i; i < n; i++) {
            nodes[i] = leaves[i];
        }

        uint256 pos = index;
        uint256 proofIdx;

        while (n > 1) {
            uint256 half = (n + 1) / 2;
            if (pos % 2 == 0) {
                // We're on the left, sibling is on the right
                if (pos + 1 < n) {
                    proof[proofIdx] = nodes[pos + 1];
                } else {
                    // No sibling (odd leaf count), proof element not needed
                    // Shrink proof array
                    proofLen--;
                }
            } else {
                // We're on the right, sibling is on the left
                proof[proofIdx] = nodes[pos - 1];
            }

            // Rebuild next level
            bytes32[] memory next = new bytes32[](half);
            for (uint256 i; i < half; i++) {
                if (2 * i + 1 < n) {
                    next[i] = _hashPair(nodes[2 * i], nodes[2 * i + 1]);
                } else {
                    next[i] = nodes[2 * i];
                }
            }

            nodes = next;
            pos = pos / 2;
            proofIdx++;
            n = half;
        }

        // Trim proof to actual length
        if (proofLen < proof.length) {
            bytes32[] memory trimmed = new bytes32[](proofLen);
            for (uint256 i; i < proofLen; i++) {
                trimmed[i] = proof[i];
            }
            return trimmed;
        }
        return proof;
    }

    /// @notice Hash a pair of nodes. Sorts them first for consistency with OZ MerkleProof.
    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        if (uint256(a) < uint256(b)) {
            return keccak256(abi.encodePacked(a, b));
        } else {
            return keccak256(abi.encodePacked(b, a));
        }
    }
}
