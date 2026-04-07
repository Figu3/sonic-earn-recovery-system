/**
 * Round 1 Merkle Tree Generator
 *
 * Generates Merkle trees for Round 1, which covers depositors from 4 protocol
 * contracts that were not resolved in the original Round 0 snapshot:
 *   - Tholgar Adapter (veUSD NFTs → 52 stkscUSD depositors)
 *   - Eliteness Equalizer (ELTOKEN → 497 stkscUSD depositors)
 *   - Eliteness ThenaAdapter (veUSD NFTs → 132 stkscUSD depositors)
 *   - Relay Contract (veETH NFTs → 40 stkscETH depositors)
 *
 * Each depositor's share is their pro-rata portion of the protocol contract's
 * total allocation. The shareWad represents the fraction of the Round 1 pool
 * they are entitled to (in WAD = 1e18 basis).
 *
 * Leaf encoding (matches StreamRecoveryClaim.sol):
 *   keccak256(bytes.concat(keccak256(abi.encode(address, shareWad))))
 *
 * Usage:
 *   npx tsx scripts/merkle-round1.ts
 *
 * Output:
 *   scripts/output/merkle-round1-usdc.json
 *   scripts/output/merkle-round1-weth.json
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

interface Round1Data {
  description: string;
  snapshot_block: number;
  protocols_resolved: Record<string, { address: string; stkscUSD?: string; stkscETH?: string; depositors: number }>;
  usdc_entitlements: Record<string, string>;
  weth_entitlements: Record<string, string>;
  usdc_total: string;
  weth_total: string;
}

interface UserShare {
  address: `0x${string}`;
  shareWad: bigint;
}

interface MerkleEntry {
  address: string;
  shareWad: string;
  sharePct: string;
  leaf: string;
  proof: string[];
}

// ─── Merkle Functions ──────────────────────────────────────────────────

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
  // Sort-hash for deterministic ordering
  if (a <= b) {
    return keccak256(encodePacked(["bytes32", "bytes32"], [a, b]));
  } else {
    return keccak256(encodePacked(["bytes32", "bytes32"], [b, a]));
  }
}

function buildMerkleTree(leaves: `0x${string}`[]): {
  root: `0x${string}`;
  proofs: `0x${string}`[][];
} {
  if (leaves.length === 0) {
    return { root: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`, proofs: [] };
  }
  if (leaves.length === 1) {
    return { root: leaves[0], proofs: [[]] };
  }

  // Build tree bottom-up
  const proofElements: Map<number, `0x${string}`[]> = new Map();
  for (let i = 0; i < leaves.length; i++) {
    proofElements.set(i, []);
  }

  let currentLevel = [...leaves];
  let currentIndices = leaves.map((_, i) => [i]);

  while (currentLevel.length > 1) {
    const nextLevel: `0x${string}`[] = [];
    const nextIndices: number[][] = [];

    for (let i = 0; i < currentLevel.length; i += 2) {
      if (i + 1 < currentLevel.length) {
        const hash = hashPair(currentLevel[i], currentLevel[i + 1]);
        nextLevel.push(hash);
        nextIndices.push([...currentIndices[i], ...currentIndices[i + 1]]);

        // Add proof elements
        for (const idx of currentIndices[i]) {
          proofElements.get(idx)!.push(currentLevel[i + 1]);
        }
        for (const idx of currentIndices[i + 1]) {
          proofElements.get(idx)!.push(currentLevel[i]);
        }
      } else {
        // Odd element: promote to next level
        nextLevel.push(currentLevel[i]);
        nextIndices.push(currentIndices[i]);
      }
    }

    currentLevel = nextLevel;
    currentIndices = nextIndices;
  }

  const proofs: `0x${string}`[][] = [];
  for (let i = 0; i < leaves.length; i++) {
    proofs.push(proofElements.get(i)!);
  }

  return { root: currentLevel[0], proofs };
}

function buildTokenTree(
  label: string,
  shares: UserShare[]
): { root: string; output: Record<string, unknown> } {
  // Verify shares sum to WAD (with dust tolerance)
  let shareSum = 0n;
  for (const s of shares) {
    shareSum += s.shareWad;
  }

  const dust = WAD - shareSum;
  if (dust > 0n && dust < BigInt(shares.length) * 2n) {
    // Assign rounding dust to largest holder
    shares.sort((a, b) => (b.shareWad > a.shareWad ? 1 : b.shareWad < a.shareWad ? -1 : 0));
    shares[0].shareWad += dust;
    console.log(`   ${label}: assigned ${dust} dust to largest holder`);
  } else if (dust !== 0n) {
    console.warn(`   ⚠️ ${label}: shares sum to ${shareSum} (dust=${dust})`);
    // Force normalize to WAD
    shares.sort((a, b) => (b.shareWad > a.shareWad ? 1 : b.shareWad < a.shareWad ? -1 : 0));
    shares[0].shareWad += dust;
  }

  // Sort by address for deterministic tree
  shares.sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));

  // Build leaves
  const leaves = shares.map((e) => computeLeaf(e.address, e.shareWad));
  const { root, proofs } = buildMerkleTree(leaves);

  console.log(`   ${label}: ${shares.length} holders, root = ${root}`);

  // Build output entries
  const entries: MerkleEntry[] = shares.map((e, i) => ({
    address: e.address,
    shareWad: e.shareWad.toString(),
    sharePct: `${(Number(e.shareWad) / 1e16).toFixed(4)}%`,
    leaf: leaves[i],
    proof: proofs[i],
  }));

  return {
    root,
    output: {
      root,
      holderCount: shares.length,
      entries,
    },
  };
}

// ─── Main ──────────────────────────────────────────────────────────────

function main() {
  const dataPath = path.join(__dirname, "output", "round1-resolved-depositors.json");
  const data: Round1Data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));

  console.log(`📋 Round 1 Resolution Data`);
  console.log(`   Snapshot block: ${data.snapshot_block}`);
  console.log(`   USDC claimants: ${Object.keys(data.usdc_entitlements).length}`);
  console.log(`   WETH claimants: ${Object.keys(data.weth_entitlements).length}`);

  const usdcTotal = BigInt(data.usdc_total);
  const wethTotal = BigInt(data.weth_total);

  console.log(`   USDC total: ${Number(usdcTotal) / 1e6} stkscUSD`);
  console.log(`   WETH total: ${Number(wethTotal) / 1e18} stkscETH`);

  // Build USDC shares (each user's proportion of the USDC pool)
  const usdcShares: UserShare[] = [];
  for (const [addr, amountStr] of Object.entries(data.usdc_entitlements)) {
    const amount = BigInt(amountStr);
    if (amount > 0n && usdcTotal > 0n) {
      const share = (amount * WAD) / usdcTotal;
      if (share > 0n) {
        usdcShares.push({ address: getAddress(addr) as `0x${string}`, shareWad: share });
      }
    }
  }

  // Build WETH shares
  const wethShares: UserShare[] = [];
  for (const [addr, amountStr] of Object.entries(data.weth_entitlements)) {
    const amount = BigInt(amountStr);
    if (amount > 0n && wethTotal > 0n) {
      const share = (amount * WAD) / wethTotal;
      if (share > 0n) {
        wethShares.push({ address: getAddress(addr) as `0x${string}`, shareWad: share });
      }
    }
  }

  console.log(`\n📊 Building Merkle trees...`);

  const usdcResult = buildTokenTree("USDC", usdcShares);
  const wethResult = buildTokenTree("WETH", wethShares);

  // Add metadata
  const usdcOutput = {
    ...usdcResult.output,
    snapshotBlock: data.snapshot_block,
    round: 1,
    description: "Round 1 USDC - Resolved protocol depositors (Tholgar + Eliteness Equalizer + Eliteness ThenaAdapter)",
    protocols: ["Tholgar Adapter", "Eliteness Equalizer", "Eliteness ThenaAdapter"],
  };

  const wethOutput = {
    ...wethResult.output,
    snapshotBlock: data.snapshot_block,
    round: 1,
    description: "Round 1 WETH - Resolved protocol depositors (Relay Contract)",
    protocols: ["Relay Contract"],
  };

  // Write outputs
  const outputDir = path.join(__dirname, "output");
  fs.mkdirSync(outputDir, { recursive: true });

  const usdcPath = path.join(outputDir, "merkle-round1-usdc.json");
  const wethPath = path.join(outputDir, "merkle-round1-weth.json");

  fs.writeFileSync(usdcPath, JSON.stringify(usdcOutput, null, 2));
  fs.writeFileSync(wethPath, JSON.stringify(wethOutput, null, 2));

  console.log(`\n✅ Written:`);
  console.log(`   ${usdcPath} (${usdcShares.length} holders, root: ${usdcResult.root})`);
  console.log(`   ${wethPath} (${wethShares.length} holders, root: ${wethResult.root})`);

  // Summary
  console.log(`\n📝 Round 1 createRound() parameters:`);
  console.log(`   usdcMerkleRoot: ${usdcResult.root}`);
  console.log(`   wethMerkleRoot: ${wethResult.root}`);
  console.log(`   usdcTotal: Calculate from Round 0 protocol shares`);
  console.log(`   wethTotal: Calculate from Round 0 protocol shares`);
}

main();
