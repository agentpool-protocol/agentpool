// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRandomnessProvider} from "../interfaces/IRandomnessProvider.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IRandomnessConsumer {
    function fulfillRandomness(uint256 requestId, uint256 randomWord) external;
}

/// @notice Base Sepolia testing only. Mainnet deployment scripts reject this provider.
contract MockRandomnessProvider is IRandomnessProvider, Ownable {
    address public consumer;
    uint256 public nextRequestId = 1;

    constructor(address owner_) Ownable(owner_) {}

    function setConsumer(address consumer_) external onlyOwner {
        require(consumer == address(0), "consumer already set");
        consumer = consumer_;
    }

    function requestRandomness(uint256) external returns (uint256 requestId) {
        require(msg.sender == consumer, "consumer only");
        requestId = nextRequestId++;
    }

    function fulfill(uint256 requestId, uint256 randomWord) external {
        IRandomnessConsumer(consumer).fulfillRandomness(requestId, randomWord);
    }
}
