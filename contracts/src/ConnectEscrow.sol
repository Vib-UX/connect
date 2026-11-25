// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ConnectEscrow
/// @notice One deposit balance per wallet. Each match locks a stake from that
/// balance; the relay settles the pot back into balances.
contract ConnectEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

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

    struct Bet {
        address playerA;
        address playerB;
        uint256 stake;
        uint64 lockedAt;
        BetStatus status;
    }

    IERC20 public immutable usdt;
    address public settler;
    uint64 public settleDeadline;

    mapping(address => uint256) public balanceOf;
    mapping(bytes32 => Bet) public bets;

    event SettlerUpdated(address indexed settler);
    event SettleDeadlineUpdated(uint64 seconds_);
    event Deposited(address indexed player, uint256 amount, uint256 balance);
    event Withdrawn(address indexed player, uint256 amount, uint256 balance);
    event Locked(bytes32 indexed betId, address indexed playerA, address indexed playerB, uint256 stake);
    event Settled(bytes32 indexed betId, Outcome outcome, uint256 pot);
    event Refunded(bytes32 indexed betId);

    error ZeroAddress();
    error ZeroAmount();
    error SamePlayers();
    error InsufficientBalance();
    error BetExists();
    error BetNotLocked();
    error NotSettler();
    error DeadlineNotReached();

    modifier onlySettler() {
        if (msg.sender != settler) revert NotSettler();
        _;
    }

    constructor(address usdt_, address settler_, uint64 settleDeadline_) Ownable(msg.sender) {
        if (usdt_ == address(0) || settler_ == address(0)) revert ZeroAddress();
        if (settleDeadline_ == 0) revert ZeroAmount();
        usdt = IERC20(usdt_);
        settler = settler_;
        settleDeadline = settleDeadline_;
        emit SettlerUpdated(settler_);
        emit SettleDeadlineUpdated(settleDeadline_);
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

    /// @notice Pull USDT from the caller into their free balance.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdt.safeTransferFrom(msg.sender, address(this), amount);
        balanceOf[msg.sender] += amount;
        emit Deposited(msg.sender, amount, balanceOf[msg.sender]);
    }

    /// @notice Send free balance back to the caller. Locked stakes stay.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 free = balanceOf[msg.sender];
        if (free < amount) revert InsufficientBalance();
        balanceOf[msg.sender] = free - amount;
        usdt.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, balanceOf[msg.sender]);
    }

    /// @notice Lock `stake` from both free balances into a new bet.
    function lock(bytes32 betId, address playerA, address playerB, uint256 stake) external onlySettler {
        if (playerA == address(0) || playerB == address(0)) revert ZeroAddress();
        if (playerA == playerB) revert SamePlayers();
        if (stake == 0) revert ZeroAmount();
        if (bets[betId].status != BetStatus.None) revert BetExists();
        if (balanceOf[playerA] < stake || balanceOf[playerB] < stake) revert InsufficientBalance();

        balanceOf[playerA] -= stake;
        balanceOf[playerB] -= stake;
        bets[betId] = Bet({
            playerA: playerA,
            playerB: playerB,
            stake: stake,
            lockedAt: uint64(block.timestamp),
            status: BetStatus.Locked
        });
        emit Locked(betId, playerA, playerB, stake);
    }

    /// @notice Credit the pot to the winner's free balance, or restore both on a draw.
    function settle(bytes32 betId, Outcome outcome) external onlySettler {
        Bet storage bet = bets[betId];
        if (bet.status != BetStatus.Locked) revert BetNotLocked();

        uint256 stake = bet.stake;
        uint256 pot = stake * 2;
        bet.status = BetStatus.Settled;

        if (outcome == Outcome.AWins) {
            balanceOf[bet.playerA] += pot;
        } else if (outcome == Outcome.BWins) {
            balanceOf[bet.playerB] += pot;
        } else {
            balanceOf[bet.playerA] += stake;
            balanceOf[bet.playerB] += stake;
        }
        emit Settled(betId, outcome, pot);
    }

    /// @notice After the settle deadline, return each locked stake to that player's free balance.
    function refund(bytes32 betId) external {
        Bet storage bet = bets[betId];
        if (bet.status != BetStatus.Locked) revert BetNotLocked();
        if (block.timestamp < uint256(bet.lockedAt) + uint256(settleDeadline)) revert DeadlineNotReached();

        uint256 stake = bet.stake;
        bet.status = BetStatus.Refunded;
        balanceOf[bet.playerA] += stake;
        balanceOf[bet.playerB] += stake;
        emit Refunded(betId);
    }
}
