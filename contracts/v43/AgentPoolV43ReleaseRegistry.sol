// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentPoolV43ReleaseRegistry} from "./interfaces/IAgentPoolV43ReleaseRegistry.sol";

/// @notice Append-only releases. Existing versions are never overwritten and
///         a recommendation is a discovery signal, not a proxy upgrade.
contract AgentPoolV43ReleaseRegistry is IAgentPoolV43ReleaseRegistry {
    enum State {
        NONE,
        CANDIDATE,
        PROVEN,
        RECOMMENDED,
        QUARANTINED
    }

    struct Release {
        bytes32 parent;
        bytes32 moduleHash;
        bytes32 manifestHash;
        uint64 registeredAt;
        State state;
    }

    address public configurationAuthority;
    address public consensus;
    bytes32 public recommendedRelease;
    mapping(bytes32 => Release) public releases;

    event ConsensusConfigured(address indexed consensus);
    event ReleaseRegistered(
        bytes32 indexed releaseId,
        bytes32 indexed parent,
        State state
    );
    event ReleaseRecommended(bytes32 indexed releaseId);
    event ReleaseQuarantined(bytes32 indexed releaseId);

    error Unauthorized();
    error InvalidTerms();
    error AlreadyConfigured();

    constructor(
        bytes32 genesisRelease,
        bytes32 genesisModuleHash,
        bytes32 genesisManifestHash,
        address configurationAuthority_
    ) {
        if (
            genesisRelease == bytes32(0) ||
            genesisModuleHash == bytes32(0) ||
            genesisManifestHash == bytes32(0) ||
            configurationAuthority_ == address(0)
        ) revert InvalidTerms();
        releases[genesisRelease] = Release({
            parent: bytes32(0),
            moduleHash: genesisModuleHash,
            manifestHash: genesisManifestHash,
            registeredAt: uint64(block.timestamp),
            state: State.RECOMMENDED
        });
        recommendedRelease = genesisRelease;
        configurationAuthority = configurationAuthority_;
        emit ReleaseRegistered(
            genesisRelease,
            bytes32(0),
            State.RECOMMENDED
        );
    }

    function configureConsensus(address consensus_) external {
        if (msg.sender != configurationAuthority) revert Unauthorized();
        if (consensus != address(0)) revert AlreadyConfigured();
        if (consensus_ == address(0) || consensus_.code.length == 0) {
            revert InvalidTerms();
        }
        consensus = consensus_;
        configurationAuthority = address(0);
        emit ConsensusConfigured(consensus_);
    }

    function isUsable(bytes32 releaseId) external view override returns (bool) {
        State state = releases[releaseId].state;
        return state == State.PROVEN || state == State.RECOMMENDED;
    }

    function registerProven(
        bytes32 releaseId,
        bytes32 parentRelease,
        bytes32 moduleHash,
        bytes32 manifestHash
    ) external override {
        if (msg.sender != consensus) revert Unauthorized();
        State parentState = releases[parentRelease].state;
        if (
            releaseId == bytes32(0) ||
            releases[releaseId].state != State.NONE ||
            (
                parentState != State.PROVEN &&
                parentState != State.RECOMMENDED
            ) ||
            moduleHash == bytes32(0) ||
            manifestHash == bytes32(0)
        ) revert InvalidTerms();
        releases[releaseId] = Release({
            parent: parentRelease,
            moduleHash: moduleHash,
            manifestHash: manifestHash,
            registeredAt: uint64(block.timestamp),
            state: State.PROVEN
        });
        emit ReleaseRegistered(releaseId, parentRelease, State.PROVEN);
    }

    function recommend(bytes32 releaseId) external override {
        if (msg.sender != consensus) revert Unauthorized();
        Release storage release = releases[releaseId];
        if (release.state != State.PROVEN) revert InvalidTerms();
        release.state = State.RECOMMENDED;
        recommendedRelease = releaseId;
        emit ReleaseRecommended(releaseId);
    }

    function quarantine(bytes32 releaseId) external override {
        if (msg.sender != consensus) revert Unauthorized();
        Release storage release = releases[releaseId];
        if (
            release.state != State.CANDIDATE &&
            release.state != State.PROVEN
        ) revert InvalidTerms();
        release.state = State.QUARANTINED;
        emit ReleaseQuarantined(releaseId);
    }
}
