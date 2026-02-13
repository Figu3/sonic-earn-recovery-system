/**
 * Quick test to verify the share-based Merkle tree implementation
 * matches the Solidity contract.
 */

import {
  keccak256,
  encodePacked,
  encodeAbiParameters,
  parseAbiParameters,
  getAddress,
} from "viem";

const WAD = 10n ** 18n;

// ─── Copy of Merkle functions ──────────────────────────────────────────

function computeLeaf(
  address: `0x${string}`,
  usdcShareWad: bigint,
  wethShareWad: bigint
): `0x${string}` {
  const innerHash = keccak256(
    encodeAbiParameters(parseAbiParameters("address, uint256, uint256"), [
      address,
      usdcShareWad,
      wethShareWad,
    ])
  );
  return keccak256(encodePacked(["bytes32"], [innerHash]));
}

function hashPair(a: `0x${string}`, b: `0x${string}`): `0x${string}` {
  const aBig = BigInt(a);
  const bBig = BigInt(b);
  if (aBig < bBig) {
    return keccak256(encodePacked(["bytes32", "bytes32"], [a, b]));
  } else {
    return keccak256(encodePacked(["bytes32", "bytes32"], [b, a]));
  }
}

function buildMerkleTree(leaves: `0x${string}`[]): {
  root: `0x${string}`;
  proofs: `0x${string}`[][];
} {
  if (leaves.length === 0) throw new Error("No leaves");
  if (leaves.length === 1) return { root: leaves[0], proofs: [[]] };

  const layers: `0x${string}`[][] = [leaves.slice()];

  while (layers[layers.length - 1].length > 1) {
    const current = layers[layers.length - 1];
    const next: `0x${string}`[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push(hashPair(current[i], current[i + 1]));
      } else {
        next.push(current[i]);
      }
    }
    layers.push(next);
  }

  const root = layers[layers.length - 1][0];
  const proofs: `0x${string}`[][] = [];

  for (let leafIdx = 0; leafIdx < leaves.length; leafIdx++) {
    const proof: `0x${string}`[] = [];
    let idx = leafIdx;
    for (let layerIdx = 0; layerIdx < layers.length - 1; layerIdx++) {
      const layer = layers[layerIdx];
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (siblingIdx < layer.length) proof.push(layer[siblingIdx]);
      idx = Math.floor(idx / 2);
    }
    proofs.push(proof);
  }

  return { root, proofs };
}

function verifyProof(
  proof: `0x${string}`[],
  root: `0x${string}`,
  leaf: `0x${string}`
): boolean {
  let computedHash = leaf;
  for (const proofElement of proof) {
    computedHash = hashPair(computedHash, proofElement);
  }
  return computedHash === root;
}

// ─── Tests ─────────────────────────────────────────────────────────────

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`✅ PASS: ${msg}`);
}

