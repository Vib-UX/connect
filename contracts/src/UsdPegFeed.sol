// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice SingleFeed that always answers $1 and stamps the current block.
/// ShareEscrow uses it for USDT, which has no Atlas feed on testnet.
contract UsdPegFeed {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (1, 1 ether, block.timestamp, block.timestamp, 1);
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function description() external pure returns (string memory) {
        return "USDT / USD";
    }
}
