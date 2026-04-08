// Build Round 0v2 V2.1 Merkle trees — TRUE RAW REBUILD from snapshot-63645527.json.
//
// Fixes applied vs the broken V2 trees:
//   (1) Undo WQ pro-rata footgun (snapshot.ts L575): scale every entitlement
//       down by (totalSupply - WQ_balance) / totalSupply.
//   (2) Add 40 WQ users (11 ETH, 29 USD) at their real pending shares
//       from withdraw-queue-resolved.json.
//   (3) Sub-distribute 9mm V2 LP pool → 7 LP holders (new, from 9mm-resolved.json).
//   (4) Exclude Shadow CL × 2 pools as dust (drop leaves; funds stay in V2.1
//       and are rescued back to admin Safe separately).
//   (5) Re-apply existing PROTOCOL_REDIRECTS and PROTOCOL_SUB_DISTRIBUTIONS
//       on the scaled (pre-footgun) balances, so targets / sub-dist holders
//       are no longer over-credited.
//   (6) Scale merkle-round1-{usdc,weth}.json amounts down by the same factor
//       (E5b: strip footgun contamination from the resolved depositors too).
//   (7) Drop the 76 already-claimed addresses (round0-claimed.json).
//
// Output:
//   scripts/output/merkle-round0v2-v2.1-usdc.json
//   scripts/output/merkle-round0v2-v2.1-weth.json
//   scripts/output/merkle-round0v2-v2.1-diff.json   (delta vs broken V2 trees)

import {
  keccak256,
  encodePacked,
  encodeAbiParameters,
  parseAbiParameters,
  getAddress,
} from "viem";
import * as fs from "fs";
import * as path from "path";

const OUT = (n: string) => path.join(__dirname, "output", n);
const WAD = 10n ** 18n;

// ─── Constants (snapshot block 63645527) ───────────────────────────────
const STKSC_USD_TOTAL = 9_598_873_684_061n;               // 6 dec
const STKSC_ETH_TOTAL = 1_343_502_287_372_450_260_592n;   // 18 dec
const WQ_USD_BAL      = 52_810_587_730n;                  // stkscUSD in WQ at snapshot
const WQ_ETH_BAL      = 12_200_946_941_215_199_702n;      // stkscETH in WQ at snapshot
const USDC_POT_R0     = 600_116_076_557n;
const WETH_POT_R0     = 623_066_129_877_001_393_497n;
const USDC_POT_R1     = 39_016_824_941n;
const WETH_POT_R1     = 15_646_390_759_667_050_822n;
// Original V1 pot totals (the amounts V2 was funded with).
// Kept for reference — not used as the target total anymore, see TARGET_* below.
const V1_USDC         = 370_052_027_675n;
const V1_WETH         = 342_400_797_390_971_049_123n;

// V2.1 target totals = V1 pot MINUS what was already claimed on V2 before pause.
// Derived from V2's live round state at the moment of pause (see
// scripts/output/round0-claimed-v2.json#{usdc,weth}.claimedOnChain):
//   V2 usdcClaimed = 21_163_994_087       -> TARGET_USDC = V1_USDC - claimed
//   V2 wethClaimed = 16_377_192_906_958_998_703 -> TARGET_WETH = V1_WETH - claimed
// These are also exactly the amounts the admin Safe rescued from V2 in the
// wind-down, so V2.1 can be funded 1:1 from the admin Safe with zero
// treasury top-up.
const TARGET_USDC     = 348_888_033_588n;                // V1_USDC  - 21_163_994_087
const TARGET_WETH     = 326_023_604_484_012_050_420n;    // V1_WETH  - 16_377_192_906_958_998_703

// Addresses to drop — protocol contracts resolved via merkle-round1
const ROUND1_RESOLVED_PROTOCOL_CONTRACTS = new Set(
  [
    "0x605257994ffef290c9ed8f51e0bf68b2735c17a9", // tholgar
    "0x636d9c9ac5e681f245051b84f908f6f84221390d", // relay
    "0xb0c855a7fb3716ebc1c4505218de4bf2186125ba", // eliteness equalizer
    "0x6328a2ff2e6bb164f1be2479af209a88295f54d5", // eliteness thena adapter
  ].map((a) => a.toLowerCase()),
);

// Shadow CL × 2 — excluded as dust per Phase C
const SHADOW_CL_POOLS = new Set(
  [
    "0x05cf0c7ed39fc2ed0bd4397716ebb02f74ff25b5",
    "0x286cc998298d9d0242c9ad30cdb587e0b2f59f22",
  ].map((a) => a.toLowerCase()),
);

// 9mm V2 LP pool — replaced by sub-distribution
const NINE_MM_POOL = "0xfb9f97e08f6bdca19353cacaf3e542e461686041";

// WQ contracts — safety check, should NOT appear in snapshot entitlements
const WQ_CONTRACTS = new Set([
  "0x5448a65ddb14e6f273cd0ed6598805105a39d8cc",
  "0x65b6afb8c1521b48488df04224dc019ea390e133",
]);

