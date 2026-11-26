// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ShareEscrow} from "../src/ShareEscrow.sol";

contract MockShare is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockSingleFeed {
    int256 public answer = 180 ether;
    uint256 public updatedAt = 1;

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256, uint256 startedAt, uint256, uint80 answeredInRound)
    {
        return (1, answer, updatedAt, updatedAt, 1);
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }
}

contract MockMultiFeed {
    uint80 public price = 400 ether;
    uint48 public onchainTs = 1;

    function set(uint80 price_, uint48 onchainTs_) external {
        price = price_;
        onchainTs = onchainTs_;
    }

    function fetchCompact(bytes4) external view returns (bytes32 packed) {
        packed = bytes32(uint256(price) | (uint256(onchainTs) << 80) | (uint256(onchainTs) << 128));
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }
}

contract ShareEscrowTest is Test {
    uint256 constant DEPOSIT = 1 ether;
    uint256 constant USD_STAKE = 1 ether;
    uint256 constant PRICE_A = 180 ether;
    uint256 constant PRICE_B = 400 ether;
    uint256 constant STAKE_A = 5555555555555555;
    uint256 constant STAKE_B = 2500000000000000;
    bytes4 constant TSLAB_FEED_ID = 0x000003a5;
    uint64 constant DEADLINE = 1 days;
    uint64 constant MAX_AGE = 3 days;

    MockShare nvda;
    MockShare tsla;
    MockSingleFeed nvdaFeed;
    MockMultiFeed tslaFeed;
    ShareEscrow escrow;
    address settler = makeAddr("settler");
    address ada = makeAddr("ada");
    address bob = makeAddr("bob");
    bytes32 bet1 = keccak256("share_match_1");
    bytes32 bet2 = keccak256("share_match_2");

    function setUp() public {
        vm.warp(1_767_000_000);
        nvda = new MockShare("NVIDIA", "NVDAB");
        tsla = new MockShare("Tesla", "TSLAB");
        nvdaFeed = new MockSingleFeed();
        tslaFeed = new MockMultiFeed();
        nvdaFeed.set(int256(PRICE_A), block.timestamp);
        tslaFeed.set(uint80(PRICE_B), uint48(block.timestamp));
        escrow = new ShareEscrow(settler, DEADLINE, MAX_AGE);
        escrow.setSingleFeed(address(nvda), address(nvdaFeed));
        escrow.setMultiFeed(address(tsla), address(tslaFeed), TSLAB_FEED_ID);
        nvda.mint(ada, DEPOSIT);
        tsla.mint(bob, DEPOSIT);
        vm.prank(ada);
        nvda.approve(address(escrow), type(uint256).max);
        vm.prank(bob);
        tsla.approve(address(escrow), type(uint256).max);
    }

    function _depositBoth() internal {
        vm.prank(ada);
        escrow.deposit(address(nvda), DEPOSIT);
        vm.prank(bob);
        escrow.deposit(address(tsla), DEPOSIT);
    }

    function _lock(bytes32 id) internal {
        vm.prank(settler);
        escrow.lock(id, ada, bob, address(nvda), address(tsla), USD_STAKE);
    }

    function test_winnerReceivesBothPiles() public {
        _depositBoth();
        _lock(bet1);

        vm.prank(settler);
        escrow.settle(bet1, ShareEscrow.Outcome.AWins);

        assertEq(escrow.balanceOf(ada, address(nvda)), DEPOSIT);
        assertEq(escrow.balanceOf(ada, address(tsla)), STAKE_B);
        assertEq(escrow.balanceOf(bob, address(nvda)), 0);
        assertEq(escrow.balanceOf(bob, address(tsla)), DEPOSIT - STAKE_B);

        vm.prank(settler);
        vm.expectRevert(ShareEscrow.BetNotLocked.selector);
        escrow.settle(bet1, ShareEscrow.Outcome.BWins);
    }

    function test_loserOfTheOtherSideReceivesBothPiles() public {
        _depositBoth();
        _lock(bet1);
        vm.prank(settler);
        escrow.settle(bet1, ShareEscrow.Outcome.BWins);

        assertEq(escrow.balanceOf(bob, address(tsla)), DEPOSIT);
        assertEq(escrow.balanceOf(bob, address(nvda)), STAKE_A);
        assertEq(escrow.balanceOf(ada, address(nvda)), DEPOSIT - STAKE_A);
        assertEq(escrow.balanceOf(ada, address(tsla)), 0);
    }

    function test_drawReturnsEachPile() public {
        _depositBoth();
        _lock(bet1);
        vm.prank(settler);
        escrow.settle(bet1, ShareEscrow.Outcome.Draw);
        assertEq(escrow.balanceOf(ada, address(nvda)), DEPOSIT);
        assertEq(escrow.balanceOf(bob, address(tsla)), DEPOSIT);
        assertEq(escrow.balanceOf(ada, address(tsla)), 0);
        assertEq(escrow.balanceOf(bob, address(nvda)), 0);
    }

    function test_lockRevertsWhenFreeBalanceIsShort() public {
        vm.prank(ada);
        escrow.deposit(address(nvda), STAKE_A / 2);
        vm.prank(bob);
        escrow.deposit(address(tsla), DEPOSIT);
        vm.prank(settler);
        vm.expectRevert(ShareEscrow.InsufficientBalance.selector);
        escrow.lock(bet1, ada, bob, address(nvda), address(tsla), USD_STAKE);
    }

    function test_withdrawCannotTakeLockedStake() public {
        vm.prank(ada);
        escrow.deposit(address(nvda), STAKE_A);
        vm.prank(bob);
        escrow.deposit(address(tsla), STAKE_B);
        _lock(bet1);
        assertEq(escrow.balanceOf(ada, address(nvda)), 0);
        vm.prank(ada);
        vm.expectRevert(ShareEscrow.InsufficientBalance.selector);
        escrow.withdraw(address(nvda), 1);
    }

    function test_stalePriceRevertsAndFreshEdgeLocks() public {
        _depositBoth();
        nvdaFeed.set(int256(PRICE_A), block.timestamp - MAX_AGE - 1);
        vm.prank(settler);
        vm.expectRevert(ShareEscrow.StalePrice.selector);
        escrow.lock(bet1, ada, bob, address(nvda), address(tsla), USD_STAKE);

        nvdaFeed.set(int256(PRICE_A), block.timestamp - MAX_AGE);
        vm.prank(settler);
        escrow.lock(bet1, ada, bob, address(nvda), address(tsla), USD_STAKE);
        assertEq(uint8(_status(bet1)), uint8(ShareEscrow.BetStatus.Locked));
    }

    function test_futureOrZeroPriceReverts() public {
        _depositBoth();
        nvdaFeed.set(int256(PRICE_A), block.timestamp + 1);
        vm.prank(settler);
        vm.expectRevert(ShareEscrow.StalePrice.selector);
        escrow.lock(bet1, ada, bob, address(nvda), address(tsla), USD_STAKE);

        nvdaFeed.set(0, block.timestamp);
        vm.prank(settler);
        vm.expectRevert(ShareEscrow.FeedNeverUpdated.selector);
        escrow.lock(bet1, ada, bob, address(nvda), address(tsla), USD_STAKE);
    }

    function test_refundAfterDeadlineReturnsEachPile() public {
        _depositBoth();
        _lock(bet1);
        vm.expectRevert(ShareEscrow.DeadlineNotReached.selector);
        escrow.refund(bet1);

        vm.warp(block.timestamp + DEADLINE);
        escrow.refund(bet1);
        assertEq(escrow.balanceOf(ada, address(nvda)), DEPOSIT);
        assertEq(escrow.balanceOf(bob, address(tsla)), DEPOSIT);
        assertEq(uint8(_status(bet1)), uint8(ShareEscrow.BetStatus.Refunded));
    }

    function test_twoBetsDoNotShareLockedFunds() public {
        _depositBoth();
        _lock(bet1);
        _lock(bet2);
        assertEq(escrow.balanceOf(ada, address(nvda)), DEPOSIT - STAKE_A * 2);
        assertEq(escrow.balanceOf(bob, address(tsla)), DEPOSIT - STAKE_B * 2);

        vm.prank(settler);
        escrow.settle(bet1, ShareEscrow.Outcome.AWins);
        assertEq(escrow.balanceOf(ada, address(nvda)), DEPOSIT - STAKE_A);
        assertEq(escrow.balanceOf(ada, address(tsla)), STAKE_B);
        assertEq(escrow.balanceOf(bob, address(tsla)), DEPOSIT - STAKE_B * 2);
        assertEq(uint8(_status(bet2)), uint8(ShareEscrow.BetStatus.Locked));
    }

    function test_sameTokenCreditsBothStakesToTheWinner() public {
        MockShare share = new MockShare("NVIDIA", "NVDAB");
        MockSingleFeed feed = new MockSingleFeed();
        feed.set(int256(PRICE_A), block.timestamp);
        escrow.setSingleFeed(address(share), address(feed));
        share.mint(ada, DEPOSIT);
        share.mint(bob, DEPOSIT);
        vm.prank(ada);
        share.approve(address(escrow), type(uint256).max);
        vm.prank(bob);
        share.approve(address(escrow), type(uint256).max);
        vm.prank(ada);
        escrow.deposit(address(share), DEPOSIT);
        vm.prank(bob);
        escrow.deposit(address(share), DEPOSIT);

        vm.prank(settler);
        escrow.lock(bet1, ada, bob, address(share), address(share), USD_STAKE);
        vm.prank(settler);
        escrow.settle(bet1, ShareEscrow.Outcome.AWins);
        assertEq(escrow.balanceOf(ada, address(share)), DEPOSIT + STAKE_A);
        assertEq(escrow.balanceOf(bob, address(share)), DEPOSIT - STAKE_A);
    }

    function test_onlySettlerCanLockAndSettle() public {
        _depositBoth();
        vm.expectRevert(ShareEscrow.NotSettler.selector);
        escrow.lock(bet1, ada, bob, address(nvda), address(tsla), USD_STAKE);
        _lock(bet1);
        vm.expectRevert(ShareEscrow.NotSettler.selector);
        escrow.settle(bet1, ShareEscrow.Outcome.AWins);
    }

    function test_duplicateBetIdReverts() public {
        _depositBoth();
        _lock(bet1);
        vm.prank(settler);
        vm.expectRevert(ShareEscrow.BetExists.selector);
        escrow.lock(bet1, ada, bob, address(nvda), address(tsla), USD_STAKE);
    }

    function test_recordedPricesStayOnTheBet() public {
        _depositBoth();
        _lock(bet1);
        (
            ,
            ,
            ,
            ,
            uint256 stakeA,
            uint256 stakeB,
            uint256 priceA,
            uint256 priceB,
            uint64 updatedAtA,
            ,
            ,
            ShareEscrow.BetStatus status
        ) = escrow.bets(bet1);
        assertEq(stakeA, STAKE_A);
        assertEq(stakeB, STAKE_B);
        assertEq(priceA, PRICE_A);
        assertEq(priceB, PRICE_B);
        assertEq(updatedAtA, uint64(block.timestamp));
        assertEq(uint8(status), uint8(ShareEscrow.BetStatus.Locked));
    }

    function test_missingOracleReverts() public {
        _depositBoth();
        MockShare other = new MockShare("Other", "OTHR");
        vm.prank(settler);
        vm.expectRevert(ShareEscrow.NoOracle.selector);
        escrow.lock(bet1, ada, bob, address(other), address(tsla), USD_STAKE);
    }

    function test_stockAgainstNativeBnbPaysBothPiles() public {
        MockSingleFeed bnbFeed = new MockSingleFeed();
        bnbFeed.set(int256(600 ether), block.timestamp);
        escrow.setSingleFeed(address(0), address(bnbFeed));
        uint256 bnbStake = 1666666666666666;

        vm.deal(ada, 1 ether);
        vm.prank(ada);
        escrow.depositNative{value: 1 ether}();
        vm.prank(bob);
        escrow.deposit(address(tsla), DEPOSIT);

        vm.prank(settler);
        escrow.lock(bet1, ada, bob, address(0), address(tsla), USD_STAKE);
        vm.prank(settler);
        escrow.settle(bet1, ShareEscrow.Outcome.AWins);

        assertEq(escrow.balanceOf(ada, address(0)), 1 ether);
        assertEq(escrow.balanceOf(ada, address(tsla)), STAKE_B);
        assertEq(escrow.balanceOf(bob, address(0)), 0);
        assertEq(escrow.balanceOf(bob, address(tsla)), DEPOSIT - STAKE_B);

        (,,,, uint256 stakeA,,,,,,,) = escrow.bets(bet1);
        assertEq(stakeA, bnbStake);

        uint256 before = ada.balance;
        vm.prank(ada);
        escrow.withdraw(address(0), 1 ether);
        assertEq(ada.balance, before + 1 ether);
        assertEq(address(escrow).balance, 0);
    }

    function test_nativeWinnerReceivesTheBnbPile() public {
        MockSingleFeed bnbFeed = new MockSingleFeed();
        bnbFeed.set(int256(600 ether), block.timestamp);
        escrow.setSingleFeed(address(0), address(bnbFeed));
        uint256 bnbStake = 1666666666666666;

        vm.deal(ada, 1 ether);
        vm.prank(ada);
        escrow.depositNative{value: 1 ether}();
        vm.prank(bob);
        escrow.deposit(address(tsla), DEPOSIT);

        vm.prank(settler);
        escrow.lock(bet1, ada, bob, address(0), address(tsla), USD_STAKE);
        vm.prank(settler);
        escrow.settle(bet1, ShareEscrow.Outcome.BWins);

        assertEq(escrow.balanceOf(bob, address(0)), bnbStake);
        assertEq(escrow.balanceOf(bob, address(tsla)), DEPOSIT);
        assertEq(escrow.balanceOf(ada, address(0)), 1 ether - bnbStake);

        uint256 before = bob.balance;
        vm.prank(bob);
        escrow.withdraw(address(0), bnbStake);
        assertEq(bob.balance, before + bnbStake);
    }

    function test_usdtAgainstStockUsesEachFeed() public {
        MockShare usdt = new MockShare("Tether", "USDT");
        MockSingleFeed usdtFeed = new MockSingleFeed();
        usdtFeed.set(int256(1 ether), block.timestamp);
        escrow.setSingleFeed(address(usdt), address(usdtFeed));
        usdt.mint(ada, DEPOSIT);
        nvda.mint(bob, DEPOSIT);
        vm.prank(ada);
        usdt.approve(address(escrow), type(uint256).max);
        vm.prank(bob);
        nvda.approve(address(escrow), type(uint256).max);
        vm.prank(ada);
        escrow.deposit(address(usdt), DEPOSIT);
        vm.prank(bob);
        escrow.deposit(address(nvda), DEPOSIT);

        vm.prank(settler);
        escrow.lock(bet1, ada, bob, address(usdt), address(nvda), USD_STAKE);
        vm.prank(settler);
        escrow.settle(bet1, ShareEscrow.Outcome.BWins);

        assertEq(escrow.balanceOf(bob, address(usdt)), USD_STAKE);
        assertEq(escrow.balanceOf(bob, address(nvda)), DEPOSIT);
        assertEq(escrow.balanceOf(ada, address(usdt)), DEPOSIT - USD_STAKE);
        assertEq(escrow.balanceOf(ada, address(nvda)), 0);
    }

    function test_shortNativeBalanceAndStaleBnbFeedRevert() public {
        MockSingleFeed bnbFeed = new MockSingleFeed();
        bnbFeed.set(int256(600 ether), block.timestamp);
        escrow.setSingleFeed(address(0), address(bnbFeed));
        vm.deal(ada, 1 ether);
        vm.prank(ada);
        escrow.depositNative{value: 1}();
        vm.prank(bob);
        escrow.deposit(address(tsla), DEPOSIT);

        vm.prank(settler);
        vm.expectRevert(ShareEscrow.InsufficientBalance.selector);
        escrow.lock(bet1, ada, bob, address(0), address(tsla), USD_STAKE);

        vm.prank(ada);
        escrow.depositNative{value: 1 ether - 1}();
        bnbFeed.set(int256(600 ether), block.timestamp - MAX_AGE - 1);
        vm.prank(settler);
        vm.expectRevert(ShareEscrow.StalePrice.selector);
        escrow.lock(bet1, ada, bob, address(0), address(tsla), USD_STAKE);
    }

    function test_lockedNativeCannotBeWithdrawn() public {
        MockSingleFeed bnbFeed = new MockSingleFeed();
        bnbFeed.set(int256(600 ether), block.timestamp);
        escrow.setSingleFeed(address(0), address(bnbFeed));
        uint256 bnbStake = 1666666666666666;
        vm.deal(ada, bnbStake);
        vm.prank(ada);
        escrow.depositNative{value: bnbStake}();
        vm.prank(bob);
        escrow.deposit(address(tsla), DEPOSIT);
        vm.prank(settler);
        escrow.lock(bet1, ada, bob, address(0), address(tsla), USD_STAKE);

        vm.prank(ada);
        vm.expectRevert(ShareEscrow.InsufficientBalance.selector);
        escrow.withdraw(address(0), 1);
    }

    function test_erc20DepositRejectsTheNativeSentinel() public {
        vm.expectRevert(ShareEscrow.ZeroAddress.selector);
        escrow.deposit(address(0), 1);
        vm.expectRevert(ShareEscrow.ZeroAmount.selector);
        escrow.depositNative{value: 0}();
    }

    function _status(bytes32 id) internal view returns (ShareEscrow.BetStatus status) {
        (,,,,,,,,,,, status) = escrow.bets(id);
    }
}
