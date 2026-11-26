// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ISingleFeed} from "push-oracle-interfaces/src/ISingleFeed.sol";
import {MintableShare} from "../src/MintableShare.sol";
import {ShareEscrow} from "../src/ShareEscrow.sol";

/// @notice Deploys ShareEscrow on BSC testnet, points minted NVDAB and XAUt
/// piles at the Atlas SingleFeeds, and runs one deposit, lock, and settle.
contract SimulateShareEscrowTestnet is Script {
    address constant NVDAB_FEED = 0x3eF39d6361EfA1E8Ca066751f438077dA81082A6;
    address constant XAU_FEED = 0xB3C87F255CE00b2692dc0eaf3e5985fBe2489764;
    address constant BNB_FEED = 0x3957d289ee9C38272377786787ea34F9dd29788D;
    uint256 constant USD_STAKE = 1 ether;
    uint256 constant MINT = 1 ether;

    function run() external {
        uint256 settlerKey = vm.envUint("ESCROW_SETTLER_PRIVATE_KEY");
        uint256 keyA = vm.envUint("PLAYER_A_PRIVATE_KEY");
        uint256 keyB = vm.envUint("PLAYER_B_PRIVATE_KEY");
        address settler = vm.addr(settlerKey);
        address playerA = vm.addr(keyA);
        address playerB = vm.addr(keyB);

        vm.startBroadcast(settlerKey);
        ShareEscrow escrow = new ShareEscrow(settler, 1 days, 3 days);
        MintableShare nvda = new MintableShare("Nvidia", "NVDAB");
        MintableShare xau = new MintableShare("Tether Gold", "XAUt");
        escrow.setSingleFeed(address(nvda), NVDAB_FEED);
        escrow.setSingleFeed(address(xau), XAU_FEED);
        escrow.setSingleFeed(address(0), BNB_FEED);
        nvda.mint(playerA, MINT);
        xau.mint(playerB, MINT);
        vm.stopBroadcast();

        vm.startBroadcast(keyA);
        nvda.approve(address(escrow), type(uint256).max);
        escrow.deposit(address(nvda), MINT);
        vm.stopBroadcast();

        vm.startBroadcast(keyB);
        xau.approve(address(escrow), type(uint256).max);
        escrow.deposit(address(xau), MINT);
        vm.stopBroadcast();

        console2.log("A deposited nvda", escrow.balanceOf(playerA, address(nvda)));
        console2.log("B deposited xau", escrow.balanceOf(playerB, address(xau)));

        bytes32 betId = keccak256("testnet_shares_v2");
        vm.startBroadcast(settlerKey);
        escrow.lock(betId, playerA, playerB, address(nvda), address(xau), USD_STAKE);
        escrow.settle(betId, ShareEscrow.Outcome.AWins);
        vm.stopBroadcast();

        (,,,, uint256 stakeA, uint256 stakeB,,,,,,) = escrow.bets(betId);

        vm.startBroadcast(keyA);
        escrow.withdraw(address(nvda), stakeA);
        escrow.withdraw(address(xau), stakeB);
        vm.stopBroadcast();

        console2.log("ShareEscrow", address(escrow));
        console2.log("NVDAB", address(nvda));
        console2.log("XAUt", address(xau));
        console2.log("PlayerA", playerA);
        console2.log("PlayerB", playerB);
        console2.log("StakeA", stakeA);
        console2.log("StakeB", stakeB);
        console2.log("A nvda", nvda.balanceOf(playerA));
        console2.log("A xau", xau.balanceOf(playerA));
    }
}
