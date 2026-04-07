// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IV1 {
    function admin() external view returns (address);
    function paused() external view returns (bool);
    function totalUsdcAllocated() external view returns (uint256);
    function totalWethAllocated() external view returns (uint256);
    function pause() external;
    function deactivateRound(uint256) external;
    function rescueToken(address, address, uint256) external;
    function rounds(uint256)
        external
        view
        returns (
            bytes32 usdcRoot,
            bytes32 wethRoot,
            uint256 usdcTotal,
            uint256 wethTotal,
            uint256 usdcClaimed,
            uint256 wethClaimed,
            uint256 claimDeadline,
            bool active
        );
}

contract ForkSweepV1Test is Test {
    address constant V1 = 0xda7805AdbEfa29b9e3Ba1d24B96C71aAE696745b;
    address constant USDC = 0x29219dd400f2Bf60E5a23d13Be72B486D4038894;
    address constant WETH = 0x50c42dEAcD8Fc9773493ED674b675bE577f2634b;
    address constant TREASURY = address(0xBEEF);

    function setUp() public {
        vm.createSelectFork("https://rpc.soniclabs.com");
    }

    function test_pause_deactivate_rescue_flow() public {
        IV1 v1 = IV1(V1);
        address admin = v1.admin();

        // Pre-state
        uint256 usdcBalBefore = IERC20(USDC).balanceOf(V1);
        uint256 wethBalBefore = IERC20(WETH).balanceOf(V1);
        uint256 totalUsdcAlloc = v1.totalUsdcAllocated();
        uint256 totalWethAlloc = v1.totalWethAllocated();

        emit log_named_uint("usdc balance pre", usdcBalBefore);
        emit log_named_uint("weth balance pre", wethBalBefore);
        emit log_named_uint("totalUsdcAllocated pre", totalUsdcAlloc);
        emit log_named_uint("totalWethAllocated pre", totalWethAlloc);

        (, , uint256 usdcTotal, uint256 wethTotal, uint256 usdcClaimed, uint256 wethClaimed, , bool active) =
            v1.rounds(0);
        assertTrue(active, "round 0 should be active");
        emit log_named_uint("round0 unclaimed usdc", usdcTotal - usdcClaimed);
        emit log_named_uint("round0 unclaimed weth", wethTotal - wethClaimed);

        // Step 1: pause
        vm.prank(admin);
        v1.pause();
        assertTrue(v1.paused(), "should be paused");

        // Step 2: deactivate round 0 (releases unclaimed allocation)
        vm.prank(admin);
        v1.deactivateRound(0);

        uint256 totalUsdcAfter = v1.totalUsdcAllocated();
        uint256 totalWethAfter = v1.totalWethAllocated();
        emit log_named_uint("totalUsdcAllocated post-deactivate", totalUsdcAfter);
        emit log_named_uint("totalWethAllocated post-deactivate", totalWethAfter);

        assertEq(totalUsdcAfter, totalUsdcAlloc - (usdcTotal - usdcClaimed), "usdc alloc should drop by unclaimed");
        assertEq(totalWethAfter, totalWethAlloc - (wethTotal - wethClaimed), "weth alloc should drop by unclaimed");

        // Step 3: rescue the now-excess balance
        uint256 rescuableUsdc = usdcBalBefore - totalUsdcAfter;
        uint256 rescuableWeth = wethBalBefore - totalWethAfter;
        emit log_named_uint("rescuable usdc", rescuableUsdc);
        emit log_named_uint("rescuable weth", rescuableWeth);

        vm.startPrank(admin);
        v1.rescueToken(USDC, TREASURY, rescuableUsdc);
        v1.rescueToken(WETH, TREASURY, rescuableWeth);
        vm.stopPrank();

        // Verify treasury received funds
        assertEq(IERC20(USDC).balanceOf(TREASURY), rescuableUsdc, "treasury usdc");
        assertEq(IERC20(WETH).balanceOf(TREASURY), rescuableWeth, "treasury weth");

        // Verify what's left in V1 = exactly what already-claimed users earned but never withdrew?
        // No — claimed funds left V1 already. What's left = totalAllocated post-deactivate
        // which should equal whatever was allocated to OTHER rounds (none here, only round 0 exists).
        uint256 v1UsdcLeft = IERC20(USDC).balanceOf(V1);
        uint256 v1WethLeft = IERC20(WETH).balanceOf(V1);
        emit log_named_uint("v1 usdc left", v1UsdcLeft);
        emit log_named_uint("v1 weth left", v1WethLeft);
        assertEq(v1UsdcLeft, totalUsdcAfter, "v1 usdc remainder == post-deactivate alloc");
        assertEq(v1WethLeft, totalWethAfter, "v1 weth remainder == post-deactivate alloc");
    }
}
