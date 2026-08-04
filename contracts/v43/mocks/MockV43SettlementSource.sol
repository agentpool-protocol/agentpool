// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    AgentPoolV43ContributionLedger
} from "../AgentPoolV43ContributionLedger.sol";
import {
    AgentPoolV43EvolutionConsensus
} from "../AgentPoolV43EvolutionConsensus.sol";

contract MockV43SettlementSource {
    bytes32 private constant GENERIC_CAPABILITY =
        keccak256("AGENTPOOL_GENERIC_CAPABILITY");

    AgentPoolV43ContributionLedger public ledger;
    AgentPoolV43EvolutionConsensus public consensus;
    bool public configured;

    function configure(
        AgentPoolV43ContributionLedger ledger_,
        AgentPoolV43EvolutionConsensus consensus_
    ) external {
        require(!configured);
        ledger = ledger_;
        consensus = consensus_;
        configured = true;
    }

    function record(
        bytes32 receiptId,
        address agent,
        uint128 units,
        bool successful
    ) external {
        ledger.recordOutcome(
            receiptId,
            agent,
            GENERIC_CAPABILITY,
            units,
            successful
        );
    }

    function adopt(
        uint256 proposalId,
        address adopter,
        bytes32 receiptId,
        bytes32 releaseId
    ) external {
        consensus.recordAdoption(
            proposalId,
            adopter,
            receiptId,
            releaseId
        );
    }

    function attest(
        bytes32 receiptId,
        address proposer,
        bytes32 moduleHash,
        bytes32 manifestHash,
        AgentPoolV43EvolutionConsensus.CanaryMetrics calldata canary
    ) external {
        consensus.attestCandidate(
            receiptId,
            proposer,
            moduleHash,
            manifestHash,
            canary
        );
    }
}
