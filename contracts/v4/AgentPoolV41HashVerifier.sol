// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentPoolV41ObjectiveVerifier} from "./interfaces/IAgentPoolV41.sol";

/// @notice Initial objective proof type for deterministic and reproducible work.
/// @dev The expected digest is committed before award. This verifier cannot score
///      subjective work and cannot choose a recipient or payout amount.
contract AgentPoolV41HashVerifier is IAgentPoolV41ObjectiveVerifier {
    function verify(
        bytes32 specificationHash,
        bytes32 deliveryHash,
        bytes32 expectedEvidenceHash,
        bytes calldata proof
    ) external pure returns (bool) {
        return keccak256(
            abi.encode(
                specificationHash,
                deliveryHash,
                keccak256(proof)
            )
        ) == expectedEvidenceHash;
    }
}
