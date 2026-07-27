// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {
    IAgentPoolV41ArtifactRegistry,
    IAgentPoolV41EmissionController,
    IAgentPoolV41ObjectiveVerifier,
    IAgentPoolV41ReleaseRegistry
} from "./interfaces/IAgentPoolV41.sol";

/// @notice Per-epoch reserve lane. Catalog quorum fixes objective evidence and
///         payout recipients before execution; only the committed proof can mint.
contract AgentPoolV41EpochVault is EIP712, ReentrancyGuard {
    enum State {
        NONE,
        OPEN,
        ACCEPTED,
        DELIVERED,
        SETTLED,
        EXPIRED
    }

    struct Assignment {
        address worker;
        uint128 reservedPayout;
        uint64 deadline;
        State state;
        bytes32 specificationHash;
        bytes32 expectedEvidenceHash;
        bytes32 payoutRoot;
        bytes32 artifactId;
        bytes32 provenanceHash;
        bytes32 licenseHash;
        bytes32 moduleId;
        bytes32 deliveryHash;
    }

    bytes32 public constant TASK_ADMISSION_TYPEHASH = keccak256(
        "TaskAdmission(bytes32 assignmentId,address worker,uint128 reservedPayout,uint64 deadline,bytes32 specificationHash,bytes32 expectedEvidenceHash,bytes32 payoutRoot,bytes32 artifactId,bytes32 provenanceHash,bytes32 licenseHash,bytes32 moduleId)"
    );

    IAgentPoolV41EmissionController public immutable controller;
    uint64 public immutable epoch;
    uint8 public immutable lane;
    bytes32 public immutable issueHash;
    bool public immutable experimentalProof;

    mapping(bytes32 => Assignment) public assignments;

    event AssignmentOpened(
        bytes32 indexed assignmentId,
        address indexed worker,
        uint256 reservedPayout,
        uint64 deadline
    );
    event AssignmentAccepted(bytes32 indexed assignmentId);
    event AssignmentDelivered(bytes32 indexed assignmentId, bytes32 deliveryHash);
    event AssignmentSettled(
        bytes32 indexed assignmentId,
        bytes32 deliveryHash,
        bytes32 proofHash
    );
    event AssignmentExpired(bytes32 indexed assignmentId);

    error InvalidTerms();
    error InvalidState();
    error Unauthorized();
    error InvalidProof();
    error InvalidQuorum();

    constructor(
        IAgentPoolV41EmissionController controller_,
        uint64 epoch_,
        uint8 lane_,
        bytes32 issueHash_,
        bool experimentalProof_
    ) EIP712("AgentPool v4.1 EpochVault", "1") {
        if (address(controller_) == address(0) || lane_ > 3) revert InvalidTerms();
        controller = controller_;
        epoch = epoch_;
        lane = lane_;
        issueHash = issueHash_;
        experimentalProof = experimentalProof_;
    }

    function openAssignment(
        bytes32 assignmentId,
        address worker,
        uint128 reservedPayout,
        uint64 deadline,
        bytes32 specificationHash,
        bytes32 expectedEvidenceHash,
        bytes32 payoutRoot,
        bytes32 artifactId,
        bytes32 provenanceHash,
        bytes32 licenseHash,
        bytes32 moduleId,
        bytes[] calldata catalogSignatures
    ) external nonReentrant {
        if (
            assignmentId == bytes32(0) ||
            worker == address(0) ||
            reservedPayout == 0 ||
            deadline <= block.timestamp ||
            specificationHash == bytes32(0) ||
            expectedEvidenceHash == bytes32(0) ||
            payoutRoot == bytes32(0) ||
            assignments[assignmentId].state != State.NONE
        ) revert InvalidTerms();
        if (lane != 2 && moduleId != bytes32(0)) revert InvalidTerms();
        if (
            artifactId != bytes32(0) &&
            (provenanceHash == bytes32(0) || licenseHash == bytes32(0))
        ) revert InvalidTerms();

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    TASK_ADMISSION_TYPEHASH,
                    assignmentId,
                    worker,
                    reservedPayout,
                    deadline,
                    specificationHash,
                    expectedEvidenceHash,
                    payoutRoot,
                    artifactId,
                    provenanceHash,
                    licenseHash,
                    moduleId
                )
            )
        );
        _verifyCatalogQuorum(digest, catalogSignatures);
        controller.reserveFromVault(reservedPayout);
        assignments[assignmentId] = Assignment({
            worker: worker,
            reservedPayout: reservedPayout,
            deadline: deadline,
            state: State.OPEN,
            specificationHash: specificationHash,
            expectedEvidenceHash: expectedEvidenceHash,
            payoutRoot: payoutRoot,
            artifactId: artifactId,
            provenanceHash: provenanceHash,
            licenseHash: licenseHash,
            moduleId: moduleId,
            deliveryHash: bytes32(0)
        });
        emit AssignmentOpened(
            assignmentId,
            worker,
            reservedPayout,
            deadline
        );
    }

    function accept(bytes32 assignmentId) external {
        Assignment storage assignment = assignments[assignmentId];
        if (assignment.state != State.OPEN || block.timestamp > assignment.deadline) {
            revert InvalidState();
        }
        if (msg.sender != assignment.worker) revert Unauthorized();
        assignment.state = State.ACCEPTED;
        emit AssignmentAccepted(assignmentId);
    }

    function deliver(bytes32 assignmentId, bytes32 deliveryHash) external {
        Assignment storage assignment = assignments[assignmentId];
        if (
            assignment.state != State.ACCEPTED ||
            block.timestamp > assignment.deadline ||
            deliveryHash == bytes32(0)
        ) revert InvalidState();
        if (msg.sender != assignment.worker) revert Unauthorized();
        assignment.deliveryHash = deliveryHash;
        assignment.state = State.DELIVERED;
        emit AssignmentDelivered(assignmentId, deliveryHash);
    }

    function settle(
        bytes32 assignmentId,
        bytes calldata proof,
        address[] calldata recipients,
        uint256[] calldata amounts,
        bytes32 artifactContentHash
    ) external nonReentrant {
        Assignment storage assignment = assignments[assignmentId];
        if (
            assignment.state != State.DELIVERED ||
            recipients.length == 0 ||
            recipients.length != amounts.length ||
            keccak256(abi.encode(recipients, amounts)) != assignment.payoutRoot
        ) revert InvalidState();
        uint256 total;
        for (uint256 index = 0; index < amounts.length; index++) total += amounts[index];
        if (total != assignment.reservedPayout) revert InvalidTerms();
        bool valid = IAgentPoolV41ObjectiveVerifier(
            controller.objectiveVerifier()
        ).verify(
            assignment.specificationHash,
            assignment.deliveryHash,
            assignment.expectedEvidenceHash,
            proof
        );
        if (!valid) revert InvalidProof();

        assignment.state = State.SETTLED;
        controller.mintBatchFromVault(recipients, amounts);
        bytes32 proofHash = keccak256(proof);

        if (assignment.artifactId != bytes32(0)) {
            if (artifactContentHash == bytes32(0)) revert InvalidTerms();
            IAgentPoolV41ArtifactRegistry(controller.artifactRegistry())
                .recordArtifact(
                    assignment.artifactId,
                    assignmentId,
                    artifactContentHash,
                    assignment.provenanceHash,
                    assignment.licenseHash,
                    assignment.worker
                );
        } else if (artifactContentHash != bytes32(0)) {
            revert InvalidTerms();
        }
        if (assignment.moduleId != bytes32(0)) {
            IAgentPoolV41ReleaseRegistry(controller.releaseRegistry())
                .recordProven(assignment.moduleId, assignmentId, proofHash);
        }
        emit AssignmentSettled(
            assignmentId,
            assignment.deliveryHash,
            proofHash
        );
    }

    function expire(bytes32 assignmentId) external nonReentrant {
        Assignment storage assignment = assignments[assignmentId];
        if (
            block.timestamp <= assignment.deadline ||
            (
                assignment.state != State.OPEN &&
                assignment.state != State.ACCEPTED &&
                assignment.state != State.DELIVERED
            )
        ) revert InvalidState();
        assignment.state = State.EXPIRED;
        controller.releaseReservationFromVault(assignment.reservedPayout);
        emit AssignmentExpired(assignmentId);
    }

    function _verifyCatalogQuorum(
        bytes32 digest,
        bytes[] calldata signatures
    ) internal view {
        uint256 quorum = controller.catalogQuorum();
        if (signatures.length < quorum) revert InvalidQuorum();
        address previous;
        uint256 valid;
        for (uint256 index = 0; index < signatures.length; index++) {
            address signer = ECDSA.recover(digest, signatures[index]);
            if (
                signer <= previous ||
                !controller.isCatalogSigner(signer)
            ) revert InvalidQuorum();
            previous = signer;
            valid++;
        }
        if (valid < quorum) revert InvalidQuorum();
    }
}
