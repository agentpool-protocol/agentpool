// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IAgentPoolV44PolicyAnchorWriter {
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

interface IAgentPoolV44MaturityAnchorWriter {
    function publish(
        bytes32 authorizationId,
        bytes32 precommitCheckpointHash,
        bytes32 exposureSlotId,
        bytes32 admissionBundleHash,
        bytes20 evidencePipelineCommit,
        bytes32 deploymentManifestHash
    ) external returns (bytes32 publicationHash);
}

/// @notice Immutable, purpose-limited threshold authority for the two v4.4
///         bootstrap publications. Anyone may relay a signed operation, but
///         neither a single owner nor an arbitrary contract caller can execute
///         it. Owners, threshold and executable methods cannot be changed.
contract AgentPoolV44ThresholdAuthority {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    bytes32 public constant DOMAIN = keccak256(
        "AGENTPOOL_V44_THRESHOLD_AUTHORITY_V1"
    );
    bytes32 public constant POLICY_ACTION = keccak256(
        "AGENTPOOL_V44_POLICY_ACTIVATION"
    );
    bytes32 public constant MATURITY_ACTION = keccak256(
        "AGENTPOOL_V44_MATURITY_PUBLICATION"
    );

    address[] private _owners;
    mapping(address => bool) public isOwner;
    uint16 private immutable _threshold;
    uint256 public nonce;

    event ThresholdOperationExecuted(
        bytes32 indexed operationHash,
        bytes32 indexed action,
        uint256 indexed nonce
    );

    error InvalidConfiguration();
    error InvalidOperation();
    error InvalidSignatures();

    constructor(address[] memory owners_, uint16 threshold_) {
        if (
            threshold_ < 2 ||
            owners_.length < threshold_ ||
            owners_.length > type(uint16).max
        ) revert InvalidConfiguration();
        address previous = address(0);
        for (uint256 index = 0; index < owners_.length; index++) {
            address owner = owners_[index];
            // Canonical ascending owners make the signer set unambiguous.
            if (owner == address(0) || owner <= previous) {
                revert InvalidConfiguration();
            }
            isOwner[owner] = true;
            _owners.push(owner);
            previous = owner;
        }
        _threshold = threshold_;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function getThreshold() external view returns (uint16) {
        return _threshold;
    }

    function operationDigest(
        bytes32 actionHash,
        uint256 operationNonce,
        uint64 deadline
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN,
                block.chainid,
                address(this),
                actionHash,
                operationNonce,
                deadline
            )
        ).toEthSignedMessageHash();
    }

    function policyActionHash(
        address anchor,
        uint64 activationSequence,
        bytes32 policyConfigurationHash,
        bytes32 signerSetHash,
        bytes32 activationSignerSetHash,
        uint16 activationThreshold,
        bytes32 activationBindingsRoot,
        bytes20 evidencePipelineCommit,
        bytes32 previousAnchorHash,
        bytes32 transparencyLogRoot
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                POLICY_ACTION,
                anchor,
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

    function maturityActionHash(
        address anchor,
        bytes32 authorizationId,
        bytes32 precommitCheckpointHash,
        bytes32 exposureSlotId,
        bytes32 admissionBundleHash,
        bytes20 evidencePipelineCommit,
        bytes32 deploymentManifestHash
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MATURITY_ACTION,
                anchor,
                authorizationId,
                precommitCheckpointHash,
                exposureSlotId,
                admissionBundleHash,
                evidencePipelineCommit,
                deploymentManifestHash
            )
        );
    }

    function executePolicyActivation(
        IAgentPoolV44PolicyAnchorWriter anchor,
        uint64 activationSequence,
        bytes32 policyConfigurationHash,
        bytes32 signerSetHash,
        bytes32 activationSignerSetHash,
        uint16 activationThreshold,
        bytes32 activationBindingsRoot,
        bytes20 evidencePipelineCommit,
        bytes32 previousAnchorHash,
        bytes32 transparencyLogRoot,
        uint256 operationNonce,
        uint64 deadline,
        bytes[] calldata signatures
    ) external returns (bytes32 anchorHash) {
        bytes32 actionHash = policyActionHash(
            address(anchor),
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
        bytes32 operationHash = _authorize(
            actionHash,
            operationNonce,
            deadline,
            signatures
        );
        anchorHash = anchor.publish(
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
        emit ThresholdOperationExecuted(
            operationHash,
            POLICY_ACTION,
            operationNonce
        );
    }

    function executeMaturityPublication(
        IAgentPoolV44MaturityAnchorWriter anchor,
        bytes32 authorizationId,
        bytes32 precommitCheckpointHash,
        bytes32 exposureSlotId,
        bytes32 admissionBundleHash,
        bytes20 evidencePipelineCommit,
        bytes32 deploymentManifestHash,
        uint256 operationNonce,
        uint64 deadline,
        bytes[] calldata signatures
    ) external returns (bytes32 publicationHash) {
        bytes32 actionHash = maturityActionHash(
            address(anchor),
            authorizationId,
            precommitCheckpointHash,
            exposureSlotId,
            admissionBundleHash,
            evidencePipelineCommit,
            deploymentManifestHash
        );
        bytes32 operationHash = _authorize(
            actionHash,
            operationNonce,
            deadline,
            signatures
        );
        publicationHash = anchor.publish(
            authorizationId,
            precommitCheckpointHash,
            exposureSlotId,
            admissionBundleHash,
            evidencePipelineCommit,
            deploymentManifestHash
        );
        emit ThresholdOperationExecuted(
            operationHash,
            MATURITY_ACTION,
            operationNonce
        );
    }

    function _authorize(
        bytes32 actionHash,
        uint256 operationNonce,
        uint64 deadline,
        bytes[] calldata signatures
    ) private returns (bytes32 digest) {
        if (
            actionHash == bytes32(0) ||
            operationNonce != nonce ||
            deadline < block.timestamp
        ) revert InvalidOperation();
        if (signatures.length < _threshold) revert InvalidSignatures();
        digest = operationDigest(actionHash, operationNonce, deadline);
        address previous = address(0);
        for (uint256 index = 0; index < signatures.length; index++) {
            address signer = digest.recover(signatures[index]);
            if (!isOwner[signer] || signer <= previous) {
                revert InvalidSignatures();
            }
            previous = signer;
        }
        nonce = operationNonce + 1;
    }
}
