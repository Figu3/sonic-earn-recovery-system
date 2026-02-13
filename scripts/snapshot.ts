/**
 * Stream Recovery Snapshot Script
 *
 * Takes a snapshot of all stkscUSD and stkscETH holders on Sonic,
 * performs recursive resolution for Trevee contracts (veUSD, wstkscUSD,
 * veETH, wstkscETH, withdraw queues), and outputs a final entitlement list.
 *
 * Usage:
 *   npx ts-node scripts/snapshot.ts [--block <blockNumber>]
 *
 * Output:
 *   scripts/output/snapshot-<block>.json
 */

import { createPublicClient, http, parseAbi, getAddress, formatUnits } from "viem";
import { sonic } from "viem/chains";
import * as fs from "fs";
import * as path from "path";

// ─── Config ────────────────────────────────────────────────────────────

const SONIC_RPC = "https://rpc.soniclabs.com";

// Token addresses
const STKSCUSD = "0x4d85ba8c3918359c78ed09581e5bc7578ba932ba" as const;
const STKSCETH = "0x455d5f11fea33a8fa9d3e285930b478b6bf85265" as const;

// Both tokens deployed around block 597800 on Sonic (2024-12-18)
const TOKEN_DEPLOY_BLOCK = 590000n;

// Trevee contracts holding stkscUSD (need recursive resolution)
const VEUSD = "0x0966CAE7338518961c2d35493D3EB481A75bb86B" as const;
const WSTKSCUSD = "0x9fb76f7ce5FCeAA2C42887ff441D46095E494206" as const;
const STKSCUSD_WITHDRAW_QUEUE = "0x5448A65ddB14e6F273cd0eD6598805105A39d8cC" as const;

// Trevee contracts holding stkscETH (need recursive resolution)
const VEETH = "0x1Ec2b9a77A7226ACD457954820197F89B3e3a578" as const;
const WSTKSCETH = "0xE8a41c62BB4d5863C6eadC96792cFE90A1f37C47" as const;
const STKSCETH_WITHDRAW_QUEUE = "0x65b6AFB8C1521B48488dF04224Dc019Ea390E133" as const;

// Contracts that need recursive resolution (lowercase for comparison)
const USD_CONTRACTS = new Set([
  VEUSD.toLowerCase(),
  WSTKSCUSD.toLowerCase(),
  STKSCUSD_WITHDRAW_QUEUE.toLowerCase(),
]);

const ETH_CONTRACTS = new Set([
  VEETH.toLowerCase(),
  WSTKSCETH.toLowerCase(),
  STKSCETH_WITHDRAW_QUEUE.toLowerCase(),
]);

// ─── ABIs ──────────────────────────────────────────────────────────────

const ERC20_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

// ─── Types ─────────────────────────────────────────────────────────────

interface HolderBalance {
  address: string;
  stkscUSD: bigint;
  stkscETH: bigint;
}

interface SnapshotOutput {
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
  recursiveResolution: {
    veUSD_holders: number;
    wstkscUSD_holders: number;
    stkscUSD_withdrawQueue_holders: number;
    veETH_holders: number;
    wstkscETH_holders: number;
    stkscETH_withdrawQueue_holders: number;
  };
  entitlements: Array<{
    address: string;
    stkscUSD_balance: string;
    stkscETH_balance: string;
    stkscUSD_share: string;
    stkscETH_share: string;
  }>;
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  const blockArg = process.argv.indexOf("--block");
  const snapshotBlock = blockArg !== -1 ? BigInt(process.argv[blockArg + 1]) : undefined;

  const client = createPublicClient({
    chain: sonic,
    transport: http(SONIC_RPC),
  });

  const block = snapshotBlock ?? (await client.getBlockNumber());
  console.log(`📸 Taking snapshot at block ${block}`);

  // Step 1: Get all unique holder addresses via Transfer events
  console.log("\n📋 Step 1: Collecting holder addresses from Transfer events...");

  const [usdHolders, ethHolders] = await Promise.all([
    getTokenHolders(client, STKSCUSD, block),
    getTokenHolders(client, STKSCETH, block),
  ]);

  console.log(`  stkscUSD: ${usdHolders.size} unique addresses`);
  console.log(`  stkscETH: ${ethHolders.size} unique addresses`);

  // Step 2: Get balances for all holders (sequentially to avoid rate limits)
  console.log("\n💰 Step 2: Fetching balances...");
  console.log("  Fetching stkscUSD balances...");
  const usdBalances = await getBalances(client, STKSCUSD, usdHolders, block);
  console.log("  Fetching stkscETH balances...");
  const ethBalances = await getBalances(client, STKSCETH, ethHolders, block);

  // Filter zero balances
  const usdNonZero = new Map([...usdBalances].filter(([, v]) => v > 0n));
  const ethNonZero = new Map([...ethBalances].filter(([, v]) => v > 0n));

