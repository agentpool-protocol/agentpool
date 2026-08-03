// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Ownerless append-only timestamp anchor for AgentPool reliability
///         policies. Anyone may publish a signed policy commitment, but the
///         evidence verifier accepts it only after checking the authorized
///         signer set and two finalized RPC views of this exact event.
contract AgentPoolV44PolicyAnchor {
    bytes32 public constant DOMAIN = keccak256(
        "AGENTPOOL_V44_POLICY_ACTIVATION_ANCHOR_V1"
    );

    mapping(bytes32 => uint64) public anchoredAtBlock;

    event PolicyActivationAnchored(
        bytes32 indexed anchorHash,
        uint64 indexed activationSequence,
        bytes32 indexed policyConfigurationHash,
        bytes32 signerSetHash,
        bytes32 activationSignerSetHash,
        uint16 activationThreshold,
        bytes32 activationBindingsRoot,
        bytes20 evidencePipelineCommit,
        bytes32 previousAnchorHash,
        bytes32 transparencyLogRoot
    );

    error InvalidAnchor();
    error DuplicateAnchor();

    function computeAnchorHash(
        uint64 activationSequence,
        bytes32 policyConfigurationHash,
        bytes32 signerSetHash,
        bytes32 activationSignerSetHash,
        uint16 activationThreshold,
        bytes32 activationBindingsRoot,
        bytes20 evidencePipelineCommit,
        bytes32 previousAnchorHash,
        bytes32 transparencyLogRoot
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN,
                block.chainid,
                address(this),
                activationSequence,
                policyConfigurationHash,
                signerSetHash,
                activationSignerSetHash,
                activationThreshold,
                activationBindingsRoot,
                evidencePipelineCommit,
                previousAnchorHash,
                transparencyLogRoot
            )
        );
    }

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
    ) external returns (bytes32 anchorHash) {
        if (
            activationSequence == 0 ||
            policyConfigurationHash == bytes32(0) ||
            signerSetHash == bytes32(0) ||
            activationSignerSetHash == bytes32(0) ||
            activationThreshold < 2 ||
            activationBindingsRoot == bytes32(0) ||
            evidencePipelineCommit == bytes20(0) ||
            transparencyLogRoot == bytes32(0)
        ) revert InvalidAnchor();
        anchorHash = computeAnchorHash(
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
        if (anchoredAtBlock[anchorHash] != 0) revert DuplicateAnchor();
        anchoredAtBlock[anchorHash] = uint64(block.number);
        emit PolicyActivationAnchored(
            anchorHash,
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
