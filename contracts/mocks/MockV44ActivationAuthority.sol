// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IV44PolicyAnchor {
    function publish(
        uint64 activationSequence,
        bytes32 policyConfigurationHash,
        bytes32 signerSetHash,
        bytes32 activationSignerSetHash,
        uint16 activationThreshold,
        bytes32 activationBindingsRoot,
        bytes20 evidencePipelineCommit,
        bytes32 previousAnchorHash,
        bytes32 transparencyLogRoot
    ) external returns (bytes32 anchorHash);
}

/// @dev Local-rehearsal stand-in for a threshold Safe. Never deploy this
///      single-caller helper as the production activation authority.
contract MockV44ActivationAuthority {
    function activate(
        IV44PolicyAnchor anchor,
        uint64 activationSequence,
        bytes32 policyConfigurationHash,
        bytes32 signerSetHash,
        bytes32 activationSignerSetHash,
        uint16 activationThreshold,
        bytes32 activationBindingsRoot,
        bytes20 evidencePipelineCommit,
        bytes32 previousAnchorHash,
        bytes32 transparencyLogRoot
    ) external returns (bytes32 anchorHash) {
        return anchor.publish(
            activationSequence,
            policyConfigurationHash,
            signerSetHash,
            activationSignerSetHash,
            activationThreshold,
            activationBindingsRoot,
            evidencePipelineCommit,
            previousAnchorHash,
            transparencyLogRoot
        );
    }
}
