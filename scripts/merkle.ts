/**
 * Merkle Tree Generation Script (Share-Based)
 *
 * Takes the snapshot JSON and generates a Merkle tree where each leaf
 * encodes the user's pro-rata SHARE (in WAD = 1e18) of the stkscUSD
 * and stkscETH pools. The same tree is reused for ALL distribution rounds.
 *
 * Usage:
 *   npx tsx scripts/merkle.ts --snapshot scripts/output/snapshot-<block>.json
 *
 * Output:
 *   scripts/output/merkle-shares.json
 *
 * The leaf encoding matches the contract:
 *   keccak256(bytes.concat(keccak256(abi.encode(address, usdcShareWad, wethShareWad))))
 */

import {
  keccak256,
  encodePacked,
  encodeAbiParameters,
  parseAbiParameters,
  getAddress,
} from "viem";
import * as fs from "fs";
import * as path from "path";

// ─── Constants ─────────────────────────────────────────────────────────

const WAD = 10n ** 18n;

// ─── Types ─────────────────────────────────────────────────────────────

interface SnapshotEntry {
  address: string;
  stkscUSD_balance: string;
  stkscETH_balance: string;
  stkscUSD_share: string;
  stkscETH_share: string;
}

interface SnapshotFile {
  snapshotBlock: number;
  timestamp: string;
  stkscUSD: {
    totalSupply: string;
    decimals: number;
    holderCount: number;
  };
  stkscETH: {
    totalSupply: string;
    decimals: number;
    holderCount: number;
  };
  entitlements: SnapshotEntry[];
}

interface MerkleEntry {
  address: string;
  usdcShareWad: string;
  wethShareWad: string;
  usdcSharePct: string;   // Human-readable percentage
  wethSharePct: string;   // Human-readable percentage
  leaf: string;
  proof: string[];
  index: number;
}

interface MerkleOutput {
  snapshotBlock: number;
  merkleRoot: string;
  leafCount: number;
  totalUsdcShareWad: string;
  totalWethShareWad: string;
  entries: MerkleEntry[];
}

// ─── Merkle Tree Implementation ────────────────────────────────────────

/**
 * Compute the double-hashed leaf matching the Solidity contract:
 *   keccak256(bytes.concat(keccak256(abi.encode(address, usdcShareWad, wethShareWad))))
 */
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

/**
 * Sort-hash a pair of nodes (matching OpenZeppelin MerkleProof).
 */
function hashPair(a: `0x${string}`, b: `0x${string}`): `0x${string}` {
  const aBig = BigInt(a);
  const bBig = BigInt(b);
  if (aBig < bBig) {
    return keccak256(encodePacked(["bytes32", "bytes32"], [a, b]));
  } else {
    return keccak256(encodePacked(["bytes32", "bytes32"], [b, a]));
  }
}

/**
 * Build a standard binary Merkle tree and return the root + proofs.
 */
function buildMerkleTree(leaves: `0x${string}`[]): {
  root: `0x${string}`;
  proofs: `0x${string}`[][];
} {
  if (leaves.length === 0) throw new Error("No leaves");
  if (leaves.length === 1) {
    return { root: leaves[0], proofs: [[]] };
  }

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

      if (siblingIdx < layer.length) {
        proof.push(layer[siblingIdx]);
      }
      idx = Math.floor(idx / 2);
    }
    proofs.push(proof);
  }

  return { root, proofs };
}

/**
 * Verify a Merkle proof (matching OpenZeppelin's MerkleProof.verify).
 */
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