  console.log(`  stkscUSD: ${usdNonZero.size} non-zero holders`);
  console.log(`  stkscETH: ${ethNonZero.size} non-zero holders`);

  // Step 3: Recursive resolution for Trevee contracts
  console.log("\n🔄 Step 3: Recursive resolution of Trevee contract holdings...");

  const resolvedUSD = await resolveContractHoldings(
    client,
    usdNonZero,
    USD_CONTRACTS,
    [
      { contract: VEUSD, name: "veUSD" },
      { contract: WSTKSCUSD, name: "wstkscUSD" },
      { contract: STKSCUSD_WITHDRAW_QUEUE, name: "stkscUSD Withdraw Queue" },
    ],
    block
  );

  const resolvedETH = await resolveContractHoldings(
    client,
    ethNonZero,
    ETH_CONTRACTS,
    [
      { contract: VEETH, name: "veETH" },
      { contract: WSTKSCETH, name: "wstkscETH" },
      { contract: STKSCETH_WITHDRAW_QUEUE, name: "stkscETH Withdraw Queue" },
    ],
    block
  );

  // Step 4: Merge into final entitlement map
  console.log("\n📊 Step 4: Computing final entitlements...");

  const allAddresses = new Set([...resolvedUSD.keys(), ...resolvedETH.keys()]);
  const entitlements: HolderBalance[] = [];

  for (const addr of allAddresses) {
    entitlements.push({
      address: addr,
      stkscUSD: resolvedUSD.get(addr) ?? 0n,
      stkscETH: resolvedETH.get(addr) ?? 0n,
    });
  }

  // Sort by total USD value (stkscUSD first, then stkscETH)
  entitlements.sort((a, b) => {
    const totalA = a.stkscUSD + a.stkscETH * 10n ** 12n; // Normalize 18 dec to compare
    const totalB = b.stkscUSD + b.stkscETH * 10n ** 12n;
    return totalB > totalA ? 1 : totalB < totalA ? -1 : 0;
  });

  // Step 5: Get total supplies for share computation
  const usdTotalSupply = await withRetry(() =>
    client.readContract({ address: STKSCUSD, abi: ERC20_ABI, functionName: "totalSupply", blockNumber: block })
  );
  const ethTotalSupply = await withRetry(() =>
    client.readContract({ address: STKSCETH, abi: ERC20_ABI, functionName: "totalSupply", blockNumber: block })
  );

  // Step 6: Output
  const output: SnapshotOutput = {
    snapshotBlock: Number(block),
    timestamp: new Date().toISOString(),
    stkscUSD: {
      totalSupply: usdTotalSupply.toString(),
      decimals: 6,
      holderCount: resolvedUSD.size,
    },
    stkscETH: {
      totalSupply: ethTotalSupply.toString(),
      decimals: 18,
      holderCount: resolvedETH.size,
    },
    recursiveResolution: {
      veUSD_holders: 0, // Will be filled by resolveContractHoldings
      wstkscUSD_holders: 0,
      stkscUSD_withdrawQueue_holders: 0,
      veETH_holders: 0,
      wstkscETH_holders: 0,
      stkscETH_withdrawQueue_holders: 0,
    },
    entitlements: entitlements.map((e) => ({
      address: e.address,
      stkscUSD_balance: e.stkscUSD.toString(),
      stkscETH_balance: e.stkscETH.toString(),
      stkscUSD_share:
        usdTotalSupply > 0n
          ? ((e.stkscUSD * 10n ** 18n) / usdTotalSupply).toString()
          : "0",
      stkscETH_share:
        ethTotalSupply > 0n
          ? ((e.stkscETH * 10n ** 18n) / ethTotalSupply).toString()
          : "0",
    })),
  };

  // Sanity check: sum of all entitlements should equal total supply
  const usdSum = entitlements.reduce((acc, e) => acc + e.stkscUSD, 0n);
  const ethSum = entitlements.reduce((acc, e) => acc + e.stkscETH, 0n);
  console.log(`\n✅ Sanity checks:`);
  console.log(`  stkscUSD: sum=${usdSum} totalSupply=${usdTotalSupply} match=${usdSum === usdTotalSupply}`);
  console.log(`  stkscETH: sum=${ethSum} totalSupply=${ethTotalSupply} match=${ethSum === ethTotalSupply}`);

  if (usdSum !== usdTotalSupply || ethSum !== ethTotalSupply) {
    console.warn("⚠️  WARNING: Entitlement sum does not match total supply. Investigate before proceeding.");
  }

