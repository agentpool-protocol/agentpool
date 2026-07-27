// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoolV41ObjectiveVerifier {
    function verify(
        bytes32 specificationHash,
        bytes32 deliveryHash,
        bytes32 expectedEvidenceHash,
        bytes calldata proof
    ) external view returns (bool);
}

interface IAgentPoolV41EmissionController {
    function isCatalogSigner(address signer) external view returns (bool);
    function catalogQuorum() external view returns (uint8);
    function isVault(address candidate) external view returns (bool);
    function isSystemVault(address candidate) external view returns (bool);
    function objectiveVerifier() external view returns (address);
    function releaseRegistry() external view returns (address);
    function artifactRegistry() external view returns (address);

    function mintBatchFromVault(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external;

    function reserveFromVault(uint256 amount) external;
    function releaseReservationFromVault(uint256 amount) external;
}

interface IAgentPoolV41ReleaseRegistry {
    function recordProven(
        bytes32 moduleId,
        bytes32 assignmentId,
        bytes32 proofHash
    ) external;
}

interface IAgentPoolV41ArtifactRegistry {
    function recordArtifact(
        bytes32 artifactId,
        bytes32 assignmentId,
        bytes32 contentHash,
        bytes32 provenanceHash,
        bytes32 licenseHash,
        address author
    ) external;
}