// ─── Embedded redirects (copied verbatim from scripts/merkle.ts) ───────
const PROTOCOL_REDIRECTS: Record<string, { target: string; label: string }> = {
  "0xe8e1a980a7fc8d47d337d704fa73fbb81ee55c25": { target: "0x4d62b6E166767988106cF7Ee8fE23E480E76FF1d", label: "Silo bwstkscETH-26" },
  "0x15641c093e566bd951c5e08e505a644478125f70": { target: "0x4d62b6E166767988106cF7Ee8fE23E480E76FF1d", label: "Silo bwstkscUSD-55" },
  "0x4e09ff794d255a123b00efa30162667a8054a845": { target: "0x4d62b6E166767988106cF7Ee8fE23E480E76FF1d", label: "Silo bwstkscUSD-23" },
  "0x916cd56a5fbbeae186f488f4db83b00c103b46e7": { target: "0x4d62b6E166767988106cF7Ee8fE23E480E76FF1d", label: "Silo bwstkscETH-other" },
  "0x64fcc3a02eeeba05ef701b7eed066c6ebd5d4e51": { target: "0x65ef8fd6168a4bc2cfebf83b0c83a8a9b7aad1f9", label: "Spectra sw-wstkscETH" },
  "0xd6bbab428240c6a4e093e13802f2eca3e9f0de7d": { target: "0x4e260eDF7f736A62Cc36c828B0C7470b33a681Ac", label: "dLEND wstkscUSD" },
  "0x10451579fd6375c8bee09f1e2c5831afde9003ed": { target: "0x4e260eDF7f736A62Cc36c828B0C7470b33a681Ac", label: "dLEND wstkscUSD (Silo)" },
  "0xf0c5f8b8715d2e54415079c5a520af5ab8858c75": { target: "0x4e260eDF7f736A62Cc36c828B0C7470b33a681Ac", label: "dLEND wstkscETH" },
  "0x896f4d49916ac5cfc36d7a260a7039ba4ea317b6": { target: "0xC328dFcD2C8450e2487a91daa9B75629075b7A43", label: "Pendle SY-wstkscUSD" },
  "0x8bb86a99f97f5d19718bd5ca0b0ca00354532ef3": { target: "0xC328dFcD2C8450e2487a91daa9B75629075b7A43", label: "Pendle SY-wstkscETH" },
  // Royco Weiroll wallets → depositor addresses
  "0x4d75d997b8f4c9fa9417202ef333cfee599496bc": { target: "0x30ef7087862f3c99242efc9633394eae629d6e9d", label: "Royco Weiroll → depositor" },
  "0xc71a94935c0be2621728b4959ace6686e85e9f70": { target: "0x1c1732e19d016f20f59ade301375b1572a0981c2", label: "Royco Weiroll → depositor" },
  "0x18573f4983e0ae137a6167fe9c67d0e3cb339db5": { target: "0xa161f191de22191bbb83f6d9f6ba1b702425a173", label: "Royco Weiroll → depositor" },
  "0x325c51df3b427c4b8620633bde2e5e7c1b635782": { target: "0x95c9b6b5d9b93bdf823526b46d0abc4c6adcdb83", label: "Royco Weiroll → depositor" },
  "0x0b89b50de40accba24d463010ce9141ad7bf6c2b": { target: "0xc25687cf9c5fdcad9ca418c9be09540b11d2ef46", label: "Royco Weiroll → depositor" },
  "0xb55fa7434b0daa3ae22735464f8783d4d28c71d9": { target: "0xc6404f24db2f573f07f3a60758765caad198c0c3", label: "Royco Weiroll → depositor" },
  "0x9099f045611f091e20a78a164af730dbc49b5f3b": { target: "0x7f6914d8d27dd810cc1f4575f5722492b999a54f", label: "Royco Weiroll → depositor" },
  "0xc18c27aaf17be2d83bbc17c1fdec5b05e62a4cc0": { target: "0x10b9f7a1435f2486324dcf6a930cfc64332a43bc", label: "Royco Weiroll → depositor" },
  "0x95600ee18096fd41d56ca619c230e59819a1e970": { target: "0x478bb542f7658d635abba67edb987806dff5b83d", label: "Royco Weiroll → depositor" },
  "0x119d69120c9940a9d8ee78a35f865d39bf08a622": { target: "0x110b099f023aed984009265752866bd6ad9a459a", label: "Royco Weiroll → depositor" },
  "0xe0c4a018c3b8d30188a318ad557140a06458aae7": { target: "0x007048da7c4c54c4b02db949eb83c7367c1c59fd", label: "Royco Weiroll → depositor" },
  "0x57b01e0bc2589f6bb14fba12112e5fb00468bab6": { target: "0x50e26bade4e2a15f7f46148e3c36e8cf11937da5", label: "Royco Weiroll → depositor" },
  "0xcbce33689057e96ab7b2158f0b2b2d73019149b1": { target: "0xf71e9ec4d7015bf50dfbe12a23d5a6071167b06e", label: "Royco Weiroll → depositor" },
  "0x4116a9df14c8fbab03fba45173aa3ce126d24a8c": { target: "0x7cb552152e2b28f9f6911c51b69b0d8d1fadafe1", label: "Royco Weiroll → depositor" },
};

interface SubDistHolder { address: string; balanceWei: string; }
interface SubDistribution { label: string; totalLiquidity: string; holders: SubDistHolder[]; }

