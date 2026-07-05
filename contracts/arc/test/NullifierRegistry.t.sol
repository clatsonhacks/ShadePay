// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/NullifierRegistry.sol";

contract NullifierRegistryTest is Test {
    NullifierRegistry reg;
    address admin = address(0xA11CE);
    address pool = address(0xB0B);
    address stranger = address(0xBAD);

    bytes32 constant N1 = bytes32(uint256(0x1111));

    function setUp() public {
        vm.prank(admin);
        reg = new NullifierRegistry(admin);
        vm.prank(admin);
        reg.setAuthorizedSpender(pool, true);
    }

    function test_authorized_spender_can_spend() public {
        vm.prank(pool);
        bool ok = reg.spend(N1);
        assertTrue(ok, "spend should succeed");
        assertTrue(reg.isSpent(N1), "nullifier should be spent");
    }

    function test_double_spend_reverts() public {
        vm.prank(pool);
        reg.spend(N1);
        vm.prank(pool);
        vm.expectRevert(abi.encodeWithSelector(NullifierRegistry.NullifierAlreadySpent.selector, N1));
        reg.spend(N1);
    }

    function test_unauthorized_spender_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(NullifierRegistry.UnauthorizedSpender.selector, stranger));
        reg.spend(N1);
    }

    function test_revoked_spender_cannot_spend() public {
        vm.prank(admin);
        reg.setAuthorizedSpender(pool, false);
        vm.prank(pool);
        vm.expectRevert(abi.encodeWithSelector(NullifierRegistry.UnauthorizedSpender.selector, pool));
        reg.spend(N1);
    }

    function test_paused_blocks_spend() public {
        vm.prank(admin);
        reg.pause();
        vm.prank(pool);
        vm.expectRevert(); // Pausable: EnforcedPause
        reg.spend(N1);
    }

    function test_non_admin_cannot_authorize() public {
        vm.prank(stranger);
        vm.expectRevert(); // AccessControl
        reg.setAuthorizedSpender(stranger, true);
    }
}
