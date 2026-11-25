// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISingleFeed} from "push-oracle-interfaces/src/ISingleFeed.sol";
import {IMultiFeed} from "push-oracle-interfaces/src/IMultiFeed.sol";
import {FeedCodec} from "push-oracle-interfaces/src/libraries/FeedCodec.sol";

/// @title ShareEscrow
/// @notice One free balance per player per share token. A match locks two
/// piles, which may be different tokens, and the game result pays both piles
/// to the winner. At lock the contract reads each token's Atlas feed, sizes
/// the pile from that price, and freezes the share count.
contract ShareEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using FeedCodec for bytes32;

    enum BetStatus {
        None,
        Locked,
        Settled,
        Refunded
    }

    enum Outcome {
        AWins,
        BWins,
        Draw
    }

    enum FeedKind {
        None,
        Single,
        Multi
    }

    struct Oracle {
        address feed;
        bytes4 feedId;
        FeedKind kind;
    }

    struct Bet {
        address playerA;
        address playerB;
        address tokenA;
        address tokenB;
        uint256 stakeA;
        uint256 stakeB;
        uint256 priceA;
        uint256 priceB;
        uint64 updatedAtA;
        uint64 updatedAtB;
        uint64 lockedAt;
        BetStatus status;
    }

    address public settler;
    uint64 public settleDeadline;
    /// @notice A lock reverts when either feed update is older than this.
    uint64 public maxPriceAge;

    mapping(address player => mapping(address token => uint256)) public balanceOf;
    mapping(bytes32 betId => Bet) public bets;
    mapping(address token => Oracle) public oracles;

    event SettlerUpdated(address indexed settler);
    event SettleDeadlineUpdated(uint64 seconds_);
    event MaxPriceAgeUpdated(uint64 seconds_);
    event OracleUpdated(address indexed token, address indexed feed, bytes4 feedId, FeedKind kind);
    event Deposited(address indexed player, address indexed token, uint256 amount, uint256 balance);
    event Withdrawn(address indexed player, address indexed token, uint256 amount, uint256 balance);
    event Locked(
        bytes32 indexed betId,
        address indexed playerA,
        address indexed playerB,
        address tokenA,
        address tokenB,
        uint256 stakeA,
        uint256 stakeB,
        uint256 priceA,
        uint256 priceB
    );
    event Settled(bytes32 indexed betId, Outcome outcome, uint256 stakeA, uint256 stakeB);
    event Refunded(bytes32 indexed betId);

    error ZeroAddress();
    error ZeroAmount();
    error SamePlayers();
    error InsufficientBalance();
    error BetExists();
    error BetNotLocked();
    error NotSettler();
    error DeadlineNotReached();
    error StalePrice();
    error NoOracle();
    error FeedNeverUpdated();
    error BadPrice();

    modifier onlySettler() {
        if (msg.sender != settler) revert NotSettler();
        _;
    }

    constructor(address settler_, uint64 settleDeadline_, uint64 maxPriceAge_) Ownable(msg.sender) {
        if (settler_ == address(0)) revert ZeroAddress();
        if (settleDeadline_ == 0 || maxPriceAge_ == 0) revert ZeroAmount();
        settler = settler_;
        settleDeadline = settleDeadline_;
        maxPriceAge = maxPriceAge_;
        emit SettlerUpdated(settler_);
        emit SettleDeadlineUpdated(settleDeadline_);
        emit MaxPriceAgeUpdated(maxPriceAge_);
    }

    function setSettler(address settler_) external onlyOwner {
        if (settler_ == address(0)) revert ZeroAddress();
        settler = settler_;
        emit SettlerUpdated(settler_);
    }

    function setSettleDeadline(uint64 seconds_) external onlyOwner {
        if (seconds_ == 0) revert ZeroAmount();
        settleDeadline = seconds_;
        emit SettleDeadlineUpdated(seconds_);
    }

    function setMaxPriceAge(uint64 seconds_) external onlyOwner {
        if (seconds_ == 0) revert ZeroAmount();
        maxPriceAge = seconds_;
        emit MaxPriceAgeUpdated(seconds_);
    }

    /// @notice Point `token` at an Atlas SingleFeed. `latestRoundData` sizes its pile.
    function setSingleFeed(address token, address feed) external onlyOwner {
        _setOracle(token, feed, bytes4(0), FeedKind.Single);
    }

    /// @notice Point `token` at an Atlas MultiFeed id. `fetchCompact` sizes its pile.
    function setMultiFeed(address token, address feed, bytes4 feedId) external onlyOwner {
        if (feedId == bytes4(0)) revert ZeroAmount();
        _setOracle(token, feed, feedId, FeedKind.Multi);
    }

    /// @notice Pull `token` from the caller into their free balance.
    function deposit(address token, uint256 amount) external nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        balanceOf[msg.sender][token] += amount;
        emit Deposited(msg.sender, token, amount, balanceOf[msg.sender][token]);
    }

    /// @notice Send free balance of `token` back to the caller. Locked stakes stay.
    function withdraw(address token, uint256 amount) external nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 free = balanceOf[msg.sender][token];
        if (free < amount) revert InsufficientBalance();
        balanceOf[msg.sender][token] = free - amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount, balanceOf[msg.sender][token]);
    }

    /// @notice Lock two piles sized from the Atlas feeds. `usdStake` is the
    /// dollar amount, 18 decimals, for each side. The share counts freeze here.
    function lock(bytes32 betId, address playerA, address playerB, address tokenA, address tokenB, uint256 usdStake)
        external
        onlySettler
    {
        if (playerA == address(0) || playerB == address(0) || tokenA == address(0) || tokenB == address(0)) {
            revert ZeroAddress();
        }
        if (playerA == playerB) revert SamePlayers();
        if (usdStake == 0) revert ZeroAmount();
        if (bets[betId].status != BetStatus.None) revert BetExists();

        (uint256 stakeA, uint256 priceA, uint64 updatedAtA) = _debit(playerA, tokenA, usdStake);
        (uint256 stakeB, uint256 priceB, uint64 updatedAtB) = _debit(playerB, tokenB, usdStake);
        Bet storage bet = bets[betId];
        bet.playerA = playerA;
        bet.playerB = playerB;
        bet.tokenA = tokenA;
        bet.tokenB = tokenB;
        bet.stakeA = stakeA;
        bet.stakeB = stakeB;
        bet.priceA = priceA;
        bet.priceB = priceB;
        bet.updatedAtA = updatedAtA;
        bet.updatedAtB = updatedAtB;
        bet.lockedAt = uint64(block.timestamp);
        bet.status = BetStatus.Locked;
        emit Locked(betId, playerA, playerB, tokenA, tokenB, stakeA, stakeB, priceA, priceB);
    }

    /// @notice Credit both frozen piles to the winner, or return each pile on a draw.
    function settle(bytes32 betId, Outcome outcome) external onlySettler {
        Bet storage bet = bets[betId];
        if (bet.status != BetStatus.Locked) revert BetNotLocked();

        bet.status = BetStatus.Settled;
        if (outcome == Outcome.AWins) {
            _credit(bet.playerA, bet.tokenA, bet.stakeA);
            _credit(bet.playerA, bet.tokenB, bet.stakeB);
        } else if (outcome == Outcome.BWins) {
            _credit(bet.playerB, bet.tokenA, bet.stakeA);
            _credit(bet.playerB, bet.tokenB, bet.stakeB);
        } else {
            _credit(bet.playerA, bet.tokenA, bet.stakeA);
            _credit(bet.playerB, bet.tokenB, bet.stakeB);
        }
        emit Settled(betId, outcome, bet.stakeA, bet.stakeB);
    }

    /// @notice After the settle deadline, return each locked pile to the player who locked it.
    function refund(bytes32 betId) external {
        Bet storage bet = bets[betId];
        if (bet.status != BetStatus.Locked) revert BetNotLocked();
        if (block.timestamp < uint256(bet.lockedAt) + uint256(settleDeadline)) revert DeadlineNotReached();

        bet.status = BetStatus.Refunded;
        _credit(bet.playerA, bet.tokenA, bet.stakeA);
        _credit(bet.playerB, bet.tokenB, bet.stakeB);
        emit Refunded(betId);
    }

    function _credit(address player, address token, uint256 amount) private {
        balanceOf[player][token] += amount;
    }

    function _debit(address player, address token, uint256 usdStake)
        private
        returns (uint256 stake, uint256 price, uint64 updatedAt)
    {
        uint8 priceDecimals;
        (price, updatedAt, priceDecimals) = _mark(token);
        stake = _shares(token, usdStake, price, priceDecimals);
        if (balanceOf[player][token] < stake) revert InsufficientBalance();
        balanceOf[player][token] -= stake;
    }

    function _setOracle(address token, address feed, bytes4 feedId, FeedKind kind) private {
        if (token == address(0) || feed == address(0)) revert ZeroAddress();
        oracles[token] = Oracle({feed: feed, feedId: feedId, kind: kind});
        emit OracleUpdated(token, feed, feedId, kind);
    }

    /// @dev Same checks as the Atlas consumer: a zero answer has never updated,
    /// and an update older than `maxPriceAge` is stale.
    function _mark(address token) private view returns (uint256 price, uint64 updatedAt, uint8 priceDecimals) {
        Oracle memory oracle = oracles[token];
        if (oracle.kind == FeedKind.None) revert NoOracle();
        if (oracle.kind == FeedKind.Single) {
            (, int256 answer,, uint256 updated,) = ISingleFeed(oracle.feed).latestRoundData();
            if (answer <= 0) revert FeedNeverUpdated();
            price = uint256(answer);
            updatedAt = uint64(updated);
            priceDecimals = ISingleFeed(oracle.feed).decimals();
        } else {
            bytes32 packed = IMultiFeed(oracle.feed).fetchCompact(oracle.feedId);
            if (packed.isEmpty()) revert FeedNeverUpdated();
            (uint80 aggregatedPrice,, uint48 onchainTs) = packed.decode();
            if (aggregatedPrice == 0) revert FeedNeverUpdated();
            price = uint256(aggregatedPrice);
            updatedAt = uint64(onchainTs);
            priceDecimals = IMultiFeed(oracle.feed).decimals();
        }
        if (priceDecimals > 18) revert BadPrice();
        _requireFresh(updatedAt);
    }

    function _shares(address token, uint256 usdStake, uint256 price, uint8 priceDecimals)
        private
        view
        returns (uint256 shares)
    {
        uint8 tokenDecimals = IERC20Metadata(token).decimals();
        shares = usdStake * (10 ** tokenDecimals) / (price * (10 ** (18 - priceDecimals)));
        if (shares == 0) revert ZeroAmount();
    }

    function _requireFresh(uint64 updatedAt) private view {
        if (updatedAt == 0 || updatedAt > block.timestamp) revert StalePrice();
        if (block.timestamp - updatedAt > maxPriceAge) revert StalePrice();
    }
}