const PROTOCOL_SUB_DISTRIBUTIONS: Record<string, SubDistribution> = {
  "0xa1a0ecccd628a70434221e3e5f832517e97a697c": {
    label: "StakeDAO Curve wstkscUSD",
    totalLiquidity: "5356424869016069636703",
    holders: [
      { address: "0xc17703c3932aa68e567ff172b55af64f963127b1", balanceWei: "5319407574631076903134" },
      { address: "0x52f541764e6e90eebc5c21ff570de0e2d63766b6", balanceWei: "17043349486928037644" },
      { address: "0x968e55af69f9f60abcc231a5a84d8a559ffb6cac", balanceWei: "15109245291089895353" },
      { address: "0x078ef0ba848ee19750daf6f06ab1af3add271efe", balanceWei: "4116774185219423158" },
      { address: "0x6faaa9071bb5b1c0ff5d37846391f6f388a7f622", balanceWei: "603127160836047132" },
      { address: "0xeda49bce2f38d284f839be1f4f2e23e6c7cc7dbd", balanceWei: "127180171484074237" },
      { address: "0xd39b2a01d4dca42f32ff52244a1b28811e40045f", balanceWei: "17569060444705917" },
      { address: "0xcd60153384818fdcb5ee9f549ffbff4fccbd037e", balanceWei: "49028990550128" },
    ],
  },
  "0x05d57366b862022f76fe93316e81e9f24218bbfc": {
    label: "Euler ewstkscETH-1",
    totalLiquidity: "42100898052356702192",
    holders: [
      { address: "0xa4c63a2e8d0556ddb36c6544625284c663642384", balanceWei: "17495136574287911811" },
      { address: "0xa4c63a2e8d0556ddb36c6544625284c663642385", balanceWei: "13047983382745749807" },
      { address: "0xa4c63a2e8d0556ddb36c6544625284c663642381", balanceWei: "10716109817947532063" },
      { address: "0xa0a3640ef3a68d2579d30d78247bc613f45f94a9", balanceWei: "495372063210291337" },
      { address: "0xa781538006b07b856eb3d8b01c3d8d87382cb8f5", balanceWei: "340648688566542091" },
      { address: "0x4ea8dc2b1c36ad392169965e73bde7781dc050ad", balanceWei: "2054863957664606" },
      { address: "0xb672ea44a1ec692a9baf851dc90a1ee3db25f1c4", balanceWei: "1748968237442891" },
      { address: "0x7945620c7365ca601dbacf8f4c3e3bb678071c1b", balanceWei: "676617023512148" },
      { address: "0xd0f9c63cebc70884d63ed41851c9482305c5fee2", balanceWei: "467686541759791" },
      { address: "0x3b93a553da6afd7f1c11b85a9c87a8f9657c0301", balanceWei: "315200131769083" },
      { address: "0xa4c63a2e8d0556ddb36c6544625284c663642383", balanceWei: "99999618926696" },
      { address: "0x60583f22ada7b1352bb2faf694b3eaaf942696dd", balanceWei: "97212565102367" },
      { address: "0x50de2fb5cd259c1b99dbd3bb4e7aac76be7288fc", balanceWei: "64589335218530" },
      { address: "0x7841708ee45e96464bbd5ec53f2f0b5671e720c2", balanceWei: "38191802533686" },
      { address: "0x993d50b5f5c1259496b6cd419ef209bb9ff2b75d", balanceWei: "38050824122584" },
      { address: "0x027090f33876291f05833029611dd9932471afa2", balanceWei: "32149617702286" },
      { address: "0x5dd2cab9e6bb3a67e6415bd5d978e76e81544891", balanceWei: "12953497940697" },
      { address: "0xa71a705c620ff8ddff7f5144800613469d5838bb", balanceWei: "1041970558417" },
      { address: "0x19f29007707989212d19d7687fb29ead1338f006", balanceWei: "464809760" },
      { address: "0x4a07034856aeb680d517aba6cb532724ce1265be", balanceWei: "9611541" },
    ],
  },
  "0x45088fb2ffebfdcf4dff7b7201bfa4cd2077c30e": {
    label: "Royco Sonic USDC",
    totalLiquidity: "1708852035",
    holders: [
      { address: "0xea012d5ab5c24a6f33e0fa5b2839320b35e15437", balanceWei: "1000000000" },
      { address: "0x7f6914d8d27dd810cc1f4575f5722492b999a54f", balanceWei: "571160000" },
      { address: "0x30ef7087862f3c99242efc9633394eae629d6e9d", balanceWei: "30100000" },
      { address: "0x110b099f023aed984009265752866bd6ad9a459a", balanceWei: "25970000" },
      { address: "0x7cb552152e2b28f9f6911c51b69b0d8d1fadafe1", balanceWei: "20470000" },
      { address: "0x95c9b6b5d9b93bdf823526b46d0abc4c6adcdb83", balanceWei: "20000000" },
      { address: "0x1c1732e19d016f20f59ade301375b1572a0981c2", balanceWei: "18560000" },
      { address: "0x50e26bade4e2a15f7f46148e3c36e8cf11937da5", balanceWei: "10530000" },
      { address: "0xf71e9ec4d7015bf50dfbe12a23d5a6071167b06e", balanceWei: "10000000" },
      { address: "0xa161f191de22191bbb83f6d9f6ba1b702425a173", balanceWei: "1000000" },
      { address: "0xc25687cf9c5fdcad9ca418c9be09540b11d2ef46", balanceWei: "1000000" },
      { address: "0x10b9f7a1435f2486324dcf6a930cfc64332a43bc", balanceWei: "50000" },
      { address: "0xc6404f24db2f573f07f3a60758765caad198c0c3", balanceWei: "10000" },
      { address: "0x478bb542f7658d635abba67edb987806dff5b83d", balanceWei: "8" },
      { address: "0x007048da7c4c54c4b02db949eb83c7367c1c59fd", balanceWei: "5" },
    ],
  },
};

// ─── Merkle helpers (must match V1 / build-round0v2.ts exactly) ────────

function computeLeaf(address: `0x${string}`, shareWad: bigint): `0x${string}` {
  const inner = keccak256(
    encodeAbiParameters(parseAbiParameters("address, uint256"), [address, shareWad]),
  );
  return keccak256(encodePacked(["bytes32"], [inner]));
}

function hashPair(a: `0x${string}`, b: `0x${string}`): `0x${string}` {
  return a <= b
    ? keccak256(encodePacked(["bytes32", "bytes32"], [a, b]))
    : keccak256(encodePacked(["bytes32", "bytes32"], [b, a]));
}

