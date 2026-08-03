// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice One-shot timestamp anchor for an AgentPool reliability policy.
///         The immutable activation authority must be a threshold contract
///         (for example a Safe). The observation clock starts only when that
///         contract executes the activation transaction. Signer rotation is
///         deliberately unsupported: a new authority requires a new anchor
///         deployment and a fresh observation window.
contract AgentPoolV44PolicyAnchor {
    bytes32 public constant DOMAIN = keccak256(
        "AGENTPOOL_V44_POLICY_ACTIVATION_ANCHOR_V2"
    );

    address public immutable ACTIVATION_AUTHORITY;
    mapping(bytes32 => uint64) public anchoredAtBlock;
    bytes32 public activeAnchorHash;

    event PolicyActivationAnchored(
        bytes32 indexed anchorHash,
        uint64 indexed activationSequence,
        bytes32 indexed policyConfigurationHash,
        address activationAuthority,
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
    error Unauthorized();

    constructor(address activationAuthority_) {
        if (
            activationAuthority_ == address(0) ||
            activationAuthority_.code.length == 0
        ) revert InvalidAnchor();
        ACTIVATION_AUTHORITY = activationAuthority_;
    }

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
                ACTIVATION_AUTHORITY,
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
        if (msg.sender != ACTIVATION_AUTHORITY) revert Unauthorized();
        if (
            activationSequence != 1 ||
            policyConfigurationHash == bytes32(0) ||
            signerSetHash == bytes32(0) ||
            activationSignerSetHash == bytes32(0) ||
            activationThreshold < 2 ||
            activationBindingsRoot == bytes32(0) ||
            evidencePipelineCommit == bytes20(0) ||
            transparencyLogRoot == bytes32(0) ||
            previousAnchorHash != bytes32(0)
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
        if (
            activeAnchorHash != bytes32(0) ||
            anchoredAtBlock[anchorHash] != 0
        ) revert DuplicateAnchor();
        activeAnchorHash = anchorHash;
        anchoredAtBlock[anchorHash] = uint64(block.number);
        emit PolicyActivationAnchored(
            anchorHash,
            activationSequence,
            policyConfigurationHash,
            ACTIVATION_AUTHORITY,
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
