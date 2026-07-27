// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Objective boundary for v4.2 improvement emission.
/// @dev A verifier can validate evidence, but cannot select recipients,
///      payout amounts, or mint tokens.
interface IAgentPoolV42ImprovementVerifier {
    function verifyIssue(
        bytes32 issueHash,
        bytes32 evidenceHash,
        address reproducer,
        bytes calldata proof
    ) external view returns (bool);

    function scoreCandidate(
        bytes32 issueHash,
        bytes32 codeHash,
        bytes32 manifestHash,
        bytes32 deliveryHash,
        address author,
        bytes calldata proof
    ) external view returns (uint16 scoreBps);
}