function buildMerkleTree(leaves: `0x${string}`[]): { root: `0x${string}`; proofs: `0x${string}`[][] } {
  if (leaves.length === 0) return { root: ("0x" + "00".repeat(32)) as `0x${string}`, proofs: [] };
  if (leaves.length === 1) return { root: leaves[0], proofs: [[]] };

  const proofElements = new Map<number, `0x${string}`[]>();
  for (let i = 0; i < leaves.length; i++) proofElements.set(i, []);

  let level = [...leaves];
  let idxs = leaves.map((_, i) => [i]);

  while (level.length > 1) {
    const nextLevel: `0x${string}`[] = [];
    const nextIdxs: number[][] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        nextLevel.push(hashPair(level[i], level[i + 1]));
        nextIdxs.push([...idxs[i], ...idxs[i + 1]]);
        for (const idx of idxs[i]) proofElements.get(idx)!.push(level[i + 1]);
        for (const idx of idxs[i + 1]) proofElements.get(idx)!.push(level[i]);
      } else {
        nextLevel.push(level[i]);
        nextIdxs.push(idxs[i]);
      }
    }
    level = nextLevel;
    idxs = nextIdxs;
  }
  const proofs: `0x${string}`[][] = [];
  for (let i = 0; i < leaves.length; i++) proofs.push(proofElements.get(i)!);
  return { root: level[0], proofs };
}

// ─── Types ─────────────────────────────────────────────────────────────

type StkscMap = Map<string, { usd: bigint; eth: bigint }>;

function ensure(m: StkscMap, a: string) {
  const k = a.toLowerCase();
  let v = m.get(k);
  if (!v) { v = { usd: 0n, eth: 0n }; m.set(k, v); }
  return v;
}

function sumUsd(m: StkscMap): bigint { let s = 0n; for (const v of m.values()) s += v.usd; return s; }
function sumEth(m: StkscMap): bigint { let s = 0n; for (const v of m.values()) s += v.eth; return s; }

// ─── Main ──────────────────────────────────────────────────────────────

