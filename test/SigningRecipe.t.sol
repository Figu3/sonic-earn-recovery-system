// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

interface IV21 {
    function signWaiver(bytes calldata) external;
    function hasSignedWaiver(address) external view returns (bool);
    function getWaiverDigest(address) external view returns (bytes32);
}
interface ISafe {
    function approveHash(bytes32) external;
    function getMessageHash(bytes memory) external view returns (bytes32);
}

contract SigningRecipe is Test {
    address constant V21 = 0x61eba3FAa88a20d9BB574c42EFC6e812f95F1d03;

    function setUp() public { vm.createSelectFork("https://rpc.soniclabs.com"); }

    function _signSafe(address safe, address[3] memory approvers, bytes memory bundle) internal {
        bytes32 digest = IV21(V21).getWaiverDigest(safe);
        bytes32 msgHash = ISafe(safe).getMessageHash(abi.encode(digest));
        for (uint i = 0; i < 3; i++) {
            vm.prank(approvers[i]);
            ISafe(safe).approveHash(msgHash);
        }
        vm.prank(safe);
        IV21(V21).signWaiver(bundle);
        assertTrue(IV21(V21).hasSignedWaiver(safe), "waiver did not flip");
    }

    function test_Safe_0x7D1C() public {
        address safe = 0x7D1C5910C1d82A4874fAC4EDfe80eb3C2b706676;
        address[3] memory approvers = [
            0x71B07E11096a510ff06AE91d6d39677E7D4dF072,
            0xa0Be4055768365bC268230a6a40EE23467A2B3D0,
            0xa1eB063E50bd82f3b511BaC3084AbD67Cf79AfD4
        ];
        bytes memory bundle = hex"00000000000000000000000071b07e11096a510ff06ae91d6d39677e7d4df072000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000a0be4055768365bc268230a6a40ee23467a2b3d0000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000a1eb063e50bd82f3b511bac3084abd67cf79afd4000000000000000000000000000000000000000000000000000000000000000001";
        _signSafe(safe, approvers, bundle);
        emit log_string("  0x7D1C PASS");
    }

    function test_Safe_0xb802() public {
        address safe = 0xb8022c515174F41C4EF9211FE5dcFff27B01DE87;
        address[3] memory approvers = [
            0x249D692406f9C1e5Aa2887712D6fEf0dB169f00b,
            0x299d1A66c2199A2c7f4d7b2fD0Cafb68B9822ECf,
            0x8631e1204C80d0bD9B718787734f80766cF1351F
        ];
        bytes memory bundle = hex"000000000000000000000000249d692406f9c1e5aa2887712d6fef0db169f00b000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000299d1a66c2199a2c7f4d7b2fd0cafb68b9822ecf0000000000000000000000000000000000000000000000000000000000000000010000000000000000000000008631e1204c80d0bd9b718787734f80766cf1351f000000000000000000000000000000000000000000000000000000000000000001";
        _signSafe(safe, approvers, bundle);
        emit log_string("  0xb802 PASS");
    }
}
