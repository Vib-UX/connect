// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISingleFeed} from "push-oracle-interfaces/src/ISingleFeed.sol";
import {MintableShare} from "../src/MintableShare.sol";
import {ShareEscrow} from "../src/ShareEscrow.sol";

/**
 * Sizes a crossed NVDAB / XAUt bet from the live Atlas SingleFeeds and settles
 * it on a BSC testnet fork. The feeds are the addresses Atlas published.
 * Testnet has no share ERC-20 at those addresses, so the piles are minted here
 * and pointed at the feeds. Nothing is broadcast.
 *
 *   forge test --match-path test/ShareEscrow.fork.t.sol -vv
 */
contract ShareEscrowForkTest is Test {
    /// @dev Atlas SingleFeed NVDAB/USD on BSC testnet. 18 decimals, open read.
    address constant NVDAB_FEED = 0x3eF39d6361EfA1E8Ca066751f438077dA81082A6;
    /// @dev Atlas SingleFeed XAU/USD on BSC testnet, used in place of the Tesla feed.
    address constant XAU_FEED = 0xB3C87F255CE00b2692dc0eaf3e5985fBe2489764;

    uint256 constant USD_STAKE = 1 ether;
    uint64 constant DEADLINE = 1 days;
    uint64 constant MAX_AGE = 3 days;
    string constant DEFAULT_RPC = "https://bsc-testnet.publicnode.com";

    ShareEscrow escrow;
    MintableShare nvda;
    MintableShare xau;
    address settler;
    address ada;
    address bob;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_TESTNET_RPC", DEFAULT_RPC);
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 97, "expected BSC testnet fork (chain id 97)");

        settler = makeAddr("settler");
        ada = makeAddr("ada");
        bob = makeAddr("bob");
        nvda = new MintableShare("Nvidia", "NVDAB");
        xau = new MintableShare("Tether Gold", "XAUt");
        escrow = new ShareEscrow(settler, DEADLINE, MAX_AGE);
        escrow.setSingleFeed(address(nvda), NVDAB_FEED);
        escrow.setSingleFeed(address(xau), XAU_FEED);
    }

    function testFork_liveFeedsSizeThePilesAndWinnerTakesBoth() public {
        (uint256 nvdaShares, uint256 nvdaPrice, uint64 nvdaUpdated) =
            _quoteSingle(address(nvda), NVDAB_FEED, "SingleFeed NVDAB/USD");
        (uint256 xauShares, uint256 xauPrice, uint64 xauUpdated) =
            _quoteSingle(address(xau), XAU_FEED, "SingleFeed XAU/USD");
        assertGt(nvdaShares, 0);
        assertGt(xauShares, 0);
        assertLe(block.timestamp - nvdaUpdated, MAX_AGE);
        assertLe(block.timestamp - xauUpdated, MAX_AGE);

        nvda.mint(ada, nvdaShares);
        xau.mint(bob, xauShares);

        vm.prank(ada);
        nvda.approve(address(escrow), type(uint256).max);
        vm.prank(bob);
        xau.approve(address(escrow), type(uint256).max);
        vm.prank(ada);
        escrow.deposit(address(nvda), nvdaShares);
        vm.prank(bob);
        escrow.deposit(address(xau), xauShares);

        bytes32 betId = keccak256("fork_nvda_xau");
        vm.prank(settler);
        escrow.lock(betId, ada, bob, address(nvda), address(xau), USD_STAKE);

        (,,,, uint256 lockedNvda, uint256 lockedXau, uint256 priceA, uint256 priceB,,,,) = _bet(betId);
        assertEq(lockedNvda, nvdaShares);
        assertEq(lockedXau, xauShares);
        assertEq(priceA, nvdaPrice);
        assertEq(priceB, xauPrice);

        vm.prank(settler);
        escrow.settle(betId, ShareEscrow.Outcome.AWins);

        assertEq(escrow.balanceOf(ada, address(nvda)), nvdaShares);
        assertEq(escrow.balanceOf(ada, address(xau)), xauShares);
        assertEq(escrow.balanceOf(bob, address(nvda)), 0);
        assertEq(escrow.balanceOf(bob, address(xau)), 0);

        vm.prank(settler);
        vm.expectRevert(ShareEscrow.BetNotLocked.selector);
        escrow.settle(betId, ShareEscrow.Outcome.BWins);

        vm.prank(ada);
        escrow.withdraw(address(nvda), nvdaShares);
        vm.prank(ada);
        escrow.withdraw(address(xau), xauShares);
        assertEq(IERC20(address(nvda)).balanceOf(ada), nvdaShares);
        assertEq(IERC20(address(xau)).balanceOf(ada), xauShares);
        assertEq(escrow.balanceOf(ada, address(nvda)), 0);
        assertEq(escrow.balanceOf(ada, address(xau)), 0);
    }

    /// @dev `USD_STAKE` is a dollar amount with 18 decimals. Both testnet
    /// feeds answer with 18 decimals. The share count still uses whatever
    /// `decimals()` the feed reports.
    function _quoteSingle(address token, address feed, string memory expectedDescription)
        internal
        view
        returns (uint256 shares, uint256 price, uint64 updatedAt)
    {
        assertEq(ISingleFeed(feed).description(), expectedDescription);
        (, int256 answer,, uint256 updated,) = ISingleFeed(feed).latestRoundData();
        assertGt(answer, 0, "feed never updated");
        uint8 priceDecimals = ISingleFeed(feed).decimals();
        price = uint256(answer);
        uint8 tokenDecimals = MintableShare(token).decimals();
        assertLe(priceDecimals, 18);
        shares = USD_STAKE * (10 ** tokenDecimals) / (price * (10 ** (18 - priceDecimals)));
        assertGt(shares, 0, "stake rounds to zero");
        updatedAt = uint64(updated);
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
