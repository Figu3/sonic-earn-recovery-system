// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IV2 {
    function migrateWaiverFromV1() external;
    function canClaimUsdc(uint256, address, uint256, bytes32[] calldata)
        external view returns (bool, uint256);
    function claimUsdc(uint256, uint256, bytes32[] calldata) external;
    function hasSignedWaiver(address) external view returns (bool);
    function hasClaimedUsdc(uint256, address) external view returns (bool);
}

contract ForkR0v2ClaimTest is Test {
    address constant V2 = 0x6472D708cD88C7DD94e77A5c5023dA6FDc41Ad31;
    address constant USDC = 0x29219dd400f2Bf60E5a23d13Be72B486D4038894;
    address constant USER = 0xc70Aa0Bc5C372CA2006204C91Af480dacF621Bac;

    uint256 constant SHARE_WAD = 3491921935364192;
    uint256 constant EXPECTED_AMOUNT = 1292192782; // 1292.19 USDC

    function setUp() public {
        vm.createSelectFork("https://rpc.soniclabs.com");
    }

    function test_full_claim_flow() public {
        IV2 v2 = IV2(V2);

        // Build proof
        bytes32[] memory proof = new bytes32[](12);
        proof[0]  = 0xc73e8e06be62b4523927b7b0b30dc306c28efb8415327189797e71129fa61c4a;
        proof[1]  = 0xb03b26e8fa5aa1e0b457b9d8f5182d6d8b733a9d6e5bf3611bf876b25ddab7b3;
        proof[2]  = 0x028e8d3fc1515b9b76558ce6be7822a55846780aa61e089009be8339ae94a50f;
        proof[3]  = 0x8c7280f392fc8b7d4ac7581aee2cc19fee93f7612e10fb7671cf4de5a205f720;
        proof[4]  = 0xd0de830b8f4b68da487cb3f304308e77f404a1db7345576f352c99d7a76ffafd;
        proof[5]  = 0xa6dd6c65cc595557fb18339180d7ed3c516556ced03b22a4422baf15daafe17d;
        proof[6]  = 0x4e1197bbbccb403e322c11efcfcbba973c23fad36a38a631c19cabd1afb9d109;
        proof[7]  = 0xa7bfa012aa7391a0943a3545c214d638ebaa9ed0131e8e4addedebf2814b9cbb;
        proof[8]  = 0xac5ec51dcac5ba43999ad76425c7d203054128f5e9000c77210366aebba1ba1d;
        proof[9]  = 0x716a0fa4f94a0c646e6d4cce08ab2435f5c0e0a6ee963ab44cc3a8f8a0dbd387;
        proof[10] = 0xdb86468ae195841456ec64d22ca56e1b27d070eaaa7ea554a6f7c99e6b2ed48f;
        proof[11] = 0x5e551c5c96076468d3b1241fafcfa450588e68d76e17f5f6a19a79ca650361bc;

        // Pre-state
        assertFalse(v2.hasSignedWaiver(USER), "should not have signed yet");
        assertFalse(v2.hasClaimedUsdc(0, USER), "should not have claimed yet");
        (bool eligible0, uint256 amount0) = v2.canClaimUsdc(0, USER, SHARE_WAD, proof);
        assertFalse(eligible0, "should NOT be eligible before waiver");
        emit log_named_uint("amount before waiver", amount0);

        // Step 1: User migrates waiver from V1
        vm.prank(USER);
        v2.migrateWaiverFromV1();
        assertTrue(v2.hasSignedWaiver(USER), "waiver should be migrated");

        // Step 2: canClaim should now return true with correct amount
        (bool eligible1, uint256 amount1) = v2.canClaimUsdc(0, USER, SHARE_WAD, proof);
        assertTrue(eligible1, "should be eligible after waiver migration");
        // Allow ≤1 wei floor-rounding difference vs JSON metadata
        assertApproxEqAbs(amount1, EXPECTED_AMOUNT, 1, "amount within 1 wei of expected");
        emit log_named_uint("amount after waiver", amount1);
        emit log_named_uint("expected (json)", EXPECTED_AMOUNT);

        // Step 3: Actually claim
        uint256 balBefore = IERC20(USDC).balanceOf(USER);
        vm.prank(USER);
        v2.claimUsdc(0, SHARE_WAD, proof);
        uint256 balAfter = IERC20(USDC).balanceOf(USER);

        assertApproxEqAbs(balAfter - balBefore, EXPECTED_AMOUNT, 1, "USDC received within 1 wei");
        assertTrue(v2.hasClaimedUsdc(0, USER), "claim flag set");
        emit log_named_uint("USDC received (raw)", balAfter - balBefore);
    }
}