  // Write output
  const scriptDir = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
  const outputDir = path.join(scriptDir, "output");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `snapshot-${block}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n📁 Snapshot written to: ${outputPath}`);
  console.log(`   Total unique addresses: ${entitlements.length}`);
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Sleep for `ms` milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff on 429 / rate-limit errors.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  baseDelay = 1000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const isRateLimit =
        e?.cause?.cause?.status === 429 ||
        e?.cause?.status === 429 ||
        e?.message?.includes("429") ||
        e?.details?.includes("429");

      if (isRateLimit && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
        process.stdout.write(`  ⏳ Rate limited, retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 1}/${maxRetries})...\n`);
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
  throw new Error("Unreachable");
}

/**
 * Collect all unique addresses that have ever received a token via Transfer events.
 */
async function getTokenHolders(
  client: ReturnType<typeof createPublicClient>,
  token: `0x${string}`,
  block: bigint
): Promise<Set<string>> {
  const holders = new Set<string>();
  const BATCH_SIZE = 50000n;

  let fromBlock = TOKEN_DEPLOY_BLOCK;

  while (fromBlock <= block) {
    const toBlock = fromBlock + BATCH_SIZE > block ? block : fromBlock + BATCH_SIZE;

    try {
      const logs = await withRetry(() =>
        client.getLogs({
          address: token,
          event: {
            type: "event",
            name: "Transfer",
            inputs: [
              { type: "address", name: "from", indexed: true },
              { type: "address", name: "to", indexed: true },
              { type: "uint256", name: "value", indexed: false },
            ],
          },
          fromBlock,
          toBlock,
        })
      );

      for (const log of logs) {
        if (log.args.to) holders.add(log.args.to.toLowerCase());
      }
    } catch (e: any) {
      // If batch too large, try smaller batches
      if (e.message?.includes("Log response size exceeded") || e.message?.includes("range")) {
        const mid = fromBlock + (toBlock - fromBlock) / 2n;
        // Recursively get smaller ranges
        const smallBatch1 = await getTokenHoldersRange(client, token, fromBlock, mid);
        const smallBatch2 = await getTokenHoldersRange(client, token, mid + 1n, toBlock);
        smallBatch1.forEach((h) => holders.add(h));
        smallBatch2.forEach((h) => holders.add(h));
      } else {
        throw e;
      }
    }

    fromBlock = toBlock + 1n;
    if ((fromBlock - TOKEN_DEPLOY_BLOCK) % (BATCH_SIZE * 5n) < BATCH_SIZE) {
      const pct = Number((fromBlock - TOKEN_DEPLOY_BLOCK) * 100n / (block - TOKEN_DEPLOY_BLOCK));
      process.stdout.write(`  ... scanned up to block ${fromBlock} (${pct}%)\r`);
    }
  }

  return holders;
}

async function getTokenHoldersRange(
  client: ReturnType<typeof createPublicClient>,
  token: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint
): Promise<Set<string>> {
  const holders = new Set<string>();
  const logs = await withRetry(() =>
    client.getLogs({
      address: token,
      event: {
        type: "event",
        name: "Transfer",
        inputs: [
          { type: "address", name: "from", indexed: true },
          { type: "address", name: "to", indexed: true },
          { type: "uint256", name: "value", indexed: false },
        ],
      },
      fromBlock,
      toBlock,
    })
  );

  for (const log of logs) {
    if (log.args.to) holders.add(log.args.to.toLowerCase());
  }
  return holders;
}

/**
 * Batch-fetch balances for all holder addresses with rate-limit protection.
 */
async function getBalances(
  client: ReturnType<typeof createPublicClient>,
  token: `0x${string}`,
  holders: Set<string>,
  block: bigint
): Promise<Map<string, bigint>> {
  const balances = new Map<string, bigint>();
  const addresses = Array.from(holders);
  const BATCH_SIZE = 20; // Small batches to avoid 429s
  const DELAY_MS = 100;  // 100ms between batches

  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const batch = addresses.slice(i, i + BATCH_SIZE);

    const results = await withRetry(async () => {
      return Promise.all(
        batch.map((addr) =>
          client.readContract({
            address: token,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [addr as `0x${string}`],
            blockNumber: block,
          })
        )
      );
    });

    for (let j = 0; j < batch.length; j++) {
      balances.set(batch[j], results[j]);
    }

    if (i % (BATCH_SIZE * 10) === 0 || i + BATCH_SIZE >= addresses.length) {
      process.stdout.write(`  ... fetched ${Math.min(i + BATCH_SIZE, addresses.length)}/${addresses.length} balances\r`);
    }

    // Rate-limit delay between batches
    if (i + BATCH_SIZE < addresses.length) {
      await sleep(DELAY_MS);
    }
  }

  process.stdout.write("\n");
  return balances;
}

/**
 * For each Trevee contract holding stksc tokens, resolve its balance
 * proportionally to the underlying depositors.
 *
 * Logic:
 *   contractBalance = stkscToken.balanceOf(contract)
 *   For each depositor in the contract:
 *     share = depositorBalance / contractTotalSupply
 *     userEntitlement += share * contractBalance
 */
