/**
 * Fix Snapshot Script (v3)
 *
 * Corrects the snapshot-62788943.json by:
 *   A) Removing incorrectly absorbed "dust" from Silo protocol addresses and
 *      adding the correct amounts to their actual depositors.
 *   B) Resolving the Relay contract's veETH NFT holdings to individual depositors.
 *
 * ─── Root Cause A: Silo Dust ─────────────────────────────────────────────
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
 * ─── Root Cause B: Relay Contract ────────────────────────────────────────
 *
 * The Relay contract (0x636d9c9ac5e681f245051b84f908f6f84221390d) holds
 * 53 veETH NFTs (91.028 stkscETH) on behalf of 41 individual depositors.
 * The snapshot credits the Relay as a single holder instead of resolving
 * to the actual depositors. Users deposited veNFTs into the Relay via
 * direct ERC721 safeTransferFrom — the ownership was traced by analyzing
 * all Transfer events to/from the Relay contract across Sonic chain history.
 *
 * ─── Fix Approach ──────────────────────────────────────────────────────────
 *
 * 1. Subtract ALL unmapped AV1 amounts from the Silo address (not just "missing" ones)
 * 2. Add ALL 18 unmapped AV1 token amounts to their depositors (even if depositor
 *    is already in the snapshot from mapped tokens or wstkscUSD — "existing in
 *    snapshot" does NOT mean "unmapped token already credited")
 * 3. Add the 1 missing AV2 ETH depositor
 * 4. Resolve Relay contract: remove its stkscETH balance, add to 41 depositors
 * 5. Verify sums == totalSupply (zero-sum correction)
 *
 * ─── Data Sources ──────────────────────────────────────────────────────────
 *
 *   - /tmp/av1_additional_depositors.json (18 unmapped AV1 token→depositor)
 *   - /tmp/av1_all_tokens.json (all AV1 token IDs and amounts)
 *   - /tmp/auto_voter_v2_eth_resolved.json (AV2 ETH data including #1637)
 *   - /tmp/relay_eth_resolved.json (Relay 53 NFTs → 41 depositors with amounts)
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

interface RelayResolvedData {
  relay_address: string;
  snapshot_block: number;
  depositor_amounts: Record<string, number>; // address -> wei amount
  token_amounts: Record<string, number>;      // tokenId -> wei amount
  token_ids: number[];
  total_locked: number;
  depositor_count: number;
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

// Relay contract that manages veETH NFTs on behalf of depositors
const RELAY_ADDRESS =
  "0x636d9c9ac5e681f245051b84f908f6f84221390d";

// ─── Main ──────────────────────────────────────────────────────────────

function main() {
  const scriptDir = path.dirname(
    decodeURIComponent(new URL(import.meta.url).pathname)
  );
  const snapshotPath = path.join(scriptDir, "output", "snapshot-62788943-raw.json");

  console.log("Loading snapshot...");
  const snapshot: SnapshotFile = loadJson(snapshotPath);
  console.log(`   Block: ${snapshot.snapshotBlock}`);
  console.log(`   Entries: ${snapshot.entitlements.length}`);

  const usdTotalSupply = BigInt(snapshot.stkscUSD.totalSupply);
  const ethTotalSupply = BigInt(snapshot.stkscETH.totalSupply);
  const WAD = 10n ** 18n;

  // ── Verify required data files exist ────────────────────────────────

  const requiredFiles = [
    "/tmp/av1_additional_depositors.json",
    "/tmp/av1_all_tokens.json",
    "/tmp/auto_voter_v2_eth_resolved.json",
    "/tmp/relay_eth_resolved.json",
  ];
  for (const f of requiredFiles) {
    if (!fs.existsSync(f)) {
      console.error(`❌ Required data file not found: ${f}`);
      console.error(`   Run the investigation scripts first to generate these files.`);
      process.exit(1);
    }
  }

  // ── Load resolved data ──────────────────────────────────────────────

  console.log("\nLoading resolved data...");

  const av1Additional: AdditionalDepositors = loadJson(
    "/tmp/av1_additional_depositors.json"
  );
  const av1AllTokens: AllTokensData = loadJson("/tmp/av1_all_tokens.json");
  const av2Eth: ResolvedData = loadJson(
    "/tmp/auto_voter_v2_eth_resolved.json"
  );
  const relayEth: RelayResolvedData = loadJson(
    "/tmp/relay_eth_resolved.json"
  );

  // ── Idempotency guard: check if fix has already been applied ──────
  // If the AV2 ETH depositor is already in the snapshot, the fix was
  // already applied. Running again would incorrectly subtract from Silo twice.
  const alreadyFixed = snapshot.entitlements.some(
    (e) => e.address.toLowerCase() === AV2_ETH_1637_DEPOSITOR.toLowerCase()
      && BigInt(e.stkscETH_balance) > 0n
  );
  if (alreadyFixed) {
    console.log("\n⚠️  Fix already applied (AV2 ETH depositor already present). Skipping.");
    process.exit(0);
  }

  // Build set of existing addresses in the snapshot
  const existingAddresses = new Set<string>();
  for (const entry of snapshot.entitlements) {
    existingAddresses.add(entry.address.toLowerCase());
  }
  console.log(`   Existing addresses in snapshot: ${existingAddresses.size}`);

  // ── Identify ALL unmapped AV1 depositors ────────────────────────────
  // ALL 18 unmapped tokens were absorbed as dust into Silo by the first fix.
  // Even if the depositor is already in the snapshot (from mapped AV1 tokens
  // or wstkscUSD), their unmapped token amounts were NOT credited — they
  // were incorrectly lumped into Silo's balance.
  //
  // Previous bug: only added unmapped tokens whose depositors were NOT in
  // the snapshot, assuming existing depositors were "already resolved".
  // This missed 8 tokens (56,397 stkscUSD) for depositors who were in the
  // snapshot for other reasons.

  const unmappedUsdDepositors = new Map<string, bigint>(); // addr -> total amount
  let unmappedTokenCount = 0;
  let unmappedUsdTotal = 0n;
  let newDepositorCount = 0;
  let existingDepositorCount = 0;

  for (const [tokenId, depositor] of Object.entries(av1Additional)) {
    const amount = av1AllTokens.token_amounts[tokenId];
    if (amount === undefined) {
      console.warn(`   Warning: Token ${tokenId} not in av1_all_tokens`);
      continue;
    }
    const addr = depositor.toLowerCase();
    const existing = unmappedUsdDepositors.get(addr) ?? 0n;
    unmappedUsdDepositors.set(addr, existing + BigInt(amount));
    unmappedTokenCount++;
    unmappedUsdTotal += BigInt(amount);

    if (existingAddresses.has(addr)) {
      existingDepositorCount++;
    } else {
      newDepositorCount++;
    }
  }

  // Verify total matches expectations
  if (unmappedUsdTotal !== BigInt(av1AllTokens.unmapped_amount)) {
    console.error(
      `   MISMATCH: expected ${av1AllTokens.unmapped_amount}, got ${unmappedUsdTotal}`
    );
    process.exit(1);
  }

  console.log(
    `   AV1 unmapped: ${unmappedTokenCount} tokens, ${unmappedUsdDepositors.size} unique depositors, ` +
      `${Number(unmappedUsdTotal) / 1e6} stkscUSD`
  );
  console.log(
    `   ${existingDepositorCount} tokens augment existing snapshot addresses, ` +
      `${newDepositorCount} tokens create new addresses`
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

  if (siloUsdBalance < unmappedUsdTotal) {
    console.error(
      `   FATAL: USD Silo balance (${siloUsdBalance}) < amount to remove (${unmappedUsdTotal})`
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
    `   USD Silo after fix: ${Number(siloUsdBalance - unmappedUsdTotal) / 1e6} stkscUSD`
  );
  console.log(
    `   ETH Silo after fix: ${Number(siloEthBalance - av2EthToken1637Amount) / 1e18} stkscETH`
  );

  // ── Verify Relay address exists ──────────────────────────────────────

  const relayEntry = snapshot.entitlements.find(
    (e) => e.address.toLowerCase() === RELAY_ADDRESS
  );
  if (!relayEntry) {
    console.error(`   FATAL: Relay ${RELAY_ADDRESS} not found in snapshot`);
    process.exit(1);
  }
  const relaySnapshotEthBalance = BigInt(relayEntry.stkscETH_balance);
  console.log(
    `\n   Relay current balance: ${Number(relaySnapshotEthBalance) / 1e18} stkscETH`
  );
  console.log(
    `   Relay resolved total:  ${Number(BigInt(relayEth.total_locked)) / 1e18} stkscETH`
  );
  console.log(
    `   Relay depositors: ${relayEth.depositor_count} depositors, ${relayEth.token_ids.length} NFTs`
  );

  // ── Step 1: Copy all balances, adjusting Silo + Relay entries ──────

  console.log("\nStep 1: Copying balances and adjusting Silo dust + zeroing Relay...");

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
      usdBalance -= unmappedUsdTotal;
    }
    if (addr === ETH_SILO_ADDRESS) {
      ethBalance -= av2EthToken1637Amount;
    }

    // Zero out the Relay contract — its balance will be redistributed to depositors
    if (addr === RELAY_ADDRESS) {
      ethBalance = 0n;
    }

    if (usdBalance > 0n || ethBalance > 0n) {
      newBalances.set(addr, {
        usd: usdBalance,
        eth: ethBalance,
        label: entry.label,
      });
    }
  }

  console.log(`   Subtracted ${Number(unmappedUsdTotal) / 1e6} stkscUSD from USD Silo`);
  console.log(
    `   Subtracted ${Number(av2EthToken1637Amount) / 1e18} stkscETH from ETH Silo`
  );
  console.log(
    `   Zeroed Relay: removed ${Number(relaySnapshotEthBalance) / 1e18} stkscETH`
  );

  // ── Step 2: Add missing depositors ──────────────────────────────────

  console.log("\nStep 2: Adding missing depositors...");

  // Add ALL 18 unmapped AV1 USD depositors to their correct addresses
  let usdAdded = 0;
  for (const [addr, amount] of unmappedUsdDepositors) {
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
    `   USD: ${usdAdded} new addresses, ${unmappedUsdDepositors.size - usdAdded} augmented`
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

  // ── Step 3: Resolve Relay depositors ────────────────────────────────

  console.log("\nStep 3: Resolving Relay contract to individual depositors...");

  // The Relay's snapshot balance may differ slightly from the sum of on-chain
  // locked() amounts due to pro-rata redistribution in the original snapshot.
  // We distribute the SNAPSHOT balance (not resolved total) proportionally
  // to maintain zero-sum correctness.
  const relayResolvedTotal = BigInt(relayEth.total_locked);
  let relayDistributed = 0n;
  const relayDepositorEntries = Object.entries(relayEth.depositor_amounts);
  let relayNewCount = 0;
  let relayAugmentedCount = 0;

  for (let i = 0; i < relayDepositorEntries.length; i++) {
    const [depositor, resolvedAmountNum] = relayDepositorEntries[i];
    const addr = depositor.toLowerCase();
    const resolvedAmount = BigInt(resolvedAmountNum);

    // Calculate pro-rata share of the snapshot balance
    // For the last depositor, assign the remainder to avoid rounding drift
    let amount: bigint;
    if (i === relayDepositorEntries.length - 1) {
      amount = relaySnapshotEthBalance - relayDistributed;
    } else {
      amount = (resolvedAmount * relaySnapshotEthBalance) / relayResolvedTotal;
    }
    relayDistributed += amount;

    const existing = newBalances.get(addr);
    if (existing) {
      existing.eth += amount;
      relayAugmentedCount++;
    } else {
      newBalances.set(addr, { usd: 0n, eth: amount });
      relayNewCount++;
    }
  }

  console.log(
    `   Distributed ${Number(relayDistributed) / 1e18} stkscETH to ${relayDepositorEntries.length} depositors`
  );
  console.log(
    `   ${relayNewCount} new addresses, ${relayAugmentedCount} augmented existing`
  );

  // Sanity check: distributed must exactly equal what was removed
  if (relayDistributed !== relaySnapshotEthBalance) {
    console.error(
      `   FATAL: Relay distribution mismatch: distributed=${relayDistributed}, ` +
        `removed=${relaySnapshotEthBalance}`
    );
    process.exit(1);
  }
  console.log(`   ✓ Relay distribution matches exactly (zero-sum)`);

  // ── Step 4: Verify totals ─────────────────────────────────────────

  console.log("\nStep 4: Verifying totals...");

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

  // ── Step 5: Build output ──────────────────────────────────────────

  console.log("\nStep 5: Building output...");

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
        unmappedUsdDepositors.size,
      autoVoterV2ETH_holders:
        snapshot.recursiveResolution.autoVoterV2ETH_holders + 1,
      relay_resolved_holders: relayDepositorEntries.length,
      relay_resolved_nfts: relayEth.token_ids.length,
      relay_resolved_stkscETH: Number(relaySnapshotEthBalance),
      note_fixes_applied: 3,
      fix_v2_usd_dust_removed_from: USD_SILO_ADDRESS,
      fix_v2_usd_dust_amount: Number(unmappedUsdTotal),
      fix_v2_eth_dust_removed_from: ETH_SILO_ADDRESS,
      fix_v2_eth_dust_amount: Number(av2EthToken1637Amount),
      fix_v3_relay_resolved_from: RELAY_ADDRESS,
      fix_v3_relay_amount: Number(relaySnapshotEthBalance),
    },
    entitlements,
  };

  // Write output
  const outputDir = path.join(scriptDir, "output");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(
    outputDir,
    `snapshot-${snapshot.snapshotBlock}.json`
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
    // Note: 0x1fcd2c55ae99c01f4200657a9f472c05c85b420a also has Relay veETH token #1474
    // so we can't check exact ETH=0. We check USD only and verify ETH is present.
    { addr: "0x1fcd2c55ae99c01f4200657a9f472c05c85b420a", tokenIds: "USD#5511+6412+Relay#1474", expectedUsd: 2529080203n + 1498088195n, expectedEth: -1n },
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
    const ethOk = expectedEth === -1n ? true : actualEth === expectedEth; // -1n = skip ETH check
    if (usdOk && ethOk) {
      console.log(
        `   ✓ ${addr} (${tokenIds}): USD=${Number(actualUsd) / 1e6}, ETH=${Number(actualEth) / 1e18}`
      );
    } else {
      console.log(
        `   ✗ ${addr} (${tokenIds}): USD=${Number(actualUsd) / 1e6} (expected ${Number(expectedUsd) / 1e6}), ` +
          `ETH=${Number(actualEth) / 1e18} (expected ${expectedEth === -1n ? "any" : Number(expectedEth) / 1e18})`
      );
      allCorrect = false;
    }
  }

  // Check the 8 previously-skipped tokens: depositors already in snapshot whose
  // unmapped AV1 amounts were NOT credited by the old code
  console.log("\nPreviously-skipped unmapped tokens (v3 bug fix — amounts now added):");
  const skippedTokenChecks = [
    { addr: "0x4334703b0b74e2045926f82f4158a103fce1df4f", tokenId: "2665", amount: 14651868074n },
    { addr: "0x28ef7b4252ac35266f5a16af86046356ce60fad0", tokenId: "4475", amount: 15343380078n },
    { addr: "0xb21f69a8eba1475c96c09e8c62842dcc16f0d441", tokenId: "4706", amount: 20065708511n },
    { addr: "0x24c9496b9be8572ea1d80b8fdfa720dd2584aa9e", tokenId: "5267+5313+5599", amount: 901478569n + 315181621n + 40332775n },
    { addr: "0xe8d176dc1adc732a838e2056109be4c34d1dfb57", tokenId: "5845", amount: 52298465n },
    { addr: "0x097adbe246858a0fa8f9492889ae00fd87638044", tokenId: "5965", amount: 5026791900n },
  ];
  for (const { addr, tokenId, amount } of skippedTokenChecks) {
    const entry = entitlements.find((e) => e.address.toLowerCase() === addr);
    const origEntry = snapshot.entitlements.find((e) => e.address.toLowerCase() === addr);
    if (!entry || !origEntry) {
      console.log(`   ✗ ${addr} (token ${tokenId}): NOT FOUND`);
      allCorrect = false;
      continue;
    }
    const origUsd = BigInt(origEntry.stkscUSD_balance);
    const newUsd = BigInt(entry.stkscUSD_balance);
    // New balance must be at least origBalance + unmapped amount
    const expectedMin = origUsd + amount;
    const ok = newUsd >= expectedMin;
    console.log(
      `   ${ok ? "✓" : "✗"} ${addr} (token ${tokenId}): ` +
        `was ${Number(origUsd) / 1e6}, now ${Number(newUsd) / 1e6}, ` +
        `added ${Number(amount) / 1e6} stkscUSD`
    );
    if (!ok) allCorrect = false;
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
    const expectedUsd = siloUsdBalance - unmappedUsdTotal;
    const actualUsd = BigInt(usdSiloFixed.stkscUSD_balance);
    const ok = actualUsd === expectedUsd;
    console.log(
      `   ${ok ? "✓" : "✗"} USD Silo: ${Number(actualUsd) / 1e6} stkscUSD ` +
        `(was ${Number(siloUsdBalance) / 1e6}, removed ${Number(unmappedUsdTotal) / 1e6})`
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

  // Check Relay is removed and key depositors are present
  console.log("\nRelay resolution (should be zeroed, depositors credited):");
  const relayFixed = entitlements.find(
    (e) => e.address.toLowerCase() === RELAY_ADDRESS
  );
  if (relayFixed) {
    console.log(
      `   ✗ Relay still in output with ETH=${Number(BigInt(relayFixed.stkscETH_balance)) / 1e18}`
    );
    allCorrect = false;
  } else {
    console.log(`   ✓ Relay address removed from output (balance zeroed)`);
  }

  // Check the user who triggered this investigation: 0x4334703b
  // Should have: wstkscUSD (~106,710) + mapped veUSD #1969 (18,024) + unmapped veUSD #2665 (14,652)
  // = ~139,386 stkscUSD + ETH from Relay tokens
  const userAddr = "0x4334703b0b74e2045926f82f4158a103fce1df4f";
  const userEntry = entitlements.find(
    (e) => e.address.toLowerCase() === userAddr
  );
  if (userEntry) {
    const userEth = Number(BigInt(userEntry.stkscETH_balance)) / 1e18;
    const userUsd = Number(BigInt(userEntry.stkscUSD_balance)) / 1e6;
    // USD must include unmapped veUSD #2665 (14,651.87) — previous bug missed this
    const hasUnmappedFunds = userUsd > 139000; // was 124,734 before fix
    // ETH must include Relay tokens #107 + #322 — should be >> 6 stkscETH
    const hasRelayFunds = userEth > 50;
    const ok = hasUnmappedFunds && hasRelayFunds;
    console.log(
      `   ${ok ? "✓" : "✗"} ${userAddr}: USD=${userUsd.toFixed(6)}, ETH=${userEth.toFixed(6)}`
    );
    console.log(
      `     (was 124,734 stkscUSD before fix; now includes unmapped veUSD #2665 = +14,652)`
    );
    console.log(
      `     (was 6.013 stkscETH before Relay fix; now includes Relay tokens #107 + #322)`
    );
    if (!ok) allCorrect = false;
  } else {
    console.log(`   ✗ ${userAddr}: NOT FOUND`);
    allCorrect = false;
  }

  // Check a few more Relay depositors
  const relaySpotChecks = [
    { addr: "0x28ef7b4252ac35266f5a16af86046356ce60fad0", label: "tokens #1127+#1201+#1245", minEth: 7.0 },
    { addr: "0x097adbe246858a0fa8f9492889ae00fd87638044", label: "tokens #1473+#1610", minEth: 6.0 },
    { addr: "0x33ae316fcbea378c08d53be8b3803f34babd3e61", label: "token #413", minEth: 6.5 },
  ];
  for (const { addr, label, minEth } of relaySpotChecks) {
    const entry = entitlements.find((e) => e.address.toLowerCase() === addr);
    if (entry) {
      const ethVal = Number(BigInt(entry.stkscETH_balance)) / 1e18;
      const ok = ethVal >= minEth;
      console.log(
        `   ${ok ? "✓" : "✗"} ${addr} (${label}): ETH=${ethVal.toFixed(6)}`
      );
      if (!ok) allCorrect = false;
    } else {
      console.log(`   ✗ ${addr} (${label}): NOT FOUND`);
      allCorrect = false;
    }
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
  console.log(`   Fix type: Dust correction + Relay resolution`);
  console.log(
    `   USD: Removed ${Number(unmappedUsdTotal) / 1e6} stkscUSD from Silo, ` +
      `added to ${unmappedUsdDepositors.size} depositors (${unmappedTokenCount} tokens)`
  );
  console.log(
    `   ETH (Silo dust): Removed ${Number(av2EthToken1637Amount) / 1e18} stkscETH from Silo, ` +
      `added to 1 depositor (token #1637)`
  );
  console.log(
    `   ETH (Relay): Removed ${Number(relaySnapshotEthBalance) / 1e18} stkscETH from Relay, ` +
      `distributed to ${relayDepositorEntries.length} depositors (${relayEth.token_ids.length} NFTs)`
  );
  console.log(`   New addresses: ${entitlements.length - snapshot.entitlements.length}`);
  console.log(`   All checks passed: ${allCorrect}`);
  console.log(
    `   All ${unmappedTokenCount} unmapped AV1 tokens credited to their depositors`
  );
}

// ─── Run ───────────────────────────────────────────────────────────────

main();
