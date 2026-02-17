/**
 * Merkle Tree Generation Script (Split Trees — One per Token)
 *
 * Takes the snapshot JSON and generates TWO Merkle trees:
 *   - USDC tree: one leaf per stkscUSD holder with their pro-rata share
 *   - WETH tree: one leaf per stkscETH holder with their pro-rata share
 *
 * Leaf encoding (single-share, matching the contract):
 *   keccak256(bytes.concat(keccak256(abi.encode(address, shareWad))))
 *
 * Usage:
 *   npx tsx scripts/merkle.ts --snapshot scripts/output/snapshot-<block>.json
 *
 * Output:
 *   scripts/output/merkle-usdc.json
 *   scripts/output/merkle-weth.json
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

// ─── Protocol Redirects ────────────────────────────────────────────────
// Protocol contracts that cannot claim directly. Their share is redirected
// to a designated recipient address. Balances from multiple contracts
// mapping to the same recipient are consolidated.

const PROTOCOL_REDIRECTS: Record<string, { target: string; label: string }> = {
  // Silo → single Silo distribution address
  "0xe8e1a980a7fc8d47d337d704fa73fbb81ee55c25": {
    target: "0x4d62b6E166767988106cF7Ee8fE23E480E76FF1d",
    label: "Silo bwstkscETH-26",
  },
  "0x15641c093e566bd951c5e08e505a644478125f70": {
    target: "0x4d62b6E166767988106cF7Ee8fE23E480E76FF1d",
    label: "Silo bwstkscUSD-55",
  },
  "0x4e09ff794d255a123b00efa30162667a8054a845": {
    target: "0x4d62b6E166767988106cF7Ee8fE23E480E76FF1d",
    label: "Silo bwstkscUSD-23",
  },
  "0x916cd56a5fbbeae186f488f4db83b00c103b46e7": {
    target: "0x4d62b6E166767988106cF7Ee8fE23E480E76FF1d",
    label: "Silo bwstkscETH-other",
  },
  // Spectra → resolved to its single holder
  "0x64fcc3a02eeeba05ef701b7eed066c6ebd5d4e51": {
    target: "0x65ef8fd6168a4bc2cfebf83b0c83a8a9b7aad1f9",
    label: "Spectra sw-wstkscETH (1 holder)",
  },
};

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
  shareWad: string;
  sharePct: string;   // Human-readable percentage
  leaf: string;
  proof: string[];
  index: number;
}

interface MerkleOutput {
  snapshotBlock: number;
  token: string;
  merkleRoot: string;
  leafCount: number;
  totalShareWad: string;
  entries: MerkleEntry[];
}

// ─── Merkle Tree Implementation ────────────────────────────────────────

/**
 * Compute the double-hashed leaf matching the Solidity contract:
 *   keccak256(bytes.concat(keccak256(abi.encode(address, shareWad))))
 */
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

// ─── Tree Builder ─────────────────────────────────────────────────────

interface UserShare {
  address: `0x${string}`;
  shareWad: bigint;
}

