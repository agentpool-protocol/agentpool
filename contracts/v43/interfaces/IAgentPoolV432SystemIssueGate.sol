// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoolV432SystemIssueGate {
    struct IssueTerms {
        bytes32 issueId;
        address bootstrapProposer;
        bytes32 specificationHash;
        address verifier;
        bytes32 expectedEvidenceHash;
        bytes32 objectiveRoot;
        bytes32 validatorRoot;
        uint128 candidateBudgetCap;
        uint128 totalBudgetCap;
        uint16 maxCandidates;
        uint16 minimumReveals;
        uint16 passScoreBps;
        uint16 minimumValidatorGroups;
        uint8 funding;
        uint64 expiresAt;
    }

    function consumeFor(
        IssueTerms calldata issue,
        uint128 budget,
        address proposer,
        bytes32[] calldata bootstrapProof
    ) external;

    function approveIssueHash(bytes32 issueHash) external;

    function hashIssue(
        IssueTerms calldata issue
    ) external pure returns (bytes32);
}
