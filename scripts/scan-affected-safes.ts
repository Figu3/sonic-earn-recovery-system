import { createPublicClient, http, parseAbi, defineChain, getAddress } from "viem";
import * as fs from "fs";

const sonic = defineChain({
  id: 146, name: "Sonic", nativeCurrency: { name: "S", symbol: "S", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.soniclabs.com"] } },
});
const safeAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function VERSION() view returns (string)",
  "function getMessageHash(bytes) view returns (bytes32)",
]);

async function main() {
  const breakdown = JSON.parse(fs.readFileSync(__dirname + "/output/safe-threshold-breakdown.json", "utf8"));
  const multi = breakdown.multiList as Array<{addr: string; threshold: number; usdc: string; weth: string}>;
  console.log(`Scanning ${multi.length} multi-sig Safes...\n`);

  const client = createPublicClient({ chain: sonic, transport: http() });

  let edge_nestedOwner = 0;
  let edge_7702Owner = 0;
  let edge_oldVersion = 0;
  let edge_noFallback = 0;
  let edge_someContractOwner = 0;
  const issues: string[] = [];

  for (const s of multi) {
    const addr = getAddress(s.addr);
    let version = "?";
    try { version = await client.readContract({ address: addr, abi: safeAbi, functionName: "VERSION" }); }
    catch { version = "N/A"; }

    let owners: readonly `0x${string}`[] = [];
    try { owners = await client.readContract({ address: addr, abi: safeAbi, functionName: "getOwners" }); }
    catch { issues.push(`${addr}: getOwners() reverted`); continue; }

    // Test getMessageHash via fallback
    let hasFallback = false;
    try {
      await client.readContract({
        address: addr, abi: safeAbi, functionName: "getMessageHash",
        args: ["0x"]  as any,
      });
      hasFallback = true;
    } catch { hasFallback = false; }
    if (!hasFallback) edge_noFallback++;

    // Inspect each owner
    let nested = 0, e7702 = 0, otherContract = 0;
    for (const o of owners) {
      const code = await client.getBytecode({ address: o });
      if (!code || code === "0x") continue; // EOA
      // Check for 7702 delegation prefix 0xef0100
      if (code.length === 48 && code.toLowerCase().startsWith("0xef0100")) {
        e7702++;
      } else {
        // Try to detect if it's a Safe (has VERSION())
        try {
          await client.readContract({ address: o, abi: safeAbi, functionName: "VERSION" });
          nested++;
        } catch {
          otherContract++;
        }
      }
    }
    if (nested > 0) edge_nestedOwner++;
    if (e7702 > 0) edge_7702Owner++;
    if (otherContract > 0) edge_someContractOwner++;
    if (version !== "?" && version !== "N/A" && version !== "1.3.0" && version !== "1.4.1" && version !== "1.4.0") {
      edge_oldVersion++;
      issues.push(`${addr}: unusual version ${version}`);
    }

    const tag = (nested ? `nested:${nested} ` : "") + (e7702 ? `7702:${e7702} ` : "") + (otherContract ? `other-contract:${otherContract} ` : "");
    if (tag || !hasFallback) {
      console.log(`${addr}  v=${version}  threshold=${s.threshold}  ${tag}${hasFallback ? "" : "[NO FALLBACK]"}`);
    }
  }

  console.log("\n=== Edge case summary ===");
  console.log(`Total multi-sig Safes:                 ${multi.length}`);
  console.log(`Safes with at least one nested Safe owner:    ${edge_nestedOwner}`);
  console.log(`Safes with at least one 7702 EOA owner:       ${edge_7702Owner}`);
  console.log(`Safes with non-Safe contract owner (other):   ${edge_someContractOwner}`);
  console.log(`Safes on unusual Safe version:                ${edge_oldVersion}`);
  console.log(`Safes without standard fallback handler:      ${edge_noFallback}`);
  console.log(`\nClean Safes (all-EOA owners, standard version, working fallback):`);
  const clean = multi.length - new Set([edge_nestedOwner, edge_7702Owner, edge_someContractOwner, edge_oldVersion, edge_noFallback]).size;
  console.log(`  ~${multi.length - edge_nestedOwner - edge_7702Owner - edge_someContractOwner - edge_oldVersion - edge_noFallback} (lower bound, may double-count)`);

  if (issues.length) {
    console.log("\nNoted:");
    issues.forEach(i => console.log("  - " + i));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