function buildTokenTree(
  tokenName: string,
  shares: UserShare[]
): { root: `0x${string}`; output: MerkleOutput; snapshotBlock: number } & { _shares: UserShare[] } {
  console.log(`\n🧮 Building ${tokenName} tree (${shares.length} holders)...`);

  let shareSum = 0n;
  for (const s of shares) {
    shareSum += s.shareWad;
  }

  // Handle rounding dust — assign to the largest holder
  const dust = WAD - shareSum;
  if (dust !== 0n) {
    shares.sort((a, b) => (b.shareWad > a.shareWad ? 1 : b.shareWad < a.shareWad ? -1 : 0));
    if (dust > 0n) {
      shares[0].shareWad += dust;
      shareSum += dust;
    }
    console.log(`   Rounding dust: ${dust} → assigned to ${shares[0].address}`);
  }

  console.log(`   Share sum: ${shareSum} (expected: ${WAD}, match: ${shareSum === WAD})`);

  if (shareSum !== WAD) {
    console.error(`❌ FATAL: ${tokenName} share sum does not equal 1 WAD. Aborting.`);
    process.exit(1);
  }

  // Sort by address for deterministic tree
  shares.sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));

  // Build Merkle tree
  const leaves = shares.map((e) => computeLeaf(e.address, e.shareWad));
  const { root, proofs } = buildMerkleTree(leaves);
  console.log(`   Root: ${root}`);
  console.log(`   Leaves: ${leaves.length}`);

  // Verify all proofs
  console.log(`   Verifying all proofs...`);
  let verifyOk = true;
  for (let i = 0; i < leaves.length; i++) {
    if (!verifyProof(proofs[i], root, leaves[i])) {
      console.error(`   ❌ Proof verification failed for index ${i} (${shares[i].address})`);
      verifyOk = false;
    }
  }

  if (!verifyOk) {
    console.error(`❌ FATAL: Some ${tokenName} proofs failed verification. Aborting.`);
    process.exit(1);
  }
  console.log(`   All ${leaves.length} proofs verified ✓`);

  const entries: MerkleEntry[] = shares.map((e, i) => ({
    address: e.address,
    shareWad: e.shareWad.toString(),
    sharePct: `${(Number(e.shareWad) / 1e16).toFixed(4)}%`,
    leaf: leaves[i],
    proof: proofs[i],
    index: i,
  }));

  return {
    root,
    _shares: shares,
    snapshotBlock: 0, // filled by caller
    output: {
      snapshotBlock: 0,
      token: tokenName,
      merkleRoot: root,
      leafCount: leaves.length,
      totalShareWad: shareSum.toString(),
      entries,
    },
  };
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

  // ── Apply protocol redirects ──────────────────────────────────────────
  // Replace contract addresses with their designated recipients, merging
  // balances when multiple contracts map to the same target.

  console.log(`\n🔀 Applying protocol redirects...`);

  const redirectedEntitlements: SnapshotEntry[] = [];
  const mergedBalances: Record<string, { usd: bigint; eth: bigint; sources: string[] }> = {};
  let redirectCount = 0;

  for (const entry of snapshot.entitlements) {
    const addrLower = entry.address.toLowerCase();
    const redirect = PROTOCOL_REDIRECTS[addrLower];

    if (redirect) {
      redirectCount++;
      const targetLower = redirect.target.toLowerCase();
      const usdBal = BigInt(entry.stkscUSD_balance);
      const ethBal = BigInt(entry.stkscETH_balance);

      console.log(`   ${redirect.label} (${entry.address})`);
      console.log(`     → ${redirect.target}`);
      if (usdBal > 0n) console.log(`     stkscUSD: ${Number(usdBal) / 1e6}`);
      if (ethBal > 0n) console.log(`     stkscETH: ${Number(ethBal) / 1e18}`);

      if (!mergedBalances[targetLower]) {
        mergedBalances[targetLower] = { usd: 0n, eth: 0n, sources: [] };
      }
      mergedBalances[targetLower].usd += usdBal;
      mergedBalances[targetLower].eth += ethBal;
      mergedBalances[targetLower].sources.push(redirect.label);
    } else {
      redirectedEntitlements.push(entry);
    }
  }

  // Check if any redirect targets already exist as holders and merge
  for (const [targetLower, merged] of Object.entries(mergedBalances)) {
    const existingIdx = redirectedEntitlements.findIndex(
      (e) => e.address.toLowerCase() === targetLower
    );

    if (existingIdx !== -1) {
      // Target address already has its own entitlement — add to it
      const existing = redirectedEntitlements[existingIdx];
      const newUsd = BigInt(existing.stkscUSD_balance) + merged.usd;
      const newEth = BigInt(existing.stkscETH_balance) + merged.eth;
      redirectedEntitlements[existingIdx] = {
        ...existing,
        stkscUSD_balance: newUsd.toString(),
        stkscETH_balance: newEth.toString(),
        stkscUSD_share: (newUsd * WAD / usdTotalSupply).toString(),
        stkscETH_share: (newEth * WAD / ethTotalSupply).toString(),
      };
      console.log(`   ⚡ Merged into existing holder ${existing.address} (${merged.sources.join(" + ")})`);
    } else {
      // New entry for the redirect target
      const targetAddr = getAddress(targetLower) as string;
      redirectedEntitlements.push({
        address: targetAddr,
        stkscUSD_balance: merged.usd.toString(),
        stkscETH_balance: merged.eth.toString(),
        stkscUSD_share: merged.usd > 0n ? ((merged.usd * WAD) / usdTotalSupply).toString() : "0",
        stkscETH_share: merged.eth > 0n ? ((merged.eth * WAD) / ethTotalSupply).toString() : "0",
      });
      console.log(`   ✅ Created new entry for ${targetAddr} (${merged.sources.join(" + ")})`);
    }
  }

  console.log(`   Redirected ${redirectCount} protocol contracts → ${Object.keys(mergedBalances).length} target(s)`);
  console.log(`   Entries: ${snapshot.entitlements.length} → ${redirectedEntitlements.length}`);

  // ── Compute per-user shares ──────────────────────────────────────────
  const usdcShares: UserShare[] = [];
  const wethShares: UserShare[] = [];

  for (const entry of redirectedEntitlements) {
    const usdBalance = BigInt(entry.stkscUSD_balance);
    const ethBalance = BigInt(entry.stkscETH_balance);
    const addr = getAddress(entry.address) as `0x${string}`;

    // USDC tree: only include holders with non-zero stkscUSD balance
    if (usdBalance > 0n && usdTotalSupply > 0n) {
      const share = (usdBalance * WAD) / usdTotalSupply;
      if (share > 0n) {
        usdcShares.push({ address: addr, shareWad: share });
      }
    }

    // WETH tree: only include holders with non-zero stkscETH balance
    if (ethBalance > 0n && ethTotalSupply > 0n) {
      const share = (ethBalance * WAD) / ethTotalSupply;
      if (share > 0n) {
        wethShares.push({ address: addr, shareWad: share });
      }
    }
  }

  console.log(`\n📊 Holders:`);
  console.log(`   USDC tree: ${usdcShares.length} holders`);
  console.log(`   WETH tree: ${wethShares.length} holders`);

  // Build both trees
  const usdcResult = buildTokenTree("USDC", usdcShares);
  usdcResult.output.snapshotBlock = snapshot.snapshotBlock;

  const wethResult = buildTokenTree("WETH", wethShares);
  wethResult.output.snapshotBlock = snapshot.snapshotBlock;

  // Write outputs
  const scriptDir = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
  const outputDir = path.join(scriptDir, "output");
  fs.mkdirSync(outputDir, { recursive: true });

  const usdcOutputPath = path.join(outputDir, "merkle-usdc.json");
  fs.writeFileSync(usdcOutputPath, JSON.stringify(usdcResult.output, null, 2));

  const wethOutputPath = path.join(outputDir, "merkle-weth.json");
  fs.writeFileSync(wethOutputPath, JSON.stringify(wethResult.output, null, 2));

  console.log(`\n📁 Output files:`);
  console.log(`   USDC: ${usdcOutputPath}`);
  console.log(`   WETH: ${wethOutputPath}`);

  // Summary table (top 5 per token)
  console.log(`\n📊 Top 5 USDC claimants:`);
  const byUsdcShare = [...usdcResult.output.entries].sort((a, b) => {
    const diff = BigInt(b.shareWad) - BigInt(a.shareWad);
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  });
  for (let i = 0; i < Math.min(5, byUsdcShare.length); i++) {
    console.log(`   ${i + 1}. ${byUsdcShare[i].address}: ${byUsdcShare[i].sharePct}`);
  }

  console.log(`\n📊 Top 5 WETH claimants:`);
  const byWethShare = [...wethResult.output.entries].sort((a, b) => {
    const diff = BigInt(b.shareWad) - BigInt(a.shareWad);
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  });
  for (let i = 0; i < Math.min(5, byWethShare.length); i++) {
    console.log(`   ${i + 1}. ${byWethShare[i].address}: ${byWethShare[i].sharePct}`);
  }

  // ── CSV Export (for sharing with users) ────────────────────────────────
  console.log(`\n📄 Generating CSV files...`);

  const usdcCsvPath = path.join(outputDir, "claims-usdc.csv");
  const wethCsvPath = path.join(outputDir, "claims-weth.csv");

  const usdcCsvRows = ["address,share_pct,share_wad"];
  for (const e of byUsdcShare) {
    usdcCsvRows.push(`${e.address},${e.sharePct},${e.shareWad}`);
  }
  fs.writeFileSync(usdcCsvPath, usdcCsvRows.join("\n") + "\n");

  const wethCsvRows = ["address,share_pct,share_wad"];
  for (const e of byWethShare) {
    wethCsvRows.push(`${e.address},${e.sharePct},${e.shareWad}`);
  }
  fs.writeFileSync(wethCsvPath, wethCsvRows.join("\n") + "\n");

  console.log(`   USDC CSV: ${usdcCsvPath} (${byUsdcShare.length} rows)`);
  console.log(`   WETH CSV: ${wethCsvPath} (${byWethShare.length} rows)`);

  console.log(`\n📋 How to use:`);
  console.log(`   1. Deploy StreamRecoveryClaim(admin, usdc, weth)`);
  console.log(`   2. Fund contract with USDC + WETH for this round`);
  console.log(`   3. Call createRound(${usdcResult.root}, ${wethResult.root}, usdcTotal, wethTotal)`);
  console.log(`   4. USDC holders call claimUsdc(roundId, shareWad, proof)`);
  console.log(`   5. WETH holders call claimWeth(roundId, shareWad, proof)`);
  console.log(`   6. Users in both trees can call claimBoth() for convenience`);
  console.log(`   7. For future rounds: repeat steps 2-3 with same roots`);
}

// ─── Run ───────────────────────────────────────────────────────────────

main();
