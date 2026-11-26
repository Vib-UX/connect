// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMultiFeed} from "push-oracle-interfaces/src/IMultiFeed.sol";
import {ISingleFeed} from "push-oracle-interfaces/src/ISingleFeed.sol";
import {FeedCodec} from "push-oracle-interfaces/src/libraries/FeedCodec.sol";
import {ShareEscrow} from "../src/ShareEscrow.sol";

interface IShareToken is IERC20 {
    function decimals() external view returns (uint8);
}

/**
 * Sizes a crossed NVDAB / TSLAB bet from the live Atlas feeds and settles it
 * on a BSC mainnet fork. Nothing is broadcast.
 *
 *   BSC_MAINNET_RPC=https://bsc-dataseed.binance.org forge test --match-path test/ShareEscrow.fork.t.sol -vv
 */
contract ShareEscrowForkTest is Test {
    using FeedCodec for bytes32;
    address constant NVDAB = 0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436;
    address constant TSLAB = 0x5b1910eAaD6450E50f816082Aa078C41F10C292f;
    /// @dev Atlas SingleFeed NVDAB/USD. 18 decimals, open read.
    address constant NVDAB_FEED = 0xf25Af12920D408bAf6211e9e90eDa89DF3D8CCDa;
    /// @dev Atlas MultiFeed. Tesla is feed id 933, 18 decimals, open read.
    address constant TSLAB_FEED = 0xEAcE519ebB14fB8404fA6DdD23C3b34abaDE44aa;
    bytes4 constant TSLAB_FEED_ID = 0x000003a5;
    /// @dev Mainnet holder used only inside the fork. The test transfers a dust amount to the two players.
    address constant NVDAB_HOLDER = 0x5a52E96BAcdaBb82fd05763E25335261B270Efcb;
    address constant TSLAB_HOLDER = 0x08439901c2bB071cd0812eD329675C9657434083;

    uint256 constant USD_STAKE = 1 ether;
    uint64 constant DEADLINE = 1 days;
    uint64 constant MAX_AGE = 3 days;
    string constant DEFAULT_RPC = "https://bsc-dataseed.binance.org";

    ShareEscrow escrow;
    address settler;
    address ada;
    address bob;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_MAINNET_RPC", DEFAULT_RPC);
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 56, "expected BSC mainnet fork (chain id 56)");

        settler = makeAddr("settler");
        ada = makeAddr("ada");
        bob = makeAddr("bob");
        escrow = new ShareEscrow(settler, DEADLINE, MAX_AGE);
        escrow.setSingleFeed(NVDAB, NVDAB_FEED);
        escrow.setMultiFeed(TSLAB, TSLAB_FEED, TSLAB_FEED_ID);
    }

    function testFork_liveFeedsSizeThePilesAndWinnerTakesBoth() public {
        (uint256 nvdaShares, uint256 nvdaPrice, uint64 nvdaUpdated) = _quoteSingle(NVDAB, NVDAB_FEED, "SingleFeed NVDAB/USD");
        (uint256 tslaShares, uint256 tslaPrice, uint64 tslaUpdated) = _quoteTesla(TSLAB);
        assertGt(nvdaShares, 0);
        assertGt(tslaShares, 0);
        assertLe(block.timestamp - nvdaUpdated, MAX_AGE);
        assertLe(block.timestamp - tslaUpdated, MAX_AGE);

        _fund(NVDAB, NVDAB_HOLDER, ada, nvdaShares);
        _fund(TSLAB, TSLAB_HOLDER, bob, tslaShares);

        vm.prank(ada);
        IShareToken(NVDAB).approve(address(escrow), type(uint256).max);
        vm.prank(bob);
        IShareToken(TSLAB).approve(address(escrow), type(uint256).max);
        vm.prank(ada);
        escrow.deposit(NVDAB, nvdaShares);
        vm.prank(bob);
        escrow.deposit(TSLAB, tslaShares);

        bytes32 betId = keccak256("fork_nvda_tsla");
        vm.prank(settler);
        escrow.lock(betId, ada, bob, NVDAB, TSLAB, USD_STAKE);

        (,,,, uint256 lockedNvda, uint256 lockedTsla, uint256 priceA, uint256 priceB,,,,) = _bet(betId);
        assertEq(lockedNvda, nvdaShares);
        assertEq(lockedTsla, tslaShares);
        assertEq(priceA, nvdaPrice);
        assertEq(priceB, tslaPrice);

        vm.prank(settler);
        escrow.settle(betId, ShareEscrow.Outcome.AWins);

        assertEq(escrow.balanceOf(ada, NVDAB), nvdaShares);
        assertEq(escrow.balanceOf(ada, TSLAB), tslaShares);
        assertEq(escrow.balanceOf(bob, NVDAB), 0);
        assertEq(escrow.balanceOf(bob, TSLAB), 0);

        vm.prank(settler);
        vm.expectRevert(ShareEscrow.BetNotLocked.selector);
        escrow.settle(betId, ShareEscrow.Outcome.BWins);

        vm.prank(ada);
        escrow.withdraw(NVDAB, nvdaShares);
        vm.prank(ada);
        escrow.withdraw(TSLAB, tslaShares);
        assertEq(IShareToken(NVDAB).balanceOf(ada), nvdaShares);
        assertEq(IShareToken(TSLAB).balanceOf(ada), tslaShares);
        assertEq(escrow.balanceOf(ada, NVDAB), 0);
        assertEq(escrow.balanceOf(ada, TSLAB), 0);
    }

    /// @dev Tesla lives on the Atlas MultiFeed. The compact word is decoded
    /// with FeedCodec, then checked against the decoded `fetch` snapshot.
    function _quoteTesla(address token) internal view returns (uint256 shares, uint256 price, uint64 updatedAt) {
        assertEq(IMultiFeed(TSLAB_FEED).description(), "MultiFeed");
        bytes32 packed = IMultiFeed(TSLAB_FEED).fetchCompact(TSLAB_FEED_ID);
        assertFalse(packed.isEmpty(), "tesla feed never updated");
        (uint80 decodedPrice,, uint48 onchainTs) = packed.decode();
        IMultiFeed.PriceSnapshot memory snap = IMultiFeed(TSLAB_FEED).fetch(TSLAB_FEED_ID);
        assertEq(uint256(decodedPrice), uint256(snap.price));
        assertEq(uint256(onchainTs), uint256(snap.onchainTs));
        uint8 priceDecimals = IMultiFeed(TSLAB_FEED).decimals();
        price = uint256(decodedPrice);
        shares = _shares(token, price, priceDecimals);
        updatedAt = uint64(onchainTs);
    }

    /// @dev `USD_STAKE` is a dollar amount with 18 decimals. The Nvidia
    /// SingleFeed answers with 18 decimals. The share count still uses
    /// whatever `decimals()` the feed reports.
    function _quoteSingle(address token, address feed, string memory expectedDescription)
        internal
        returns (uint256 shares, uint256 price, uint64 updatedAt)
    {
        vm.prank(settler, settler);
        assertEq(ISingleFeed(feed).description(), expectedDescription);
        vm.prank(settler, settler);
        (, int256 answer,, uint256 updated,) = ISingleFeed(feed).latestRoundData();
        assertGt(answer, 0, "feed never updated");
        vm.prank(settler, settler);
        uint8 priceDecimals = ISingleFeed(feed).decimals();
        price = uint256(answer);
        shares = _shares(token, price, priceDecimals);
        updatedAt = uint64(updated);
    }

    function _shares(address token, uint256 price, uint8 priceDecimals) internal view returns (uint256 shares) {
        assertLe(priceDecimals, 18);
        uint8 tokenDecimals = IShareToken(token).decimals();
        shares = USD_STAKE * (10 ** tokenDecimals) / (price * (10 ** (18 - priceDecimals)));
        assertGt(shares, 0, "stake rounds to zero");
    }

    function _fund(address token, address holder, address player, uint256 amount) internal {
        uint256 before = IShareToken(token).balanceOf(holder);
        assertGe(before, amount, "holder is short");
        vm.prank(holder);
        IShareToken(token).transfer(player, amount);
        assertEq(IShareToken(token).balanceOf(player), amount);
    }

    function _bet(bytes32 betId)
        internal
        view
        returns (
            address,
            address,
            address,
            address,
            uint256 stakeA,
            uint256 stakeB,
            uint256 priceA,
            uint256 priceB,
            uint64,
            uint64,
            uint64,
            ShareEscrow.BetStatus
        )
    {
        return escrow.bets(betId);
    }
}