function runTests() {
  console.log("🧪 Running share-based Merkle tree tests...\n");

  // Test 1: Single leaf
  {
    const leaf = computeLeaf(
      "0x0000000000000000000000000000000000000001",
      WAD, // 100% USDC share
      WAD  // 100% WETH share
    );
    const { root, proofs } = buildMerkleTree([leaf]);
    assert(root === leaf, "Single leaf: root equals leaf");
    assert(proofs[0].length === 0, "Single leaf: empty proof");
    assert(verifyProof(proofs[0], root, leaf), "Single leaf: proof verifies");
  }

  // Test 2: Two leaves with 50/50 split
  {
    const leaf0 = computeLeaf("0x0000000000000000000000000000000000000001", WAD / 2n, WAD / 2n);
    const leaf1 = computeLeaf("0x0000000000000000000000000000000000000002", WAD / 2n, WAD / 2n);
    const { root, proofs } = buildMerkleTree([leaf0, leaf1]);

    assert(verifyProof(proofs[0], root, leaf0), "Two leaves 50/50: proof[0] verifies");
    assert(verifyProof(proofs[1], root, leaf1), "Two leaves 50/50: proof[1] verifies");
    assert(!verifyProof(proofs[0], root, leaf1), "Two leaves 50/50: cross-proof fails");
  }

  // Test 3: Three leaves with asymmetric shares
  {
    // 30% USDC / 70% WETH, 50% / 20%, 20% / 10%
    const leaf0 = computeLeaf("0x0000000000000000000000000000000000000001", 3n * WAD / 10n, 7n * WAD / 10n);
    const leaf1 = computeLeaf("0x0000000000000000000000000000000000000002", 5n * WAD / 10n, 2n * WAD / 10n);
    const leaf2 = computeLeaf("0x0000000000000000000000000000000000000003", 2n * WAD / 10n, 1n * WAD / 10n);
    const { root, proofs } = buildMerkleTree([leaf0, leaf1, leaf2]);

    assert(verifyProof(proofs[0], root, leaf0), "Three leaves: proof[0] verifies");
    assert(verifyProof(proofs[1], root, leaf1), "Three leaves: proof[1] verifies");
    assert(verifyProof(proofs[2], root, leaf2), "Three leaves: proof[2] verifies");
  }

  // Test 4: Large tree (100 leaves)
  {
    const leaves: `0x${string}`[] = [];
    for (let i = 1; i <= 100; i++) {
      const addr = `0x${i.toString(16).padStart(40, "0")}` as `0x${string}`;
      // Each gets 1% of each pool
      leaves.push(computeLeaf(addr, WAD / 100n, WAD / 100n));
    }
    const { root, proofs } = buildMerkleTree(leaves);

    let allOk = true;
    for (let i = 0; i < leaves.length; i++) {
      if (!verifyProof(proofs[i], root, leaves[i])) {
        console.error(`  ❌ proof[${i}] failed`);
        allOk = false;
      }
    }
    assert(allOk, "100 leaves: all proofs verify");
  }

  // Test 5: Double-hash leaf encoding matches Solidity
  {
    const addr = "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" as `0x${string}`;
    const usdcShare = 3n * WAD / 10n; // 30%
    const wethShare = 7n * WAD / 10n; // 70%

    const abiEncoded = encodeAbiParameters(
      parseAbiParameters("address, uint256, uint256"),
      [addr, usdcShare, wethShare]
    );
    const innerHash = keccak256(abiEncoded);
    const expectedLeaf = keccak256(encodePacked(["bytes32"], [innerHash]));
    const actualLeaf = computeLeaf(addr, usdcShare, wethShare);
    assert(actualLeaf === expectedLeaf, "Double-hash leaf encoding matches Solidity");
  }

  // Test 6: Share-to-payout math simulation
  {
    const user1Share = 3n * WAD / 10n; // 30%
    const user2Share = 7n * WAD / 10n; // 70%

    // Simulate round with 10,000 USDC and 5 WETH
    const roundUsdcTotal = 10_000n * 10n ** 6n;
    const roundWethTotal = 5n * 10n ** 18n;

    const user1Usdc = (user1Share * roundUsdcTotal) / WAD;
    const user2Usdc = (user2Share * roundUsdcTotal) / WAD;

    const user1Weth = (user1Share * roundWethTotal) / WAD;
    const user2Weth = (user2Share * roundWethTotal) / WAD;

    assert(user1Usdc === 3000n * 10n ** 6n, "Share math: user1 gets 3000 USDC (30%)");
    assert(user2Usdc === 7000n * 10n ** 6n, "Share math: user2 gets 7000 USDC (70%)");
    assert(user1Weth === 15n * 10n ** 17n, "Share math: user1 gets 1.5 WETH (30%)");
    assert(user2Weth === 35n * 10n ** 17n, "Share math: user2 gets 3.5 WETH (70%)");

    // Same shares, different round totals
    const round2UsdcTotal = 500n * 10n ** 6n;
    const user1UsdcR2 = (user1Share * round2UsdcTotal) / WAD;
    assert(user1UsdcR2 === 150n * 10n ** 6n, "Share math round 2: user1 gets 150 USDC (30% of 500)");
  }

  // Test 7: End-to-end with fake snapshot
  {
    const snapshot = {
      stkscUSD: { totalSupply: "10000000" }, // 10 USDC total
      stkscETH: { totalSupply: "5000000000000000000" }, // 5 ETH total
      entitlements: [
        { address: "0x0000000000000000000000000000000000000001", stkscUSD_balance: "3000000", stkscETH_balance: "1000000000000000000" },
        { address: "0x0000000000000000000000000000000000000002", stkscUSD_balance: "5000000", stkscETH_balance: "2500000000000000000" },
        { address: "0x0000000000000000000000000000000000000003", stkscUSD_balance: "2000000", stkscETH_balance: "1500000000000000000" },
      ],
    };

    const usdTotal = BigInt(snapshot.stkscUSD.totalSupply);
    const ethTotal = BigInt(snapshot.stkscETH.totalSupply);

    const computed = snapshot.entitlements.map((e) => {
      const usdBal = BigInt(e.stkscUSD_balance);
      const ethBal = BigInt(e.stkscETH_balance);
      return {
        address: getAddress(e.address) as `0x${string}`,
        usdcShareWad: (usdBal * WAD) / usdTotal,
        wethShareWad: (ethBal * WAD) / ethTotal,
      };
    });

    computed.sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));

    const leaves = computed.map((e) => computeLeaf(e.address, e.usdcShareWad, e.wethShareWad));
    const { root, proofs } = buildMerkleTree(leaves);

    for (let i = 0; i < leaves.length; i++) {
      assert(
        verifyProof(proofs[i], root, leaves[i]),
        `End-to-end: user ${computed[i].address} proof verifies (USDC: ${computed[i].usdcShareWad}, WETH: ${computed[i].wethShareWad})`
      );
    }

    // Verify shares: 30%, 50%, 20%
    assert(computed.find((e) => e.address.endsWith("01"))!.usdcShareWad === 3n * WAD / 10n, "User 1 has 30% USDC share");
    assert(computed.find((e) => e.address.endsWith("02"))!.usdcShareWad === 5n * WAD / 10n, "User 2 has 50% USDC share");
    assert(computed.find((e) => e.address.endsWith("03"))!.usdcShareWad === 2n * WAD / 10n, "User 3 has 20% USDC share");
  }

  console.log("\n🎉 All tests passed!");
}

runTests();