async function resolveContractHoldings(
  client: ReturnType<typeof createPublicClient>,
  directBalances: Map<string, bigint>,
  contractSet: Set<string>,
  contracts: Array<{ contract: `0x${string}`; name: string }>,
  block: bigint
): Promise<Map<string, bigint>> {
  const resolved = new Map<string, bigint>();

  // First, add all direct (non-contract) holders
  for (const [addr, balance] of directBalances) {
    if (!contractSet.has(addr.toLowerCase())) {
      const existing = resolved.get(addr) ?? 0n;
      resolved.set(addr, existing + balance);
    }
  }

  // Track unresolvable contract balances for pro-rata redistribution
  const unresolvableBalances: Array<{ name: string; balance: bigint }> = [];

  // Then resolve each contract
  for (const { contract, name } of contracts) {
    const contractBalance = directBalances.get(contract.toLowerCase());
    if (!contractBalance || contractBalance === 0n) {
      console.log(`  ${name}: no balance, skipping`);
      continue;
    }

    console.log(`  ${name}: resolving ${contractBalance.toString()} across depositors...`);

    // Check if contract supports ERC20 totalSupply (withdraw queues don't)
    let wrapperTotalSupply: bigint;
    try {
      wrapperTotalSupply = await withRetry(() =>
        client.readContract({
          address: contract,
          abi: ERC20_ABI,
          functionName: "totalSupply",
          blockNumber: block,
        })
      );
    } catch (e: any) {
      // Withdraw queue contracts don't have totalSupply/balanceOf
      // Their balance will be redistributed pro-rata to all resolved holders
      console.log(`  ${name}: not an ERC20 (totalSupply reverted), will redistribute pro-rata`);
      unresolvableBalances.push({ name, balance: contractBalance });
      continue;
    }

    if (wrapperTotalSupply === 0n) {
      console.log(`  ${name}: total supply is 0, skipping`);
      continue;
    }

    // Get all holders of the wrapper/ve token (the contract itself is an ERC20)
    const wrapperHolders = await getTokenHolders(client, contract, block);
    const wrapperBalances = await getBalances(client, contract, wrapperHolders, block);

    let resolvedCount = 0;
    let resolvedSum = 0n;

    for (const [depositor, wrapperBalance] of wrapperBalances) {
      if (wrapperBalance === 0n) continue;

      // Pro-rata share of the underlying stksc token
      const entitlement = (wrapperBalance * contractBalance) / wrapperTotalSupply;
      if (entitlement === 0n) continue;

      const existing = resolved.get(depositor) ?? 0n;
      resolved.set(depositor, existing + entitlement);
      resolvedSum += entitlement;
      resolvedCount++;
    }

    // Handle rounding dust: assign to first depositor
    const dust = contractBalance - resolvedSum;
    if (dust > 0n && resolvedCount > 0) {
      const firstDepositor = [...wrapperBalances.entries()].find(([, b]) => b > 0n)?.[0];
      if (firstDepositor) {
        const existing = resolved.get(firstDepositor) ?? 0n;
        resolved.set(firstDepositor, existing + dust);
      }
    }

    console.log(`  ${name}: resolved to ${resolvedCount} depositors (dust: ${dust})`);
  }

  // Redistribute unresolvable contract balances (withdraw queues) pro-rata to all resolved holders
  if (unresolvableBalances.length > 0) {
    for (const { name, balance } of unresolvableBalances) {
      // Recalculate total each time since previous redistribution changes balances
      const resolvedTotal = [...resolved.values()].reduce((acc, v) => acc + v, 0n);
      if (resolvedTotal === 0n) {
        console.warn(`  ⚠️  No resolved holders to redistribute ${name} to!`);
        continue;
      }
      console.log(`  ${name}: redistributing ${balance} pro-rata across ${resolved.size} holders (resolvedTotal: ${resolvedTotal})...`);
      let redistributedSum = 0n;
      const entries = [...resolved.entries()];
      for (const [addr, holderBalance] of entries) {
        const share = (holderBalance * balance) / resolvedTotal;
        if (share > 0n) {
          resolved.set(addr, holderBalance + share);
          redistributedSum += share;
        }
      }
      // Assign dust to largest holder
      const dust = balance - redistributedSum;
      if (dust > 0n) {
        let largest = entries[0][0];
        let largestBal = entries[0][1];
        for (const [addr, bal] of entries) {
          if (bal > largestBal) { largest = addr; largestBal = bal; }
        }
        resolved.set(largest, (resolved.get(largest) ?? 0n) + dust);
      }
      console.log(`  ${name}: redistributed to ${resolved.size} holders (dust: ${dust})`);
    }
  }

  return resolved;
}

// ─── Run ───────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
