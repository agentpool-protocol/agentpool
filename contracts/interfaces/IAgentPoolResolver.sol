// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoolResolver {
    function openDispute(uint256 jobId) external returns (uint256 disputeId);
}
