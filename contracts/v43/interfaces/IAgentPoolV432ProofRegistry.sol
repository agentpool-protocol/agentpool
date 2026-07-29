// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentPoolV43ProofRegistry} from "./IAgentPoolV43ProofRegistry.sol";

interface IAgentPoolV432ProofRegistry is IAgentPoolV43ProofRegistry {
    function openRoundWithPolicy(
        bytes32 roundId,
        uint64 commitDeadline,
        uint64 revealDeadline,
        bytes32 validatorRoot,
        bytes32 excludedGroup,
        uint16 minimumGroups
    ) external;

    function commitWithProof(
        bytes32 roundId,
        bytes32 commitment,
        bytes32[] calldata validatorProof
    ) external;

    function groupCount(bytes32 roundId) external view returns (uint16);

    /// @return 1 on quorum failure, 2 on a completed failing score,
    ///         and 3 on pass. Reverts while the round is still open.
    function resolutionStatus(
        bytes32 roundId,
        uint16 minimumReveals,
        uint16 minimumGroups,
        uint16 passScoreBps
    ) external view returns (uint8);
}
