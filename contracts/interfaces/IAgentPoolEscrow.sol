// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoolEscrow {
    enum Outcome {
        PASS,
        FAIL,
        AMBIGUOUS
    }

    function resolveChallenge(uint256 jobId, Outcome outcome, address evaluatorReceiver) external;
}
