// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoolEscrow {
    enum Outcome {
        PASS,
        FAIL,
        AMBIGUOUS
    }

    function proposeOutcome(uint256 jobId, bytes32 verifierId, Outcome outcome) external;
    function finalizeUnchallenged(uint256 jobId, address[] calldata validatorReceivers) external;
    function resolveChallenge(
        uint256 jobId,
        Outcome outcome,
        address[] calldata validatorReceivers
    ) external;
}
