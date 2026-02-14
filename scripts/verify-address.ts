/**
 * Verify Address — Community verification tool
 *
 * Allows anyone to check if their address is included in the recovery snapshot
 * and view their entitlements (stkscUSD balance, stkscETH balance, share %).
 *
 * Usage:
 *   npx tsx scripts/verify-address.ts <address>
 *   npx tsx scripts/verify-address.ts 0xYourAddress
 *
 * This script reads from the snapshot and merkle files in scripts/output/
 */

import * as fs from "fs";
import * as path from "path";
import { getAddress } from "viem";

// ─── Helpers ──────────────────────────────────────────────────────────

function formatUsdc(raw: string): string {
  const n = BigInt(raw);
  const whole = n / 1_000_000n;
  const frac = n % 1_000_000n;
  return `${whole.toLocaleString()}.${frac.toString().padStart(6, "0")} USDC`;
}

function formatWeth(raw: string): string {
  const n = BigInt(raw);
  const whole = n / 10n ** 18n;
  const frac = n % 10n ** 18n;
  return `${whole}.${frac.toString().padStart(18, "0").slice(0, 6)} WETH`;
}

function formatSharePct(shareWad: string): string {
  const n = BigInt(shareWad);
  // shareWad is in WAD (1e18 = 100%)
  const pct = Number(n) / 1e16;
  return `${pct.toFixed(6)}%`;
}

// ─── Main ─────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help") {
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║         Stream Recovery — Address Verification Tool             ║
╚══════════════════════════════════════════════════════════════════╝

Usage:
  npx tsx scripts/verify-address.ts <address>

Example:
  npx tsx scripts/verify-address.ts 0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B
`);
    process.exit(0);
  }

  let address: string;
  try {
    address = getAddress(args[0]);
  } catch {
    console.error(`❌ Invalid Ethereum address: ${args[0]}`);
    process.exit(1);
  }

  const outputDir = path.join(__dirname, "output");

  // ── Load snapshot ──
  const snapshotFiles = fs.readdirSync(outputDir).filter((f) => f.startsWith("snapshot-") && f.endsWith(".json"));
  if (snapshotFiles.length === 0) {
    console.error("❌ No snapshot file found in scripts/output/");
    process.exit(1);
  }
  const snapshotPath = path.join(outputDir, snapshotFiles[0]);
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));

  // ── Find address in snapshot ──
  const entry = snapshot.entitlements.find(
    (e: any) => e.address.toLowerCase() === address.toLowerCase()
  );

  console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║         Stream Recovery — Address Verification                  ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝`);
  console.log(`\n📌 Address: ${address}`);
  console.log(`📦 Snapshot block: ${snapshot.snapshotBlock}`);
  console.log(`📅 Snapshot time:  ${snapshot.timestamp}\n`);

  if (!entry) {
    console.log(`❌ Address NOT FOUND in the recovery snapshot.`);
    console.log(`\n   This means the address did not hold stkscUSD or stkscETH`);
    console.log(`   at block ${snapshot.snapshotBlock} on Sonic.\n`);
    process.exit(0);
  }

  console.log(`✅ Address FOUND in the recovery snapshot!\n`);
  console.log(`─── Balances at Snapshot ────────────────────────────────────────`);

  const hasUsdc = BigInt(entry.stkscUSD_balance) > 0n;
  const hasWeth = BigInt(entry.stkscETH_balance) > 0n;

  if (hasUsdc) {
    console.log(`  💵 stkscUSD: ${formatUsdc(entry.stkscUSD_balance)}`);
    console.log(`     Share:   ${formatSharePct(entry.stkscUSD_share)} of total USDC pool`);
  } else {
    console.log(`  💵 stkscUSD: None`);
  }

  if (hasWeth) {
    console.log(`  💎 stkscETH: ${formatWeth(entry.stkscETH_balance)}`);
    console.log(`     Share:   ${formatSharePct(entry.stkscETH_share)} of total WETH pool`);
  } else {
    console.log(`  💎 stkscETH: None`);
  }

  // ── Check merkle trees ──
  console.log(`\n─── Merkle Tree Inclusion ───────────────────────────────────────`);

  const usdcMerklePath = path.join(outputDir, "merkle-usdc.json");
  const wethMerklePath = path.join(outputDir, "merkle-weth.json");

  if (hasUsdc && fs.existsSync(usdcMerklePath)) {
    const usdcMerkle = JSON.parse(fs.readFileSync(usdcMerklePath, "utf-8"));
    const usdcEntry = usdcMerkle.entries.find(
      (e: any) => e.address.toLowerCase() === address.toLowerCase()
    );
    if (usdcEntry) {
      console.log(`  ✅ Included in USDC Merkle tree`);
      console.log(`     Leaf index: ${usdcEntry.index}`);
      console.log(`     Share WAD:  ${usdcEntry.shareWad}`);
      console.log(`     Proof size: ${usdcEntry.proof.length} hashes`);
    } else {
      console.log(`  ⚠️  Not found in USDC Merkle tree (unexpected)`);
    }
  } else if (!hasUsdc) {
    console.log(`  ⬜ Not in USDC tree (no stkscUSD balance)`);
  }

  if (hasWeth && fs.existsSync(wethMerklePath)) {
    const wethMerkle = JSON.parse(fs.readFileSync(wethMerklePath, "utf-8"));
    const wethEntry = wethMerkle.entries.find(
      (e: any) => e.address.toLowerCase() === address.toLowerCase()
    );
    if (wethEntry) {
      console.log(`  ✅ Included in WETH Merkle tree`);
      console.log(`     Leaf index: ${wethEntry.index}`);
      console.log(`     Share WAD:  ${wethEntry.shareWad}`);
      console.log(`     Proof size: ${wethEntry.proof.length} hashes`);
    } else {
      console.log(`  ⚠️  Not found in WETH Merkle tree (unexpected)`);
    }
  } else if (!hasWeth) {
    console.log(`  ⬜ Not in WETH tree (no stkscETH balance)`);
  }

  // ── Payout simulation ──
  console.log(`\n─── Payout Simulation (example) ─────────────────────────────────`);
  console.log(`  If a recovery round distributes funds, your payout would be:`);

  if (hasUsdc) {
    const shareWad = BigInt(entry.stkscUSD_share);
    // Example: if 100,000 USDC is distributed
    const exampleUsdc = 100_000n * 1_000_000n;
    const payout = (shareWad * exampleUsdc) / (10n ** 18n);
    const payoutWhole = payout / 1_000_000n;
    const payoutFrac = payout % 1_000_000n;
    console.log(`  💵 ${payoutWhole}.${payoutFrac.toString().padStart(6, "0")} USDC per $100,000 distributed`);
  }

  if (hasWeth) {
    const shareWad = BigInt(entry.stkscETH_share);
    // Example: if 100 WETH is distributed
    const exampleWeth = 100n * 10n ** 18n;
    const payout = (shareWad * exampleWeth) / (10n ** 18n);
    const payoutFormatted = Number(payout) / 1e18;
    console.log(`  💎 ${payoutFormatted.toFixed(6)} WETH per 100 WETH distributed`);
  }

  console.log(`\n─── Summary ────────────────────────────────────────────────────`);
  console.log(`  Total stkscUSD holders: ${snapshot.stkscUSD.holderCount}`);
  console.log(`  Total stkscETH holders: ${snapshot.stkscETH.holderCount}`);
  console.log(`  Total unique addresses: ${snapshot.entitlements.length}`);
  console.log(`  Snapshot block: ${snapshot.snapshotBlock}\n`);
}

main();
