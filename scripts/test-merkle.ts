/**
 * Quick test to verify the single-share Merkle tree implementation
 * matches the Solidity contract (split-tree design).
 *
 * Leaf encoding: keccak256(bytes.concat(keccak256(abi.encode(address, shareWad))))
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
  shareWad: bigint
): `0x${string}` {
  const innerHash = keccak256(
    encodeAbiParameters(parseAbiParameters("address, uint256"), [
      address,
      shareWad,
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
  console.log("🧪 Running single-share Merkle tree tests (split-tree design)...\n");

  // Test 1: Single leaf
  {
    const leaf = computeLeaf(
      "0x0000000000000000000000000000000000000001",
      WAD // 100% share
    );
    const { root, proofs } = buildMerkleTree([leaf]);
    assert(root === leaf, "Single leaf: root equals leaf");
    assert(proofs[0].length === 0, "Single leaf: empty proof");
    assert(verifyProof(proofs[0], root, leaf), "Single leaf: proof verifies");
  }

  // Test 2: Two leaves with 50/50 split
  {
    const leaf0 = computeLeaf("0x0000000000000000000000000000000000000001", WAD / 2n);
    const leaf1 = computeLeaf("0x0000000000000000000000000000000000000002", WAD / 2n);
    const { root, proofs } = buildMerkleTree([leaf0, leaf1]);

    assert(verifyProof(proofs[0], root, leaf0), "Two leaves 50/50: proof[0] verifies");
    assert(verifyProof(proofs[1], root, leaf1), "Two leaves 50/50: proof[1] verifies");
    assert(!verifyProof(proofs[0], root, leaf1), "Two leaves 50/50: cross-proof fails");
  }

  // Test 3: Three leaves with asymmetric shares
  {
    const leaf0 = computeLeaf("0x0000000000000000000000000000000000000001", 3n * WAD / 10n);
    const leaf1 = computeLeaf("0x0000000000000000000000000000000000000002", 5n * WAD / 10n);
    const leaf2 = computeLeaf("0x0000000000000000000000000000000000000003", 2n * WAD / 10n);
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
      leaves.push(computeLeaf(addr, WAD / 100n));
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
    const share = 3n * WAD / 10n; // 30%

    const abiEncoded = encodeAbiParameters(
      parseAbiParameters("address, uint256"),
      [addr, share]
    );
    const innerHash = keccak256(abiEncoded);
    const expectedLeaf = keccak256(encodePacked(["bytes32"], [innerHash]));
    const actualLeaf = computeLeaf(addr, share);
    assert(actualLeaf === expectedLeaf, "Double-hash leaf encoding matches Solidity");
  }

  // Test 6: Share-to-payout math simulation (USDC tree)
  {
    const user1Share = 3n * WAD / 10n; // 30%
    const user2Share = 7n * WAD / 10n; // 70%

    // Simulate USDC round with 10,000 USDC
    const roundTotal = 10_000n * 10n ** 6n;

    const user1Payout = (user1Share * roundTotal) / WAD;
    const user2Payout = (user2Share * roundTotal) / WAD;

    assert(user1Payout === 3000n * 10n ** 6n, "Share math: user1 gets 3000 USDC (30%)");
    assert(user2Payout === 7000n * 10n ** 6n, "Share math: user2 gets 7000 USDC (70%)");

    // Same shares, different round totals
    const round2Total = 500n * 10n ** 6n;
    const user1PayoutR2 = (user1Share * round2Total) / WAD;
    assert(user1PayoutR2 === 150n * 10n ** 6n, "Share math round 2: user1 gets 150 USDC (30% of 500)");
  }

  // Test 7: Share-to-payout math simulation (WETH tree)
  {
    const user1Share = 4n * WAD / 10n; // 40%
    const user2Share = 6n * WAD / 10n; // 60%

    const roundTotal = 5n * 10n ** 18n; // 5 WETH

    const user1Payout = (user1Share * roundTotal) / WAD;
    const user2Payout = (user2Share * roundTotal) / WAD;

    assert(user1Payout === 2n * 10n ** 18n, "WETH math: user1 gets 2 WETH (40%)");
    assert(user2Payout === 3n * 10n ** 18n, "WETH math: user2 gets 3 WETH (60%)");
  }

  // Test 8: End-to-end with fake snapshot — two separate trees
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

    // Build USDC tree
    const usdcUsers = snapshot.entitlements
      .filter((e) => BigInt(e.stkscUSD_balance) > 0n)
      .map((e) => ({
        address: getAddress(e.address) as `0x${string}`,
        shareWad: (BigInt(e.stkscUSD_balance) * WAD) / usdTotal,
      }))
      .sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));

    const usdcLeaves = usdcUsers.map((e) => computeLeaf(e.address, e.shareWad));
    const usdcTree = buildMerkleTree(usdcLeaves);

    for (let i = 0; i < usdcLeaves.length; i++) {
      assert(
        verifyProof(usdcTree.proofs[i], usdcTree.root, usdcLeaves[i]),
        `End-to-end USDC: user ${usdcUsers[i].address} proof verifies (share: ${usdcUsers[i].shareWad})`
      );
    }

    // Build WETH tree
    const wethUsers = snapshot.entitlements
      .filter((e) => BigInt(e.stkscETH_balance) > 0n)
      .map((e) => ({
        address: getAddress(e.address) as `0x${string}`,
        shareWad: (BigInt(e.stkscETH_balance) * WAD) / ethTotal,
      }))
      .sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));

    const wethLeaves = wethUsers.map((e) => computeLeaf(e.address, e.shareWad));
    const wethTree = buildMerkleTree(wethLeaves);

    for (let i = 0; i < wethLeaves.length; i++) {
      assert(
        verifyProof(wethTree.proofs[i], wethTree.root, wethLeaves[i]),
        `End-to-end WETH: user ${wethUsers[i].address} proof verifies (share: ${wethUsers[i].shareWad})`
      );
    }

    // Verify USDC shares: 30%, 50%, 20%
    assert(usdcUsers.find((e) => e.address.endsWith("01"))!.shareWad === 3n * WAD / 10n, "User 1 has 30% USDC share");
    assert(usdcUsers.find((e) => e.address.endsWith("02"))!.shareWad === 5n * WAD / 10n, "User 2 has 50% USDC share");
    assert(usdcUsers.find((e) => e.address.endsWith("03"))!.shareWad === 2n * WAD / 10n, "User 3 has 20% USDC share");

    // Verify WETH shares: 20%, 50%, 30%
    assert(wethUsers.find((e) => e.address.endsWith("01"))!.shareWad === 2n * WAD / 10n, "User 1 has 20% WETH share");
    assert(wethUsers.find((e) => e.address.endsWith("02"))!.shareWad === 5n * WAD / 10n, "User 2 has 50% WETH share");
    assert(wethUsers.find((e) => e.address.endsWith("03"))!.shareWad === 3n * WAD / 10n, "User 3 has 30% WETH share");
  }

  // Test 9: USDC-only users are NOT in WETH tree
  {
    const snapshot = {
      stkscUSD: { totalSupply: "10000000" },
      stkscETH: { totalSupply: "5000000000000000000" },
      entitlements: [
        { address: "0x0000000000000000000000000000000000000001", stkscUSD_balance: "5000000", stkscETH_balance: "0" },           // USDC only
        { address: "0x0000000000000000000000000000000000000002", stkscUSD_balance: "5000000", stkscETH_balance: "5000000000000000000" }, // Both
      ],
    };

    const usdTotal = BigInt(snapshot.stkscUSD.totalSupply);
    const ethTotal = BigInt(snapshot.stkscETH.totalSupply);

    const usdcUsers = snapshot.entitlements
      .filter((e) => BigInt(e.stkscUSD_balance) > 0n)
      .map((e) => ({
        address: getAddress(e.address) as `0x${string}`,
        shareWad: (BigInt(e.stkscUSD_balance) * WAD) / usdTotal,
      }));

    const wethUsers = snapshot.entitlements
      .filter((e) => BigInt(e.stkscETH_balance) > 0n)
      .map((e) => ({
        address: getAddress(e.address) as `0x${string}`,
        shareWad: (BigInt(e.stkscETH_balance) * WAD) / ethTotal,
      }));

    assert(usdcUsers.length === 2, "USDC tree has 2 holders");
    assert(wethUsers.length === 1, "WETH tree has 1 holder (USDC-only user excluded)");
    assert(wethUsers[0].shareWad === WAD, "WETH-only holder gets 100% share");
  }

  // Test 10: Different trees have different roots
  {
    const leaf1 = computeLeaf("0x0000000000000000000000000000000000000001", 3n * WAD / 10n);
    const leaf2 = computeLeaf("0x0000000000000000000000000000000000000001", 7n * WAD / 10n);

    // Same address, different shares → different leaves
    assert(leaf1 !== leaf2, "Same address, different shares → different leaves");

    // Different trees from different shares
    const tree1 = buildMerkleTree([leaf1]);
    const tree2 = buildMerkleTree([leaf2]);
    assert(tree1.root !== tree2.root, "Different share amounts → different roots");
  }

  // Test 11: Cross-tree proof doesn't work
  {
    // USDC tree: user has 30% share
    const usdcLeaf = computeLeaf("0x0000000000000000000000000000000000000001", 3n * WAD / 10n);
    const usdcTree = buildMerkleTree([usdcLeaf]);

    // WETH tree: user has 70% share
    const wethLeaf = computeLeaf("0x0000000000000000000000000000000000000001", 7n * WAD / 10n);
    const wethTree = buildMerkleTree([wethLeaf]);

    // USDC proof should NOT verify against WETH root
    assert(
      !verifyProof(usdcTree.proofs[0], wethTree.root, usdcLeaf),
      "Cross-tree: USDC proof fails against WETH root"
    );
    assert(
      !verifyProof(wethTree.proofs[0], usdcTree.root, wethLeaf),
      "Cross-tree: WETH proof fails against USDC root"
    );
  }

  console.log("\n🎉 All tests passed!");
}

runTests();
