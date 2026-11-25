// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ConnectEscrow} from "../src/ConnectEscrow.sol";
import {MockUSDT} from "../src/MockUSDT.sol";

/// @dev Deploys MockUSDT + ConnectEscrow on BSC testnet (chain id 97).
/// Mints test USDT to the deployer and optional player wallets.
/// Fund player gas separately with cast send (dust tBNB).
contract DeployConnectEscrowTestnet is Script {
    function run() external returns (MockUSDT usdt, ConnectEscrow escrow) {
        address settler = vm.envAddress("ESCROW_SETTLER");
        uint64 deadline = uint64(vm.envOr("ESCROW_SETTLE_DEADLINE", uint256(1 days)));
        uint256 mintAmount = vm.envOr("TESTNET_MINT_USDT", uint256(1 ether));
        uint256 playerMint = vm.envOr("TESTNET_PLAYER_USDT", uint256(0.1 ether));

        address playerA = vm.envOr("PLAYER_A", address(0));
        address playerB = vm.envOr("PLAYER_B", address(0));

        vm.startBroadcast();
        usdt = new MockUSDT();
        escrow = new ConnectEscrow(address(usdt), settler, deadline);
        usdt.mint(msg.sender, mintAmount);
        if (playerA != address(0)) usdt.mint(playerA, playerMint);
        if (playerB != address(0)) usdt.mint(playerB, playerMint);
        vm.stopBroadcast();

        console2.log("MockUSDT", address(usdt));
        console2.log("ConnectEscrow", address(escrow));
        console2.log("Settler", settler);
        console2.log("PlayerA", playerA);
        console2.log("PlayerB", playerB);
        console2.log("PlayerMintUSDT", playerMint);
    }
}
