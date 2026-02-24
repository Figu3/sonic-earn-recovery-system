/**
 * LP Holder Enumeration Script
 *
 * Enumerates LP holders for three protocols that need sub-distribution:
 *
 *   1. Shadow Exchange CL Pools (V3-style, no fungible LP token)
 *      - wstkscETH pool: 0x05cf0c7ed39fc2ed0bd4397716ebb02f74ff25b5
 *      - stkscETH pool:  0x286cc998298d9d0242c9ad30cdb587e0b2f59f22
 *      → Enumerate via Mint events, check positions() for current liquidity
 *
 *   2. StakeDAO Curve Pool (ERC20 LP + Gauge staking)
 *      - LP Token:        0xA1A0eCcCD628A70434221e3e5f832517E97A697C
 *      - Gauge:           0x175FfDDd16515A64d46415dd7E935E4B4fA7D710
 *      - Locker Gateway:  0x52f541764E6e90eeBc5c21Ff570De0e2D63766B6
 *      → Enumerate via Transfer events on both LP and Gauge, check balanceOf()
 *
 *   3. Euler/MeV (from verified CSV — no on-chain scanning needed)
 *      - ewstkscETH-1 vault: 0x05d57366b862022f76fe93316e81e9f24218bbfc
 *      → Parse CSV, compute pro-rata shares
 *
 * Usage:
 *   npx tsx scripts/enumerate-lp-holders.ts [--block <blockNumber>]
 *
 * Output:
 *   scripts/output/lp-holders.json
 */

import { createPublicClient, http, parseAbi, keccak256, encodePacked, getAddress } from "viem";
import { sonic } from "viem/chains";
import * as fs from "fs";
import * as path from "path";

// ─── Config ────────────────────────────────────────────────────────────

const SONIC_RPC = "https://rpc.soniclabs.com";
const TOKEN_DEPLOY_BLOCK = 590000n;

// Shadow CL Pool addresses
const SHADOW_WSTKSCETH_POOL = "0x05cf0c7ed39fc2ed0bd4397716ebb02f74ff25b5" as const;
const SHADOW_STKSCETH_POOL = "0x286cc998298d9d0242c9ad30cdb587e0b2f59f22" as const;

// StakeDAO addresses
const STAKEDAO_CURVE_LP = "0xA1A0eCcCD628A70434221e3e5f832517E97A697C" as const;
const STAKEDAO_GAUGE = "0x175FfDDd16515A64d46415dd7E935E4B4fA7D710" as const;
const STAKEDAO_LOCKER_GATEWAY = "0x52f541764E6e90eeBc5c21Ff570De0e2D63766B6" as const;
const STAKEDAO_VAULT = "0xBEfDFd5b87ECc71CD72cC84BcfFE8F0b3daE4771" as const;

// Euler vault address (for label)
const EULER_VAULT = "0x05d57366b862022f76fe93316e81e9f24218bbfc" as const;

// CSV path for Euler/MeV depositors
const EULER_CSV_PATH = "/Users/figue/Downloads/wstkscETH _vault_claim.csv";

// ─── ABIs ──────────────────────────────────────────────────────────────

const ERC20_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

