/**
 * Stream Recovery Snapshot Script
 *
 * Takes a snapshot of all stkscUSD and stkscETH holders on Sonic,
 * resolves Trevee's own contracts (veUSD/veETH via NFT locks,
 * wstkscUSD/wstkscETH via ERC20 pro-rata, withdraw queues),
 * and outputs an entitlement list.
 *
 * Third-party protocol contracts (Silo, Pendle, Euler, dLEND, Morpho,
 * Spectra, Royco, AMM pools) that hold wstksc tokens will appear in
 * the output with their pro-rata share of the underlying stksc.
 * Each protocol handles sub-distribution to their depositors.
 *
 * Usage:
 *   npx tsx scripts/snapshot.ts [--block <blockNumber>]
 *
 * Output:
 *   scripts/output/snapshot-<block>.json
 */

import { createPublicClient, http, parseAbi } from "viem";
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
const VEETH = "0x1Ec2b9a77A7226ACD457954820197F89B3E3a578" as const;
const WSTKSCETH = "0xE8a41c62BB4d5863C6eadC96792cFE90A1f37C47" as const;
const STKSCETH_WITHDRAW_QUEUE = "0x65b6AFB8C1521B48488dF04224Dc019Ea390E133" as const;

// Trevee contracts that directly hold stksc tokens (resolved to depositors)
const USD_TREVEE_CONTRACTS = new Set([
  VEUSD.toLowerCase(),
  WSTKSCUSD.toLowerCase(),
  STKSCUSD_WITHDRAW_QUEUE.toLowerCase(),
]);

const ETH_TREVEE_CONTRACTS = new Set([
  VEETH.toLowerCase(),
  WSTKSCETH.toLowerCase(),
  STKSCETH_WITHDRAW_QUEUE.toLowerCase(),
]);

// Known third-party protocol contracts (for labeling in output only).
// These hold wstksc tokens and will receive their pro-rata share of stksc.
// Each protocol handles sub-distribution to their depositors.
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
  "0xd6bbab428240c6a4e093e13802f2eca3e9f0de7d": "Morpho Blue",
  "0x05cf0c7ed39fc2ed0bd4397716ebb02f74ff25b5": "CL Pool wstkscETH",
  "0x286cc998298d9d0242c9ad30cdb587e0b2f59f22": "CL Pool stkscETH",
  "0xfb9f97e08f6bdca19353cacaf3e542e461686041": "9mm V2 LP",
};

// ─── ABIs ──────────────────────────────────────────────────────────────

const ERC20_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

