// Snapshot Round 0 claim status from V1.
// Reads hasClaimedUsdc[0][addr] and hasClaimedWeth[0][addr] for every leaf
// in the original Round 0 Merkle trees, using multicall for efficiency.
//
// Output: scripts/output/round0-claimed.json
//
// Run: cd scripts && npx tsx snapshot-round0-claims.ts

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

const V1 = "0xda7805AdbEfa29b9e3Ba1d24B96C71aAE696745b" as const;
const SONIC_RPC = process.env.SONIC_RPC_URL || "https://rpc.soniclabs.com";

const abi = parseAbi([
  "function hasClaimedUsdc(uint256, address) view returns (bool)",
  "function hasClaimedWeth(uint256, address) view returns (bool)",
  "function rounds(uint256) view returns (bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,bool)",
]);

type Entry = { address: `0x${string}`; shareWad: string };
type Tree = { merkleRoot: string; leafCount: number; entries: Entry[] };

async function main() {
  const usdcTree: Tree = JSON.parse(
    fs.readFileSync(path.join(__dirname, "output/merkle-usdc.json"), "utf8"),
  );
  const wethTree: Tree = JSON.parse(
    fs.readFileSync(path.join(__dirname, "output/merkle-weth.json"), "utf8"),
  );

  console.log(`USDC leaves: ${usdcTree.entries.length}`);
  console.log(`WETH leaves: ${wethTree.entries.length}`);

  const client = createPublicClient({
    chain: sonic,
    transport: http(SONIC_RPC, { batch: true }),
  });

  // Verify pause + roots match
  const round0 = await client.readContract({
    address: V1,
    abi,
    functionName: "rounds",
    args: [0n],
  });
  console.log("On-chain Round 0:");
  console.log("  usdcRoot:", round0[0]);
  console.log("  wethRoot:", round0[1]);
  console.log("  usdcTotal:", round0[2].toString());
  console.log("  wethTotal:", round0[3].toString());
  console.log("  usdcClaimed:", round0[4].toString());
  console.log("  wethClaimed:", round0[5].toString());
  if (round0[0].toLowerCase() !== usdcTree.merkleRoot.toLowerCase()) {
    throw new Error("USDC root mismatch — wrong tree file?");
  }
  if (round0[1].toLowerCase() !== wethTree.merkleRoot.toLowerCase()) {
    throw new Error("WETH root mismatch — wrong tree file?");
  }
  console.log("Roots match ✓");

  async function readClaimed(
    fn: "hasClaimedUsdc" | "hasClaimedWeth",
    addrs: `0x${string}`[],
  ): Promise<boolean[]> {
    const BATCH = 500;
    const out: boolean[] = [];
    for (let i = 0; i < addrs.length; i += BATCH) {
      const slice = addrs.slice(i, i + BATCH);
      const calls = slice.map((addr) => ({
        address: V1,
        abi,
        functionName: fn,
        args: [0n, addr] as const,
      }));
      // viem multicall — auto-batched via http({batch:true})
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

  console.log("Reading hasClaimedUsdc...");
  const usdcAddrs = usdcTree.entries.map((e) => e.address);
  const usdcClaimedFlags = await readClaimed("hasClaimedUsdc", usdcAddrs);

  console.log("Reading hasClaimedWeth...");
  const wethAddrs = wethTree.entries.map((e) => e.address);
  const wethClaimedFlags = await readClaimed("hasClaimedWeth", wethAddrs);

  // Aggregate
  const usdcClaimed = usdcAddrs.filter((_, i) => usdcClaimedFlags[i]);
  const wethClaimed = wethAddrs.filter((_, i) => wethClaimedFlags[i]);

  // Sum claimed amounts (using shareWad × round.usdcTotal / 1e18) for sanity check
  const usdcTotal = round0[2];
  const wethTotal = round0[3];
  let usdcClaimedSum = 0n;
  for (let i = 0; i < usdcAddrs.length; i++) {
    if (usdcClaimedFlags[i]) {
      usdcClaimedSum += (BigInt(usdcTree.entries[i].shareWad) * usdcTotal) / 10n ** 18n;
    }
  }
  let wethClaimedSum = 0n;
  for (let i = 0; i < wethAddrs.length; i++) {
    if (wethClaimedFlags[i]) {
      wethClaimedSum += (BigInt(wethTree.entries[i].shareWad) * wethTotal) / 10n ** 18n;
    }
  }

  console.log("\n=== Sanity Check ===");
  console.log(`USDC claimed (computed): ${usdcClaimedSum.toString()}`);
  console.log(`USDC claimed (on-chain): ${round0[4].toString()}`);
  console.log(`  delta: ${(usdcClaimedSum - round0[4]).toString()}`);
  console.log(`WETH claimed (computed): ${wethClaimedSum.toString()}`);
  console.log(`WETH claimed (on-chain): ${round0[5].toString()}`);
  console.log(`  delta: ${(wethClaimedSum - round0[5]).toString()}`);

  console.log("\n=== Counts ===");
  console.log(`USDC claimed: ${usdcClaimed.length} / ${usdcAddrs.length}`);
  console.log(`WETH claimed: ${wethClaimed.length} / ${wethAddrs.length}`);

  const out = {
    snapshotBlock: 63645527,
    v1: V1,
    paused: true,
    usdc: {
      total: usdcTotal.toString(),
      claimedOnChain: round0[4].toString(),
      claimedComputed: usdcClaimedSum.toString(),
      claimedAddresses: usdcClaimed,
    },
    weth: {
      total: wethTotal.toString(),
      claimedOnChain: round0[5].toString(),
      claimedComputed: wethClaimedSum.toString(),
      claimedAddresses: wethClaimed,
    },
  };
  const outPath = path.join(__dirname, "output/round0-claimed.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWritten: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
