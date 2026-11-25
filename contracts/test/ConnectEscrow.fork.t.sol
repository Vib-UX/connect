// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ConnectEscrow} from "../src/ConnectEscrow.sol";
import {MockUSDT} from "../src/MockUSDT.sol";

/**
 * Runs the escrow flow on a live BSC testnet fork.
 * No faucet needed: vm.deal covers gas, MockUSDT.mint covers the 0.1 deposits.
 *
 *   forge test --match-path test/ConnectEscrow.fork.t.sol -vv
 *   BNB_RPC_URL=https://... forge test --match-path test/ConnectEscrow.fork.t.sol
 */
contract ConnectEscrowForkTest is Test {
    uint256 constant DEPOSIT = 0.1 ether;
    uint256 constant STAKE = 0.001 ether;
    uint64 constant DEADLINE = 1 days;

    string constant DEFAULT_RPC = "https://data-seed-prebsc-1-s1.bnbchain.org:8545";

    MockUSDT usdt;
    ConnectEscrow escrow;
    address settler;
    address ada;
    address bob;

    function setUp() public {
        string memory rpc = vm.envOr("BNB_RPC_URL", DEFAULT_RPC);
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 97, "expected BSC testnet fork (chain id 97)");

        settler = makeAddr("settler");
        ada = makeAddr("ada");
        bob = makeAddr("bob");

        // Gas on the fork without a faucet.
        vm.deal(settler, 1 ether);
        vm.deal(ada, 1 ether);
        vm.deal(bob, 1 ether);

        usdt = new MockUSDT();
        escrow = new ConnectEscrow(address(usdt), settler, DEADLINE);

        usdt.mint(ada, DEPOSIT);
        usdt.mint(bob, DEPOSIT);
        vm.prank(ada);
        usdt.approve(address(escrow), type(uint256).max);
        vm.prank(bob);
        usdt.approve(address(escrow), type(uint256).max);
    }

    function testFork_chainIsBscTestnet() public view {
        assertEq(block.chainid, 97);
        assertTrue(address(escrow).code.length > 0);
        assertTrue(address(usdt).code.length > 0);
    }

    function testFork_oneDepositFundsTwoBets() public {
        vm.prank(ada);
        escrow.deposit(DEPOSIT);
        vm.prank(bob);
        escrow.deposit(DEPOSIT);

        bytes32 bet1 = keccak256("fork_match_1");
        bytes32 bet2 = keccak256("fork_match_2");

        vm.prank(settler);
        escrow.lock(bet1, ada, bob, STAKE);
        assertEq(escrow.balanceOf(ada), DEPOSIT - STAKE);
        assertEq(escrow.balanceOf(bob), DEPOSIT - STAKE);

        vm.prank(settler);
        escrow.settle(bet1, ConnectEscrow.Outcome.AWins);
        assertEq(escrow.balanceOf(ada), DEPOSIT + STAKE);
        assertEq(escrow.balanceOf(bob), DEPOSIT - STAKE);

        vm.prank(settler);
        escrow.lock(bet2, ada, bob, STAKE);
        vm.prank(settler);
        escrow.settle(bet2, ConnectEscrow.Outcome.BWins);
        assertEq(escrow.balanceOf(ada), DEPOSIT);
        assertEq(escrow.balanceOf(bob), DEPOSIT);
    }

    function testFork_drawAndWithdraw() public {
        vm.prank(ada);
        escrow.deposit(DEPOSIT);
        vm.prank(bob);
        escrow.deposit(DEPOSIT);

        bytes32 betId = keccak256("fork_draw");
        vm.prank(settler);
        escrow.lock(betId, ada, bob, STAKE);
        vm.prank(settler);
        escrow.settle(betId, ConnectEscrow.Outcome.Draw);

        assertEq(escrow.balanceOf(ada), DEPOSIT);
        assertEq(escrow.balanceOf(bob), DEPOSIT);

        uint256 before = usdt.balanceOf(ada);
        vm.prank(ada);
        escrow.withdraw(DEPOSIT);
        assertEq(usdt.balanceOf(ada), before + DEPOSIT);
        assertEq(escrow.balanceOf(ada), 0);
    }

    function testFork_shortBalanceCannotLock() public {
        vm.prank(ada);
        escrow.deposit(STAKE / 2);
        vm.prank(bob);
        escrow.deposit(DEPOSIT);

        vm.prank(settler);
        vm.expectRevert(ConnectEscrow.InsufficientBalance.selector);
        escrow.lock(keccak256("fork_short"), ada, bob, STAKE);
    }
}