// ─── Main ──────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const snapshotPath = getArg("--snapshot");

  if (!snapshotPath) {
    console.error("Usage: npx tsx scripts/merkle.ts --snapshot <path>");
    process.exit(1);
  }

  // Load snapshot
  const snapshot: SnapshotFile = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
  console.log(`📋 Loaded snapshot from block ${snapshot.snapshotBlock}`);
  console.log(`   ${snapshot.entitlements.length} addresses`);

  const usdTotalSupply = BigInt(snapshot.stkscUSD.totalSupply);
  const ethTotalSupply = BigInt(snapshot.stkscETH.totalSupply);

  console.log(`   stkscUSD totalSupply: ${usdTotalSupply}`);
  console.log(`   stkscETH totalSupply: ${ethTotalSupply}`);

  // Compute per-user shares in WAD
  console.log(`\n🧮 Computing per-user shares (WAD)...`);

  interface UserShare {
    address: `0x${string}`;
    usdcShareWad: bigint;
    wethShareWad: bigint;
  }

  const userShares: UserShare[] = [];
  let usdcShareSum = 0n;
  let wethShareSum = 0n;

  for (const entry of snapshot.entitlements) {
    const usdBalance = BigInt(entry.stkscUSD_balance);
    const ethBalance = BigInt(entry.stkscETH_balance);

    if (usdBalance === 0n && ethBalance === 0n) continue;

    // share = balance * WAD / totalSupply
    const usdcShare = usdTotalSupply > 0n ? (usdBalance * WAD) / usdTotalSupply : 0n;
    const wethShare = ethTotalSupply > 0n ? (ethBalance * WAD) / ethTotalSupply : 0n;

    if (usdcShare === 0n && wethShare === 0n) continue;

    userShares.push({
      address: getAddress(entry.address) as `0x${string}`,
      usdcShareWad: usdcShare,
      wethShareWad: wethShare,
    });

    usdcShareSum += usdcShare;
    wethShareSum += wethShare;
  }

  // Handle rounding dust — assign to the largest holder
  const usdcDust = WAD - usdcShareSum;
  const wethDust = WAD - wethShareSum;

  if (usdcDust !== 0n || wethDust !== 0n) {
    // Sort to find largest holder
    userShares.sort((a, b) => {
      const totalA = a.usdcShareWad + a.wethShareWad;
      const totalB = b.usdcShareWad + b.wethShareWad;
      return totalB > totalA ? 1 : totalB < totalA ? -1 : 0;
    });

    // Only add positive dust (negative would mean sum > WAD, which shouldn't happen with floor division)
    if (usdcDust > 0n) {
      userShares[0].usdcShareWad += usdcDust;
      usdcShareSum += usdcDust;
    }
    if (wethDust > 0n) {
      userShares[0].wethShareWad += wethDust;
      wethShareSum += wethDust;
    }

    console.log(`   Rounding dust: USDC=${usdcDust}, WETH=${wethDust} → assigned to ${userShares[0].address}`);
  }

  console.log(`   ${userShares.length} eligible addresses`);
  console.log(`   USDC share sum: ${usdcShareSum} (expected: ${WAD}, match: ${usdcShareSum === WAD})`);
  console.log(`   WETH share sum: ${wethShareSum} (expected: ${WAD}, match: ${wethShareSum === WAD})`);

  if (
    (usdTotalSupply > 0n && usdcShareSum !== WAD) ||
    (ethTotalSupply > 0n && wethShareSum !== WAD)
  ) {
    console.error("❌ FATAL: Share sum does not equal 1 WAD. Aborting.");
    process.exit(1);
  }

  // Sort by address for deterministic tree
  userShares.sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));

  // Build Merkle tree
  console.log(`\n🌳 Building Merkle tree...`);

  const leaves = userShares.map((e) =>
    computeLeaf(e.address, e.usdcShareWad, e.wethShareWad)
  );

  const { root, proofs } = buildMerkleTree(leaves);
  console.log(`   Root: ${root}`);
  console.log(`   Leaves: ${leaves.length}`);

  // Verify all proofs
  console.log(`\n✅ Verifying all proofs...`);
  let verifyOk = true;

  for (let i = 0; i < leaves.length; i++) {
    const isValid = verifyProof(proofs[i], root, leaves[i]);
    if (!isValid) {
      console.error(`   ❌ Proof verification failed for index ${i} (${userShares[i].address})`);
      verifyOk = false;
    }
  }

  if (!verifyOk) {
    console.error("❌ FATAL: Some proofs failed verification. Aborting.");
    process.exit(1);
  }
  console.log(`   All ${leaves.length} proofs verified ✓`);

  // Build output
  const merkleEntries: MerkleEntry[] = userShares.map((e, i) => ({
    address: e.address,
    usdcShareWad: e.usdcShareWad.toString(),
    wethShareWad: e.wethShareWad.toString(),
    usdcSharePct: `${(Number(e.usdcShareWad) / 1e16).toFixed(4)}%`,
    wethSharePct: `${(Number(e.wethShareWad) / 1e16).toFixed(4)}%`,
    leaf: leaves[i],
    proof: proofs[i],
    index: i,
  }));

  const output: MerkleOutput = {
    snapshotBlock: snapshot.snapshotBlock,
    merkleRoot: root,
    leafCount: leaves.length,
    totalUsdcShareWad: usdcShareSum.toString(),
    totalWethShareWad: wethShareSum.toString(),
    entries: merkleEntries,
  };

  // Write output
  const scriptDir = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
  const outputDir = path.join(scriptDir, "output");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `merkle-shares.json`);
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`\n📁 Merkle tree written to: ${outputPath}`);
  console.log(`   Use merkleRoot ${root} for ALL createRound() calls`);

  // Summary table (top 10)
  console.log(`\n📊 Top 10 claimants by USDC share:`);
  const byUsdcShare = [...merkleEntries].sort((a, b) => {
    const diff = BigInt(b.usdcShareWad) - BigInt(a.usdcShareWad);
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  });

  for (let i = 0; i < Math.min(10, byUsdcShare.length); i++) {
    const e = byUsdcShare[i];
    console.log(`   ${i + 1}. ${e.address}: USDC ${e.usdcSharePct}, WETH ${e.wethSharePct}`);
  }

  console.log(`\n📋 How to use:`);
  console.log(`   1. Deploy StreamRecoveryClaim(admin, usdc, weth)`);
  console.log(`   2. Fund contract with USDC + WETH for this round`);
  console.log(`   3. Call createRound(${root}, usdcTotal, wethTotal)`);
  console.log(`   4. Users claim with (roundId, usdcShareWad, wethShareWad, proof)`);
  console.log(`   5. For future rounds: repeat steps 2-3 with same merkleRoot`);
}

// ─── Run ───────────────────────────────────────────────────────────────

main();