function main() {
  console.log("=== Round 0v2 V2.1 REBUILD — from snapshot-63645527.json ===\n");

  // Step 1: Load snapshot-63645527.json
  const snapPath = OUT("snapshot-63645527.json");
  const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
  console.log(`Loaded snapshot: ${snap.entitlements.length} entries at block ${snap.snapshotBlock}`);
  if (BigInt(snap.stkscUSD.totalSupply) !== STKSC_USD_TOTAL) throw new Error("stkscUSD totalSupply mismatch");
  if (BigInt(snap.stkscETH.totalSupply) !== STKSC_ETH_TOTAL) throw new Error("stkscETH totalSupply mismatch");

  const balances: StkscMap = new Map();
  for (const e of snap.entitlements) {
    const a = e.address.toLowerCase();
    if (WQ_CONTRACTS.has(a)) throw new Error(`unexpected WQ contract in snapshot: ${a}`);
    balances.set(a, { usd: BigInt(e.stkscUSD_balance), eth: BigInt(e.stkscETH_balance) });
  }
  {
    const su = sumUsd(balances), se = sumEth(balances);
    console.log(`  sum(stkscUSD) = ${su}  match=${su === STKSC_USD_TOTAL}`);
    console.log(`  sum(stkscETH) = ${se}  match=${se === STKSC_ETH_TOTAL}`);
    if (su !== STKSC_USD_TOTAL || se !== STKSC_ETH_TOTAL)
      throw new Error("snapshot sum != totalSupply");
  }

  // Step 2: Undo WQ pro-rata footgun by scaling down
  console.log("\n--- Step 2: undo WQ pro-rata (scale down) ---");
  const usdNum = STKSC_USD_TOTAL - WQ_USD_BAL;  // target sum post-scaling
  const ethNum = STKSC_ETH_TOTAL - WQ_ETH_BAL;
  console.log(`  USD factor = ${usdNum} / ${STKSC_USD_TOTAL}`);
  console.log(`  ETH factor = ${ethNum} / ${STKSC_ETH_TOTAL}`);

  let scaledUsdSum = 0n, scaledEthSum = 0n;
  let largestUsdAddr = ""; let largestUsdBal = 0n;
  let largestEthAddr = ""; let largestEthBal = 0n;
  for (const [addr, v] of balances) {
    v.usd = (v.usd * usdNum) / STKSC_USD_TOTAL;
    v.eth = (v.eth * ethNum) / STKSC_ETH_TOTAL;
    scaledUsdSum += v.usd;
    scaledEthSum += v.eth;
    if (v.usd > largestUsdBal) { largestUsdBal = v.usd; largestUsdAddr = addr; }
    if (v.eth > largestEthBal) { largestEthBal = v.eth; largestEthAddr = addr; }
  }
  const usdDust = usdNum - scaledUsdSum;
  const ethDust = ethNum - scaledEthSum;
  console.log(`  scaled sum USD = ${scaledUsdSum} (target ${usdNum}, dust ${usdDust})`);
  console.log(`  scaled sum ETH = ${scaledEthSum} (target ${ethNum}, dust ${ethDust})`);
  if (usdDust > 0n) balances.get(largestUsdAddr)!.usd += usdDust;
  if (ethDust > 0n) balances.get(largestEthAddr)!.eth += ethDust;

  // Step 3: Add 40 WQ users (stksc shares from withdraw-queue-resolved.json)
  console.log("\n--- Step 3: add WQ users ---");
  const wqFile = JSON.parse(fs.readFileSync(OUT("withdraw-queue-resolved.json"), "utf8"));
  let wqEthAdded = 0n, wqUsdAdded = 0n;
  for (const [addr, amt] of Object.entries(wqFile.eth.perUser)) {
    ensure(balances, addr).eth += BigInt(amt as string);
    wqEthAdded += BigInt(amt as string);
  }
  for (const [addr, amt] of Object.entries(wqFile.usd.perUser)) {
    ensure(balances, addr).usd += BigInt(amt as string);
    wqUsdAdded += BigInt(amt as string);
  }
  console.log(`  added 11 WQ-ETH users, total stkscETH = ${wqEthAdded} (expected ${WQ_ETH_BAL})`);
  console.log(`  added 29 WQ-USD users, total stkscUSD = ${wqUsdAdded} (expected ${WQ_USD_BAL})`);
  if (wqEthAdded !== WQ_ETH_BAL) throw new Error("WQ-ETH sum mismatch");
  if (wqUsdAdded !== WQ_USD_BAL) throw new Error("WQ-USD sum mismatch");

  {
    const su = sumUsd(balances), se = sumEth(balances);
    console.log(`  sum(stkscUSD) after WQ = ${su} (target ${STKSC_USD_TOTAL}, diff ${STKSC_USD_TOTAL - su})`);
    console.log(`  sum(stkscETH) after WQ = ${se} (target ${STKSC_ETH_TOTAL}, diff ${STKSC_ETH_TOTAL - se})`);
  }

  // Step 4: Apply PROTOCOL_SUB_DISTRIBUTIONS (StakeDAO, Euler, Royco USDC)
  console.log("\n--- Step 4: apply protocol sub-distributions ---");
  for (const [poolAddr, dist] of Object.entries(PROTOCOL_SUB_DISTRIBUTIONS)) {
    const key = poolAddr.toLowerCase();
    const v = balances.get(key);
    if (!v) { console.log(`  ${dist.label}: NOT in snapshot (skip)`); continue; }
    const usdBal = v.usd, ethBal = v.eth;
    balances.delete(key);
    const totalLiq = BigInt(dist.totalLiquidity);
    let usdDistributed = 0n, ethDistributed = 0n;
    for (const h of dist.holders) {
      const hBal = BigInt(h.balanceWei);
      const hUsd = totalLiq > 0n ? (usdBal * hBal) / totalLiq : 0n;
      const hEth = totalLiq > 0n ? (ethBal * hBal) / totalLiq : 0n;
      const t = ensure(balances, h.address);
      t.usd += hUsd; t.eth += hEth;
      usdDistributed += hUsd; ethDistributed += hEth;
    }
    // dust → largest holder (first in list)
    const du = usdBal - usdDistributed, de = ethBal - ethDistributed;
    if (du > 0n || de > 0n) {
      const t = ensure(balances, dist.holders[0].address);
      t.usd += du; t.eth += de;
    }
    console.log(`  ${dist.label}: usd=${usdBal} eth=${ethBal} → ${dist.holders.length} holders (dust u=${du} e=${de})`);
  }

  // Step 5: Apply PROTOCOL_REDIRECTS (Silo, Spectra, dLEND, Pendle, Royco Weiroll)
  console.log("\n--- Step 5: apply protocol redirects ---");
  let redirectCount = 0;
  for (const [src, { target, label }] of Object.entries(PROTOCOL_REDIRECTS)) {
    const srcKey = src.toLowerCase();
    const v = balances.get(srcKey);
    if (!v) { continue; }
    balances.delete(srcKey);
    const t = ensure(balances, target);
    t.usd += v.usd; t.eth += v.eth;
    redirectCount++;
    if (v.usd > 0n || v.eth > 0n) {
      console.log(`  ${label}: ${src} → ${target} (u=${v.usd} e=${v.eth})`);
    }
  }
  console.log(`  redirected ${redirectCount} protocol contracts`);

  // Step 6: Add 9mm V2 LP sub-distribution
  console.log("\n--- Step 6: apply 9mm V2 LP sub-distribution ---");
  const nineMmFile = JSON.parse(fs.readFileSync(OUT("9mm-resolved.json"), "utf8"));
  const nineMmKey = NINE_MM_POOL.toLowerCase();
  const nineMmV = balances.get(nineMmKey);
  if (!nineMmV) throw new Error("9mm pool not in snapshot");
  const nineMmEth = nineMmV.eth;
  const nineMmUsd = nineMmV.usd;
  balances.delete(nineMmKey);
  let nineMmDistributed = 0n;
  for (const [addr, amt] of Object.entries(nineMmFile.perUser)) {
    const a = BigInt(amt as string);
    ensure(balances, addr).eth += a;
    nineMmDistributed += a;
  }
  const nineMmDust = nineMmEth - nineMmDistributed;
  console.log(`  9mm pool eth=${nineMmEth} usd=${nineMmUsd} → ${Object.keys(nineMmFile.perUser).length} holders`);
  console.log(`  distributed=${nineMmDistributed} dust=${nineMmDust}`);
  if (nineMmUsd !== 0n) throw new Error("9mm unexpectedly has stkscUSD");
  // Pre-computed 9mm-resolved.json has 6 wei dust; leave as dust (drops from tree).
  // For exact conservation we'd add to a holder, but 6 wei ETH is negligible.

  // Step 7: Drop Shadow CL × 2 pools (dust, stays in V2.1 → rescued later)
  console.log("\n--- Step 7: drop Shadow CL × 2 pools (dust) ---");
  let shadowDroppedEth = 0n, shadowDroppedUsd = 0n;
  for (const p of SHADOW_CL_POOLS) {
    const v = balances.get(p);
    if (!v) { console.log(`  Shadow ${p}: not present`); continue; }
    shadowDroppedEth += v.eth; shadowDroppedUsd += v.usd;
    console.log(`  Shadow ${p}: dropped eth=${v.eth} usd=${v.usd}`);
    balances.delete(p);
  }
  console.log(`  total shadow dropped: eth=${shadowDroppedEth} usd=${shadowDroppedUsd}`);

  // Step 8: Drop the 4 protocol contracts resolved via merkle-round1
  console.log("\n--- Step 8: drop round1-resolved protocol contracts ---");
  let r1DroppedEth = 0n, r1DroppedUsd = 0n;
  for (const p of ROUND1_RESOLVED_PROTOCOL_CONTRACTS) {
    const v = balances.get(p);
    if (!v) continue;
    r1DroppedEth += v.eth; r1DroppedUsd += v.usd;
    console.log(`  dropped ${p}: eth=${v.eth} usd=${v.usd}`);
    balances.delete(p);
  }

  // Step 9: Convert stksc → USDC/WETH via V1 formula: share * pot / WAD
  console.log("\n--- Step 9: convert stksc → USDC/WETH ---");
  // V1 formula (merkle.ts + StreamRecoveryClaim.sol):
  //   share_i = balance_i * WAD / totalSupply
  //   payout_i = share_i * pot / WAD
  // Use the ORIGINAL totalSupply as denominator (not the post-scaling sum) —
  // this preserves the per-user pro-rata of the original Round-0 pot.
  const usdcAbs = new Map<string, bigint>();
  const wethAbs = new Map<string, bigint>();
  for (const [addr, v] of balances) {
    if (v.usd > 0n) {
      const share = (v.usd * WAD) / STKSC_USD_TOTAL;
      const amt = (share * USDC_POT_R0) / WAD;
      if (amt > 0n) usdcAbs.set(addr, amt);
    }
    if (v.eth > 0n) {
      const share = (v.eth * WAD) / STKSC_ETH_TOTAL;
      const amt = (share * WETH_POT_R0) / WAD;
      if (amt > 0n) wethAbs.set(addr, amt);
    }
  }
  {
    let u = 0n; for (const a of usdcAbs.values()) u += a;
    let w = 0n; for (const a of wethAbs.values()) w += a;
    console.log(`  sum USDC (pre-round1, pre-claimed) = ${u}`);
    console.log(`  sum WETH (pre-round1, pre-claimed) = ${w}`);
  }

  // Step 10: Drop V1 claimers BEFORE merging round1.
  // This matches build-round0v2.ts ordering so that V1-claimed users who
  // are also round1 protocol depositors re-enter with their R1 share only
  // (they forfeited their R0 direct share by claiming on V1 but still
  // have a legitimate R1 protocol-distribution share). This is design
  // intent, enforced by Step 10 / Step 11 ordering.
  //
  // V2 claimers are dropped AFTER the R1 merge (Step 11b below), because
  // V2 already paid them for BOTH their R0 direct share AND their R1
  // protocol share (V2's tree was the full R0 rebuild + R1 merge minus
  // V1-claimers). Re-adding them in Step 11 would double-pay the R1
  // portion, so the V2-claimer drop must come AFTER the merge.
  console.log("\n--- Step 10: drop V1 claimers (before round1 merge) ---");
  const claimedV1 = JSON.parse(fs.readFileSync(OUT("round0-claimed.json"), "utf8"));
  const usdcClaimed = new Set<string>((claimedV1.usdc.claimedAddresses as string[]).map((a) => a.toLowerCase()));
  const wethClaimed = new Set<string>((claimedV1.weth.claimedAddresses as string[]).map((a) => a.toLowerCase()));
  console.log(`  V1 USDC claimers: ${usdcClaimed.size}`);
  console.log(`  V1 WETH claimers: ${wethClaimed.size}`);
  let dropUsdc = 0, dropUsdcAmt = 0n;
  for (const a of usdcClaimed) {
    const v = usdcAbs.get(a);
    if (v !== undefined) { dropUsdcAmt += v; usdcAbs.delete(a); dropUsdc++; }
  }
  let dropWeth = 0, dropWethAmt = 0n;
  for (const a of wethClaimed) {
    const v = wethAbs.get(a);
    if (v !== undefined) { dropWethAmt += v; wethAbs.delete(a); dropWeth++; }
  }
  console.log(`  dropped ${dropUsdc}/${usdcClaimed.size} USDC claimed (amt=${dropUsdcAmt})`);
  console.log(`  dropped ${dropWeth}/${wethClaimed.size} WETH claimed (amt=${dropWethAmt})`);

  // Step 11 (E5b): Merge merkle-round1 SCALED DOWN by the footgun factor.
  console.log("\n--- Step 11 (E5b): merge merkle-round1 (scaled down) ---");
  const mergeRound1 = (
    file: string,
    potR1: bigint,
    num: bigint,
    denom: bigint,
    target: Map<string, bigint>,
    tokenName: string,
  ) => {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    let addedNew = 0, merged = 0;
    let rawTotal = 0n, scaledTotal = 0n;
    for (const e of j.entries as Array<{ address: string; shareWad: string }>) {
      // amount = shareWad * potR1 / WAD  (V1 contract's exact formula)
      const rawAmt = (BigInt(e.shareWad) * potR1) / WAD;
      if (rawAmt === 0n) continue;
      // Scale down by the footgun factor (the underlying pool balance was inflated)
      const scaledAmt = (rawAmt * num) / denom;
      rawTotal += rawAmt;
      scaledTotal += scaledAmt;
      const a = e.address.toLowerCase();
      if (target.has(a)) { target.set(a, target.get(a)! + scaledAmt); merged++; }
      else { target.set(a, scaledAmt); addedNew++; }
    }
    console.log(`  ${tokenName}: raw R1 total=${rawTotal} → scaled=${scaledTotal} (delta ${rawTotal - scaledTotal})`);
    console.log(`  ${tokenName}: added ${addedNew} new + ${merged} merged`);
  };
  mergeRound1(OUT("merkle-round1-usdc.json"), USDC_POT_R1, usdNum, STKSC_USD_TOTAL, usdcAbs, "USDC");
  mergeRound1(OUT("merkle-round1-weth.json"), WETH_POT_R1, ethNum, STKSC_ETH_TOTAL, wethAbs, "WETH");

  // Step 11b: Drop V2 claimers AFTER the R1 merge.
  // V2 already paid them BOTH their R0 direct share AND their R1 protocol
  // share (V2's tree = R0 rebuild + R1 merge - V1-claimers). Re-adding them
  // in Step 11 would double-pay the R1 portion, so the V2-claimer drop must
  // come AFTER the merge. Unlike Step 10 (V1 claimers), there is no "re-entry
  // via R1" carve-out here — V2 claimers are fully excluded from V2.1.
  console.log("\n--- Step 11b: drop V2 claimers (after round1 merge, full exclusion) ---");
  const claimedV2 = JSON.parse(fs.readFileSync(OUT("round0-claimed-v2.json"), "utf8"));
  const usdcClaimedV2 = new Set<string>(
    (claimedV2.usdc.claimedAddresses as string[]).map((a) => a.toLowerCase()),
  );
  const wethClaimedV2 = new Set<string>(
    (claimedV2.weth.claimedAddresses as string[]).map((a) => a.toLowerCase()),
  );
  let dropV2Usdc = 0, dropV2UsdcAmt = 0n;
  for (const a of usdcClaimedV2) {
    const v = usdcAbs.get(a);
    if (v !== undefined) { dropV2UsdcAmt += v; usdcAbs.delete(a); dropV2Usdc++; }
  }
  let dropV2Weth = 0, dropV2WethAmt = 0n;
  for (const a of wethClaimedV2) {
    const v = wethAbs.get(a);
    if (v !== undefined) { dropV2WethAmt += v; wethAbs.delete(a); dropV2Weth++; }
  }
  console.log(`  dropped ${dropV2Usdc}/${usdcClaimedV2.size} USDC V2-claimed (amt=${dropV2UsdcAmt})`);
  console.log(`  dropped ${dropV2Weth}/${wethClaimedV2.size} WETH V2-claimed (amt=${dropV2WethAmt})`);

  // Step 12: Build final entry lists
  console.log("\n--- Step 12: build merkle trees ---");
  const buildTree = (
    absMap: Map<string, bigint>,
    token: "USDC" | "WETH",
    outFile: string,
    targetTotal: bigint,
  ) => {
    const survivors = [...absMap.entries()]
      .filter(([, a]) => a > 0n)
      .sort((x, y) => (x[0] < y[0] ? -1 : 1));
    const rawTotal = survivors.reduce((s, [, a]) => s + a, 0n);
    console.log(`\n  [${token}] survivors=${survivors.length}  rawTotal=${rawTotal}  target=${targetTotal}`);

    // Option A: normalize all amounts so sum = targetTotal exactly.
    // scaled_i = raw_i * targetTotal / rawTotal; assign rounding dust to largest.
    let normSum = 0n;
    const normalized: Array<[string, bigint]> = survivors.map(([addr, amt]) => {
      const s = (amt * targetTotal) / rawTotal;
      normSum += s;
      return [addr, s];
    });
    let largestIdx = 0;
    for (let i = 1; i < normalized.length; i++) {
      if (normalized[i][1] > normalized[largestIdx][1]) largestIdx = i;
    }
    const normDust = targetTotal - normSum;
    if (normDust !== 0n) {
      normalized[largestIdx][1] += normDust;
      console.log(`  normalized: added ${normDust} dust to ${normalized[largestIdx][0]} to hit target exactly`);
    }
    const newTotal = targetTotal;
    // POST-NORMALIZATION ZERO FILTER (Phase G Group B fix):
    // Step 12's normalization (s = amt * targetTotal / rawTotal) can round
    // small entries down to zero. The pre-normalize survivors filter (above)
    // catches entries that were zero before normalization, but not these.
    // If we leave them in the tree, they consume the user's claim slot
    // (`hasClaimedUsdc` is set even for amount=0 claims) without paying out
    // anything — a self-affecting foot-gun, see Phase H Finding 6.
    // The filter is safe wrt INV4: dropped entries contribute zero to the
    // sum, so the post-filter sum is still exactly targetTotal.
    const filtered = normalized.filter(([, a]) => a > 0n);
    const droppedZeros = normalized.length - filtered.length;
    if (droppedZeros > 0) {
      console.log(`  post-normalize zero filter: dropped ${droppedZeros} entries that rounded to 0`);
    }
    const finalsPairs = filtered;
    console.log(`  haircut vs raw: ${rawTotal - targetTotal} (${token === "USDC" ? Number(rawTotal - targetTotal) / 1e6 : Number(rawTotal - targetTotal) / 1e18} ${token})`);

    type FE = { address: `0x${string}`; shareWad: bigint; amount: bigint };
    const finals: FE[] = finalsPairs.map(([addr, amt]) => ({
      address: getAddress(addr) as `0x${string}`,
      shareWad: (amt * WAD + newTotal / 2n) / newTotal,
      amount: amt,
    }));
    let shareSum = finals.reduce((s, e) => s + e.shareWad, 0n);
    const shareDelta = WAD - shareSum;
    if (shareDelta !== 0n) {
      let maxIdx = 0;
      for (let i = 1; i < finals.length; i++)
        if (finals[i].shareWad > finals[maxIdx].shareWad) maxIdx = i;
      finals[maxIdx].shareWad += shareDelta;
      console.log(`  adjusted ${finals[maxIdx].address} by ${shareDelta} to make shareSum=WAD`);
    }
    shareSum = finals.reduce((s, e) => s + e.shareWad, 0n);
    if (shareSum !== WAD) throw new Error(`[${token}] shareSum != WAD: ${shareSum}`);

    const payoutSum = finals.reduce((s, e) => s + (e.shareWad * newTotal) / WAD, 0n);
    const payoutDust = newTotal - payoutSum;
    console.log(`  payoutSum=${payoutSum}  dust=${payoutDust}`);
    if (payoutSum > newTotal) throw new Error("payoutSum > newTotal");

    const leaves = finals.map((e) => computeLeaf(e.address, e.shareWad));
    const { root, proofs } = buildMerkleTree(leaves);
    console.log(`  root=${root}`);

    const out = {
      description: `Round 0v2 V2.1 ${token} — raw rebuild from snapshot-63645527.json`,
      snapshotBlock: 63645527,
      rebuildVersion: "2.1",
      sourceRound0Total: (token === "USDC" ? USDC_POT_R0 : WETH_POT_R0).toString(),
      merkleRoot: root,
      leafCount: finals.length,
      newTotal: newTotal.toString(),
      payoutSum: payoutSum.toString(),
      payoutDustWei: payoutDust.toString(),
      fixesApplied: [
        "undo-wq-pro-rata-footgun",
        "add-40-wq-users",
        "9mm-v2-lp-sub-distribution",
        "exclude-shadow-cl-dust",
        "protocol-redirects-on-scaled-balances",
        "protocol-sub-distributions-on-scaled-balances",
        "merkle-round1-scaled-down",
        "drop-claimed",
      ],
      entries: finals.map((e, i) => ({
        address: e.address,
        shareWad: e.shareWad.toString(),
        amount: e.amount.toString(),
        leaf: leaves[i],
        proof: proofs[i],
      })),
    };
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    console.log(`  written: ${outFile}`);
    return { newTotal, leafCount: finals.length, root };
  };

  const u = buildTree(usdcAbs, "USDC", OUT("merkle-round0v2-v2.1-usdc.json"), TARGET_USDC);
  const w = buildTree(wethAbs, "WETH", OUT("merkle-round0v2-v2.1-weth.json"), TARGET_WETH);

  // Step 13: Reconcile vs the V2 wind-down balances (what the admin Safe rescued)
  console.log("\n=== RECONCILIATION vs V2 wind-down targets ===");
  console.log(`USDC: target=${TARGET_USDC}  newTotal=${u.newTotal}  delta=${TARGET_USDC - u.newTotal}  (${Number(TARGET_USDC - u.newTotal) / 1e6} USDC)`);
  console.log(`WETH: target=${TARGET_WETH}  newTotal=${w.newTotal}  delta=${TARGET_WETH - w.newTotal}  (${Number(TARGET_WETH - w.newTotal) / 1e18} WETH)`);
  console.log(`  V1 pot was: USDC=${V1_USDC}  WETH=${V1_WETH}`);
  console.log(`  V2 already paid out: USDC=${V1_USDC - TARGET_USDC}  WETH=${V1_WETH - TARGET_WETH}`);
  console.log(`  WETH delta includes Shadow CL dropped: ${shadowDroppedEth} stkscETH (≈ ${Number(shadowDroppedEth * WETH_POT_R0 / STKSC_ETH_TOTAL) / 1e18} WETH)`);

  // Step 14: Diff vs existing broken V2 trees
  console.log("\n=== DIFF vs broken V2 trees ===");
  const diffReport: any = { usdc: {}, weth: {} };
  const diffTree = (newFile: string, oldFile: string, token: string) => {
    const nw = JSON.parse(fs.readFileSync(newFile, "utf8"));
    const ol = JSON.parse(fs.readFileSync(oldFile, "utf8"));
    const nwMap = new Map<string, bigint>();
    const olMap = new Map<string, bigint>();
    for (const e of nw.entries) nwMap.set(e.address.toLowerCase(), BigInt(e.amount));
    for (const e of ol.entries) olMap.set(e.address.toLowerCase(), BigInt(e.amount));
    const added: Array<{ addr: string; amt: string }> = [];
    const removed: Array<{ addr: string; amt: string }> = [];
    const changed: Array<{ addr: string; old: string; new: string; delta: string }> = [];
    for (const [a, v] of nwMap) {
      if (!olMap.has(a)) added.push({ addr: a, amt: v.toString() });
      else {
        const old = olMap.get(a)!;
        if (old !== v) changed.push({ addr: a, old: old.toString(), new: v.toString(), delta: (v - old).toString() });
      }
    }
    for (const [a, v] of olMap) {
      if (!nwMap.has(a)) removed.push({ addr: a, amt: v.toString() });
    }
    console.log(`  ${token}: added=${added.length}  removed=${removed.length}  changed=${changed.length}`);
    console.log(`    old leaves=${olMap.size}  new leaves=${nwMap.size}  (Δ ${nwMap.size - olMap.size})`);
    return { added, removed, changed, oldLeaves: olMap.size, newLeaves: nwMap.size };
  };
  diffReport.usdc = diffTree(
    OUT("merkle-round0v2-v2.1-usdc.json"),
    OUT("merkle-round0v2-usdc.json"),
    "USDC",
  );
  diffReport.weth = diffTree(
    OUT("merkle-round0v2-v2.1-weth.json"),
    OUT("merkle-round0v2-weth.json"),
    "WETH",
  );
  fs.writeFileSync(OUT("merkle-round0v2-v2.1-diff.json"), JSON.stringify(diffReport, null, 2));
  console.log(`  diff written: ${OUT("merkle-round0v2-v2.1-diff.json")}`);
}

main();
