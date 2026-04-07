// Deep audit of R0v2 contract leaves: detect ERC-1271 support more reliably.
//
// For every contract in r0v2-contract-audit.json:
//   1. Fetch bytecode
//   2. Check if bytecode contains the ERC-1271 selector 0x1626ba7e
//   3. Direct staticcall isValidSignature(bytes32(0), bytes(0x00)) — passes if it
//      either returns the magic value, returns 0xffffffff (rejected sig — that's
//      still ERC-1271-aware), or reverts with a custom error other than
//      "no function". Reverts with empty data are treated as "not implemented".
//
// Output:
//   scripts/output/r0v2-deep-audit.json
//   Console summary: confirmed-OK vs likely-stuck contracts.

import { createPublicClient, http, defineChain, encodeFunctionData, parseAbi } from "viem";
import * as fs from "fs";
import * as path from "path";

const sonic = defineChain({
  id: 146,
  name: "Sonic",
  nativeCurrency: { name: "Sonic", symbol: "S", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.soniclabs.com"] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

const ERC1271_SELECTOR = "1626ba7e"; // isValidSignature(bytes32,bytes)

const erc1271Abi = parseAbi([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);

type Row = {
  address: string;
  isSafe: boolean;
  label: string | null;
  usdc: string;
  weth: string;
  classification: string;
};

async function main() {
  const audit = JSON.parse(fs.readFileSync(path.join(__dirname, "output/r0v2-contract-audit.json"), "utf8"));
  const rows: Row[] = audit.rows;
  console.log(`Loaded ${rows.length} contract rows`);

  const client = createPublicClient({ chain: sonic, transport: http(undefined, { batch: true }) });

  type Result = Row & {
    bytecodeSize: number;
    hasErc1271Selector: boolean;
    erc1271Returns: string | null; // null = revert/no fn, else hex of returndata
    canSign: boolean;
  };

  const results: Result[] = [];
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);

    // Get bytecode
    const codes = await Promise.all(
      slice.map((r) => client.getCode({ address: r.address as `0x${string}` })),
    );

    // Try ERC-1271 staticcall
    const checks = await Promise.all(
      slice.map(async (r) => {
        try {
          // dummy zero hash + dummy sig
          const ret = await client.readContract({
            address: r.address as `0x${string}`,
            abi: erc1271Abi,
            functionName: "isValidSignature",
            args: ["0x" + "00".repeat(32) as `0x${string}`, "0x" as `0x${string}`],
          });
          return { ok: true, ret: ret as string };
        } catch (e: any) {
          // Distinguish "function does not exist" (returndata empty / 0x) from
          // "function exists but rejected the dummy sig" (custom revert).
          const msg = String(e?.message || "");
          // If the error includes returndata or known custom error, the function exists
          if (msg.includes("reverted") && (msg.includes("0x") || msg.includes("Error("))) {
            return { ok: true, ret: null }; // function exists, rejected
          }
          return { ok: false, ret: null };
        }
      }),
    );

    for (let k = 0; k < slice.length; k++) {
      const r = slice[k];
      const code = codes[k] || "0x";
      const hasSel = code.toLowerCase().includes(ERC1271_SELECTOR);
      const check = checks[k];
      const canSign = r.isSafe || check.ok || hasSel;
      results.push({
        ...r,
        bytecodeSize: (code.length - 2) / 2,
        hasErc1271Selector: hasSel,
        erc1271Returns: check.ret,
        canSign,
      });
    }
    process.stdout.write(`  ${Math.min(i + BATCH, rows.length)}/${rows.length}\r`);
  }
  process.stdout.write("\n");

  // Classify
  const ok = results.filter((r) => r.canSign);
  const stuck = results.filter((r) => !r.canSign);

  // Sort stuck by USDC desc + WETH
  stuck.sort((a, b) => {
    const av = BigInt(a.usdc) + (BigInt(a.weth) * 4_000_000n) / 10n ** 18n; // crude USD weight
    const bv = BigInt(b.usdc) + (BigInt(b.weth) * 4_000_000n) / 10n ** 18n;
    return bv > av ? 1 : bv < av ? -1 : 0;
  });

  const sumUsdc = (xs: Result[]) => xs.reduce((s, r) => s + BigInt(r.usdc), 0n);
  const sumWeth = (xs: Result[]) => xs.reduce((s, r) => s + BigInt(r.weth), 0n);

  console.log("\n=== DEEP AUDIT RESULTS ===");
  console.log(`Total contracts:           ${results.length}`);
  console.log(`Can sign (Safe/ERC-1271):  ${ok.length}  →  ${(Number(sumUsdc(ok)) / 1e6).toFixed(2)} USDC + ${(Number(sumWeth(ok)) / 1e18).toFixed(6)} WETH`);
  console.log(`Likely STUCK:              ${stuck.length}  →  ${(Number(sumUsdc(stuck)) / 1e6).toFixed(2)} USDC + ${(Number(sumWeth(stuck)) / 1e18).toFixed(6)} WETH`);

  console.log("\n--- TOP 30 STUCK CONTRACTS BY VALUE ---");
  for (const r of stuck.slice(0, 30)) {
    const lbl = r.label ? ` ${r.label}` : "";
    console.log(`  ${r.address}  ${(Number(r.usdc) / 1e6).toFixed(2).padStart(12)} USDC  ${(Number(r.weth) / 1e18).toFixed(6).padStart(14)} WETH  bytecode=${r.bytecodeSize}B${lbl}`);
  }

  fs.writeFileSync(
    path.join(__dirname, "output/r0v2-deep-audit.json"),
    JSON.stringify(
      {
        total: results.length,
        canSign: ok.length,
        stuck: stuck.length,
        canSignSumUsdc: sumUsdc(ok).toString(),
        canSignSumWeth: sumWeth(ok).toString(),
        stuckSumUsdc: sumUsdc(stuck).toString(),
        stuckSumWeth: sumWeth(stuck).toString(),
        stuckList: stuck,
        canSignList: ok.map((r) => r.address),
      },
      null,
      2,
    ),
  );
  console.log("\nWritten: scripts/output/r0v2-deep-audit.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
