// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {
    IAgentPoolV43ContributionLedger
} from "./interfaces/IAgentPoolV43ContributionLedger.sol";
import {
    IAgentPoolV43ReleaseRegistry
} from "./interfaces/IAgentPoolV43ReleaseRegistry.sol";

/// @notice Ownerless release recommendation consensus. It never upgrades a
///         running contract or moves user funds. A release becomes recommended
///         only after an objective canary gate, contribution-weighted
///         commit/reveal vote, and independent successful adoption.
contract AgentPoolV43EvolutionConsensus is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum ProposalState {
        NONE,
        COMMIT,
        REVEAL,
        ADOPTION,
        RECOMMENDED,
        REJECTED,
        EXPIRED
    }

    enum ReleaseState {
        NONE,
        CANDIDATE,
        PROVEN,
        RECOMMENDED,
        QUARANTINED
    }

    struct Proposal {
        address proposer;
        address proposedSource;
        bytes32 parentRelease;
        bytes32 releaseId;
        bytes32 moduleHash;
        bytes32 manifestHash;
        uint64 snapshotEpoch;
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint64 adoptionDeadline;
        uint128 bond;
        uint128 yesWeight;
        uint128 noWeight;
        uint16 voterCount;
        uint16 groupCount;
        uint16 adoptionCount;
        uint16 adoptionGroupCount;
        ProposalState state;
        bool sourceActivation;
        bool alreadyProven;
    }

    struct Vote {
        bytes32 commitment;
        uint128 weight;
        bool revealed;
        bool support;
    }

    struct CanaryMetrics {
        uint16 qualityBps;
        uint16 baselineQualityBps;
        uint64 cost;
        uint64 baselineCost;
        uint64 latency;
        uint64 baselineLatency;
        uint16 securityRegressions;
    }

    struct CandidateAttestation {
        address proposer;
        bytes32 moduleHash;
        bytes32 manifestHash;
        bytes32 canaryHash;
        bool used;
    }

    uint16 public constant BPS = 10_000;
    uint16 public constant QUORUM_BPS = 3_000;
    uint16 public constant SUPERMAJORITY_BPS = 6_667;
    uint16 public constant MIN_VOTERS = 5;
    uint16 public constant MIN_GROUPS = 3;
    uint16 public constant MIN_ADOPTIONS = 5;
    uint16 public constant MIN_ADOPTION_GROUPS = 3;
    uint8 public constant CONTRIBUTION_LOOKBACK = 8;
    uint64 public constant MIN_PHASE_DURATION = 1 days;

    IERC20 public immutable token;
    IAgentPoolV43ContributionLedger public immutable ledger;
    IAgentPoolV43ReleaseRegistry public immutable releaseRegistry;
    bytes32 public immutable financeInvariantHash;
    uint128 public immutable minimumProposalBond;

    uint256 public nextProposalId = 1;
    bytes32 public recommendedRelease;
    uint256 public slashPool;

    mapping(uint256 => Proposal) public proposals;
    mapping(bytes32 => ReleaseState) public releaseStates;
    mapping(bytes32 => bytes32) public releaseParents;
    mapping(bytes32 => CanaryMetrics) public releaseCanaries;
    mapping(uint256 => mapping(address => Vote)) public votes;
    mapping(uint256 => mapping(bytes32 => bool)) public representedGroup;
    mapping(uint256 => mapping(address => bool)) public adoptedBy;
    mapping(uint256 => mapping(bytes32 => bool)) public adoptionGroup;
    mapping(bytes32 => bool) public adoptionReceipt;
    mapping(bytes32 => CandidateAttestation) public candidateAttestations;

    event ReleaseProposed(
        uint256 indexed proposalId,
        bytes32 indexed releaseId,
        bytes32 indexed parentRelease,
        address proposer
    );
    event CandidateAttested(
        bytes32 indexed receiptId,
        address indexed source,
        address indexed proposer,
        bytes32 moduleHash
    );
    event VoteCommitted(
        uint256 indexed proposalId,
        address indexed voter,
        uint256 weight
    );
    event VoteRevealed(
        uint256 indexed proposalId,
        address indexed voter,
        bool support,
        uint256 weight
    );
    event ReleaseProven(uint256 indexed proposalId, bytes32 indexed releaseId);
    event AdoptionRecorded(
        uint256 indexed proposalId,
        address indexed adopter,
        bytes32 indexed receiptId
    );
    event ReleaseRecommended(
        uint256 indexed proposalId,
        bytes32 indexed releaseId
    );
    event ReleaseQuarantined(bytes32 indexed releaseId);
    event ProposalClosed(uint256 indexed proposalId, ProposalState state);

    error InvalidTerms();
    error InvalidState();
    error Unauthorized();
    error DuplicateParticipation();
    error InsufficientConsensus();

    constructor(
        IERC20 token_,
        IAgentPoolV43ContributionLedger ledger_,
        IAgentPoolV43ReleaseRegistry releaseRegistry_,
        bytes32 financeInvariantHash_,
        bytes32 genesisRelease_,
        uint128 minimumProposalBond_
    ) {
        if (
            address(token_) == address(0) ||
            address(ledger_) == address(0) ||
            address(releaseRegistry_) == address(0) ||
            financeInvariantHash_ == bytes32(0) ||
            genesisRelease_ == bytes32(0) ||
            minimumProposalBond_ == 0
        ) revert InvalidTerms();
        token = token_;
        ledger = ledger_;
        releaseRegistry = releaseRegistry_;
        financeInvariantHash = financeInvariantHash_;
        minimumProposalBond = minimumProposalBond_;
        recommendedRelease = genesisRelease_;
        releaseStates[genesisRelease_] = ReleaseState.RECOMMENDED;
    }

    function voteCommitment(
        uint256 proposalId,
        address voter,
        bool support,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(proposalId, voter, support, salt));
    }

    function attestCandidate(
        bytes32 receiptId,
        address proposer,
        bytes32 moduleHash,
        bytes32 manifestHash,
        CanaryMetrics calldata canary
    ) external {
        if (
            !ledger.isActiveSource(msg.sender) ||
            receiptId == bytes32(0) ||
            proposer == address(0) ||
            moduleHash == bytes32(0) ||
            manifestHash == bytes32(0) ||
            candidateAttestations[receiptId].proposer != address(0)
        ) revert InvalidTerms();
        _checkCanary(canary);
        candidateAttestations[receiptId] = CandidateAttestation({
            proposer: proposer,
            moduleHash: moduleHash,
            manifestHash: manifestHash,
            canaryHash: keccak256(abi.encode(canary)),
            used: false
        });
        emit CandidateAttested(
            receiptId,
            msg.sender,
            proposer,
            moduleHash
        );
    }

    function proposeRelease(
        bytes32 candidateReceiptId,
        bytes32 parentRelease,
        bytes32 releaseId,
        bytes32 moduleHash,
        bytes32 manifestHash,
        bytes32 claimedFinanceInvariantHash,
        address proposedSource,
        bool sourceActivation,
        CanaryMetrics calldata canary,
        uint128 bond,
        uint64 commitDeadline,
        uint64 revealDeadline,
        uint64 adoptionDeadline
    ) external nonReentrant returns (uint256 proposalId) {
        if (!ledger.mature()) revert Unauthorized();
        if (
            releaseStates[parentRelease] != ReleaseState.PROVEN &&
            releaseStates[parentRelease] != ReleaseState.RECOMMENDED
        ) revert InvalidTerms();
        if (
            releaseId == bytes32(0) ||
            releaseStates[releaseId] != ReleaseState.NONE ||
            moduleHash == bytes32(0) ||
            manifestHash == bytes32(0) ||
            claimedFinanceInvariantHash != financeInvariantHash ||
            bond < minimumProposalBond ||
            commitDeadline < block.timestamp + MIN_PHASE_DURATION ||
            revealDeadline < commitDeadline + MIN_PHASE_DURATION ||
            adoptionDeadline < revealDeadline + MIN_PHASE_DURATION
        ) revert InvalidTerms();
        if (
            sourceActivation &&
            (proposedSource == address(0) || proposedSource.code.length == 0)
        ) revert InvalidTerms();
        _checkCanary(canary);
        CandidateAttestation storage attestation = candidateAttestations[
            candidateReceiptId
        ];
        if (
            attestation.used ||
            attestation.proposer != msg.sender ||
            attestation.moduleHash != moduleHash ||
            attestation.manifestHash != manifestHash ||
            attestation.canaryHash != keccak256(abi.encode(canary))
        ) revert InvalidTerms();
        attestation.used = true;

        uint64 snapshotEpoch = ledger.currentEpoch();
        if (
            ledger.votingPowerAt(
                msg.sender,
                snapshotEpoch,
                CONTRIBUTION_LOOKBACK
            ) == 0
        ) revert Unauthorized();

        proposalId = nextProposalId++;
        proposals[proposalId] = Proposal({
            proposer: msg.sender,
            proposedSource: proposedSource,
            parentRelease: parentRelease,
            releaseId: releaseId,
            moduleHash: moduleHash,
            manifestHash: manifestHash,
            snapshotEpoch: snapshotEpoch,
            commitDeadline: commitDeadline,
            revealDeadline: revealDeadline,
            adoptionDeadline: adoptionDeadline,
            bond: bond,
            yesWeight: 0,
            noWeight: 0,
            voterCount: 0,
            groupCount: 0,
            adoptionCount: 0,
            adoptionGroupCount: 0,
            state: ProposalState.COMMIT,
            sourceActivation: sourceActivation
            ,
            alreadyProven: false
        });
        releaseStates[releaseId] = ReleaseState.CANDIDATE;
        releaseParents[releaseId] = parentRelease;
        releaseCanaries[releaseId] = canary;
        token.safeTransferFrom(msg.sender, address(this), bond);
        emit ReleaseProposed(
            proposalId,
            releaseId,
            parentRelease,
            msg.sender
        );
    }

    /// @notice Objective settlement sources may make a release opt-in usable in
    ///         BOOTSTRAP. This never changes the recommended release, enables a
    ///         settlement source, or alters any financial invariant.
    function proveRelease(
        bytes32 candidateReceiptId,
        bytes32 parentRelease,
        bytes32 releaseId,
        bytes32 moduleHash,
        bytes32 manifestHash,
        bytes32 claimedFinanceInvariantHash,
        CanaryMetrics calldata canary
    ) external {
        if (
            releaseStates[parentRelease] != ReleaseState.PROVEN &&
            releaseStates[parentRelease] != ReleaseState.RECOMMENDED
        ) revert InvalidTerms();
        if (
            releaseId == bytes32(0) ||
            releaseStates[releaseId] != ReleaseState.NONE ||
            moduleHash == bytes32(0) ||
            manifestHash == bytes32(0) ||
            claimedFinanceInvariantHash != financeInvariantHash
        ) revert InvalidTerms();
        _checkCanary(canary);
        CandidateAttestation storage attestation = candidateAttestations[
            candidateReceiptId
        ];
        if (
            attestation.used ||
            attestation.proposer != msg.sender ||
            attestation.moduleHash != moduleHash ||
            attestation.manifestHash != manifestHash ||
            attestation.canaryHash != keccak256(abi.encode(canary))
        ) revert InvalidTerms();
        attestation.used = true;
        releaseStates[releaseId] = ReleaseState.PROVEN;
        releaseParents[releaseId] = parentRelease;
        releaseCanaries[releaseId] = canary;
        releaseRegistry.registerProven(
            releaseId,
            parentRelease,
            moduleHash,
            manifestHash
        );
        emit ReleaseProven(0, releaseId);
    }

    /// @notice Once the ledger irreversibly reaches MATURE, an already proven
    ///         opt-in release can enter binding recommendation consensus.
    function proposeRecommendation(
        bytes32 releaseId,
        address proposedSource,
        bool sourceActivation,
        uint128 bond,
        uint64 commitDeadline,
        uint64 revealDeadline,
        uint64 adoptionDeadline
    ) external nonReentrant returns (uint256 proposalId) {
        if (!ledger.mature()) revert Unauthorized();
        if (
            releaseStates[releaseId] != ReleaseState.PROVEN ||
            bond < minimumProposalBond ||
            commitDeadline < block.timestamp + MIN_PHASE_DURATION ||
            revealDeadline < commitDeadline + MIN_PHASE_DURATION ||
            adoptionDeadline < revealDeadline + MIN_PHASE_DURATION
        ) revert InvalidTerms();
        if (
            sourceActivation &&
            (proposedSource == address(0) || proposedSource.code.length == 0)
        ) revert InvalidTerms();
        uint64 snapshotEpoch = ledger.currentEpoch();
        if (
            ledger.votingPowerAt(
                msg.sender,
                snapshotEpoch,
                CONTRIBUTION_LOOKBACK
            ) == 0
        ) revert Unauthorized();
        proposalId = nextProposalId++;
        proposals[proposalId] = Proposal({
            proposer: msg.sender,
            proposedSource: proposedSource,
            parentRelease: releaseParents[releaseId],
            releaseId: releaseId,
            moduleHash: bytes32(0),
            manifestHash: bytes32(0),
            snapshotEpoch: snapshotEpoch,
            commitDeadline: commitDeadline,
            revealDeadline: revealDeadline,
            adoptionDeadline: adoptionDeadline,
            bond: bond,
            yesWeight: 0,
            noWeight: 0,
            voterCount: 0,
            groupCount: 0,
            adoptionCount: 0,
            adoptionGroupCount: 0,
            state: ProposalState.COMMIT,
            sourceActivation: sourceActivation,
            alreadyProven: true
        });
        token.safeTransferFrom(msg.sender, address(this), bond);
        emit ReleaseProposed(
            proposalId,
            releaseId,
            releaseParents[releaseId],
            msg.sender
        );
    }

    function commitVote(
        uint256 proposalId,
        bytes32 commitment
    ) external {
        Proposal storage proposal = proposals[proposalId];
        if (
            proposal.state != ProposalState.COMMIT ||
            block.timestamp > proposal.commitDeadline ||
            commitment == bytes32(0)
        ) revert InvalidState();
        Vote storage vote = votes[proposalId][msg.sender];
        if (vote.commitment != bytes32(0)) revert DuplicateParticipation();
        uint256 weight = ledger.votingPowerAt(
            msg.sender,
            proposal.snapshotEpoch,
            CONTRIBUTION_LOOKBACK
        );
        if (weight == 0 || weight > type(uint128).max) revert Unauthorized();
        vote.commitment = commitment;
        vote.weight = uint128(weight);
        emit VoteCommitted(proposalId, msg.sender, weight);
    }

    function revealVote(
        uint256 proposalId,
        bool support,
        bytes32 salt
    ) external {
        Proposal storage proposal = proposals[proposalId];
        if (
            block.timestamp <= proposal.commitDeadline ||
            block.timestamp > proposal.revealDeadline ||
            (
                proposal.state != ProposalState.COMMIT &&
                proposal.state != ProposalState.REVEAL
            )
        ) revert InvalidState();
        Vote storage vote = votes[proposalId][msg.sender];
        if (
            vote.revealed ||
            vote.commitment !=
            voteCommitment(proposalId, msg.sender, support, salt)
        ) revert InvalidTerms();
        vote.revealed = true;
        vote.support = support;
        proposal.state = ProposalState.REVEAL;
        proposal.voterCount++;
        bytes32 group = ledger.operatorGroup(msg.sender);
        if (group == bytes32(0)) revert Unauthorized();
        if (!representedGroup[proposalId][group]) {
            representedGroup[proposalId][group] = true;
            proposal.groupCount++;
        }
        if (support) proposal.yesWeight += vote.weight;
        else proposal.noWeight += vote.weight;
        emit VoteRevealed(proposalId, msg.sender, support, vote.weight);
    }

    function finalizeVote(uint256 proposalId) external {
        Proposal storage proposal = proposals[proposalId];
        if (
            block.timestamp <= proposal.revealDeadline ||
            (
                proposal.state != ProposalState.COMMIT &&
                proposal.state != ProposalState.REVEAL
            )
        ) revert InvalidState();
        uint256 cast = uint256(proposal.yesWeight) + proposal.noWeight;
        uint256 total = ledger.totalSuccessfulAt(
            proposal.snapshotEpoch,
            CONTRIBUTION_LOOKBACK
        );
        bool passes =
            proposal.voterCount >= MIN_VOTERS &&
            proposal.groupCount >= MIN_GROUPS &&
            cast >= total * QUORUM_BPS &&
            uint256(proposal.yesWeight) * BPS >=
            cast * SUPERMAJORITY_BPS;
        if (!passes) {
            proposal.state = ProposalState.REJECTED;
            if (!proposal.alreadyProven) {
                releaseStates[proposal.releaseId] = ReleaseState.QUARANTINED;
            }
            uint256 returned = proposal.bond / 2;
            slashPool += proposal.bond - returned;
            token.safeTransfer(proposal.proposer, returned);
            emit ProposalClosed(proposalId, proposal.state);
            return;
        }
        proposal.state = ProposalState.ADOPTION;
        if (!proposal.alreadyProven) {
            releaseStates[proposal.releaseId] = ReleaseState.PROVEN;
            releaseRegistry.registerProven(
                proposal.releaseId,
                proposal.parentRelease,
                proposal.moduleHash,
                proposal.manifestHash
            );
        }
        emit ReleaseProven(proposalId, proposal.releaseId);
    }

    function recordAdoption(
        uint256 proposalId,
        address adopter,
        bytes32 receiptId
    ) external {
        Proposal storage proposal = proposals[proposalId];
        if (
            proposal.state != ProposalState.ADOPTION ||
            block.timestamp > proposal.adoptionDeadline ||
            !ledger.isActiveSource(msg.sender)
        ) revert Unauthorized();
        if (
            adopter == address(0) ||
            receiptId == bytes32(0) ||
            adoptionReceipt[receiptId] ||
            adoptedBy[proposalId][adopter]
        ) revert DuplicateParticipation();
        bytes32 group = ledger.operatorGroup(adopter);
        if (group == bytes32(0)) revert InvalidTerms();
        adoptionReceipt[receiptId] = true;
        adoptedBy[proposalId][adopter] = true;
        proposal.adoptionCount++;
        if (!adoptionGroup[proposalId][group]) {
            adoptionGroup[proposalId][group] = true;
            proposal.adoptionGroupCount++;
        }
        emit AdoptionRecorded(proposalId, adopter, receiptId);
        if (
            proposal.adoptionCount >= MIN_ADOPTIONS &&
            proposal.adoptionGroupCount >= MIN_ADOPTION_GROUPS
        ) {
            proposal.state = ProposalState.RECOMMENDED;
            releaseStates[proposal.releaseId] = ReleaseState.RECOMMENDED;
            recommendedRelease = proposal.releaseId;
            releaseRegistry.recommend(proposal.releaseId);
            if (proposal.sourceActivation) {
                ledger.setSource(proposal.proposedSource, true);
            }
            token.safeTransfer(proposal.proposer, proposal.bond);
            emit ReleaseRecommended(proposalId, proposal.releaseId);
        }
    }

    function expireAdoption(uint256 proposalId) external {
        Proposal storage proposal = proposals[proposalId];
        if (
            proposal.state != ProposalState.ADOPTION ||
            block.timestamp <= proposal.adoptionDeadline
        ) revert InvalidState();
        proposal.state = ProposalState.EXPIRED;
        if (!proposal.alreadyProven) {
            releaseStates[proposal.releaseId] = ReleaseState.QUARANTINED;
        }
        uint256 returned = proposal.bond / 2;
        slashPool += proposal.bond - returned;
        token.safeTransfer(proposal.proposer, returned);
        emit ProposalClosed(proposalId, proposal.state);
    }

    function _checkCanary(CanaryMetrics calldata canary) internal pure {
        if (
            canary.securityRegressions != 0 ||
            canary.qualityBps < canary.baselineQualityBps ||
            canary.baselineCost == 0 ||
            canary.baselineLatency == 0
        ) revert InvalidTerms();
        bool costImproved =
            uint256(canary.cost) * BPS <=
            uint256(canary.baselineCost) * 9_500;
        bool latencyImproved =
            uint256(canary.latency) * BPS <=
            uint256(canary.baselineLatency) * 9_500;
        if (!costImproved && !latencyImproved) revert InvalidTerms();
    }
}
