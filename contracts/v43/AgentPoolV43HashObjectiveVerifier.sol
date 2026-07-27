// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentPoolV43ObjectiveVerifier} from "./interfaces/IAgentPoolV43ObjectiveVerifier.sol";

/// @notice Deterministic bootstrap verifier for Base Sepolia. The expected
///         digest must be fixed when the milestone is funded.
contract AgentPoolV43HashObjectiveVerifier is
    IAgentPoolV43ObjectiveVerifier
{
    function verify(
        bytes32 specificationHash,
        bytes32 deliveryHash,
        bytes32 expectedEvidenceHash,
        bytes calldata proof
    ) external pure returns (bool) {
        return
            keccak256(
                abi.encode(
                    specificationHash,
                    deliveryHash,
                    keccak256(proof)
                )
            ) == expectedEvidenceHash;
    }
}
