// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ConnectEscrow} from "../src/ConnectEscrow.sol";

contract MockUSDT is ERC20 {
    constructor() ERC20("Tether USD", "USDT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract ConnectEscrowTest is Test {
    /** BSC testnet sizes: 0.1 deposit, 0.001 stake. */
    uint256 constant DEPOSIT = 0.1 ether;
    uint256 constant STAKE = 0.001 ether;
    uint64 constant DEADLINE = 1 days;

    MockUSDT usdt;
    ConnectEscrow escrow;
    address settler = makeAddr("settler");
    address ada = makeAddr("ada");
    address bob = makeAddr("bob");
    bytes32 bet1 = keccak256("match_1");
    bytes32 bet2 = keccak256("match_2");

    function setUp() public {
        usdt = new MockUSDT();
        escrow = new ConnectEscrow(address(usdt), settler, DEADLINE);
        usdt.mint(ada, DEPOSIT);
        usdt.mint(bob, DEPOSIT);
        vm.prank(ada);
        usdt.approve(address(escrow), type(uint256).max);
        vm.prank(bob);
        usdt.approve(address(escrow), type(uint256).max);
    }

    function _depositBoth(uint256 amount) internal {
        vm.prank(ada);
        escrow.deposit(amount);
        vm.prank(bob);
        escrow.deposit(amount);
    }

    function _lock(bytes32 id) internal {
        vm.prank(settler);
        escrow.lock(id, ada, bob, STAKE);
    }

    function test_oneDepositFundsTwoBetsInSequence() public {
        _depositBoth(DEPOSIT);
        _lock(bet1);
        assertEq(escrow.balanceOf(ada), DEPOSIT - STAKE);
        assertEq(escrow.balanceOf(bob), DEPOSIT - STAKE);

        vm.prank(settler);
        escrow.settle(bet1, ConnectEscrow.Outcome.AWins);
        assertEq(escrow.balanceOf(ada), DEPOSIT + STAKE);
        assertEq(escrow.balanceOf(bob), DEPOSIT - STAKE);

        _lock(bet2);
        vm.prank(settler);
        escrow.settle(bet2, ConnectEscrow.Outcome.BWins);
        assertEq(escrow.balanceOf(ada), DEPOSIT);
        assertEq(escrow.balanceOf(bob), DEPOSIT);
    }

    function test_lockRevertsWhenFreeBalanceIsShort() public {
        vm.prank(ada);
        escrow.deposit(STAKE / 2);
        vm.prank(bob);
        escrow.deposit(DEPOSIT);
        vm.prank(settler);
        vm.expectRevert(ConnectEscrow.InsufficientBalance.selector);
        escrow.lock(bet1, ada, bob, STAKE);
    }

    function test_withdrawCannotTakeLockedStake() public {
        _depositBoth(STAKE);
        _lock(bet1);
        assertEq(escrow.balanceOf(ada), 0);
        vm.prank(ada);
        vm.expectRevert(ConnectEscrow.InsufficientBalance.selector);
        escrow.withdraw(1);
    }

    function test_settleCreditsWinnerOnce() public {
        _depositBoth(DEPOSIT);
        _lock(bet1);
        vm.prank(settler);
        escrow.settle(bet1, ConnectEscrow.Outcome.AWins);
        assertEq(escrow.balanceOf(ada), DEPOSIT + STAKE);
        assertEq(escrow.balanceOf(bob), DEPOSIT - STAKE);

        vm.prank(settler);
        vm.expectRevert(ConnectEscrow.BetNotLocked.selector);
        escrow.settle(bet1, ConnectEscrow.Outcome.BWins);
    }

    function test_drawRestoresBothBalances() public {
        _depositBoth(DEPOSIT);
        _lock(bet1);
        vm.prank(settler);
        escrow.settle(bet1, ConnectEscrow.Outcome.Draw);
        assertEq(escrow.balanceOf(ada), DEPOSIT);
        assertEq(escrow.balanceOf(bob), DEPOSIT);
    }

    function test_refundAfterDeadlineRestoresBoth() public {
        _depositBoth(DEPOSIT);
        _lock(bet1);
        vm.expectRevert(ConnectEscrow.DeadlineNotReached.selector);
        escrow.refund(bet1);

        vm.warp(block.timestamp + DEADLINE);
        escrow.refund(bet1);
        assertEq(escrow.balanceOf(ada), DEPOSIT);
        assertEq(escrow.balanceOf(bob), DEPOSIT);

        (, , , , ConnectEscrow.BetStatus status) = escrow.bets(bet1);
        assertEq(uint8(status), uint8(ConnectEscrow.BetStatus.Refunded));
    }

    function test_twoBetIdsDoNotShareLockedFunds() public {
        _depositBoth(DEPOSIT);
        _lock(bet1);
        _lock(bet2);
        assertEq(escrow.balanceOf(ada), DEPOSIT - STAKE * 2);
        assertEq(escrow.balanceOf(bob), DEPOSIT - STAKE * 2);

        vm.prank(settler);
        escrow.settle(bet1, ConnectEscrow.Outcome.AWins);
        assertEq(escrow.balanceOf(ada), DEPOSIT);
        assertEq(escrow.balanceOf(bob), DEPOSIT - STAKE * 2);

        (, , uint256 stake2, , ConnectEscrow.BetStatus status2) = escrow.bets(bet2);
        assertEq(stake2, STAKE);
        assertEq(uint8(status2), uint8(ConnectEscrow.BetStatus.Locked));
    }

    function test_onlySettlerCanLockAndSettle() public {
        _depositBoth(DEPOSIT);
        vm.expectRevert(ConnectEscrow.NotSettler.selector);
        escrow.lock(bet1, ada, bob, STAKE);

        _lock(bet1);
        vm.expectRevert(ConnectEscrow.NotSettler.selector);
        escrow.settle(bet1, ConnectEscrow.Outcome.AWins);
    }

    function test_duplicateBetIdReverts() public {
        _depositBoth(DEPOSIT);
        _lock(bet1);
        vm.prank(settler);
        vm.expectRevert(ConnectEscrow.BetExists.selector);
        escrow.lock(bet1, ada, bob, STAKE);
    }
}
