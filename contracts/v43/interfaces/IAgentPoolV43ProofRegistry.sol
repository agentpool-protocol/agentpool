// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoolV43ProofRegistry {
    function openRound(
        bytes32 roundId,
        uint64 commitDeadline,
        uint64 revealDeadline
    ) external;

    function revealCount(bytes32 roundId) external view returns (uint16);

    function medianScore(bytes32 roundId) external view returns (uint16);

    function roundReady(bytes32 roundId) external view returns (bool);
}
