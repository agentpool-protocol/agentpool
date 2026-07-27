// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IAgentPoolV41EmissionController
} from "./interfaces/IAgentPoolV41.sol";

/// @notice Append-only module and release registry. It never replaces a live module.
contract AgentPoolV41ReleaseRegistry {
    enum ModuleStatus {
        NONE,
        REGISTERED,
        PROVEN,
        CONTESTED
    }

    struct Module {
        address author;
        bytes32 codeHash;
        bytes32 manifestHash;
        bytes32 parentModuleId;
        ModuleStatus status;
        uint64 registeredAt;
        bytes32 proofAssignmentId;
        bytes32 proofHash;
    }

    struct Release {
        address composer;
        bytes32 moduleSetRoot;
        bytes32 policyHash;
        uint64 registeredAt;
    }

    IAgentPoolV41EmissionController public immutable controller;
    mapping(bytes32 => Module) public modules;
    mapping(bytes32 => Release) public releases;

    event ModuleRegistered(
        bytes32 indexed moduleId,
        address indexed author,
        bytes32 indexed codeHash,
        bytes32 manifestHash,
        bytes32 parentModuleId
    );
    event ModuleProven(
        bytes32 indexed moduleId,
        bytes32 indexed assignmentId,
        bytes32 proofHash
    );
    event ModuleContested(bytes32 indexed moduleId, bytes32 indexed evidenceHash);
    event ReleaseRegistered(
        bytes32 indexed releaseId,
        address indexed composer,
        bytes32 moduleSetRoot,
        bytes32 policyHash
    );

    error InvalidTerms();
    error AlreadyExists();
    error Unauthorized();

    constructor(IAgentPoolV41EmissionController controller_) {
        if (address(controller_) == address(0)) revert InvalidTerms();
        controller = controller_;
    }

    function registerModule(
        bytes32 codeHash,
        bytes32 manifestHash,
        bytes32 parentModuleId
    ) external returns (bytes32 moduleId) {
        if (codeHash == bytes32(0) || manifestHash == bytes32(0)) {
            revert InvalidTerms();
        }
        if (
            parentModuleId != bytes32(0) &&
            modules[parentModuleId].status == ModuleStatus.NONE
        ) revert InvalidTerms();
        moduleId = keccak256(
            abi.encode(msg.sender, codeHash, manifestHash, parentModuleId)
        );
        if (modules[moduleId].status != ModuleStatus.NONE) revert AlreadyExists();
        modules[moduleId] = Module({
            author: msg.sender,
            codeHash: codeHash,
            manifestHash: manifestHash,
            parentModuleId: parentModuleId,
            status: ModuleStatus.REGISTERED,
            registeredAt: uint64(block.timestamp),
            proofAssignmentId: bytes32(0),
            proofHash: bytes32(0)
        });
        emit ModuleRegistered(
            moduleId,
            msg.sender,
            codeHash,
            manifestHash,
            parentModuleId
        );
    }

    function recordProven(
        bytes32 moduleId,
        bytes32 assignmentId,
        bytes32 proofHash
    ) external {
        if (!controller.isSystemVault(msg.sender)) revert Unauthorized();
        Module storage module = modules[moduleId];
        if (
            module.status != ModuleStatus.REGISTERED ||
            assignmentId == bytes32(0) ||
            proofHash == bytes32(0)
        ) revert InvalidTerms();
        module.status = ModuleStatus.PROVEN;
        module.proofAssignmentId = assignmentId;
        module.proofHash = proofHash;
        emit ModuleProven(moduleId, assignmentId, proofHash);
    }

    function contestModule(bytes32 moduleId, bytes32 evidenceHash) external {
        if (!controller.isSystemVault(msg.sender)) revert Unauthorized();
        Module storage module = modules[moduleId];
        if (module.status != ModuleStatus.PROVEN || evidenceHash == bytes32(0)) {
            revert InvalidTerms();
        }
        module.status = ModuleStatus.CONTESTED;
        emit ModuleContested(moduleId, evidenceHash);
    }

    function registerRelease(
        bytes32[] calldata moduleIds,
        bytes32 policyHash
    ) external returns (bytes32 releaseId) {
        if (moduleIds.length == 0 || policyHash == bytes32(0)) {
            revert InvalidTerms();
        }
        for (uint256 index = 0; index < moduleIds.length; index++) {
            if (modules[moduleIds[index]].status != ModuleStatus.PROVEN) {
                revert InvalidTerms();
            }
        }
        bytes32 moduleSetRoot = keccak256(abi.encode(moduleIds));
        releaseId = keccak256(
            abi.encode(msg.sender, moduleSetRoot, policyHash)
        );
        if (releases[releaseId].registeredAt != 0) revert AlreadyExists();
        releases[releaseId] = Release({
            composer: msg.sender,
            moduleSetRoot: moduleSetRoot,
            policyHash: policyHash,
            registeredAt: uint64(block.timestamp)
        });
        emit ReleaseRegistered(
            releaseId,
            msg.sender,
            moduleSetRoot,
            policyHash
        );
    }
}
