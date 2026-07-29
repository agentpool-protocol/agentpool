// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {
    IAgentPoolV43ContributionLedger
} from "./interfaces/IAgentPoolV43ContributionLedger.sol";
import {
    IAgentPoolV43SystemIssueGate
} from "./interfaces/IAgentPoolV43SystemIssueGate.sol";
import {AgentPoolV43SystemIssueGate} from "./AgentPoolV43SystemIssueGate.sol";

/// @notice Work Power consensus for creating new reserve-funded system issues
///         after BOOTSTRAP has irreversibly reached MATURE.
contract AgentPoolV43IssueConsensus is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum ProposalState {
        NONE,
        COMMIT,
        REVEAL,
        APPROVED,
        REJECTED
    }

    struct Proposal {
        address proposer;
        bytes32 termsHash;
        uint64 snapshotEpoch;
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint128 bond;
        uint128 yesWeight;
        uint128 noWeight;
        uint16 voterCount;
        uint16 groupCount;
        ProposalState state;
        IAgentPoolV43SystemIssueGate.IssueTerms issue;
    }

    struct Vote {
        bytes32 commitment;
        uint128 weight;
        bool revealed;
    }

    uint16 public constant BPS = 10_000;
    uint16 public constant QUORUM_BPS = 3_000;
    uint16 public constant SUPERMAJORITY_BPS = 6_667;
    uint16 public constant MIN_VOTERS = 5;
    uint16 public constant MIN_GROUPS = 3;
    uint8 public constant CONTRIBUTION_LOOKBACK = 8;
    uint64 public constant MIN_PHASE_DURATION = 1 days;

    IERC20 public immutable token;
    IAgentPoolV43ContributionLedger public immutable ledger;
    AgentPoolV43SystemIssueGate public immutable gate;
    uint128 public immutable minimumProposalBond;
    uint256 public nextProposalId = 1;
    uint256 public slashPool;

    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => Vote)) public votes;
    mapping(uint256 => mapping(bytes32 => bool)) public representedGroup;

    event IssueProposed(
        uint256 indexed proposalId,
        bytes32 indexed issueId,
        bytes32 indexed termsHash,
        address proposer
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
    event IssueApproved(uint256 indexed proposalId, bytes32 indexed issueId);
    event IssueRejected(uint256 indexed proposalId, bytes32 indexed issueId);

    error InvalidTerms();
    error InvalidState();
    error Unauthorized();
    error DuplicateParticipation();

    constructor(
        IERC20 token_,
        IAgentPoolV43ContributionLedger ledger_,
        AgentPoolV43SystemIssueGate gate_,
        uint128 minimumProposalBond_
    ) {
        if (
            address(token_) == address(0) ||
            address(ledger_) == address(0) ||
            address(gate_) == address(0) ||
            minimumProposalBond_ == 0
        ) revert InvalidTerms();
        token = token_;
        ledger = ledger_;
        gate = gate_;
        minimumProposalBond = minimumProposalBond_;
    }

    function voteCommitment(
        uint256 proposalId,
        address voter,
        bool support,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(proposalId, voter, support, salt));
    }

    function proposeIssue(
        IAgentPoolV43SystemIssueGate.IssueTerms calldata issue,
        uint128 bond,
        uint64 commitDeadline,
        uint64 revealDeadline
    ) external nonReentrant returns (uint256 proposalId) {
        if (!ledger.mature()) revert Unauthorized();
        if (
            bond < minimumProposalBond ||
            commitDeadline < block.timestamp + MIN_PHASE_DURATION ||
            revealDeadline < commitDeadline + MIN_PHASE_DURATION
        ) revert InvalidTerms();
        uint64 snapshotEpoch = ledger.currentEpoch();
        if (
            ledger.votingPowerAt(
                msg.sender,
                snapshotEpoch,
                CONTRIBUTION_LOOKBACK
            ) == 0
        ) revert Unauthorized();
        bytes32 hash = gate.termsHash(issue);
        proposalId = nextProposalId++;
        Proposal storage proposal = proposals[proposalId];
        proposal.proposer = msg.sender;
        proposal.termsHash = hash;
        proposal.snapshotEpoch = snapshotEpoch;
        proposal.commitDeadline = commitDeadline;
        proposal.revealDeadline = revealDeadline;
        proposal.bond = bond;
        proposal.state = ProposalState.COMMIT;
        proposal.issue = issue;
        token.safeTransferFrom(msg.sender, address(this), bond);
        emit IssueProposed(proposalId, issue.issueId, hash, msg.sender);
    }

    function commitVote(uint256 proposalId, bytes32 commitment) external {
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

    function finalizeVote(uint256 proposalId) external nonReentrant {
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
            uint256 returned = proposal.bond / 2;
            slashPool += proposal.bond - returned;
            token.safeTransfer(proposal.proposer, returned);
            emit IssueRejected(proposalId, proposal.issue.issueId);
            return;
        }
        proposal.state = ProposalState.APPROVED;
        gate.approveMatureIssue(proposal.issue);
        token.safeTransfer(proposal.proposer, proposal.bond);
        emit IssueApproved(proposalId, proposal.issue.issueId);
    }
}
