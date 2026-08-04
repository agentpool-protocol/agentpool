// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Immutable, non-economic provenance anchor for a dormant mainnet
///         stage. It cannot mint, hold deposits, settle work, activate another
///         contract, or be upgraded. A mature economy requires a separate
///         deployment after its own release gates pass.
contract AgentPoolV44DormantDeploymentAnchor {
    bytes32 public constant DOMAIN = keccak256(
        "AGENTPOOL_V44_DORMANT_DEPLOYMENT_ANCHOR_V1"
    );

    bytes32 public immutable sourceTreeHash;
    bytes32 public immutable releaseConfigHash;
    bytes32 public immutable stagingPolicyHash;
    bytes32 public immutable engineeringEvidenceRoot;
    bytes32 public immutable deploymentCommitment;

    event DormantDeploymentAnchored(
        bytes32 indexed deploymentCommitment,
        bytes32 indexed sourceTreeHash,
        bytes32 indexed engineeringEvidenceRoot,
        bytes32 releaseConfigHash,
        bytes32 stagingPolicyHash,
        uint256 chainId
    );

    error InvalidAnchor();

    constructor(
        bytes32 sourceTreeHash_,
        bytes32 releaseConfigHash_,
        bytes32 stagingPolicyHash_,
        bytes32 engineeringEvidenceRoot_
    ) {
        if (
            sourceTreeHash_ == bytes32(0) ||
            releaseConfigHash_ == bytes32(0) ||
            stagingPolicyHash_ == bytes32(0) ||
            engineeringEvidenceRoot_ == bytes32(0)
        ) revert InvalidAnchor();
        sourceTreeHash = sourceTreeHash_;
        releaseConfigHash = releaseConfigHash_;
        stagingPolicyHash = stagingPolicyHash_;
        engineeringEvidenceRoot = engineeringEvidenceRoot_;
        deploymentCommitment = keccak256(
            abi.encode(
                DOMAIN,
                block.chainid,
                sourceTreeHash_,
                releaseConfigHash_,
                stagingPolicyHash_,
                engineeringEvidenceRoot_
            )
        );
        emit DormantDeploymentAnchored(
            deploymentCommitment,
            sourceTreeHash_,
            engineeringEvidenceRoot_,
            releaseConfigHash_,
            stagingPolicyHash_,
            block.chainid
        );
    }
}
