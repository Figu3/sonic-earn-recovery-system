// Audit Round 0v2 leaves: find which addresses are contracts, classify them.
//
// For each contract leaf, determine:
//   - Is it a known protocol (PROTOCOL_LABELS)?
//   - Is it ERC-1271 / Safe-capable (can sign waiver on V2)?
//   - Or stuck (no path to claim)?
//
// Output:
//   scripts/output/r0v2-contract-audit.json
//   Console: summary table

import { createPublicClient, http, defineChain, parseAbi } from "viem";
import * as fs from "fs";
import * as path from "path";

const sonic = defineChain({
  id: 146,
  name: "Sonic",
  nativeCurrency: { name: "Sonic", symbol: "S", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.soniclabs.com"] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

// From scripts/snapshot.ts — known protocols that hold wstksc tokens
const PROTOCOL_LABELS: Record<string, string> = {
  "0xe8e1a980a7fc8d47d337d704fa73fbb81ee55c25": "Silo bwstkscETH-26",
  "0x15641c093e566bd951c5e08e505a644478125f70": "Silo bwstkscUSD-55",
  "0x4e09ff794d255a123b00efa30162667a8054a845": "Silo bwstkscUSD-23",
  "0x916cd56a5fbbeae186f488f4db83b00c103b46e7": "Silo bwstkscETH-other",
  "0x8bb86a99f97f5d19718bd5ca0b0ca00354532ef3": "Pendle SY-wstkscETH",
  "0x896f4d49916ac5cfc36d7a260a7039ba4ea317b6": "Pendle SY-wstkscUSD",
  "0x05d57366b862022f76fe93316e81e9f24218bbfc": "Euler ewstkscETH-1",
  "0xf0c5f8b8715d2e54415079c5a520af5ab8858c75": "dLEND wstkscETH",
  "0x10451579fd6375c8bee09f1e2c5831afde9003ed": "dLEND wstkscUSD",
  "0x64fcc3a02eeeba05ef701b7eed066c6ebd5d4e51": "Spectra sw-wstkscETH",
  "0x45088fb2ffebfdcf4dff7b7201bfa4cd2077c30e": "Royco Sonic USDC",
  "0xd6bbab428240c6a4e093e13802f2eca3e9f0de7d": "dLEND wstkscUSD",
  "0xa1a0ecccd628a70434221e3e5f832517e97a697c": "StakeDAO Curve wstkscUSD",
  "0x05cf0c7ed39fc2ed0bd4397716ebb02f74ff25b5": "Shadow CL wstkscETH (negligible)",
  "0x286cc998298d9d0242c9ad30cdb587e0b2f59f22": "Shadow CL stkscETH (negligible)",
  "0xfb9f97e08f6bdca19353cacaf3e542e461686041": "9mm V2 LP",
  "0x6328a2ff2e6bb164f1be2479af209a88295f54d5": "Eliteness/GuruDAO ThenaAdapter",
  "0xb0c855a7fb3716ebc1c4505218de4bf2186125ba": "Eliteness/GuruDAO Equalizer",
  "0x605257994ffef290c9ed8f51e0bf68b2735c17a9": "Tholgar Adapter",
  "0x636d9c9ac5e681f245051b84f908f6f84221390d": "Relay (veETH)",
};

const safeAbi = parseAbi(["function getOwners() view returns (address[])"]);

type Leaf = { address: `0x${string}`; amount: string };

function loadLeaves(file: string): Leaf[] {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  return j.entries.map((e: any) => ({ address: e.address, amount: e.amount }));
}

async function main() {
  const usdcLeaves = loadLeaves(path.join(__dirname, "output/merkle-round0v2-usdc.json"));
  const wethLeaves = loadLeaves(path.join(__dirname, "output/merkle-round0v2-weth.json"));

  // Aggregate by address (some may have both tokens)
  const byAddr = new Map<string, { usdc: bigint; weth: bigint }>();
  for (const l of usdcLeaves) {
    const a = l.address.toLowerCase();
    const cur = byAddr.get(a) || { usdc: 0n, weth: 0n };
    cur.usdc = BigInt(l.amount);
    byAddr.set(a, cur);
  }
  for (const l of wethLeaves) {
    const a = l.address.toLowerCase();
    const cur = byAddr.get(a) || { usdc: 0n, weth: 0n };
    cur.weth = BigInt(l.amount);
    byAddr.set(a, cur);
  }
  const allAddrs = [...byAddr.keys()] as `0x${string}`[];
  console.log(`Total unique R0v2 leaf addresses: ${allAddrs.length}`);

  const client = createPublicClient({ chain: sonic, transport: http(undefined, { batch: true }) });

  // Step 1: getCode for each — find contracts
  console.log("\nFetching code for all leaves (multicall)...");
  const contracts: `0x${string}`[] = [];
  const BATCH = 200;
  for (let i = 0; i < allAddrs.length; i += BATCH) {
    const slice = allAddrs.slice(i, i + BATCH);
    const codes = await Promise.all(slice.map((a) => client.getCode({ address: a })));
    for (let k = 0; k < slice.length; k++) {
      if (codes[k] && codes[k] !== "0x") contracts.push(slice[k]);
    }
    process.stdout.write(`  ${Math.min(i + BATCH, allAddrs.length)}/${allAddrs.length}\r`);
  }
  process.stdout.write("\n");
  console.log(`  → ${contracts.length} contracts`);

  // Step 2: For each contract, try Safe.getOwners() to detect Safes (which support ERC-1271)
  console.log("\nDetecting Safes via getOwners()...");
  const safes = new Set<string>();
  for (let i = 0; i < contracts.length; i += BATCH) {
    const slice = contracts.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map((addr) =>
        client
          .readContract({ address: addr, abi: safeAbi, functionName: "getOwners" })
          .then(() => true)
          .catch(() => false),
      ),
    );
    for (let k = 0; k < slice.length; k++) if (results[k]) safes.add(slice[k].toLowerCase());
    process.stdout.write(`  ${Math.min(i + BATCH, contracts.length)}/${contracts.length}\r`);
  }
  process.stdout.write("\n");
  console.log(`  → ${safes.size} Safes (will work with V2 SignatureChecker)`);

  // Classify
  type Row = {
    address: string;
    isSafe: boolean;
    label: string | null;
    usdc: bigint;
    weth: bigint;
    classification: "safe" | "known_protocol" | "unknown_contract";
  };
  const rows: Row[] = contracts.map((addr) => {
    const a = addr.toLowerCase();
    const amts = byAddr.get(a)!;
    const isSafe = safes.has(a);
    const label = PROTOCOL_LABELS[a] || null;
    let classification: Row["classification"];
    if (isSafe) classification = "safe";
    else if (label) classification = "known_protocol";
    else classification = "unknown_contract";
    return {
      address: a,
      isSafe,
      label,
      usdc: amts.usdc,
      weth: amts.weth,
      classification,
    };
  });

  // Sort by USDC amount desc
  rows.sort((a, b) => (b.usdc + b.weth * 1000000n / 10n ** 18n > a.usdc + a.weth * 1000000n / 10n ** 18n ? 1 : -1));

  // Summary
  const sumUsdc = (rs: Row[]) => rs.reduce((s, r) => s + r.usdc, 0n);
  const sumWeth = (rs: Row[]) => rs.reduce((s, r) => s + r.weth, 0n);
  const safesRows = rows.filter((r) => r.classification === "safe");
  const knownProto = rows.filter((r) => r.classification === "known_protocol");
  const unknown = rows.filter((r) => r.classification === "unknown_contract");

  console.log("\n=== AUDIT SUMMARY ===");
  console.log(`Total leaves:                 ${allAddrs.length}`);
  console.log(`Total EOA leaves:             ${allAddrs.length - contracts.length}`);
  console.log(`Total contract leaves:        ${contracts.length}`);
  console.log(`  ├─ Safes (ERC-1271 OK):     ${safesRows.length}  →  ${formatU(sumUsdc(safesRows))} USDC + ${formatW(sumWeth(safesRows))} WETH`);
  console.log(`  ├─ Known protocols:         ${knownProto.length}  →  ${formatU(sumUsdc(knownProto))} USDC + ${formatW(sumWeth(knownProto))} WETH`);
  console.log(`  └─ Unknown contracts:       ${unknown.length}  →  ${formatU(sumUsdc(unknown))} USDC + ${formatW(sumWeth(unknown))} WETH`);

  if (knownProto.length > 0) {
    console.log("\n--- KNOWN PROTOCOLS in R0v2 (NOT resolved, will be stuck unless Safe-like) ---");
    for (const r of knownProto) console.log(`  ${r.address}  ${formatU(r.usdc).padStart(14)} USDC  ${formatW(r.weth).padStart(14)} WETH  ${r.label}`);
  }
  if (unknown.length > 0) {
    console.log("\n--- UNKNOWN CONTRACTS in R0v2 (need investigation) ---");
    for (const r of unknown.slice(0, 50))
      console.log(`  ${r.address}  ${formatU(r.usdc).padStart(14)} USDC  ${formatW(r.weth).padStart(14)} WETH`);
    if (unknown.length > 50) console.log(`  ... and ${unknown.length - 50} more`);
  }

  // Write full output
  const out = {
    totalLeaves: allAddrs.length,
    totalContracts: contracts.length,
    totalSafes: safesRows.length,
    totalKnownProtocols: knownProto.length,
    totalUnknownContracts: unknown.length,
    rows: rows.map((r) => ({ ...r, usdc: r.usdc.toString(), weth: r.weth.toString() })),
  };
  fs.writeFileSync(path.join(__dirname, "output/r0v2-contract-audit.json"), JSON.stringify(out, null, 2));
  console.log(`\nWritten: scripts/output/r0v2-contract-audit.json`);
}

function formatU(v: bigint): string { return (Number(v) / 1e6).toFixed(2); }
function formatW(v: bigint): string { return (Number(v) / 1e18).toFixed(6); }

main().catch((e) => { console.error(e); process.exit(1); });
