// Snapshot Round 0 claim status from V2.
// Reads hasClaimedUsdc[0][addr] and hasClaimedWeth[0][addr] for every leaf
// in the V2 Round 0 merkle trees (scripts/output/merkle-round0v2-{usdc,weth}.json),
// using multicall for efficiency.
//
// V2 must be paused before running this — otherwise claim state is still
// moving and the snapshot is racey. The script fails loudly if V2 is not
// paused.
//
// Output: scripts/output/round0-claimed-v2.json
//
// Run: cd scripts && npx tsx snapshot-v2-claims.ts

import { createPublicClient, http, parseAbi, defineChain } from "viem";
import * as fs from "fs";
import * as path from "path";

const sonic = defineChain({
  id: 146,
  name: "Sonic",
  nativeCurrency: { name: "Sonic", symbol: "S", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.soniclabs.com"] } },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

const V2 = "0x6472D708cD88C7DD94e77A5c5023dA6FDc41Ad31" as const;
const SONIC_RPC = process.env.SONIC_RPC_URL || "https://rpc.soniclabs.com";

const abi = parseAbi([
  "function hasClaimedUsdc(uint256, address) view returns (bool)",
  "function hasClaimedWeth(uint256, address) view returns (bool)",
  "function rounds(uint256) view returns (bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,bool)",
  "function paused() view returns (bool)",
]);

type Entry = { address: `0x${string}`; shareWad: string; amount?: string };
type Tree = { merkleRoot: string; leafCount: number; entries: Entry[] };

async function main() {
  const usdcTree: Tree = JSON.parse(
    fs.readFileSync(path.join(__dirname, "output/merkle-round0v2-usdc.json"), "utf8"),
  );
  const wethTree: Tree = JSON.parse(
    fs.readFileSync(path.join(__dirname, "output/merkle-round0v2-weth.json"), "utf8"),
  );

  console.log(`V2 USDC tree leaves: ${usdcTree.entries.length}`);
  console.log(`V2 WETH tree leaves: ${wethTree.entries.length}`);

  const client = createPublicClient({
    chain: sonic,
    transport: http(SONIC_RPC, { batch: true }),
  });

  // Hard-fail if V2 is not paused — otherwise claim state is moving and the
  // snapshot is racey.
  const paused = await client.readContract({
    address: V2,
    abi,
    functionName: "paused",
  });
  if (!paused) {
    throw new Error("V2 is NOT paused. Run v2.pause() before snapshotting claim state.");
  }
  console.log("V2 paused ✓");

  // Read on-chain round state for root + total sanity checks
  const round0 = await client.readContract({
    address: V2,
    abi,
    functionName: "rounds",
    args: [0n],
  });
  const [usdcRoot, wethRoot, usdcTotal, wethTotal, usdcClaimed, wethClaimed, deadline, active] = round0;
  console.log("On-chain V2 Round 0:");
  console.log(`  usdcRoot:    ${usdcRoot}`);
  console.log(`  wethRoot:    ${wethRoot}`);
  console.log(`  usdcTotal:   ${usdcTotal.toString()}`);
  console.log(`  wethTotal:   ${wethTotal.toString()}`);
  console.log(`  usdcClaimed: ${usdcClaimed.toString()}`);
  console.log(`  wethClaimed: ${wethClaimed.toString()}`);
  console.log(`  deadline:    ${deadline.toString()}`);
  console.log(`  active:      ${active}`);

  // NOTE: after deactivateRound, the on-chain roots are still the original
  // tree roots. After deactivateRound + rescueToken, round.usdcTotal is reset
  // to round.usdcClaimed, so the "total" field may match "claimed". We check
  // the tree root against on-chain only if the round is still active, otherwise
  // we trust the tree files (they're what V2 was deployed with).
  if (active) {
    if (usdcRoot.toLowerCase() !== usdcTree.merkleRoot.toLowerCase()) {
      throw new Error(`USDC root mismatch: on-chain=${usdcRoot} file=${usdcTree.merkleRoot}`);
    }
    if (wethRoot.toLowerCase() !== wethTree.merkleRoot.toLowerCase()) {
      throw new Error(`WETH root mismatch: on-chain=${wethRoot} file=${wethTree.merkleRoot}`);
    }
    console.log("Roots match ✓");
  } else {
    console.log("Round deactivated — skipping root check (expected post-deactivate)");
  }

  async function readClaimed(
    fn: "hasClaimedUsdc" | "hasClaimedWeth",
    addrs: `0x${string}`[],
  ): Promise<boolean[]> {
    const BATCH = 500;
    const out: boolean[] = [];
    for (let i = 0; i < addrs.length; i += BATCH) {
      const slice = addrs.slice(i, i + BATCH);
      const calls = slice.map((addr) => ({
        address: V2,
        abi,
        functionName: fn,
        args: [0n, addr] as const,
      }));
      const results = await client.multicall({
        contracts: calls,
        allowFailure: false,
      });
      for (const r of results) out.push(r as boolean);
      process.stdout.write(`  ${fn}: ${Math.min(i + BATCH, addrs.length)}/${addrs.length}\r`);
    }
    process.stdout.write("\n");
    return out;
  }

  console.log("Reading V2.hasClaimedUsdc...");
  const usdcAddrs = usdcTree.entries.map((e) => e.address);
  const usdcClaimedFlags = await readClaimed("hasClaimedUsdc", usdcAddrs);

  console.log("Reading V2.hasClaimedWeth...");
  const wethAddrs = wethTree.entries.map((e) => e.address);
  const wethClaimedFlags = await readClaimed("hasClaimedWeth", wethAddrs);

  // Aggregate claimed addresses
  const usdcClaimedAddrs = usdcAddrs.filter((_, i) => usdcClaimedFlags[i]);
  const wethClaimedAddrs = wethAddrs.filter((_, i) => wethClaimedFlags[i]);

  // Compute the sum of claimed amounts. V2 uses the ORIGINAL usdcTotal for
  // payout calc. After deactivate, round.usdcTotal was reset to usdcClaimed,
  // so we can't use the live on-chain total — we use the ORIGINAL total from
  // the tree file metadata (merkle-round0v2-usdc.json#newTotal).
  const origUsdcTotal = BigInt((usdcTree as unknown as { newTotal: string }).newTotal ?? usdcTotal.toString());
  const origWethTotal = BigInt((wethTree as unknown as { newTotal: string }).newTotal ?? wethTotal.toString());

  let usdcClaimedSum = 0n;
  for (let i = 0; i < usdcAddrs.length; i++) {
    if (usdcClaimedFlags[i]) {
      usdcClaimedSum += (BigInt(usdcTree.entries[i].shareWad) * origUsdcTotal) / 10n ** 18n;
    }
  }
  let wethClaimedSum = 0n;
  for (let i = 0; i < wethAddrs.length; i++) {
    if (wethClaimedFlags[i]) {
      wethClaimedSum += (BigInt(wethTree.entries[i].shareWad) * origWethTotal) / 10n ** 18n;
    }
  }

  console.log("\n=== Sanity check ===");
  console.log(`USDC claimed (computed from flags):  ${usdcClaimedSum.toString()}`);
  console.log(`USDC claimed (on-chain):             ${usdcClaimed.toString()}`);
  console.log(`  delta:                             ${(usdcClaimedSum - usdcClaimed).toString()}`);
  console.log(`WETH claimed (computed from flags):  ${wethClaimedSum.toString()}`);
  console.log(`WETH claimed (on-chain):             ${wethClaimed.toString()}`);
  console.log(`  delta:                             ${(wethClaimedSum - wethClaimed).toString()}`);

  // Allow tiny rounding drift (integer division). If the delta is more than
  // a few wei per claimer, something is wrong.
  const usdcTolerance = BigInt(usdcClaimedAddrs.length);
  const wethTolerance = BigInt(wethClaimedAddrs.length);
  if ((usdcClaimedSum - usdcClaimed) > usdcTolerance || (usdcClaimed - usdcClaimedSum) > usdcTolerance) {
    throw new Error(`USDC reconciliation delta > tolerance: ${usdcClaimedSum - usdcClaimed}`);
  }
  if ((wethClaimedSum - wethClaimed) > wethTolerance || (wethClaimed - wethClaimedSum) > wethTolerance) {
    throw new Error(`WETH reconciliation delta > tolerance: ${wethClaimedSum - wethClaimed}`);
  }
  console.log("Reconciliation within tolerance ✓");

  console.log("\n=== Counts ===");
  console.log(`USDC claimed: ${usdcClaimedAddrs.length} / ${usdcAddrs.length}`);
  console.log(`WETH claimed: ${wethClaimedAddrs.length} / ${wethAddrs.length}`);

  const out = {
    v2: V2,
    paused,
    roundDeactivated: !active,
    usdc: {
      totalOnChain: usdcTotal.toString(),
      claimedOnChain: usdcClaimed.toString(),
      claimedComputed: usdcClaimedSum.toString(),
      claimedAddresses: usdcClaimedAddrs,
    },
    weth: {
      totalOnChain: wethTotal.toString(),
      claimedOnChain: wethClaimed.toString(),
      claimedComputed: wethClaimedSum.toString(),
      claimedAddresses: wethClaimedAddrs,
    },
  };
  const outPath = path.join(__dirname, "output/round0-claimed-v2.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWritten: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
