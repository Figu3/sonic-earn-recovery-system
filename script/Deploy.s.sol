// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {StreamRecoveryClaim} from "../src/StreamRecoveryClaim.sol";

/// @title Deploy StreamRecoveryClaim
/// @notice Deploy with: forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --private-key $PK
/// @dev Constructor args: admin, usdc, weth
contract DeployStreamRecoveryClaim is Script {
    function run() external {
        address admin = vm.envAddress("ADMIN");
        address usdc = vm.envAddress("USDC");
        address weth = vm.envAddress("WETH");

        console2.log("Deploying StreamRecoveryClaim...");
        console2.log("  admin:", admin);
        console2.log("  usdc: ", usdc);
        console2.log("  weth: ", weth);

        vm.startBroadcast();
        StreamRecoveryClaim claim = new StreamRecoveryClaim(admin, usdc, weth);
        vm.stopBroadcast();

        console2.log("Deployed at:", address(claim));
    }
}
