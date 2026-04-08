// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {StreamRecoveryClaimV21} from "../src/StreamRecoveryClaimV21.sol";

/// @title Deploy StreamRecoveryClaimV21 on Sonic
/// @notice Usage:
///
///   source .env && forge script script/DeployV21.s.sol \
///     --rpc-url $SONIC_RPC \
///     --broadcast \
///     --verify \
///     --private-key $DEPLOYER_PK
///
/// @dev Reads constructor args from env:
///   ADMIN         — the V2.1 admin Safe (must be non-zero)
///   USDC          — Sonic USDC (0x29219dd400f2Bf60E5a23d13Be72B486D4038894)
///   WETH          — Sonic WETH (0x50c42dEAcD8Fc9773493ED674b675bE577f2634b)
///   PRIOR_WAIVERS — V1 or V2 address (V2 = 0x6472D708cD88C7DD94e77A5c5023dA6FDc41Ad31)
///                   V2.1 will read hasSignedWaiver(user) on this contract from
///                   users calling migrateWaiverFromPrior(). Pointing at V2
///                   captures BOTH the V1 migrants (already in V2 via
///                   V2.migrateWaiverFromV1) AND V2-direct signers.
contract DeployStreamRecoveryClaimV21 is Script {
    uint256 constant SONIC_CHAIN_ID = 146;

    function run() external {
        uint256 expectedChainId = vm.envOr("EXPECTED_CHAIN_ID", SONIC_CHAIN_ID);
        require(
            block.chainid == expectedChainId,
            string.concat(
                "Wrong chain! Expected ",
                vm.toString(expectedChainId),
                " but got ",
                vm.toString(block.chainid)
            )
        );

        address admin = vm.envAddress("ADMIN");
        address usdc = vm.envAddress("USDC");
        address weth = vm.envAddress("WETH");
        address priorWaivers = vm.envAddress("PRIOR_WAIVERS");

        require(admin != address(0), "ADMIN must be non-zero");
        require(usdc != address(0), "USDC must be non-zero");
        require(weth != address(0), "WETH must be non-zero");
        require(priorWaivers != address(0), "PRIOR_WAIVERS must be non-zero (V2 for this deploy)");

        // Derive deployer from the private key (never use msg.sender before
        // startBroadcast — per rules/solidity-security.md §3).
        address deployer = vm.addr(vm.envUint("DEPLOYER_PK"));

        console2.log("=== StreamRecoveryClaimV21 Deployment ===");
        console2.log("  chain id:     ", block.chainid);
        console2.log("  deployer:     ", deployer);
        console2.log("  admin:        ", admin);
        console2.log("  usdc:         ", usdc);
        console2.log("  weth:         ", weth);
        console2.log("  priorWaivers: ", priorWaivers);

        vm.startBroadcast(vm.envUint("DEPLOYER_PK"));
        StreamRecoveryClaimV21 v21 = new StreamRecoveryClaimV21(admin, usdc, weth, priorWaivers);
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Deployed ===");
        console2.log("  StreamRecoveryClaimV21:", address(v21));
        console2.log("");
        console2.log("Next steps:");
        console2.log("  1. Verify on SonicScan (auto if --verify was passed)");
        console2.log("  2. Transfer USDC+WETH from admin Safe to the V2.1 contract");
        console2.log("  3. Call v21.createRound(usdcRoot, wethRoot, usdcTotal, wethTotal)");
        console2.log("  4. Phase G post-deploy verification on a fresh fork");
        console2.log("  5. Announce");
    }
}
