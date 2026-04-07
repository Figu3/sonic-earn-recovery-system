// Build Round 0v2 Merkle trees for V2 deployment.
//
// Sources:
//   1. scripts/output/merkle-usdc.json          (original Round 0 USDC tree, 5592 leaves)
//   2. scripts/output/merkle-weth.json          (original Round 0 WETH tree, 1185 leaves)
//   3. scripts/output/round0-claimed.json       (snapshot of who already claimed)
//   4. scripts/output/merkle-round1-usdc.json   (678 resolved depositors)
//   5. scripts/output/merkle-round1-weth.json   (40 resolved depositors)
//
// Output:
//   scripts/output/merkle-round0v2-usdc.json
//   scripts/output/merkle-round0v2-weth.json

import {
  keccak256,
  encodePacked,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem";
import * as fs from "fs";
import * as path from "path";

const WAD = 10n ** 18n;
const OUT = (n: string) => path.join(__dirname, "output", n);

// Protocol contracts to remove from Round 0v2
const PROTOCOL_CONTRACTS = new Set(
  [
    "0x605257994ffef290c9ed8f51e0bf68b2735c17a9", // tholgar
    "0x636d9c9ac5e681f245051b84f908f6f84221390d", // relay
    "0xb0c855a7fb3716ebc1c4505218de4bf2186125ba", // equalizer
    "0x6328a2ff2e6bb164f1be2479af209a88295f54d5", // thena_adapter
  ].map((a) => a.toLowerCase()),
);

// ─── Merkle helpers (match V1 leaf encoding + merkle-round1.ts tree shape) ─

function computeLeaf(address: `0x${string}`, shareWad: bigint): `0x${string}` {
  const innerHash = keccak256(
    encodeAbiParameters(parseAbiParameters("address, uint256"), [address, shareWad]),
  );
  return keccak256(encodePacked(["bytes32"], [innerHash]));
}

function hashPair(a: `0x${string}`, b: `0x${string}`): `0x${string}` {
  if (a <= b) return keccak256(encodePacked(["bytes32", "bytes32"], [a, b]));
  return keccak256(encodePacked(["bytes32", "bytes32"], [b, a]));
}

function buildMerkleTree(leaves: `0x${string}`[]): { root: `0x${string}`; proofs: `0x${string}`[][] } {
  if (leaves.length === 0)
    return { root: ("0x" + "00".repeat(32)) as `0x${string}`, proofs: [] };
  if (leaves.length === 1) return { root: leaves[0], proofs: [[]] };

  const proofElements: Map<number, `0x${string}`[]> = new Map();
  for (let i = 0; i < leaves.length; i++) proofElements.set(i, []);

  let currentLevel = [...leaves];
  let currentIndices = leaves.map((_, i) => [i]);

  while (currentLevel.length > 1) {
    const nextLevel: `0x${string}`[] = [];
    const nextIndices: number[][] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      if (i + 1 < currentLevel.length) {
        nextLevel.push(hashPair(currentLevel[i], currentLevel[i + 1]));
        nextIndices.push([...currentIndices[i], ...currentIndices[i + 1]]);
        for (const idx of currentIndices[i]) proofElements.get(idx)!.push(currentLevel[i + 1]);
        for (const idx of currentIndices[i + 1]) proofElements.get(idx)!.push(currentLevel[i]);
      } else {
        nextLevel.push(currentLevel[i]);
        nextIndices.push(currentIndices[i]);
      }
    }
    currentLevel = nextLevel;
    currentIndices = nextIndices;
  }
  const proofs: `0x${string}`[][] = [];
  for (let i = 0; i < leaves.length; i++) proofs.push(proofElements.get(i)!);
  return { root: currentLevel[0], proofs };
}

// ─── Build logic ───────────────────────────────────────────────────────────

type Entry = { address: `0x${string}`; shareWad: string };

function loadResolved(file: string, totalRaw: bigint): Map<string, bigint> {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const m = new Map<string, bigint>();
  for (const e of j.entries as Entry[]) {
    const amt = (BigInt(e.shareWad) * totalRaw) / WAD;
    if (amt > 0n) m.set(e.address.toLowerCase(), amt);
  }
  return m;
}