// VotingEscrow (ve(3,3) NFT) ABI — veUSD and veETH are NOT ERC20s.
// balanceOf(address) returns NFT count, NOT token amount.
// Must use locked(tokenId) for actual deposited amounts.
const VE_NFT_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "function locked(uint256 tokenId) view returns (int128 amount, uint256 end)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function supply() view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
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
    label?: string;
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

  // Step 3: Resolve Trevee contracts (veUSD/veETH via NFT locks, wstksc via ERC20, withdraw queues)
  // Third-party protocol contracts stay in the entitlement list for protocols to handle.
  console.log("\n🔄 Step 3: Resolving Trevee contract holdings...");

  const resolvedUSD = await resolveContractHoldings(
    client,
    usdNonZero,
    USD_TREVEE_CONTRACTS,
    [
      { contract: VEUSD, name: "veUSD", type: "ve-nft" as const },
      { contract: WSTKSCUSD, name: "wstkscUSD", type: "erc20" as const },
      { contract: STKSCUSD_WITHDRAW_QUEUE, name: "stkscUSD Withdraw Queue", type: "erc20" as const },
    ],
    block
  );

  const resolvedETH = await resolveContractHoldings(
    client,
    ethNonZero,
    ETH_TREVEE_CONTRACTS,
    [
      { contract: VEETH, name: "veETH", type: "ve-nft" as const },
      { contract: WSTKSCETH, name: "wstkscETH", type: "erc20" as const },
      { contract: STKSCETH_WITHDRAW_QUEUE, name: "stkscETH Withdraw Queue", type: "erc20" as const },
    ],
    block
  );

  // Log protocol contracts that remain in the entitlements (for protocols to handle)
  const protocolEntries: string[] = [];
  for (const [addr, label] of Object.entries(PROTOCOL_LABELS)) {
    const usd = resolvedUSD.get(addr) ?? 0n;
    const eth = resolvedETH.get(addr) ?? 0n;
    if (usd > 0n || eth > 0n) {
      const usdStr = usd > 0n ? `${(Number(usd) / 1e6).toFixed(2)} stkscUSD` : "";
      const ethStr = eth > 0n ? `${(Number(eth) / 1e18).toFixed(4)} stkscETH` : "";
      protocolEntries.push(`    ${label}: ${[usdStr, ethStr].filter(Boolean).join(", ")}`);
    }
  }
  if (protocolEntries.length > 0) {
    console.log(`\n📋 Protocol contracts in entitlement list (sub-distribution by protocol):`);
    protocolEntries.forEach((e) => console.log(e));
  }

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
      veUSD_holders: resolvedUSD.size,
      wstkscUSD_holders: 0, // TODO: track per-contract counts
      stkscUSD_withdrawQueue_holders: 0,
      veETH_holders: resolvedETH.size,
      wstkscETH_holders: 0,
      stkscETH_withdrawQueue_holders: 0,
    },
    entitlements: entitlements.map((e) => {
      const label = PROTOCOL_LABELS[e.address];
      return {
        address: e.address,
        ...(label ? { label } : {}),
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
      };
    }),
  };

  // Sanity check: sum of all entitlements should equal total supply
  const usdSum = entitlements.reduce((acc, e) => acc + e.stkscUSD, 0n);
  const ethSum = entitlements.reduce((acc, e) => acc + e.stkscETH, 0n);
  console.log(`\n✅ Sanity checks:`);
  console.log(`  stkscUSD: sum=${usdSum} totalSupply=${usdTotalSupply} match=${usdSum === usdTotalSupply}`);
  console.log(`  stkscETH: sum=${ethSum} totalSupply=${ethTotalSupply} match=${ethSum === ethTotalSupply}`);

  if (usdSum !== usdTotalSupply || ethSum !== ethTotalSupply) {
    console.error("❌ FATAL: Entitlement sum does not match total supply. Aborting.");
    console.error(`  stkscUSD diff: ${usdSum - usdTotalSupply}`);
    console.error(`  stkscETH diff: ${ethSum - ethTotalSupply}`);
    process.exit(1);
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
 * to the underlying depositors.
 *
 * Two resolution strategies:
 *   - "erc20": Standard ERC20 wrapper (wstkscUSD, wstkscETH).
 *     share = depositorBalance / contractTotalSupply
 *     userEntitlement += share * contractBalance
 *
 *   - "ve-nft": Velodrome-style VotingEscrow NFT (veUSD, veETH).
 *     These are ERC721s where balanceOf(address) returns NFT count, NOT token amount.
 *     Must enumerate all token IDs, call locked(tokenId) for actual deposit,
 *     and ownerOf(tokenId) for the owner.
 */
async function resolveContractHoldings(
  client: ReturnType<typeof createPublicClient>,
  directBalances: Map<string, bigint>,
  contractSet: Set<string>,
  contracts: Array<{ contract: `0x${string}`; name: string; type: "erc20" | "ve-nft" }>,
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
  for (const { contract, name, type } of contracts) {
    const contractBalance = directBalances.get(contract.toLowerCase());
    if (!contractBalance || contractBalance === 0n) {
      console.log(`  ${name}: no balance, skipping`);
      continue;
    }

    console.log(`  ${name} (${type}): resolving ${contractBalance.toString()} across depositors...`);

    if (type === "ve-nft") {
      // ── VotingEscrow NFT resolution ──
      // Enumerate all token IDs via Transfer events, then read locked(tokenId) + ownerOf(tokenId)
      const { resolvedCount, resolvedSum } = await resolveVeNftHoldings(
        client, contract, name, contractBalance, resolved, block
      );
      console.log(`  ${name}: resolved to ${resolvedCount} depositors, sum=${resolvedSum}`);

      // Sanity check: resolved sum should closely match contractBalance
      // Any difference is rounding dust from locked amounts vs actual stksc balance
      const veGap = contractBalance - resolvedSum;
      if (veGap > 0n) {
        console.log(`  ${name}: ${veGap} unresolved (locked amounts < contract stksc balance)`);
        // This gap means some stksc sits in the ve contract but isn't in any active lock
        // (e.g., unlocked but not yet withdrawn). Redistribute pro-rata.
        unresolvableBalances.push({ name: `${name} (unlocked gap)`, balance: veGap });
      } else if (veGap < 0n) {
        console.warn(`  ⚠️  ${name}: resolved MORE than contract balance by ${-veGap}! Investigate.`);
      }
    } else {
      // ── ERC20 wrapper resolution ──
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
        console.log(`  ${name}: not an ERC20 (totalSupply reverted), will redistribute pro-rata`);
        unresolvableBalances.push({ name, balance: contractBalance });
        continue;
      }

      if (wrapperTotalSupply === 0n) {
        console.log(`  ${name}: total supply is 0, will redistribute pro-rata`);
        unresolvableBalances.push({ name: `${name} (totalSupply=0)`, balance: contractBalance });
        continue;
      }

      let wrapperHolders: Set<string>;
      let wrapperBalances: Map<string, bigint>;
      try {
        wrapperHolders = await getTokenHolders(client, contract, block);
        wrapperBalances = await getBalances(client, contract, wrapperHolders, block);
      } catch (e: any) {
        console.log(`  ${name}: failed to get holders/balances (${e.message?.slice(0, 80)}), will redistribute pro-rata`);
        unresolvableBalances.push({ name: `${name} (holder scan failed)`, balance: contractBalance });
        continue;
      }

      if (wrapperHolders.size === 0) {
        console.log(`  ${name}: no holder events found, will redistribute pro-rata`);
        unresolvableBalances.push({ name: `${name} (no holders)`, balance: contractBalance });
        continue;
      }

      let resolvedCount = 0;
      let resolvedSum = 0n;

      for (const [depositor, wrapperBalance] of wrapperBalances) {
        if (wrapperBalance === 0n) continue;

        const entitlement = (wrapperBalance * contractBalance) / wrapperTotalSupply;
        if (entitlement === 0n) continue;

        const existing = resolved.get(depositor) ?? 0n;
        resolved.set(depositor, existing + entitlement);
        resolvedSum += entitlement;
        resolvedCount++;
      }

      if (resolvedCount === 0) {
        console.log(`  ${name}: all holder balances are 0, will redistribute pro-rata`);
        unresolvableBalances.push({ name: `${name} (zero balances)`, balance: contractBalance });
        continue;
      }

      // Handle rounding dust
      const dust = contractBalance - resolvedSum;
      if (dust > 0n && resolvedCount > 0) {
        const firstDepositor = [...wrapperBalances.entries()].find(([, b]) => b > 0n)?.[0];
        if (firstDepositor) {
          resolved.set(firstDepositor, (resolved.get(firstDepositor) ?? 0n) + dust);
        }
      }

      console.log(`  ${name}: resolved to ${resolvedCount} depositors (dust: ${dust})`);
    }
  }

  // Redistribute unresolvable contract balances pro-rata to all resolved holders
  if (unresolvableBalances.length > 0) {
    for (const { name, balance } of unresolvableBalances) {
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

/**
 * Resolve a VotingEscrow (ve(3,3)) NFT contract's holdings.
 *
 * These are ERC721 contracts where:
 *   - Each lock is a token ID (NFT)
 *   - locked(tokenId) returns (int128 amount, uint256 end) — the actual deposited amount
 *   - ownerOf(tokenId) returns the owner address
 *   - balanceOf(address) returns NFT count (NOT token amount)
 *   - supply() returns total locked tokens (NOT totalSupply which is decayed voting power)
 *
 * We enumerate all token IDs via Transfer events, then read locked() + ownerOf() for each.
 */
async function resolveVeNftHoldings(
  client: ReturnType<typeof createPublicClient>,
  veContract: `0x${string}`,
  name: string,
  contractStkscBalance: bigint,
  resolved: Map<string, bigint>,
  block: bigint
): Promise<{ resolvedCount: number; resolvedSum: bigint }> {
  // Step 1: Get all token IDs ever minted via Transfer events (from address(0))
  console.log(`    ${name}: scanning Transfer events for minted token IDs...`);
  const tokenIds = new Set<bigint>();

  const BATCH_SIZE = 50000n;
  let fromBlock = TOKEN_DEPLOY_BLOCK;

  while (fromBlock <= block) {
    const toBlock = fromBlock + BATCH_SIZE > block ? block : fromBlock + BATCH_SIZE;

    try {
      const logs = await withRetry(() =>
        client.getLogs({
          address: veContract,
          event: {
            type: "event",
            name: "Transfer",
            inputs: [
              { type: "address", name: "from", indexed: true },
              { type: "address", name: "to", indexed: true },
              { type: "uint256", name: "tokenId", indexed: true },
            ],
          },
          fromBlock,
          toBlock,
          args: {
            from: "0x0000000000000000000000000000000000000000" as `0x${string}`,
          },
        })
      );

      for (const log of logs) {
        if (log.args.tokenId !== undefined) {
          tokenIds.add(log.args.tokenId);
        }
      }
    } catch (e: any) {
      if (e.message?.includes("Log response size exceeded") || e.message?.includes("range")) {
        const mid = fromBlock + (toBlock - fromBlock) / 2n;
        // Smaller range - retry both halves
        const getLogs = async (from: bigint, to: bigint) => {
          const logs = await withRetry(() =>
            client.getLogs({
              address: veContract,
              event: {
                type: "event",
                name: "Transfer",
                inputs: [
                  { type: "address", name: "from", indexed: true },
                  { type: "address", name: "to", indexed: true },
                  { type: "uint256", name: "tokenId", indexed: true },
                ],
              },
              fromBlock: from,
              toBlock: to,
              args: {
                from: "0x0000000000000000000000000000000000000000" as `0x${string}`,
              },
            })
          );
          for (const log of logs) {
            if (log.args.tokenId !== undefined) tokenIds.add(log.args.tokenId);
          }
        };
        await getLogs(fromBlock, mid);
        await getLogs(mid + 1n, toBlock);
      } else {
        throw e;
      }
    }

    fromBlock = toBlock + 1n;
  }

  console.log(`    ${name}: found ${tokenIds.size} minted token IDs`);

  // Step 2: For each token ID, get locked(tokenId) and ownerOf(tokenId) at snapshot block
  const tokenIdArray = Array.from(tokenIds);
  const QUERY_BATCH = 20;
  const DELAY_MS = 100;

  let resolvedCount = 0;
  let resolvedSum = 0n;
  let skippedZeroLock = 0;
  let skippedZeroOwner = 0;

  for (let i = 0; i < tokenIdArray.length; i += QUERY_BATCH) {
    const batch = tokenIdArray.slice(i, i + QUERY_BATCH);

    const results = await withRetry(async () => {
      return Promise.all(
        batch.map(async (tokenId) => {
          const [lockedResult, owner] = await Promise.all([
            client.readContract({
              address: veContract,
              abi: VE_NFT_ABI,
              functionName: "locked",
              args: [tokenId],
              blockNumber: block,
            }),
            client.readContract({
              address: veContract,
              abi: VE_NFT_ABI,
              functionName: "ownerOf",
              args: [tokenId],
              blockNumber: block,
            }),
          ]);
          return { tokenId, lockedAmount: lockedResult[0], lockEnd: lockedResult[1], owner };
        })
      );
    });

    for (const { lockedAmount, owner } of results) {
      // locked returns int128 — convert to bigint (always positive for active locks)
      const amount = BigInt(lockedAmount);
      if (amount <= 0n) {
        skippedZeroLock++;
        continue;
      }

      const ownerAddr = owner.toLowerCase();
      if (ownerAddr === "0x0000000000000000000000000000000000000000") {
        // NFT burned or withdrawn — lock should be 0 but just in case
        skippedZeroOwner++;
        continue;
      }

      const existing = resolved.get(ownerAddr) ?? 0n;
      resolved.set(ownerAddr, existing + amount);
      resolvedSum += amount;
      resolvedCount++;
    }

    if (i % (QUERY_BATCH * 5) === 0 || i + QUERY_BATCH >= tokenIdArray.length) {
      process.stdout.write(`    ${name}: processed ${Math.min(i + QUERY_BATCH, tokenIdArray.length)}/${tokenIdArray.length} token IDs\r`);
    }

    if (i + QUERY_BATCH < tokenIdArray.length) {
      await sleep(DELAY_MS);
    }
  }

  process.stdout.write("\n");
  console.log(`    ${name}: ${skippedZeroLock} zero-lock, ${skippedZeroOwner} burned/withdrawn`);

  return { resolvedCount, resolvedSum };
}

// ─── Run ───────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
