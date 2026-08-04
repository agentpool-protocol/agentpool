// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentPoolV43ContributionLedger} from "./interfaces/IAgentPoolV43ContributionLedger.sol";
import {IAgentPoolV43SettlementRouter} from "./interfaces/IAgentPoolV43SettlementRouter.sol";

interface IAgentPoolV43EvolutionSink {
    struct CanaryMetrics {
        uint16 qualityBps;
        uint16 baselineQualityBps;
        uint64 cost;
        uint64 baselineCost;
        uint64 latency;
        uint64 baselineLatency;
        uint16 securityRegressions;
    }

    function attestCandidate(
        bytes32 receiptId,
        address proposer,
        bytes32 moduleHash,
        bytes32 manifestHash,
        CanaryMetrics calldata canary
    ) external;

    function recordAdoption(
        uint256 proposalId,
        address adopter,
        bytes32 receiptId,
        bytes32 releaseId
    ) external;
}

/// @notice The only genesis settlement source. It narrows TaskMarket authority
///         to contribution receipts, candidate attestations, and adoptions.
contract AgentPoolV43SettlementRouter is IAgentPoolV43SettlementRouter {
    IAgentPoolV43ContributionLedger public ledger;
    IAgentPoolV43EvolutionSink public consensus;
    address public configurationAuthority;
    address public market;

    event MarketConfigured(address indexed market);

    error Unauthorized();
    error InvalidTerms();
    error AlreadyConfigured();

    constructor(address configurationAuthority_) {
        if (configurationAuthority_ == address(0)) revert InvalidTerms();
        configurationAuthority = configurationAuthority_;
    }

    function configure(
        IAgentPoolV43ContributionLedger ledger_,
        IAgentPoolV43EvolutionSink consensus_,
        address market_
    ) external {
        if (msg.sender != configurationAuthority) revert Unauthorized();
        if (market != address(0)) revert AlreadyConfigured();
        if (
            address(ledger_) == address(0) ||
            address(ledger_).code.length == 0 ||
            address(consensus_) == address(0) ||
            address(consensus_).code.length == 0 ||
            market_ == address(0) ||
            market_.code.length == 0
        ) {
            revert InvalidTerms();
        }
        ledger = ledger_;
        consensus = consensus_;
        market = market_;
        configurationAuthority = address(0);
        emit MarketConfigured(market_);
    }

    function recordOutcome(
        bytes32 receiptId,
        address agent,
        bytes32 capability,
        uint128 units,
        bool successful
    ) external override {
        if (msg.sender != market) revert Unauthorized();
        // The router is the active source seen by the ledger.
        (bool ok, bytes memory result) = address(ledger).call(
            abi.encodeWithSignature(
                "recordOutcome(bytes32,address,bytes32,uint128,bool)",
                receiptId,
                agent,
                capability,
                units,
                successful
            )
        );
        if (!ok) _bubble(result);
    }

    function recordPerformanceOutcome(
        bytes32 receiptId,
        address agent,
        bytes32 capability,
        uint128 units,
        bool successful
    ) external override {
        if (msg.sender != market) revert Unauthorized();
        (bool ok, bytes memory result) = address(ledger).call(
            abi.encodeWithSignature(
                "recordPerformance(bytes32,address,bytes32,uint128,bool)",
                receiptId,
                agent,
                capability,
                units,
                successful
            )
        );
        if (!ok) _bubble(result);
    }

    function recordBootstrapOutcome(
        bytes32 receiptId,
        address agent,
        bytes32 capability,
        uint128 units,
        bool successful
    ) external override {
        if (msg.sender != market) revert Unauthorized();
        (bool ok, bytes memory result) = address(ledger).call(
            abi.encodeWithSignature(
                "recordBootstrapPerformance(bytes32,address,bytes32,uint128,bool)",
                receiptId,
                agent,
                capability,
                units,
                successful
            )
        );
        if (!ok) _bubble(result);
    }

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
    ) external override {
        if (msg.sender != market) revert Unauthorized();
        consensus.attestCandidate(
            receiptId,
            proposer,
            moduleHash,
            manifestHash,
            IAgentPoolV43EvolutionSink.CanaryMetrics({
                qualityBps: qualityBps,
                baselineQualityBps: baselineQualityBps,
                cost: cost,
                baselineCost: baselineCost,
                latency: latency,
                baselineLatency: baselineLatency,
                securityRegressions: securityRegressions
            })
        );
    }

    function recordAdoption(
        uint256 proposalId,
        address adopter,
        bytes32 receiptId,
        bytes32 releaseId
    ) external override {
        if (msg.sender != market) revert Unauthorized();
        consensus.recordAdoption(proposalId, adopter, receiptId, releaseId);
    }

    function _bubble(bytes memory result) private pure {
        assembly ("memory-safe") {
            revert(add(result, 32), mload(result))
        }
    }
}