function buildRound0v2(
  token: "USDC" | "WETH",
  originalFile: string,
  originalTotalRaw: bigint,
  claimedAddrs: Set<string>,
  resolvedFile: string,
  resolvedTotalRaw: bigint,
  outputFile: string,
) {
  console.log(`\n=== Building Round 0v2 ${token} ===`);

  const orig = JSON.parse(fs.readFileSync(originalFile, "utf8"));
  const origEntries: Entry[] = orig.entries;
  console.log(`  original leaves: ${origEntries.length}`);

  // Step 1: compute absolute amounts for original leaves
  const absAmounts = new Map<string, bigint>();
  for (const e of origEntries) {
    absAmounts.set(e.address.toLowerCase(), (BigInt(e.shareWad) * originalTotalRaw) / WAD);
  }

  // Step 2: drop already-claimed
  let removedClaimed = 0;
  let removedClaimedAmt = 0n;
  for (const a of claimedAddrs) {
    const v = absAmounts.get(a);
    if (v !== undefined) {
      removedClaimedAmt += v;
      absAmounts.delete(a);
      removedClaimed++;
    }
  }
  console.log(`  removed claimed: ${removedClaimed} leaves, amt=${removedClaimedAmt}`);

  // Step 3: drop protocol contracts
  let removedProto = 0;
  let removedProtoAmt = 0n;
  for (const a of PROTOCOL_CONTRACTS) {
    const v = absAmounts.get(a);
    if (v !== undefined) {
      removedProtoAmt += v;
      absAmounts.delete(a);
      removedProto++;
    }
  }
  console.log(`  removed protocol contracts: ${removedProto} leaves, amt=${removedProtoAmt}`);

  // Step 4: add resolved depositors.
  // NOTE: do NOT skip users who already claimed their Round 0 leaf — their
  // protocol-contract depositor share is a SEPARATE entitlement (the protocol
  // contract held its own Round 0 leaf, and these users are the underlying
  // depositors of that contract). They get only the resolved share here, not
  // the original direct leaf (which they already claimed).
  const resolved = loadResolved(resolvedFile, resolvedTotalRaw);
  let added = 0;
  let merged = 0;
  let mergedClaimedReentry = 0;
  let addedAmt = 0n;
  for (const [addr, amt] of resolved) {
    const existing = absAmounts.get(addr);
    if (existing !== undefined) {
      absAmounts.set(addr, existing + amt);
      merged++;
    } else {
      absAmounts.set(addr, amt);
      // Track separately: brand-new user vs already-claimed user being re-added
      if (claimedAddrs.has(addr)) mergedClaimedReentry++;
      else added++;
    }
    addedAmt += amt;
  }
  console.log(`  added resolved: ${added} new + ${merged} merged + ${mergedClaimedReentry} re-entered (claimed R0 directly), amt=${addedAmt}`);

  // Step 5: finalize entries (sorted by address)
  const survivors = [...absAmounts.entries()]
    .filter(([, a]) => a > 0n)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const newTotal = survivors.reduce((s, [, a]) => s + a, 0n);
  console.log(`  final leaves: ${survivors.length}`);
  console.log(`  newTotal:     ${newTotal}`);

  // Step 6: encode shareWad against newTotal (round nearest)
  type FinalEntry = { address: `0x${string}`; shareWad: bigint; amount: bigint };
  const finalEntries: FinalEntry[] = survivors.map(([addr, amt]) => ({
    address: addr as `0x${string}`,
    shareWad: (amt * WAD + newTotal / 2n) / newTotal,
    amount: amt,
  }));
  let shareSum = finalEntries.reduce((s, e) => s + e.shareWad, 0n);
  const shareDelta = WAD - shareSum;
  if (shareDelta !== 0n) {
    let maxIdx = 0;
    for (let i = 1; i < finalEntries.length; i++)
      if (finalEntries[i].shareWad > finalEntries[maxIdx].shareWad) maxIdx = i;
    finalEntries[maxIdx].shareWad += shareDelta;
    console.log(`  adjusted ${finalEntries[maxIdx].address} by ${shareDelta} wei to make shareSum=1e18`);
  }
  shareSum = finalEntries.reduce((s, e) => s + e.shareWad, 0n);
  if (shareSum !== WAD) throw new Error(`shareSum != WAD: ${shareSum}`);

  // Step 7: verify payout sum vs newTotal
  const payoutSum = finalEntries.reduce((s, e) => s + (e.shareWad * newTotal) / WAD, 0n);
  console.log(`  payoutSum:    ${payoutSum}`);
  console.log(`  payout dust:  ${newTotal - payoutSum} wei`);
  if (payoutSum > newTotal) throw new Error("payoutSum > newTotal: would revert ClaimExceedsTotal");

  // Step 8: build merkle
  const leaves = finalEntries.map((e) => computeLeaf(e.address, e.shareWad));
  const { root, proofs } = buildMerkleTree(leaves);
  console.log(`  root:         ${root}`);

  // Step 9: write
  const out = {
    description: `Round 0v2 ${token} for V2 deployment`,
    snapshotBlock: 63645527,
    sourceRound0Total: originalTotalRaw.toString(),
    merkleRoot: root,
    leafCount: finalEntries.length,
    newTotal: newTotal.toString(),
    payoutSum: payoutSum.toString(),
    payoutDustWei: (newTotal - payoutSum).toString(),
    summary: {
      originalLeaves: origEntries.length,
      removedClaimed,
      removedClaimedAmt: removedClaimedAmt.toString(),
      removedProtocolContracts: removedProto,
      removedProtocolAmt: removedProtoAmt.toString(),
      addedNewResolved: added,
      mergedIntoExisting: merged,
      reEnteredClaimedDirect: mergedClaimedReentry,
      addedResolvedAmt: addedAmt.toString(),
      finalLeaves: finalEntries.length,
    },
    entries: finalEntries.map((e, i) => ({
      address: e.address,
      shareWad: e.shareWad.toString(),
      amount: e.amount.toString(),
      leaf: leaves[i],
      proof: proofs[i],
    })),
  };
  fs.writeFileSync(outputFile, JSON.stringify(out, null, 2));
  console.log(`  written: ${outputFile}`);

  return { newTotal, leafCount: finalEntries.length, root };
}

