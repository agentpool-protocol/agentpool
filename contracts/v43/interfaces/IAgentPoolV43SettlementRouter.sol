// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoolV43SettlementRouter {
    function recordOutcome(
        bytes32 receiptId,
        address agent,
        bytes32 capability,
        uint128 units,
        bool successful
    ) external;

    function recordPerformanceOutcome(
        bytes32 receiptId,
        address agent,
        bytes32 capability,
        uint128 units,
        bool successful
    ) external;

    function attestCandidate(
        bytes32 receiptId,
        address proposer,
        bytes32 moduleHash,
        bytes32 manifestHash,
        uint16 qualityBps,
        uint16 baselineQualityBps,
        uint64 cost,
        uint64 baselineCost,
        uint64 latency,
        uint64 baselineLatency,
        uint16 securityRegressions
    ) external;

    function recordAdoption(
        uint256 proposalId,
        address adopter,
        bytes32 receiptId,
        bytes32 releaseId
    ) external;
}
