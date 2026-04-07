// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {StreamRecoveryClaim} from "../src/StreamRecoveryClaim.sol";

/// @title Deploy Trevee Earn Recovery Distributor (StreamRecoveryClaim)
/// @notice Deploy + verify on Sonic:
///
///   source .env && forge script script/Deploy.s.sol \
///     --rpc-url sonic \
///     --broadcast \
///     --verify \
///     --private-key $PRIVATE_KEY
///
/// @dev Verify an already-deployed contract:
///
///   forge verify-contract <ADDRESS> StreamRecoveryClaim \
///     --chain 146 \
///     --verifier etherscan \
///     --verifier-url "https://api.etherscan.io/v2/api?chainid=146" \
///     --etherscan-api-key $SONICSCAN_API_KEY \
///     --constructor-args $(cast abi-encode "constructor(address,address,address)" $ADMIN $USDC $WETH) \
///     --watch
contract DeployStreamRecoveryClaim is Script {
    /// @dev Set expected chain ID to prevent deploying on the wrong network.
    ///      Sonic = 146. Override via EXPECTED_CHAIN_ID env var if needed.
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
        // V1 address — pass V1=0x0 for a fresh deploy with no waiver migration.
        address v1 = vm.envOr("V1", address(0));

        console2.log("=== StreamRecoveryClaim V2 Deployment ===");
        console2.log("  chain id:", block.chainid);
        console2.log("  admin:   ", admin);
        console2.log("  usdc:    ", usdc);
        console2.log("  weth:    ", weth);
        console2.log("  v1:      ", v1);

        vm.startBroadcast();
        StreamRecoveryClaim claim = new StreamRecoveryClaim(admin, usdc, weth, v1);
        vm.stopBroadcast();

        console2.log("=== Deployed ===");
        console2.log("  StreamRecoveryClaim:", address(claim));
        console2.log("");
        console2.log("Next steps:");
        console2.log("  1. Update EMERGENCY_PROCEDURES.md with deployed address");
        console2.log("  2. Update contracts.json registry");
        console2.log("  3. Fund contract with USDC + WETH");
        console2.log("  4. Create first round via createRound()");
    }
}