// Shadow V3-style pool positions: positions(bytes32 key) → (liquidity, ...)
// Key = keccak256(abi.encodePacked(owner, tickLower, tickUpper))
const SHADOW_POOL_ABI = parseAbi([
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function positions(bytes32) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);

// Mint event for V3-style pools — we need to get owner from topic
// event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)
const V3_MINT_EVENT = {
  type: "event" as const,
  name: "Mint" as const,
  inputs: [
    { type: "address", name: "sender", indexed: false },
    { type: "address", name: "owner", indexed: true },
    { type: "int24", name: "tickLower", indexed: true },
    { type: "int24", name: "tickUpper", indexed: true },
    { type: "uint128", name: "amount", indexed: false },
    { type: "uint256", name: "amount0", indexed: false },
    { type: "uint256", name: "amount1", indexed: false },
  ],
};

// ─── Types ─────────────────────────────────────────────────────────────

interface V3Position {
  owner: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

interface LPHolder {
  address: string;
  balance: string;      // Raw balance (LP tokens or liquidity units)
  sharePct: string;     // Human-readable percentage of pool
}

interface ProtocolHolders {
  protocol: string;
  contractAddress: string;
  tokenType: string;    // "stkscETH" | "stkscUSD" | "wstkscETH" | "wstkscUSD"
  totalLiquidity: string;
  holders: LPHolder[];
}

// ─── Helpers ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
        process.stdout.write(
          `  ⏳ Rate limited, retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 1}/${maxRetries})...\n`
        );
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
  throw new Error("Unreachable");
}

// ─── Shadow V3 Pool Enumeration ────────────────────────────────────────

async function enumerateShadowPositions(
  client: ReturnType<typeof createPublicClient>,
  poolAddress: `0x${string}`,
  poolName: string,
  block: bigint
): Promise<V3Position[]> {
  console.log(`\n🔍 Scanning Mint events for ${poolName} (${poolAddress})...`);

  const positions = new Map<string, V3Position>(); // key → position
  const BATCH_SIZE = 50000n;
  let fromBlock = TOKEN_DEPLOY_BLOCK;
  let eventCount = 0;

  while (fromBlock <= block) {
    const toBlock = fromBlock + BATCH_SIZE > block ? block : fromBlock + BATCH_SIZE;

    try {
      const logs = await withRetry(() =>
        client.getLogs({
          address: poolAddress,
          event: V3_MINT_EVENT,
          fromBlock,
          toBlock,
        })
      );

      for (const log of logs) {
        eventCount++;
        const owner = (log.args as any).owner?.toLowerCase();
        const tickLower = Number((log.args as any).tickLower);
        const tickUpper = Number((log.args as any).tickUpper);

        if (owner) {
          // Build the position key the same way the pool does
          const key = `${owner}:${tickLower}:${tickUpper}`;
          if (!positions.has(key)) {
            positions.set(key, { owner, tickLower, tickUpper, liquidity: 0n });
          }
        }
      }
    } catch (e: any) {
      // If batch too large, split in half
      if (e.message?.includes("Log response size exceeded") || e.message?.includes("range") || e.message?.includes("too large")) {
        console.log(`  ⚠️ Batch too large at ${fromBlock}-${toBlock}, splitting...`);
        const mid = fromBlock + (toBlock - fromBlock) / 2n;
        const logsA = await scanMintRange(client, poolAddress, fromBlock, mid);
        const logsB = await scanMintRange(client, poolAddress, mid + 1n, toBlock);
        for (const log of [...logsA, ...logsB]) {
          eventCount++;
          const owner = (log.args as any).owner?.toLowerCase();
          const tickLower = Number((log.args as any).tickLower);
          const tickUpper = Number((log.args as any).tickUpper);
          if (owner) {
            const key = `${owner}:${tickLower}:${tickUpper}`;
            if (!positions.has(key)) {
              positions.set(key, { owner, tickLower, tickUpper, liquidity: 0n });
            }
          }
        }
      } else {
        throw e;
      }
    }

    fromBlock = toBlock + 1n;
    const pct = Number((fromBlock - TOKEN_DEPLOY_BLOCK) * 100n / (block - TOKEN_DEPLOY_BLOCK));
    process.stdout.write(`  ... scanned up to block ${fromBlock} (${pct}%) — ${eventCount} Mint events\r`);
  }

  console.log(`\n  Found ${positions.size} unique position keys from ${eventCount} Mint events`);

  // Now query current liquidity for each position
  console.log(`  Querying current liquidity for ${positions.size} positions...`);

  const positionArray = Array.from(positions.values());
  const QUERY_BATCH = 10;

  for (let i = 0; i < positionArray.length; i += QUERY_BATCH) {
    const batch = positionArray.slice(i, i + QUERY_BATCH);

    const results = await withRetry(() =>
      Promise.all(
        batch.map((pos) => {
          // V3 position key: keccak256(abi.encodePacked(address, int24, int24))
          const posKey = keccak256(
            encodePacked(
              ["address", "int24", "int24"],
              [pos.owner as `0x${string}`, pos.tickLower, pos.tickUpper]
            )
          );
          return client.readContract({
            address: poolAddress,
            abi: SHADOW_POOL_ABI,
            functionName: "positions",
            args: [posKey],
            blockNumber: block,
          });
        })
      )
    );

    for (let j = 0; j < batch.length; j++) {
      const [liquidity] = results[j] as [bigint, bigint, bigint, bigint, bigint];
      batch[j].liquidity = liquidity;
    }

    if (i + QUERY_BATCH < positionArray.length) {
      await sleep(100);
    }
  }

  // Filter to non-zero liquidity positions
  const active = positionArray.filter((p) => p.liquidity > 0n);
  console.log(`  Active positions with liquidity > 0: ${active.length}`);

  return active;
}

async function scanMintRange(
  client: ReturnType<typeof createPublicClient>,
  poolAddress: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint
): Promise<any[]> {
  return withRetry(() =>
    client.getLogs({
      address: poolAddress,
      event: V3_MINT_EVENT,
      fromBlock,
      toBlock,
    })
  );
}

function aggregateShadowHolders(positions: V3Position[]): { holders: LPHolder[]; totalLiquidity: bigint } {
  // Aggregate by owner
  const ownerLiquidity = new Map<string, bigint>();
  for (const pos of positions) {
    const current = ownerLiquidity.get(pos.owner) ?? 0n;
    ownerLiquidity.set(pos.owner, current + pos.liquidity);
  }

  const totalLiquidity = positions.reduce((sum, p) => sum + p.liquidity, 0n);

  const holders: LPHolder[] = [];
  for (const [addr, liq] of ownerLiquidity) {
    const sharePct = totalLiquidity > 0n
      ? (Number(liq * 10000n / totalLiquidity) / 100).toFixed(2)
      : "0.00";
    holders.push({
      address: addr,
      balance: liq.toString(),
      sharePct: `${sharePct}%`,
    });
  }

  holders.sort((a, b) => {
    const aVal = BigInt(a.balance);
    const bVal = BigInt(b.balance);
    return bVal > aVal ? 1 : bVal < aVal ? -1 : 0;
  });

  return { holders, totalLiquidity };
}

// ─── StakeDAO Gauge/LP Enumeration ──────────────────────────────────────

async function enumerateStakeDAOHolders(
  client: ReturnType<typeof createPublicClient>,
  block: bigint
): Promise<{ lpHolders: LPHolder[]; gaugeHolders: LPHolder[]; totalLP: bigint; totalGauge: bigint }> {
  console.log(`\n🔍 Scanning StakeDAO Curve LP + Gauge holders...`);

  // Scan Transfer events for BOTH the LP token and the Gauge token
  const [lpAddresses, gaugeAddresses] = await Promise.all([
    scanTransferRecipients(client, STAKEDAO_CURVE_LP, block, "Curve LP"),
    scanTransferRecipients(client, STAKEDAO_GAUGE, block, "Gauge"),
  ]);

  // Get LP balances
  console.log(`\n  Querying LP balances for ${lpAddresses.size} addresses...`);
  const lpBalances = await getBalancesBatch(client, STAKEDAO_CURVE_LP, lpAddresses, block);

  // Get Gauge balances
  console.log(`  Querying Gauge balances for ${gaugeAddresses.size} addresses...`);
  const gaugeBalances = await getBalancesBatch(client, STAKEDAO_GAUGE, gaugeAddresses, block);

  // Get totals
  const totalLP = await withRetry(() =>
    client.readContract({ address: STAKEDAO_CURVE_LP, abi: ERC20_ABI, functionName: "totalSupply", blockNumber: block })
  );
  const totalGauge = await withRetry(() =>
    client.readContract({ address: STAKEDAO_GAUGE, abi: ERC20_ABI, functionName: "totalSupply", blockNumber: block })
  );

  // Build LP holder list (exclude gauge and known contracts)
  const lpHolders: LPHolder[] = [];
  for (const [addr, bal] of lpBalances) {
    if (bal <= 0n) continue;
    // Skip the gauge contract itself (it holds LP tokens as backing for gauge tokens)
    if (addr === STAKEDAO_GAUGE.toLowerCase()) continue;
    const sharePct = totalLP > 0n
      ? (Number(bal * 10000n / totalLP) / 100).toFixed(2)
      : "0.00";
    lpHolders.push({ address: addr, balance: bal.toString(), sharePct: `${sharePct}%` });
  }

  // Build Gauge holder list
  const gaugeHolders: LPHolder[] = [];
  for (const [addr, bal] of gaugeBalances) {
    if (bal <= 0n) continue;
    const sharePct = totalGauge > 0n
      ? (Number(bal * 10000n / totalGauge) / 100).toFixed(2)
      : "0.00";
    gaugeHolders.push({ address: addr, balance: bal.toString(), sharePct: `${sharePct}%` });
  }

  lpHolders.sort((a, b) => BigInt(b.balance) > BigInt(a.balance) ? 1 : -1);
  gaugeHolders.sort((a, b) => BigInt(b.balance) > BigInt(a.balance) ? 1 : -1);

  console.log(`\n  LP holders (not in gauge): ${lpHolders.length}`);
  console.log(`  Gauge stakers: ${gaugeHolders.length}`);
  console.log(`  Total LP supply: ${totalLP}`);
  console.log(`  Total Gauge supply: ${totalGauge}`);

  return { lpHolders, gaugeHolders, totalLP, totalGauge };
}

async function scanTransferRecipients(
  client: ReturnType<typeof createPublicClient>,
  token: `0x${string}`,
  block: bigint,
  label: string
): Promise<Set<string>> {
  const holders = new Set<string>();
  const BATCH_SIZE = 50000n;
  let fromBlock = TOKEN_DEPLOY_BLOCK;
  let eventCount = 0;

  console.log(`  Scanning ${label} Transfer events...`);

  while (fromBlock <= block) {
    const toBlock = fromBlock + BATCH_SIZE > block ? block : fromBlock + BATCH_SIZE;

    try {
      const logs = await withRetry(() =>
        client.getLogs({
          address: token,
          event: {
            type: "event" as const,
            name: "Transfer" as const,
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

      eventCount += logs.length;
      for (const log of logs) {
        if (log.args.to) holders.add(log.args.to.toLowerCase());
      }
    } catch (e: any) {
      if (e.message?.includes("Log response size exceeded") || e.message?.includes("range") || e.message?.includes("too large")) {
        console.log(`  ⚠️ Batch too large, splitting ${fromBlock}-${toBlock}...`);
        const mid = fromBlock + (toBlock - fromBlock) / 2n;
        const logSets = await Promise.all([
          scanTransferRange(client, token, fromBlock, mid),
          scanTransferRange(client, token, mid + 1n, toBlock),
        ]);
        for (const logs of logSets) {
          eventCount += logs.length;
          for (const log of logs) {
            if (log.args.to) holders.add(log.args.to.toLowerCase());
          }
        }
      } else {
        throw e;
      }
    }

    fromBlock = toBlock + 1n;
  }

  console.log(`    ${label}: ${holders.size} unique recipients from ${eventCount} Transfer events`);
  return holders;
}

async function scanTransferRange(
  client: ReturnType<typeof createPublicClient>,
  token: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint
): Promise<any[]> {
  return withRetry(() =>
    client.getLogs({
      address: token,
      event: {
        type: "event" as const,
        name: "Transfer" as const,
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
}

async function getBalancesBatch(
  client: ReturnType<typeof createPublicClient>,
  token: `0x${string}`,
  holders: Set<string>,
  block: bigint
): Promise<Map<string, bigint>> {
  const balances = new Map<string, bigint>();
  const addresses = Array.from(holders);
  const BATCH_SIZE = 20;
  const DELAY_MS = 100;

  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const batch = addresses.slice(i, i + BATCH_SIZE);

    const results = await withRetry(async () =>
      Promise.all(
        batch.map((addr) =>
          client.readContract({
            address: token,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [addr as `0x${string}`],
            blockNumber: block,
          })
        )
      )
    );

    for (let j = 0; j < batch.length; j++) {
      balances.set(batch[j], results[j]);
    }

    if (i + BATCH_SIZE < addresses.length) {
      await sleep(DELAY_MS);
    }
  }

  return balances;
}

// ─── Euler/MeV CSV Parsing ─────────────────────────────────────────────

function parseEulerCSV(): LPHolder[] {
  console.log(`\n📂 Parsing Euler/MeV depositor CSV...`);

  const csvContent = fs.readFileSync(EULER_CSV_PATH, "utf-8");
  const lines = csvContent.trim().split("\n");
  const headers = lines[0].split(",");

  const depositors: { address: string; shareBalance: bigint }[] = [];
  let totalShares = 0n;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const address = cols[0].toLowerCase();
    const shareBalance = BigInt(cols[1]); // share_balance column

    depositors.push({ address, shareBalance });
    totalShares += shareBalance;
  }

  console.log(`  Found ${depositors.length} depositors, total shares: ${totalShares}`);

  const holders: LPHolder[] = depositors.map((d) => {
    const sharePct = totalShares > 0n
      ? (Number(d.shareBalance * 10000n / totalShares) / 100).toFixed(2)
      : "0.00";
    return {
      address: d.address,
      balance: d.shareBalance.toString(),
      sharePct: `${sharePct}%`,
    };
  });

  holders.sort((a, b) => BigInt(b.balance) > BigInt(a.balance) ? 1 : -1);
  return holders;
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
  console.log(`📸 Enumerating LP holders at block ${block}`);

  const results: ProtocolHolders[] = [];

  // ─── 1. Shadow CL Pools ───
  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  SHADOW EXCHANGE CL POOLS");
  console.log("════════════════════════════════════════════════════════════");

  // Shadow wstkscETH pool
  const wstkscEthPositions = await enumerateShadowPositions(
    client,
    SHADOW_WSTKSCETH_POOL,
    "Shadow CL wstkscETH/scETH",
    block
  );
  const wstkscEthAgg = aggregateShadowHolders(wstkscEthPositions);

  console.log(`\n  Shadow wstkscETH Pool LP Holders:`);
  for (const h of wstkscEthAgg.holders) {
    console.log(`    ${h.address}: ${h.sharePct} (liquidity: ${h.balance})`);
  }

  results.push({
    protocol: "Shadow CL wstkscETH",
    contractAddress: SHADOW_WSTKSCETH_POOL,
    tokenType: "wstkscETH",
    totalLiquidity: wstkscEthAgg.totalLiquidity.toString(),
    holders: wstkscEthAgg.holders,
  });

  // Shadow stkscETH pool
  const stkscEthPositions = await enumerateShadowPositions(
    client,
    SHADOW_STKSCETH_POOL,
    "Shadow CL stkscETH/scETH",
    block
  );
  const stkscEthAgg = aggregateShadowHolders(stkscEthPositions);

  console.log(`\n  Shadow stkscETH Pool LP Holders:`);
  for (const h of stkscEthAgg.holders) {
    console.log(`    ${h.address}: ${h.sharePct} (liquidity: ${h.balance})`);
  }

  results.push({
    protocol: "Shadow CL stkscETH",
    contractAddress: SHADOW_STKSCETH_POOL,
    tokenType: "stkscETH",
    totalLiquidity: stkscEthAgg.totalLiquidity.toString(),
    holders: stkscEthAgg.holders,
  });

  // ─── 2. StakeDAO Curve Pool ───
  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  STAKEDAO CURVE POOL");
  console.log("════════════════════════════════════════════════════════════");

  const stakeDAO = await enumerateStakeDAOHolders(client, block);

  // Compute effective shares: LP holders get direct share, gauge stakers get
  // their gauge share × (gaugeLP / totalLP).
  // Total LP supply = LP not-in-gauge + LP in gauge = totalLP
  // Gauge holds some amount of LP. Each gauge staker's effective LP =
  //   gaugeStakerBalance / gaugeTotalSupply * gaugeHeldLP

  const gaugeLPBalance = await withRetry(() =>
    client.readContract({
      address: STAKEDAO_CURVE_LP,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [STAKEDAO_GAUGE],
      blockNumber: block,
    })
  );

  console.log(`\n  Gauge holds ${gaugeLPBalance} LP tokens of ${stakeDAO.totalLP} total`);

  // Merge all holders into effective LP shares
  const effectiveLP = new Map<string, bigint>();

  // Direct LP holders (not gauge)
  for (const h of stakeDAO.lpHolders) {
    const addr = h.address;
    const bal = BigInt(h.balance);
    effectiveLP.set(addr, (effectiveLP.get(addr) ?? 0n) + bal);
  }

  // Gauge stakers — convert gauge tokens to effective LP
  for (const h of stakeDAO.gaugeHolders) {
    const addr = h.address;
    const gaugeBalance = BigInt(h.balance);
    // effective LP = gaugeBalance * gaugeLPBalance / gaugeTotalSupply
    const effectiveBal = stakeDAO.totalGauge > 0n
      ? (gaugeBalance * gaugeLPBalance) / stakeDAO.totalGauge
      : 0n;
    effectiveLP.set(addr, (effectiveLP.get(addr) ?? 0n) + effectiveBal);
  }

  // Total effective LP
  let totalEffective = 0n;
  for (const [, bal] of effectiveLP) {
    totalEffective += bal;
  }

  const stakeDAOHolders: LPHolder[] = [];
  for (const [addr, bal] of effectiveLP) {
    if (bal <= 0n) continue;
    const sharePct = totalEffective > 0n
      ? (Number(bal * 10000n / totalEffective) / 100).toFixed(2)
      : "0.00";
    stakeDAOHolders.push({ address: addr, balance: bal.toString(), sharePct: `${sharePct}%` });
  }

  stakeDAOHolders.sort((a, b) => BigInt(b.balance) > BigInt(a.balance) ? 1 : -1);

  console.log(`\n  StakeDAO Effective LP Holders (LP + Gauge combined):`);
  for (const h of stakeDAOHolders) {
    const effective = BigInt(h.balance);
    const formattedWstksc = (Number(effective) / 1e18).toFixed(6);
    console.log(`    ${h.address}: ${h.sharePct} (effective LP: ${formattedWstksc})`);
  }

  results.push({
    protocol: "StakeDAO Curve wstkscUSD",
    contractAddress: STAKEDAO_CURVE_LP,
    tokenType: "wstkscUSD",
    totalLiquidity: totalEffective.toString(),
    holders: stakeDAOHolders,
  });

  // ─── 3. Euler/MeV ───
  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  EULER/MEV VAULT DEPOSITORS");
  console.log("════════════════════════════════════════════════════════════");

  const eulerHolders = parseEulerCSV();

  let eulerTotal = 0n;
  for (const h of eulerHolders) {
    eulerTotal += BigInt(h.balance);
  }

  console.log(`\n  Euler ewstkscETH-1 Depositors:`);
  for (const h of eulerHolders) {
    const bal = BigInt(h.balance);
    const formatted = (Number(bal) / 1e18).toFixed(6);
    console.log(`    ${h.address}: ${h.sharePct} (shares: ${formatted})`);
  }

  results.push({
    protocol: "Euler ewstkscETH-1",
    contractAddress: EULER_VAULT,
    tokenType: "wstkscETH",
    totalLiquidity: eulerTotal.toString(),
    holders: eulerHolders,
  });

  // ─── Write Output ───
  const scriptDir = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
  const outputDir = path.join(scriptDir, "output");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "lp-holders.json");

  const output = {
    snapshotBlock: Number(block),
    timestamp: new Date().toISOString(),
    protocols: results,
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n📁 LP holders written to: ${outputPath}`);

  // ─── Summary ───
  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("════════════════════════════════════════════════════════════");
  for (const r of results) {
    console.log(`  ${r.protocol}: ${r.holders.length} holders`);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
