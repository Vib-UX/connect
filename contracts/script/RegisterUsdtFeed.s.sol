// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ShareEscrow} from "../src/ShareEscrow.sol";
import {UsdPegFeed} from "../src/UsdPegFeed.sol";

/// @notice Point the deployed ShareEscrow at a $1 feed for MockUSDT so lock can size a USDT pile.
contract RegisterUsdtFeed is Script {
    address constant ESCROW = 0xda4c60592E42DCC2AED553c38D1F8B517d89e3c7;
    address constant USDT = 0x27Ae80b8eE17ffbCFCf38469A018A942BC8f8Ba9;

    function run() external {
        uint256 settlerKey = vm.envUint("ESCROW_SETTLER_PRIVATE_KEY");
        vm.startBroadcast(settlerKey);
        UsdPegFeed feed = new UsdPegFeed();
        ShareEscrow(ESCROW).setSingleFeed(USDT, address(feed));
        vm.stopBroadcast();
        console2.log("UsdPegFeed", address(feed));
    }
}
