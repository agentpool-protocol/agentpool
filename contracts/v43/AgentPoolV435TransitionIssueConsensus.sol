// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {
    IAgentPoolV435ContributionLedger
} from "./interfaces/IAgentPoolV435ContributionLedger.sol";
import {
    IAgentPoolV435SystemIssueGate
} from "./interfaces/IAgentPoolV435SystemIssueGate.sol";

/// @notice Limited Issue consensus used after BOOTSTRAP has accumulated
///         enough real work but before MATURE governance is available.
///         A proposer cannot vote. At least two other agents must reveal
///         evidence and at least one must belong to another operator group.
contract AgentPoolV435TransitionIssueConsensus is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State {
        NONE,
        COMMIT,
        REVEAL,
        APPROVED,
        REJECTED
    }

    struct Proposal {
        address proposer;
        bytes32 proposerGroup;
        bytes32 issueHash;
        bytes32 needEvidenceHash;
        uint64 snapshotEpoch;
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint128 bond;
        uint128 yesWeight;
        uint128 noWeight;
        uint16 voterCount;
        uint16 groupCount;
        State state;
    }

    struct Vote {
        bytes32 commitment;
        uint128 weight;
        bool revealed;
    }

    uint16 public constant BPS = 10_000;
    uint16 public constant QUORUM_BPS = 3_000;
    uint16 public constant SUPERMAJORITY_BPS = 6_667;
    uint8 public constant LOOKBACK = 8;
    uint64 public constant MIN_PHASE_DURATION = 1 days;

    IERC20 public immutable token;
    IAgentPoolV435ContributionLedger public immutable ledger;
    IAgentPoolV435SystemIssueGate public immutable issueGate;
    uint128 public immutable minimumBond;
    uint256 public nextProposalId = 1;
    uint256 public slashPool;

    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => IAgentPoolV435SystemIssueGate.IssueTerms)
        public proposalIssues;
    mapping(uint256 => mapping(address => Vote)) public votes;
    mapping(uint256 => mapping(bytes32 => bool)) public representedGroup;
    mapping(bytes32 => bool) public proposedIssueHash;
    mapping(bytes32 => bool) public proposedIssueId;

    event IssueProposed(
        uint256 indexed proposalId,
        bytes32 indexed issueHash,
        address indexed proposer,
        bytes32 needEvidenceHash
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
        bytes32 evidenceHash,
        uint256 weight
    );
    event ProposalClosed(uint256 indexed proposalId, State state);

    error InvalidTerms();
    error InvalidState();
    error Unauthorized();
    error DuplicateParticipation();

    constructor(
        IERC20 token_,
        IAgentPoolV435ContributionLedger ledger_,
        IAgentPoolV435SystemIssueGate issueGate_,
        uint128 minimumBond_
    ) {
        if (
            address(token_) == address(0) ||
            address(ledger_) == address(0) ||
            address(issueGate_) == address(0) ||
            minimumBond_ == 0
        ) revert InvalidTerms();
        token = token_;
        ledger = ledger_;
        issueGate = issueGate_;
        minimumBond = minimumBond_;
    }

    function voteCommitment(
        uint256 proposalId,
        address voter,
        bool support,
        bytes32 evidenceHash,
        bytes32 salt
    ) public pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    proposalId,
                    voter,
                    support,
                    evidenceHash,
                    salt
                )
            );
    }

    function propose(
        IAgentPoolV435SystemIssueGate.IssueTerms calldata issue,
        bytes32 needEvidenceHash,
        uint128 bond,
        uint64 commitDeadline,
        uint64 revealDeadline
    ) external nonReentrant returns (uint256 proposalId) {
        if (!issueGate.transitionReady()) revert Unauthorized();
        issueGate.validateTransitionIssue(issue);
        bytes32 proposerGroup = ledger.operatorGroup(msg.sender);
        bytes32 issueHash = issueGate.hashIssue(issue);
        if (
            proposerGroup == bytes32(0) ||
            issueHash == bytes32(0) ||
            needEvidenceHash == bytes32(0) ||
            proposedIssueHash[issueHash] ||
            proposedIssueId[issue.issueId] ||
            bond < minimumBond ||
            commitDeadline < block.timestamp + MIN_PHASE_DURATION ||
            revealDeadline < commitDeadline + MIN_PHASE_DURATION ||
            issue.expiresAt <= revealDeadline
        ) revert InvalidTerms();
        uint64 snapshotEpoch = ledger.governanceSnapshotEpoch();
        if (
            ledger.votingPowerAt(
                msg.sender,
                snapshotEpoch,
                LOOKBACK
            ) == 0
        ) revert Unauthorized();

        proposalId = nextProposalId++;
        proposals[proposalId] = Proposal({
            proposer: msg.sender,
            proposerGroup: proposerGroup,
            issueHash: issueHash,
            needEvidenceHash: needEvidenceHash,
            snapshotEpoch: snapshotEpoch,
            commitDeadline: commitDeadline,
            revealDeadline: revealDeadline,
            bond: bond,
            yesWeight: 0,
            noWeight: 0,
            voterCount: 0,
            groupCount: 1,
            state: State.COMMIT
        });
        proposalIssues[proposalId] = issue;
        representedGroup[proposalId][proposerGroup] = true;
        proposedIssueHash[issueHash] = true;
        proposedIssueId[issue.issueId] = true;
        token.safeTransferFrom(msg.sender, address(this), bond);
        emit IssueProposed(
            proposalId,
            issueHash,
            msg.sender,
            needEvidenceHash
        );
    }

    function commitVote(
        uint256 proposalId,
        bytes32 commitment
    ) external {
        Proposal storage proposal = proposals[proposalId];
        Vote storage vote = votes[proposalId][msg.sender];
        if (
            proposal.state != State.COMMIT ||
            block.timestamp > proposal.commitDeadline ||
            commitment == bytes32(0)
        ) revert InvalidState();
        if (
            msg.sender == proposal.proposer ||
            vote.commitment != bytes32(0)
        ) revert DuplicateParticipation();
        uint256 weight = ledger.votingPowerAt(
            msg.sender,
            proposal.snapshotEpoch,
            LOOKBACK
        );
        if (weight == 0 || weight > type(uint128).max) {
            revert Unauthorized();
        }
        vote.commitment = commitment;
        vote.weight = uint128(weight);
        emit VoteCommitted(proposalId, msg.sender, weight);
    }

    function revealVote(
        uint256 proposalId,
        bool support,
        bytes32 evidenceHash,
        bytes32 salt
    ) external {
        Proposal storage proposal = proposals[proposalId];
        Vote storage vote = votes[proposalId][msg.sender];
        if (
            block.timestamp <= proposal.commitDeadline ||
            block.timestamp > proposal.revealDeadline ||
            (
                proposal.state != State.COMMIT &&
                proposal.state != State.REVEAL
            )
        ) revert InvalidState();
        if (
            evidenceHash == bytes32(0) ||
            vote.revealed ||
            vote.commitment !=
                voteCommitment(
                    proposalId,
                    msg.sender,
                    support,
                    evidenceHash,
                    salt
                )
        ) revert InvalidTerms();
        vote.revealed = true;
        proposal.state = State.REVEAL;
        proposal.voterCount++;
        bytes32 group = ledger.operatorGroup(msg.sender);
        if (group == bytes32(0)) revert Unauthorized();
        if (!representedGroup[proposalId][group]) {
            representedGroup[proposalId][group] = true;
            proposal.groupCount++;
        }
        if (support) proposal.yesWeight += vote.weight;
        else proposal.noWeight += vote.weight;
        emit VoteRevealed(
            proposalId,
            msg.sender,
            support,
            evidenceHash,
            vote.weight
        );
    }

    function finalize(uint256 proposalId) external nonReentrant {
        Proposal storage proposal = proposals[proposalId];
        if (
            block.timestamp <= proposal.revealDeadline ||
            (
                proposal.state != State.COMMIT &&
                proposal.state != State.REVEAL
            )
        ) revert InvalidState();
        uint256 cast = uint256(proposal.yesWeight) + proposal.noWeight;
        uint256 total = ledger.totalSuccessfulAt(
            proposal.snapshotEpoch,
            LOOKBACK
        );
        bool passed =
            block.timestamp < proposalIssues[proposalId].expiresAt &&
            cast * BPS >= total * QUORUM_BPS &&
            uint256(proposal.yesWeight) * BPS >=
                total * SUPERMAJORITY_BPS;
        if (passed) {
            proposal.state = State.APPROVED;
            issueGate.approveTransitionIssue(
                proposalIssues[proposalId]
            );
            token.safeTransfer(proposal.proposer, proposal.bond);
        } else {
            proposal.state = State.REJECTED;
            proposedIssueHash[proposal.issueHash] = false;
            proposedIssueId[
                proposalIssues[proposalId].issueId
            ] = false;
            uint256 returned = proposal.bond / 2;
            slashPool += proposal.bond - returned;
            token.safeTransfer(proposal.proposer, returned);
        }
        emit ProposalClosed(proposalId, proposal.state);
    }
}
