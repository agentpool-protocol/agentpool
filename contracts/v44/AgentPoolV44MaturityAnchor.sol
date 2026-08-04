// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice One-shot, chain-timestamped authorization for the single 50th
///         SYSTEM settlement. The publication must exist before its JobCreated
///         event; evidence assembled later cannot retroactively authorize it.
contract AgentPoolV44MaturityAnchor {
    bytes32 public constant DOMAIN = keccak256(
        "AGENTPOOL_V44_MATURITY_ANCHOR_V1"
    );

    address public immutable AUTHORITY;
    bytes32 public publicationHash;
    uint64 public publishedAtBlock;

    event MaturityAuthorizationPublished(
        bytes32 indexed publicationHash,
        bytes32 indexed authorizationId,
        bytes32 indexed exposureSlotId,
        bytes32 precommitCheckpointHash,
        bytes32 admissionBundleHash,
        bytes20 evidencePipelineCommit,
        bytes32 deploymentManifestHash
    );

    error InvalidPublication();
    error DuplicatePublication();
    error Unauthorized();

    constructor(address authority_) {
        if (authority_ == address(0) || authority_.code.length == 0) {
            revert InvalidPublication();
        }
        AUTHORITY = authority_;
    }

    function computePublicationHash(
        bytes32 authorizationId,
        bytes32 precommitCheckpointHash,
        bytes32 exposureSlotId,
        bytes32 admissionBundleHash,
        bytes20 evidencePipelineCommit,
        bytes32 deploymentManifestHash
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN,
                block.chainid,
                address(this),
                AUTHORITY,
                authorizationId,
                precommitCheckpointHash,
                exposureSlotId,
                admissionBundleHash,
                evidencePipelineCommit,
                deploymentManifestHash
            )
        );
    }

    function publish(
        bytes32 authorizationId,
        bytes32 precommitCheckpointHash,
        bytes32 exposureSlotId,
        bytes32 admissionBundleHash,
        bytes20 evidencePipelineCommit,
        bytes32 deploymentManifestHash
    ) external returns (bytes32 resolvedPublicationHash) {
        if (msg.sender != AUTHORITY) revert Unauthorized();
        if (
            authorizationId == bytes32(0) ||
            precommitCheckpointHash == bytes32(0) ||
            exposureSlotId == bytes32(0) ||
            admissionBundleHash == bytes32(0) ||
            evidencePipelineCommit == bytes20(0) ||
            deploymentManifestHash == bytes32(0)
        ) revert InvalidPublication();
        if (publicationHash != bytes32(0)) revert DuplicatePublication();
        resolvedPublicationHash = computePublicationHash(
            authorizationId,
            precommitCheckpointHash,
            exposureSlotId,
            admissionBundleHash,
            evidencePipelineCommit,
            deploymentManifestHash
        );
        publicationHash = resolvedPublicationHash;
        publishedAtBlock = uint64(block.number);
        emit MaturityAuthorizationPublished(
            resolvedPublicationHash,
            authorizationId,
            exposureSlotId,
            precommitCheckpointHash,
            admissionBundleHash,
            evidencePipelineCommit,
            deploymentManifestHash
        );
    }
}
