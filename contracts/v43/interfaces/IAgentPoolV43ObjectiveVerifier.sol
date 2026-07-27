// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoolV43ObjectiveVerifier {
    function verify(
        bytes32 specificationHash,
        bytes32 deliveryHash,
        bytes32 expectedEvidenceHash,
        bytes calldata proof
    ) external view returns (bool);
}
