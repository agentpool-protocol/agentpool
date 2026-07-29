// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IAgentPoolV43ContributionLedger
} from "./interfaces/IAgentPoolV43ContributionLedger.sol";

/// @notice Non-transferable proof-of-contribution ledger. Work sources are
///         versioned settlement contracts, not administrators or token holders.
///         A source may be changed only by the evolution consensus after its
///         release has passed voting and independent adoption.
contract AgentPoolV43ContributionLedger is
    IAgentPoolV43ContributionLedger
{
    struct AgentProfile {
        bytes32 group;
        bytes32 runtimeHash;
        bool registered;
    }

    struct Outcome {
        uint128 attempted;
        uint128 successful;
    }

    uint64 public constant EPOCH_DURATION = 7 days;
    uint8 public constant MAX_LOOKBACK = 8;
    uint16 public constant MAX_AGENT_SHARE_BPS = 1_000;
    uint16 public constant BPS = 10_000;
    uint16 public constant MIN_MATURE_AGENTS = 5;
    uint16 public constant MIN_MATURE_GROUPS = 3;
    uint64 public constant MIN_MATURE_SETTLEMENTS = 50;
    uint16 public constant MAX_MATURE_GROUP_SHARE_BPS = 5_000;

    uint64 public immutable genesisStart;
    address public bootstrapAuthority;
    address public consensus;
    bool public override mature;
    uint16 public eligibleAgentCount;
    uint16 public eligibleGroupCount;
    uint16 public activeEpochCount;
    uint64 public successfulSettlementCount;
    uint256 public totalSuccessfulUnits;
    uint256 public largestGroupSuccessfulUnits;

    mapping(address => AgentProfile) public profiles;
    mapping(address => bool) public override isActiveSource;
    mapping(bytes32 => bool) public claimedReceipt;
    mapping(uint64 => mapping(address => Outcome)) public outcomes;
    mapping(
        uint64 =>
            mapping(address => mapping(bytes32 => Outcome))
    ) public runtimeOutcomes;
    mapping(
        uint64 =>
            mapping(
                address =>
                    mapping(bytes32 => mapping(bytes32 => Outcome))
            )
    ) public runtimeCapabilityOutcomes;
    mapping(uint64 => Outcome) public epochTotals;
    mapping(address => bool) public agentBecameEligible;
    mapping(bytes32 => bool) public groupBecameEligible;
    mapping(bytes32 => uint256) public groupSuccessfulUnits;
    mapping(uint64 => bool) public epochBecameActive;

    event AgentRegistered(
        address indexed agent,
        bytes32 indexed operatorGroup,
        bytes32 runtimeHash
    );
    event RuntimeUpdated(address indexed agent, bytes32 runtimeHash);
    event OutcomeRecorded(
        address indexed source,
        address indexed agent,
        bytes32 indexed receiptId,
        uint256 units,
        bool successful
    );
    event RuntimeOutcomeRecorded(
        address indexed agent,
        bytes32 indexed runtimeHash,
        bytes32 indexed receiptId,
        uint256 units,
        bool successful
    );
    event RuntimeCapabilityOutcomeRecorded(
        address indexed agent,
        bytes32 indexed runtimeHash,
        bytes32 indexed capability,
        bytes32 receiptId,
        uint256 units,
        bool successful
    );
    event SourceStatusChanged(address indexed source, bool active);
    event ConsensusConfigured(address indexed consensus);
    event MaturityReached(
        uint16 eligibleAgents,
        uint16 eligibleGroups,
        uint64 successfulSettlements,
        uint16 activeEpochs
    );

    error InvalidTerms();
    error Unauthorized();
    error DuplicateReceipt();
    error AlreadyConfigured();

    constructor(
        uint64 genesisStart_,
        address initialSource_,
        address bootstrapAuthority_
    ) {
        if (
            genesisStart_ < block.timestamp ||
            initialSource_ == address(0) ||
            initialSource_.code.length == 0 ||
            bootstrapAuthority_ == address(0)
        ) revert InvalidTerms();
        genesisStart = genesisStart_;
        bootstrapAuthority = bootstrapAuthority_;
        isActiveSource[initialSource_] = true;
        emit SourceStatusChanged(initialSource_, true);
    }

    function configureConsensus(address consensus_) external {
        if (msg.sender != bootstrapAuthority) revert Unauthorized();
        if (consensus != address(0)) revert AlreadyConfigured();
        if (consensus_ == address(0) || consensus_.code.length == 0) {
            revert InvalidTerms();
        }
        consensus = consensus_;
        bootstrapAuthority = address(0);
        emit ConsensusConfigured(consensus_);
    }

    function register(bytes32 group, bytes32 runtimeHash) external {
        if (
            group == bytes32(0) ||
            runtimeHash == bytes32(0) ||
            profiles[msg.sender].registered
        ) revert InvalidTerms();
        profiles[msg.sender] = AgentProfile({
            group: group,
            runtimeHash: runtimeHash,
            registered: true
        });
        emit AgentRegistered(msg.sender, group, runtimeHash);
    }

    function updateRuntime(bytes32 runtimeHash) external {
        AgentProfile storage profile = profiles[msg.sender];
        if (!profile.registered || runtimeHash == bytes32(0)) {
            revert InvalidTerms();
        }
        profile.runtimeHash = runtimeHash;
        emit RuntimeUpdated(msg.sender, runtimeHash);
    }

    function operatorGroup(
        address agent
    ) external view override returns (bytes32) {
        return profiles[agent].group;
    }

    function currentEpoch() public view override returns (uint64) {
        if (block.timestamp < genesisStart) return 0;
        return
            uint64((block.timestamp - uint256(genesisStart)) / EPOCH_DURATION);
    }

    function recordOutcome(
        bytes32 receiptId,
        address agent,
        bytes32 capability,
        uint128 units,
        bool successful
    ) external {
        if (!isActiveSource[msg.sender]) revert Unauthorized();
        if (
            receiptId == bytes32(0) ||
            agent == address(0) ||
            capability == bytes32(0) ||
            units == 0 ||
            !profiles[agent].registered
        ) revert InvalidTerms();
        if (claimedReceipt[receiptId]) revert DuplicateReceipt();
        claimedReceipt[receiptId] = true;

        uint64 epoch = currentEpoch();
        Outcome storage agentOutcome = outcomes[epoch][agent];
        bytes32 runtimeHash = profiles[agent].runtimeHash;
        Outcome storage runtimeOutcome = runtimeOutcomes[epoch][agent][
            runtimeHash
        ];
        Outcome storage capabilityOutcome = runtimeCapabilityOutcomes[epoch][
            agent
        ][runtimeHash][capability];
        Outcome storage total = epochTotals[epoch];
        agentOutcome.attempted += units;
        runtimeOutcome.attempted += units;
        capabilityOutcome.attempted += units;
        total.attempted += units;
        if (successful) {
            agentOutcome.successful += units;
            runtimeOutcome.successful += units;
            capabilityOutcome.successful += units;
            total.successful += units;
            successfulSettlementCount++;
            totalSuccessfulUnits += units;
            bytes32 group = profiles[agent].group;
            uint256 groupTotal = groupSuccessfulUnits[group] + units;
            groupSuccessfulUnits[group] = groupTotal;
            if (groupTotal > largestGroupSuccessfulUnits) {
                largestGroupSuccessfulUnits = groupTotal;
            }
            if (!agentBecameEligible[agent]) {
                agentBecameEligible[agent] = true;
                eligibleAgentCount++;
            }
            if (!groupBecameEligible[group]) {
                groupBecameEligible[group] = true;
                eligibleGroupCount++;
            }
            if (!epochBecameActive[epoch]) {
                epochBecameActive[epoch] = true;
                activeEpochCount++;
            }
            _maybeMature();
        }
        emit OutcomeRecorded(
            msg.sender,
            agent,
            receiptId,
            units,
            successful
        );
        emit RuntimeCapabilityOutcomeRecorded(
            agent,
            runtimeHash,
            capability,
            receiptId,
            units,
            successful
        );
        emit RuntimeOutcomeRecorded(
            agent,
            runtimeHash,
            receiptId,
            units,
            successful
        );
    }

    function totalSuccessfulAt(
        uint64 endEpoch,
        uint8 lookback
    ) public view override returns (uint256 total) {
        if (lookback == 0 || lookback > MAX_LOOKBACK) revert InvalidTerms();
        uint64 count = endEpoch + 1 < lookback
            ? endEpoch + 1
            : uint64(lookback);
        for (uint64 offset = 0; offset < count; offset++) {
            total += epochTotals[endEpoch - offset].successful;
        }
    }

    function votingPowerAt(
        address agent,
        uint64 endEpoch,
        uint8 lookback
    ) external view override returns (uint256) {
        if (lookback == 0 || lookback > MAX_LOOKBACK) revert InvalidTerms();
        uint64 count = endEpoch + 1 < lookback
            ? endEpoch + 1
            : uint64(lookback);
        uint256 attempted;
        uint256 successful;
        for (uint64 offset = 0; offset < count; offset++) {
            Outcome storage outcome = outcomes[endEpoch - offset][agent];
            attempted += outcome.attempted;
            successful += outcome.successful;
        }
        if (attempted == 0 || successful == 0) return 0;
        uint256 total = totalSuccessfulAt(endEpoch, lookback);
        uint256 shareCap = (total * MAX_AGENT_SHARE_BPS) / BPS;
        uint256 cappedContribution = successful < shareCap
            ? successful
            : shareCap;
        uint256 reliabilityBps = (successful * BPS) / attempted;
        return (cappedContribution * reliabilityBps) / BPS;
    }

    function runtimePerformanceAt(
        address agent,
        bytes32 runtimeHash,
        uint64 endEpoch,
        uint8 lookback
    ) external view override returns (uint256 attempted, uint256 successful) {
        if (
            agent == address(0) ||
            runtimeHash == bytes32(0) ||
            lookback == 0 ||
            lookback > MAX_LOOKBACK
        ) revert InvalidTerms();
        uint64 count = endEpoch + 1 < lookback
            ? endEpoch + 1
            : uint64(lookback);
        for (uint64 offset = 0; offset < count; offset++) {
            Outcome storage outcome = runtimeOutcomes[
                endEpoch - offset
            ][agent][runtimeHash];
            attempted += outcome.attempted;
            successful += outcome.successful;
        }
    }

    function runtimeCapabilityPerformanceAt(
        address agent,
        bytes32 runtimeHash,
        bytes32 capability,
        uint64 endEpoch,
        uint8 lookback
    ) external view override returns (uint256 attempted, uint256 successful) {
        if (
            agent == address(0) ||
            runtimeHash == bytes32(0) ||
            capability == bytes32(0) ||
            lookback == 0 ||
            lookback > MAX_LOOKBACK
        ) revert InvalidTerms();
        uint64 count = endEpoch + 1 < lookback
            ? endEpoch + 1
            : uint64(lookback);
        for (uint64 offset = 0; offset < count; offset++) {
            Outcome storage outcome = runtimeCapabilityOutcomes[
                endEpoch - offset
            ][agent][runtimeHash][capability];
            attempted += outcome.attempted;
            successful += outcome.successful;
        }
    }

    function setSource(address source, bool active) external override {
        if (msg.sender != consensus) revert Unauthorized();
        if (source == address(0) || source.code.length == 0) {
            revert InvalidTerms();
        }
        isActiveSource[source] = active;
        emit SourceStatusChanged(source, active);
    }

    function _maybeMature() internal {
        if (
            mature ||
            eligibleAgentCount < MIN_MATURE_AGENTS ||
            eligibleGroupCount < MIN_MATURE_GROUPS ||
            successfulSettlementCount < MIN_MATURE_SETTLEMENTS ||
            activeEpochCount < 2 ||
            largestGroupSuccessfulUnits * BPS >=
                totalSuccessfulUnits * MAX_MATURE_GROUP_SHARE_BPS
        ) return;
        mature = true;
        emit MaturityReached(
            eligibleAgentCount,
            eligibleGroupCount,
            successfulSettlementCount,
            activeEpochCount
        );
    }
}
