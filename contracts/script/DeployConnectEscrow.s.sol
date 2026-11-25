// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {ConnectEscrow} from "../src/ConnectEscrow.sol";

/// @dev USDT on BNB Smart Chain.
address constant USDT_BNB = 0x55d398326f99059fF775485246999027B3197955;

contract DeployConnectEscrow is Script {
    function run() external returns (ConnectEscrow escrow) {
        address settler = vm.envAddress("ESCROW_SETTLER");
        uint64 deadline = uint64(vm.envOr("ESCROW_SETTLE_DEADLINE", uint256(1 days)));
        vm.startBroadcast();
        escrow = new ConnectEscrow(USDT_BNB, settler, deadline);
        vm.stopBroadcast();
    }
}