function main() {
  const USDC_TOTAL_R0 = 600_116_076_557n;
  const WETH_TOTAL_R0 = 623_066_129_877_001_393_497n;
  const USDC_TOTAL_R1 = 39_016_824_941n;
  const WETH_TOTAL_R1 = 15_646_390_759_667_050_822n;

  const claimed = JSON.parse(fs.readFileSync(OUT("round0-claimed.json"), "utf8"));
  const usdcClaimed = new Set<string>(
    (claimed.usdc.claimedAddresses as string[]).map((a) => a.toLowerCase()),
  );
  const wethClaimed = new Set<string>(
    (claimed.weth.claimedAddresses as string[]).map((a) => a.toLowerCase()),
  );

  const u = buildRound0v2(
    "USDC",
    OUT("merkle-usdc.json"),
    USDC_TOTAL_R0,
    usdcClaimed,
    OUT("merkle-round1-usdc.json"),
    USDC_TOTAL_R1,
    OUT("merkle-round0v2-usdc.json"),
  );
  const w = buildRound0v2(
    "WETH",
    OUT("merkle-weth.json"),
    WETH_TOTAL_R0,
    wethClaimed,
    OUT("merkle-round1-weth.json"),
    WETH_TOTAL_R1,
    OUT("merkle-round0v2-weth.json"),
  );

  console.log("\n=== ROUND 0v2 SUMMARY ===");
  console.log(`USDC: ${u.leafCount} leaves, total=${u.newTotal} (${(Number(u.newTotal) / 1e6).toFixed(2)} USDC), root=${u.root}`);
  console.log(`WETH: ${w.leafCount} leaves, total=${w.newTotal} (${(Number(w.newTotal) / 1e18).toFixed(6)} WETH), root=${w.root}`);

  const V1_USDC = 370_052_027_675n;
  const V1_WETH = 342_400_797_390_971_049_123n;
  console.log("\n=== V1 BALANCE vs FUNDING NEED ===");
  console.log(`USDC: V1=${V1_USDC}, R0v2=${u.newTotal}, dust=${V1_USDC - u.newTotal} (${Number(V1_USDC - u.newTotal) / 1e6} USDC)`);
  console.log(`WETH: V1=${V1_WETH}, R0v2=${w.newTotal}, dust=${V1_WETH - w.newTotal} (${Number(V1_WETH - w.newTotal) / 1e18} WETH)`);
}

main();
