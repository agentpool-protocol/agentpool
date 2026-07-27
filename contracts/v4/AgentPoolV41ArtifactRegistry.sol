// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IAgentPoolV41EmissionController
} from "./interfaces/IAgentPoolV41.sol";

/// @notice Provenance-only registry for verified public and improvement artifacts.
contract AgentPoolV41ArtifactRegistry {
    struct Artifact {
        bytes32 assignmentId;
        bytes32 contentHash;
        bytes32 provenanceHash;
        bytes32 licenseHash;
        address author;
        uint64 registeredAt;
    }

    IAgentPoolV41EmissionController public immutable controller;
    mapping(bytes32 => Artifact) public artifacts;

    event ArtifactRecorded(
        bytes32 indexed artifactId,
        bytes32 indexed assignmentId,
        bytes32 indexed contentHash,
        address author
    );

    error Unauthorized();
    error InvalidTerms();
    error AlreadyExists();

    constructor(IAgentPoolV41EmissionController controller_) {
        if (address(controller_) == address(0)) revert InvalidTerms();
        controller = controller_;
    }

    function recordArtifact(
        bytes32 artifactId,
        bytes32 assignmentId,
        bytes32 contentHash,
        bytes32 provenanceHash,
        bytes32 licenseHash,
        address author
    ) external {
        if (!controller.isVault(msg.sender)) revert Unauthorized();
        if (
            artifactId == bytes32(0) ||
            assignmentId == bytes32(0) ||
            contentHash == bytes32(0) ||
            provenanceHash == bytes32(0) ||
            licenseHash == bytes32(0) ||
            author == address(0)
        ) revert InvalidTerms();
        if (artifacts[artifactId].registeredAt != 0) revert AlreadyExists();
        artifacts[artifactId] = Artifact({
            assignmentId: assignmentId,
            contentHash: contentHash,
            provenanceHash: provenanceHash,
            licenseHash: licenseHash,
            author: author,
            registeredAt: uint64(block.timestamp)
        });
        emit ArtifactRecorded(
            artifactId,
            assignmentId,
            contentHash,
            author
        );
    }
}
