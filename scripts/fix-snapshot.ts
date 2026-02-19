/**
 * Fix Snapshot Script (v2)
 *
 * Corrects the snapshot-62788943.json by removing incorrectly absorbed "dust"
 * from Silo protocol addresses and adding the correct amounts to their actual
 * depositors.
 *
 * ─── Root Cause ────────────────────────────────────────────────────────────
 *
 * The first fix (commit 0e6f427, Feb 17) resolved auto voter depositors, but
 * used an earlier version of av1_additional_depositors.json that only had 8 of
 * the 18 unmapped token→depositor mappings. The remaining 10 tokens (totaling
 * 91,059.29 stkscUSD) were left as a shortfall after removing the auto voter
 * contract entry and re-adding the known depositors.
 *
 * The first fix's "dust" adjustment assigned this ENTIRE shortfall to the
 * largest stkscUSD holder — the Silo bwstkscUSD-55 contract at
 * 0x15641c093e566bd951c5e08e505a644478125f70. This was NOT rounding dust;
 * it was ~$91K of real depositor funds incorrectly credited to Silo.
 *
 * The same mechanism affected stkscETH: AV2 ETH token #1637 (0.584 stkscETH)
 * was absorbed as "dust" into Silo bwstkscETH-26 at
 * 0xe8e1a980a7fc8d47d337d704fa73fbb81ee55c25.
 *
 * ─── Fix Approach ──────────────────────────────────────────────────────────
 *
 * 1. Subtract the incorrectly absorbed amounts from the Silo addresses
 * 2. Add the 10 missing AV1 USD depositors (8 unique addresses)
 * 3. Add the 1 missing AV2 ETH depositor
 * 4. Verify sums == totalSupply (zero-sum correction)
 *
 * NO pro-rata undo is needed — all other balances in the snapshot are correct.
 * The shortfall was dumped onto a single address (Silo), not redistributed.
 *
 * ─── Data Sources ──────────────────────────────────────────────────────────
 *
 *   - /tmp/av1_additional_depositors.json (18 unmapped AV1 token→depositor)
 *   - /tmp/av1_all_tokens.json (all AV1 token IDs and amounts)
 *   - /tmp/auto_voter_v2_eth_resolved.json (AV2 ETH data including #1637)
 *
 * Usage:
 *   npx tsx scripts/fix-snapshot.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types ─────────────────────────────────────────────────────────────

interface SnapshotEntry {
  address: string;
  label?: string;
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
  recursiveResolution: Record<string, number>;
  entitlements: SnapshotEntry[];
}

interface AllTokensData {
  all_token_ids: number[];
  token_amounts: Record<string, number>;
  unmapped_token_ids: number[];
  total_locked: number;
  mapped_amount: number;
  unmapped_amount: number;
}

interface AdditionalDepositors {
  [tokenId: string]: string; // tokenId -> depositor address
}

interface ResolvedData {
  depositor_amounts: Record<string, number>;
  total_locked: number;
  token_amounts: Record<string, number>;
  token_ids: number[];
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

// ─── Constants ─────────────────────────────────────────────────────────

// Silo contracts that incorrectly received "dust" in the first fix
const USD_SILO_ADDRESS =
  "0x15641c093e566bd951c5e08e505a644478125f70"; // Silo bwstkscUSD-55
const ETH_SILO_ADDRESS =
  "0xe8e1a980a7fc8d47d337d704fa73fbb81ee55c25"; // Silo bwstkscETH-26

// AV2 ETH token #1637 depositor (confirmed NOT in snapshot)
const AV2_ETH_1637_DEPOSITOR =
  "0x697f27643eed4d13276a126a31f0e84eeff92de8";

// ─── Main ──────────────────────────────────────────────────────────────

function main() {
  const scriptDir = path.dirname(
    decodeURIComponent(new URL(import.meta.url).pathname)
  );
  const snapshotPath = path.join(scriptDir, "output", "snapshot-62788943.json");

  console.log("Loading snapshot...");
  const snapshot: SnapshotFile = loadJson(snapshotPath);
  console.log(`   Block: ${snapshot.snapshotBlock}`);
  console.log(`   Entries: ${snapshot.entitlements.length}`);

  const usdTotalSupply = BigInt(snapshot.stkscUSD.totalSupply);
  const ethTotalSupply = BigInt(snapshot.stkscETH.totalSupply);
  const WAD = 10n ** 18n;

  // ── Load resolved data ──────────────────────────────────────────────

  console.log("\nLoading resolved data...");

  const av1Additional: AdditionalDepositors = loadJson(
    "/tmp/av1_additional_depositors.json"
  );
  const av1AllTokens: AllTokensData = loadJson("/tmp/av1_all_tokens.json");
  const av2Eth: ResolvedData = loadJson(
    "/tmp/auto_voter_v2_eth_resolved.json"
  );

  // Build set of existing addresses in the snapshot
  const existingAddresses = new Set<string>();
  for (const entry of snapshot.entitlements) {
    existingAddresses.add(entry.address.toLowerCase());
  }
  console.log(`   Existing addresses in snapshot: ${existingAddresses.size}`);

  // ── Identify the 10 missing AV1 depositors ──────────────────────────
  // These are the tokens whose depositors are NOT yet in the snapshot.
  // The first fix resolved 8 of 18 tokens; we need to add the other 10.

  const missingUsdDepositors = new Map<string, bigint>(); // addr -> total amount
  let missingUsdTokenCount = 0;
  let missingUsdTotal = 0n;

  const alreadyResolvedTokenCount = { count: 0 };
  let alreadyResolvedTotal = 0n;

  for (const [tokenId, depositor] of Object.entries(av1Additional)) {
    const amount = av1AllTokens.token_amounts[tokenId];
    if (amount === undefined) {
      console.warn(`   Warning: Token ${tokenId} not in av1_all_tokens`);
      continue;
    }
    const addr = depositor.toLowerCase();
    if (existingAddresses.has(addr)) {
      // Already correctly in the snapshot from the first fix
      alreadyResolvedTokenCount.count++;
      alreadyResolvedTotal += BigInt(amount);
    } else {
      // Missing — their amount was absorbed as dust by the Silo
      const existing = missingUsdDepositors.get(addr) ?? 0n;
      missingUsdDepositors.set(addr, existing + BigInt(amount));
      missingUsdTokenCount++;
      missingUsdTotal += BigInt(amount);
    }
  }

  // Verify the split matches expectations
  const grandTotal = alreadyResolvedTotal + missingUsdTotal;
  if (grandTotal !== BigInt(av1AllTokens.unmapped_amount)) {
    console.error(
      `   MISMATCH: expected ${av1AllTokens.unmapped_amount}, ` +
        `got ${grandTotal} (resolved=${alreadyResolvedTotal} + missing=${missingUsdTotal})`
    );
    process.exit(1);
  }

  console.log(
    `   AV1 already resolved by first fix: ${alreadyResolvedTokenCount.count} tokens, ` +
      `${Number(alreadyResolvedTotal) / 1e6} stkscUSD — no changes needed`
  );
  console.log(
    `   AV1 still missing (absorbed as dust): ${missingUsdTokenCount} tokens, ` +
      `${missingUsdDepositors.size} unique depositors, ${Number(missingUsdTotal) / 1e6} stkscUSD`
  );

  // ── Identify missing AV2 ETH depositor ──────────────────────────────

  const av2EthToken1637Amount = BigInt(av2Eth.token_amounts["1637"]);

  if (existingAddresses.has(AV2_ETH_1637_DEPOSITOR)) {
    console.error(
      `   UNEXPECTED: AV2 ETH #1637 depositor ${AV2_ETH_1637_DEPOSITOR} IS in snapshot`
    );
    process.exit(1);
  }

  console.log(
    `   AV2 ETH #1637: ${Number(av2EthToken1637Amount) / 1e18} stkscETH ` +
      `→ ${AV2_ETH_1637_DEPOSITOR} (NOT in snapshot, absorbed as ETH dust)`
  );

  // ── Verify Silo addresses exist and have sufficient balance ─────────

  const siloUsdEntry = snapshot.entitlements.find(
    (e) => e.address.toLowerCase() === USD_SILO_ADDRESS
  );
  const siloEthEntry = snapshot.entitlements.find(
    (e) => e.address.toLowerCase() === ETH_SILO_ADDRESS
  );

  if (!siloUsdEntry) {
    console.error(`   FATAL: USD Silo ${USD_SILO_ADDRESS} not found in snapshot`);
    process.exit(1);
  }
  if (!siloEthEntry) {
    console.error(`   FATAL: ETH Silo ${ETH_SILO_ADDRESS} not found in snapshot`);
    process.exit(1);
  }

  const siloUsdBalance = BigInt(siloUsdEntry.stkscUSD_balance);
  const siloEthBalance = BigInt(siloEthEntry.stkscETH_balance);

  console.log(
    `\n   USD Silo current balance: ${Number(siloUsdBalance) / 1e6} stkscUSD`
  );
  console.log(
    `   ETH Silo current balance: ${Number(siloEthBalance) / 1e18} stkscETH`
  );

  if (siloUsdBalance < missingUsdTotal) {
    console.error(
      `   FATAL: USD Silo balance (${siloUsdBalance}) < amount to remove (${missingUsdTotal})`
    );
    process.exit(1);
  }
  if (siloEthBalance < av2EthToken1637Amount) {
    console.error(
      `   FATAL: ETH Silo balance (${siloEthBalance}) < amount to remove (${av2EthToken1637Amount})`
    );
    process.exit(1);
  }

  console.log(
    `   USD Silo after fix: ${Number(siloUsdBalance - missingUsdTotal) / 1e6} stkscUSD`
  );
  console.log(
    `   ETH Silo after fix: ${Number(siloEthBalance - av2EthToken1637Amount) / 1e18} stkscETH`
  );

  // ── Step 1: Copy all balances, adjusting Silo entries ───────────────

  console.log("\nStep 1: Copying balances and adjusting Silo dust...");

  const newBalances = new Map<
    string,
    { usd: bigint; eth: bigint; label?: string }
  >();

  for (const entry of snapshot.entitlements) {
    const addr = entry.address.toLowerCase();
    let usdBalance = BigInt(entry.stkscUSD_balance);
    let ethBalance = BigInt(entry.stkscETH_balance);

    // Subtract incorrectly absorbed dust from Silo addresses
    if (addr === USD_SILO_ADDRESS) {
      usdBalance -= missingUsdTotal;
    }
    if (addr === ETH_SILO_ADDRESS) {
      ethBalance -= av2EthToken1637Amount;
    }

    if (usdBalance > 0n || ethBalance > 0n) {
      newBalances.set(addr, {
        usd: usdBalance,
        eth: ethBalance,
        label: entry.label,
      });
    }
  }

  console.log(`   Subtracted ${Number(missingUsdTotal) / 1e6} stkscUSD from USD Silo`);
  console.log(
    `   Subtracted ${Number(av2EthToken1637Amount) / 1e18} stkscETH from ETH Silo`
  );

  // ── Step 2: Add missing depositors ──────────────────────────────────

  console.log("\nStep 2: Adding missing depositors...");

  // Add 10 missing AV1 USD depositors (8 unique addresses)
  let usdAdded = 0;
  for (const [addr, amount] of missingUsdDepositors) {
    const existing = newBalances.get(addr);
    if (existing) {
      // Address exists with ETH balance — add USD
      existing.usd += amount;
      console.log(
        `   Augmented ${addr}: +${Number(amount) / 1e6} stkscUSD`
      );
    } else {
      newBalances.set(addr, { usd: amount, eth: 0n });
      usdAdded++;
      console.log(
        `   Added ${addr}: ${Number(amount) / 1e6} stkscUSD`
      );
    }
  }
  console.log(
    `   USD: ${usdAdded} new addresses, ${missingUsdDepositors.size - usdAdded} augmented`
  );

  // Add 1 missing AV2 ETH depositor
  const existingEthEntry = newBalances.get(AV2_ETH_1637_DEPOSITOR);
  if (existingEthEntry) {
    existingEthEntry.eth += av2EthToken1637Amount;
    console.log(
      `   Augmented ${AV2_ETH_1637_DEPOSITOR}: +${Number(av2EthToken1637Amount) / 1e18} stkscETH`
    );
  } else {
    newBalances.set(AV2_ETH_1637_DEPOSITOR, {
      usd: 0n,
      eth: av2EthToken1637Amount,
    });
    console.log(
      `   Added ${AV2_ETH_1637_DEPOSITOR}: ${Number(av2EthToken1637Amount) / 1e18} stkscETH`
    );
  }

  // ── Step 3: Verify totals ─────────────────────────────────────────

  console.log("\nStep 3: Verifying totals...");

  let newUsdSum = 0n;
  let newEthSum = 0n;
  for (const { usd, eth } of newBalances.values()) {
    newUsdSum += usd;
    newEthSum += eth;
  }

  const usdDiff = usdTotalSupply - newUsdSum;
  const ethDiff = ethTotalSupply - newEthSum;

  console.log(`   stkscUSD: sum=${newUsdSum}, supply=${usdTotalSupply}, diff=${usdDiff}`);
  console.log(`   stkscETH: sum=${newEthSum}, supply=${ethTotalSupply}, diff=${ethDiff}`);

  if (usdDiff !== 0n) {
    console.error(
      `   FATAL: USD sum mismatch by ${usdDiff} (${Number(usdDiff) / 1e6} stkscUSD)`
    );
    process.exit(1);
  }
  if (ethDiff !== 0n) {
    console.error(
      `   FATAL: ETH sum mismatch by ${ethDiff} (${Number(ethDiff) / 1e18} stkscETH)`
    );
    process.exit(1);
  }

  console.log(`   ✓ stkscUSD matches totalSupply exactly`);
  console.log(`   ✓ stkscETH matches totalSupply exactly`);

  // ── Step 4: Build output ──────────────────────────────────────────

  console.log("\nStep 4: Building output...");

  const entitlements: SnapshotEntry[] = [];
  for (const [addr, { usd, eth, label }] of newBalances) {
    if (usd === 0n && eth === 0n) continue;
    entitlements.push({
      address: addr,
      ...(label ? { label } : {}),
      stkscUSD_balance: usd.toString(),
      stkscETH_balance: eth.toString(),
      stkscUSD_share:
        usdTotalSupply > 0n
          ? ((usd * WAD) / usdTotalSupply).toString()
          : "0",
      stkscETH_share:
        ethTotalSupply > 0n
          ? ((eth * WAD) / ethTotalSupply).toString()
          : "0",
    });
  }

  // Sort by total value (eth first, then usd)
  entitlements.sort((a, b) => {
    const aEth = BigInt(a.stkscETH_balance);
    const bEth = BigInt(b.stkscETH_balance);
    if (aEth !== bEth) return aEth > bEth ? -1 : 1;
    const aUsd = BigInt(a.stkscUSD_balance);
    const bUsd = BigInt(b.stkscUSD_balance);
    if (aUsd !== bUsd) return aUsd > bUsd ? -1 : 1;
    return 0;
  });

  const usdHolders = entitlements.filter(
    (e) => BigInt(e.stkscUSD_balance) > 0n
  ).length;
  const ethHolders = entitlements.filter(
    (e) => BigInt(e.stkscETH_balance) > 0n
  ).length;

  const output: SnapshotFile = {
    snapshotBlock: snapshot.snapshotBlock,
    timestamp: new Date().toISOString(),
    stkscUSD: {
      totalSupply: usdTotalSupply.toString(),
      decimals: 6,
      holderCount: usdHolders,
    },
    stkscETH: {
      totalSupply: ethTotalSupply.toString(),
      decimals: 18,
      holderCount: ethHolders,
    },
    recursiveResolution: {
      ...snapshot.recursiveResolution,
      autoVoterV1_holders:
        snapshot.recursiveResolution.autoVoterV1_holders +
        missingUsdDepositors.size,
      autoVoterV2ETH_holders:
        snapshot.recursiveResolution.autoVoterV2ETH_holders + 1,
      note_fixes_applied: 2,
      fix_v2_usd_dust_removed_from: USD_SILO_ADDRESS,
      fix_v2_usd_dust_amount: Number(missingUsdTotal),
      fix_v2_eth_dust_removed_from: ETH_SILO_ADDRESS,
      fix_v2_eth_dust_amount: Number(av2EthToken1637Amount),
    },
    entitlements,
  };

  // Write output
  const outputDir = path.join(scriptDir, "output");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(
    outputDir,
    `snapshot-${snapshot.snapshotBlock}-fixed.json`
  );
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nSnapshot written to: ${outputPath}`);
  console.log(`   Total unique addresses: ${entitlements.length}`);
  console.log(`   (was ${snapshot.entitlements.length})`);
  console.log(`   USD holders: ${usdHolders}`);
  console.log(`   ETH holders: ${ethHolders}`);

  // ── Spot checks ───────────────────────────────────────────────────

  console.log("\n── Spot checks ──────────────────────────────────────────");

  // Check all missing depositors are now included with correct amounts
  console.log("\nMissing depositors (should now be present):");
  const expectedMissing: Array<{
    addr: string;
    tokenIds: string;
    expectedUsd: bigint;
    expectedEth: bigint;
  }> = [
    { addr: "0x38aed5923c16e1777c981d1dbe955fefce8e20c4", tokenIds: "4691", expectedUsd: 3542171013n, expectedEth: 0n },
    { addr: "0xba181deb98afc2202202c9aebf26b18f46d70497", tokenIds: "4740", expectedUsd: 10017385949n, expectedEth: 0n },
    { addr: "0xc70aa0bc5c372ca2006204c91af480dacf621bac", tokenIds: "4861+5145", expectedUsd: 19159900563n + 1395045904n, expectedEth: 0n },
    { addr: "0x1fcd2c55ae99c01f4200657a9f472c05c85b420a", tokenIds: "5511+6412", expectedUsd: 2529080203n + 1498088195n, expectedEth: 0n },
    { addr: "0x8c3a8873348fa28e9b855080646fec43c39f4a05", tokenIds: "5990", expectedUsd: 2999623243n, expectedEth: 0n },
    { addr: "0xe9d62b53622ff203ba106dbafcd04fe5ac87261a", tokenIds: "6103", expectedUsd: 40000980000n, expectedEth: 0n },
    { addr: "0x7fb778baaa42d224ed6866334ed985f5d1105f3d", tokenIds: "6785", expectedUsd: 9795075924n, expectedEth: 0n },
    { addr: "0x9f8460b720f0ea9bc98515e9d6e427b9ac611cae", tokenIds: "6864", expectedUsd: 121943311n, expectedEth: 0n },
    { addr: AV2_ETH_1637_DEPOSITOR, tokenIds: "ETH#1637", expectedUsd: 0n, expectedEth: av2EthToken1637Amount },
  ];

  let allCorrect = true;
  for (const { addr, tokenIds, expectedUsd, expectedEth } of expectedMissing) {
    const entry = entitlements.find(
      (e) => e.address.toLowerCase() === addr
    );
    if (!entry) {
      console.log(`   ✗ ${addr} (${tokenIds}): NOT FOUND`);
      allCorrect = false;
      continue;
    }
    const actualUsd = BigInt(entry.stkscUSD_balance);
    const actualEth = BigInt(entry.stkscETH_balance);
    const usdOk = actualUsd === expectedUsd;
    const ethOk = actualEth === expectedEth;
    if (usdOk && ethOk) {
      console.log(
        `   ✓ ${addr} (${tokenIds}): USD=${Number(actualUsd) / 1e6}, ETH=${Number(actualEth) / 1e18}`
      );
    } else {
      console.log(
        `   ✗ ${addr} (${tokenIds}): USD=${Number(actualUsd) / 1e6} (expected ${Number(expectedUsd) / 1e6}), ` +
          `ETH=${Number(actualEth) / 1e18} (expected ${Number(expectedEth) / 1e18})`
      );
      allCorrect = false;
    }
  }

  // Check Silo addresses have correct reduced balances
  console.log("\nSilo addresses (should have reduced balances):");
  const usdSiloFixed = entitlements.find(
    (e) => e.address.toLowerCase() === USD_SILO_ADDRESS
  );
  const ethSiloFixed = entitlements.find(
    (e) => e.address.toLowerCase() === ETH_SILO_ADDRESS
  );

  if (usdSiloFixed) {
    const expectedUsd = siloUsdBalance - missingUsdTotal;
    const actualUsd = BigInt(usdSiloFixed.stkscUSD_balance);
    const ok = actualUsd === expectedUsd;
    console.log(
      `   ${ok ? "✓" : "✗"} USD Silo: ${Number(actualUsd) / 1e6} stkscUSD ` +
        `(was ${Number(siloUsdBalance) / 1e6}, removed ${Number(missingUsdTotal) / 1e6})`
    );
    if (!ok) allCorrect = false;
  }

  if (ethSiloFixed) {
    const expectedEth = siloEthBalance - av2EthToken1637Amount;
    const actualEth = BigInt(ethSiloFixed.stkscETH_balance);
    const ok = actualEth === expectedEth;
    console.log(
      `   ${ok ? "✓" : "✗"} ETH Silo: ${Number(actualEth) / 1e18} stkscETH ` +
        `(was ${Number(siloEthBalance) / 1e18}, removed ${Number(av2EthToken1637Amount) / 1e18})`
    );
    if (!ok) allCorrect = false;
  }

  // Check the 4 flagged addresses — their balances should be UNCHANGED
  // (they were never modified, since the dust went to Silo, not to them)
  console.log("\nveUSD locked() vs fixed snapshot (should be ~0.948% diff — unchanged from input):");
  const veNftChecks = [
    { addr: "0xf80397386de0fd09e6fb3cc4d232bc954deb669c", locked: 309013.095267 },
    { addr: "0x66e359ec96093235f41c9bb4dca96a8fed872402", locked: 290906.639 },
    { addr: "0x81794deb7ac412929cc6506b64f9c43870086ac5", locked: 256237.4903 },
    { addr: "0x225fb7e7c27ed5631a74f808e6a20df1a3bcf9ac", locked: 237457.8816 },
  ];

  for (const { addr, locked } of veNftChecks) {
    const e = entitlements.find((e) => e.address.toLowerCase() === addr);
    if (e) {
      const reported = Number(BigInt(e.stkscUSD_balance)) / 1e6;
      const diff = ((locked - reported) / locked) * 100;
      console.log(
        `   ${addr}: locked=${locked}, snapshot=${reported.toFixed(6)}, diff=${diff.toFixed(6)}%`
      );
    }
  }

  console.log(
    "\nNote: The ~0.948% diff in veUSD locked() vs snapshot is from the ORIGINAL"
  );
  console.log(
    "snapshot.ts pro-rata redistribution (which spread ALL unresolvable balances,"
  );
  console.log(
    "not just the 10 missing tokens). That redistribution is baked into the raw"
  );
  console.log(
    "snapshot and was NOT caused by the first fix's dust absorption."
  );
  console.log(
    "The dust absorption only affected the Silo addresses."
  );

  // ── Summary ───────────────────────────────────────────────────────

  console.log("\n── Summary ──────────────────────────────────────────────");
  console.log(`   Fix type: Dust absorption correction (no pro-rata undo)`);
  console.log(
    `   USD: Removed ${Number(missingUsdTotal) / 1e6} stkscUSD from Silo, ` +
      `added to ${missingUsdDepositors.size} depositors (${missingUsdTokenCount} tokens)`
  );
  console.log(
    `   ETH: Removed ${Number(av2EthToken1637Amount) / 1e18} stkscETH from Silo, ` +
      `added to 1 depositor (token #1637)`
  );
  console.log(`   New addresses: ${entitlements.length - snapshot.entitlements.length}`);
  console.log(`   All checks passed: ${allCorrect}`);
  console.log(
    `   Note: 8 AV1 tokens (${Number(alreadyResolvedTotal) / 1e6} stkscUSD) were already correct — untouched`
  );
}

// ─── Run ───────────────────────────────────────────────────────────────

main();
