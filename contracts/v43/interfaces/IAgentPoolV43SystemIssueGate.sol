// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoolV43SystemIssueGate {
    struct IssueTerms {
        bytes32 issueId;
        bytes32 specificationHash;
        bytes32 verifierCodehash;
        uint128 candidateBudgetCap;
        uint128 totalBudgetCap;
        uint16 maxCandidates;
        uint8 funding;
        uint64 expiresAt;
    }

    function consume(
        IssueTerms calldata issue,
        uint128 requestedBudget,
        bytes32[] calldata bootstrapProof
    ) external;
}
