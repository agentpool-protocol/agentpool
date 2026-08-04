// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {
    IAgentPoolV43ContributionLedger
} from "./interfaces/IAgentPoolV43ContributionLedger.sol";

/// @notice Finite Base Sepolia incubation pool for autonomous improvement
///         candidates. It pays pre-work quotes only after an immutable
///         candidate artifact and commit/reveal canary evidence are available.
///
/// @dev This overlay is intentionally incapable of minting, recording Work
///      Power, activating a settlement source, or recommending a release.
///      Base-mainnet deployment is rejected by the constructor.
contract AgentPoolV439CandidateRewardPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TESTNET_CHAIN_ID = 84_532;
    uint16 public constant BPS = 10_000;
    bool public constant CREATES_WORK_POWER = false;
    bool public constant CAN_RECOMMEND_RELEASE = false;
    bool public constant CAN_MINT = false;

    enum IssueState {
        NONE,
        BIDDING,
        RUNNING,
        VALIDATING,
        SETTLED,
        REJECTED,
        EXPIRED
    }

    struct Issue {
        address reporter;
        IssueState state;
        uint64 openedDay;
        uint64 bidDeadline;
        uint64 deliveryDeadline;
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint128 budgetCap;
        uint128 reporterQuote;
        uint128 validatorQuoteTotal;
        uint32 selectedCandidateId;
        uint16 validatorCount;
        uint16 revealedCount;
        uint16 positiveCount;
        uint16 representedGroups;
        bytes32 issueDigest;
        bytes32 sourceSnapshotDigest;
        bytes32 acceptanceDigest;
        bytes32 artifactDigest;
        bytes32 patchDigest;
    }

    struct CandidateBid {
        address author;
        uint128 quote;
        bytes32 planCommitment;
        bytes32 planHash;
        bool delivered;
    }

    struct Validation {
        bytes32 commitment;
        bytes32 group;
        bytes32 evidenceDigest;
        uint128 quote;
        uint16 scoreBps;
        bool revealed;
        bool paid;
    }

    IERC20 public immutable token;
    IAgentPoolV43ContributionLedger public immutable contributionLedger;
    uint128 public immutable maxReporterQuote;
    uint128 public immutable maxCandidateQuote;
    uint128 public immutable maxValidatorQuote;
    uint128 public immutable maxIssueBudget;
    uint128 public immutable dailyCap;
    uint128 public immutable lifetimeCap;
    uint16 public immutable passScoreBps;
    uint16 public immutable minimumValidators;
    uint16 public immutable minimumValidatorGroups;
    uint16 public immutable maxCandidates;
    uint16 public immutable maxValidators;
    uint64 public immutable maxIssueLifetime;

    uint256 public totalFunded;
    uint256 public totalReserved;
    uint256 public totalPaid;

    mapping(bytes32 => Issue) public issues;
    mapping(bytes32 => CandidateBid[]) private _candidateBids;
    mapping(bytes32 => mapping(address => bool)) public candidateBidBy;
    mapping(bytes32 => mapping(address => Validation)) public validations;
    mapping(bytes32 => address[]) private _validators;
    mapping(bytes32 => mapping(bytes32 => bool)) public representedGroup;
    mapping(bytes32 => bool) public usedIssueDigest;
    mapping(bytes32 => bool) public provenArtifact;
    mapping(address => bytes32) public activeIssue;
    mapping(uint64 => uint256) public dailyReserved;

    event Funded(address indexed funder, uint256 amount, uint256 totalFunded);
    event IssueOpened(
        bytes32 indexed issueId,
        bytes32 indexed issueDigest,
        address indexed reporter,
        uint256 budgetCap,
        bytes32 sourceSnapshotDigest
    );
    event CandidateBidSubmitted(
        bytes32 indexed issueId,
        uint32 indexed candidateId,
        address indexed author,
        uint256 quote
    );
    event CandidateAwarded(
        bytes32 indexed issueId,
        uint32 indexed candidateId,
        address indexed author,
        uint256 quote
    );
    event CandidateDelivered(
        bytes32 indexed issueId,
        uint32 indexed candidateId,
        bytes32 indexed artifactDigest,
        bytes32 patchDigest
    );
    event ValidationCommitted(
        bytes32 indexed issueId,
        address indexed validator,
        bytes32 indexed operatorGroup,
        uint256 quote
    );
    event ValidationRevealed(
        bytes32 indexed issueId,
        address indexed validator,
        uint16 scoreBps,
        bytes32 evidenceDigest
    );
    event RolePaid(
        bytes32 indexed issueId,
        address indexed recipient,
        bytes32 indexed role,
        uint256 amount
    );
    event IssueFinalized(
        bytes32 indexed issueId,
        bool passed,
        uint256 paid,
        uint256 unusedBudget
    );
    event IssueExpired(bytes32 indexed issueId, uint256 releasedBudget);

    error WrongChain();
    error InvalidTerms();
    error InvalidState();
    error Unauthorized();
    error Duplicate();
    error CapacityExceeded();
    error Deadline();

    constructor(
        IERC20 token_,
        IAgentPoolV43ContributionLedger contributionLedger_,
        uint128 maxReporterQuote_,
        uint128 maxCandidateQuote_,
        uint128 maxValidatorQuote_,
        uint128 maxIssueBudget_,
        uint128 dailyCap_,
        uint128 lifetimeCap_,
        uint16 passScoreBps_,
        uint16 minimumValidators_,
        uint16 minimumValidatorGroups_,
        uint16 maxCandidates_,
        uint16 maxValidators_,
        uint64 maxIssueLifetime_
    ) {
        if (block.chainid != TESTNET_CHAIN_ID) revert WrongChain();
        if (
            address(token_) == address(0) ||
            address(contributionLedger_) == address(0) ||
            address(contributionLedger_).code.length == 0 ||
            maxReporterQuote_ == 0 ||
            maxCandidateQuote_ == 0 ||
            maxValidatorQuote_ == 0 ||
            maxIssueBudget_ <
                maxReporterQuote_ +
                    maxCandidateQuote_ +
                    maxValidatorQuote_ ||
            dailyCap_ < maxIssueBudget_ ||
            lifetimeCap_ < dailyCap_ ||
            passScoreBps_ == 0 ||
            passScoreBps_ > BPS ||
            minimumValidators_ == 0 ||
            minimumValidatorGroups_ == 0 ||
            minimumValidatorGroups_ > minimumValidators_ ||
            maxCandidates_ == 0 ||
            maxCandidates_ > 16 ||
            maxValidators_ < minimumValidators_ ||
            maxValidators_ > 15 ||
            maxIssueLifetime_ == 0
        ) revert InvalidTerms();
        token = token_;
        contributionLedger = contributionLedger_;
        maxReporterQuote = maxReporterQuote_;
        maxCandidateQuote = maxCandidateQuote_;
        maxValidatorQuote = maxValidatorQuote_;
        maxIssueBudget = maxIssueBudget_;
        dailyCap = dailyCap_;
        lifetimeCap = lifetimeCap_;
        passScoreBps = passScoreBps_;
        minimumValidators = minimumValidators_;
        minimumValidatorGroups = minimumValidatorGroups_;
        maxCandidates = maxCandidates_;
        maxValidators = maxValidators_;
        maxIssueLifetime = maxIssueLifetime_;
    }

    function fund(uint128 amount) external nonReentrant {
        if (amount == 0 || totalFunded + amount > lifetimeCap) {
            revert CapacityExceeded();
        }
        totalFunded += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount, totalFunded);
    }

    function candidateCount(bytes32 issueId) external view returns (uint256) {
        return _candidateBids[issueId].length;
    }

    function candidate(
        bytes32 issueId,
        uint32 candidateId
    ) external view returns (CandidateBid memory) {
        if (candidateId == 0 || candidateId > _candidateBids[issueId].length) {
            revert InvalidTerms();
        }
        return _candidateBids[issueId][candidateId - 1];
    }

    function issueValidators(
        bytes32 issueId
    ) external view returns (address[] memory) {
        return _validators[issueId];
    }

    function candidatePlanCommitment(
        bytes32 issueId,
        address author,
        bytes32 planHash,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(issueId, author, planHash, salt));
    }

    function validationCommitment(
        bytes32 issueId,
        address validator,
        bytes32 artifactDigest,
        uint16 scoreBps,
        bytes32 evidenceDigest,
        bytes32 salt
    ) public pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    issueId,
                    validator,
                    artifactDigest,
                    scoreBps,
                    evidenceDigest,
                    salt
                )
            );
    }

    function openIssue(
        bytes32 issueId,
        bytes32 issueDigest,
        bytes32 sourceSnapshotDigest,
        bytes32 acceptanceDigest,
        uint128 budgetCap,
        uint128 reporterQuote,
        uint64 bidDeadline,
        uint64 deliveryDeadline,
        uint64 commitDeadline,
        uint64 revealDeadline
    ) external nonReentrant {
        if (
            issueId == bytes32(0) ||
            issueDigest == bytes32(0) ||
            sourceSnapshotDigest == bytes32(0) ||
            acceptanceDigest == bytes32(0) ||
            budgetCap == 0 ||
            budgetCap > maxIssueBudget ||
            reporterQuote > maxReporterQuote ||
            bidDeadline <= block.timestamp ||
            deliveryDeadline <= bidDeadline ||
            commitDeadline <= deliveryDeadline ||
            revealDeadline <= commitDeadline ||
            revealDeadline > block.timestamp + maxIssueLifetime
        ) revert InvalidTerms();
        if (
            issues[issueId].state != IssueState.NONE ||
            usedIssueDigest[issueDigest] ||
            activeIssue[msg.sender] != bytes32(0)
        ) revert Duplicate();
        uint64 day = uint64(block.timestamp / 1 days);
        if (
            dailyReserved[day] + budgetCap > dailyCap ||
            totalPaid + totalReserved + budgetCap > totalFunded ||
            totalPaid + totalReserved + budgetCap > lifetimeCap
        ) revert CapacityExceeded();

        usedIssueDigest[issueDigest] = true;
        activeIssue[msg.sender] = issueId;
        dailyReserved[day] += budgetCap;
        totalReserved += budgetCap;
        issues[issueId] = Issue({
            reporter: msg.sender,
            state: IssueState.BIDDING,
            openedDay: day,
            bidDeadline: bidDeadline,
            deliveryDeadline: deliveryDeadline,
            commitDeadline: commitDeadline,
            revealDeadline: revealDeadline,
            budgetCap: budgetCap,
            reporterQuote: reporterQuote,
            validatorQuoteTotal: 0,
            selectedCandidateId: 0,
            validatorCount: 0,
            revealedCount: 0,
            positiveCount: 0,
            representedGroups: 0,
            issueDigest: issueDigest,
            sourceSnapshotDigest: sourceSnapshotDigest,
            acceptanceDigest: acceptanceDigest,
            artifactDigest: bytes32(0),
            patchDigest: bytes32(0)
        });
        emit IssueOpened(
            issueId,
            issueDigest,
            msg.sender,
            budgetCap,
            sourceSnapshotDigest
        );
    }

    function submitCandidateBid(
        bytes32 issueId,
        uint128 quote,
        bytes32 planCommitment
    ) external {
        Issue storage issue = issues[issueId];
        if (
            issue.state != IssueState.BIDDING ||
            block.timestamp > issue.bidDeadline
        ) revert Deadline();
        if (
            quote == 0 ||
            quote > maxCandidateQuote ||
            planCommitment == bytes32(0) ||
            uint256(issue.reporterQuote) + quote > issue.budgetCap
        ) revert InvalidTerms();
        if (
            candidateBidBy[issueId][msg.sender] ||
            _candidateBids[issueId].length >= maxCandidates
        ) revert Duplicate();
        candidateBidBy[issueId][msg.sender] = true;
        _candidateBids[issueId].push(
            CandidateBid({
                author: msg.sender,
                quote: quote,
                planCommitment: planCommitment,
                planHash: bytes32(0),
                delivered: false
            })
        );
        uint32 candidateId = uint32(_candidateBids[issueId].length);
        uint32 selected = issue.selectedCandidateId;
        if (
            selected == 0 ||
            quote < _candidateBids[issueId][selected - 1].quote
        ) {
            issue.selectedCandidateId = candidateId;
        }
        emit CandidateBidSubmitted(issueId, candidateId, msg.sender, quote);
    }

    function awardCandidate(bytes32 issueId) external {
        Issue storage issue = issues[issueId];
        if (
            issue.state != IssueState.BIDDING ||
            block.timestamp <= issue.bidDeadline ||
            issue.selectedCandidateId == 0
        ) revert InvalidState();
        issue.state = IssueState.RUNNING;
        CandidateBid storage selected = _selectedCandidate(issueId);
        emit CandidateAwarded(
            issueId,
            issue.selectedCandidateId,
            selected.author,
            selected.quote
        );
    }

    function deliverCandidate(
        bytes32 issueId,
        bytes32 planHash,
        bytes32 planSalt,
        bytes32 artifactDigest,
        bytes32 patchDigest
    ) external {
        Issue storage issue = issues[issueId];
        CandidateBid storage selected = _selectedCandidate(issueId);
        if (
            issue.state != IssueState.RUNNING ||
            block.timestamp > issue.deliveryDeadline
        ) revert Deadline();
        if (msg.sender != selected.author) revert Unauthorized();
        if (
            selected.delivered ||
            planHash == bytes32(0) ||
            artifactDigest == bytes32(0) ||
            patchDigest == bytes32(0) ||
            provenArtifact[artifactDigest] ||
            candidatePlanCommitment(
                issueId,
                msg.sender,
                planHash,
                planSalt
            ) != selected.planCommitment
        ) revert InvalidTerms();
        selected.planHash = planHash;
        selected.delivered = true;
        issue.artifactDigest = artifactDigest;
        issue.patchDigest = patchDigest;
        issue.state = IssueState.VALIDATING;
        emit CandidateDelivered(
            issueId,
            issue.selectedCandidateId,
            artifactDigest,
            patchDigest
        );
    }

    function commitValidation(
        bytes32 issueId,
        bytes32 commitment,
        uint128 quote
    ) external {
        Issue storage issue = issues[issueId];
        if (
            issue.state != IssueState.VALIDATING ||
            block.timestamp > issue.commitDeadline
        ) revert Deadline();
        if (
            commitment == bytes32(0) ||
            quote == 0 ||
            quote > maxValidatorQuote ||
            validations[issueId][msg.sender].commitment != bytes32(0) ||
            _validators[issueId].length >= maxValidators ||
            uint256(issue.reporterQuote) +
                _selectedCandidate(issueId).quote +
                issue.validatorQuoteTotal +
                quote >
            issue.budgetCap
        ) revert InvalidTerms();
        bytes32 group = contributionLedger.operatorGroup(msg.sender);
        if (group == bytes32(0)) {
            group = keccak256(abi.encodePacked("INCUBATION", msg.sender));
        }
        validations[issueId][msg.sender] = Validation({
            commitment: commitment,
            group: group,
            evidenceDigest: bytes32(0),
            quote: quote,
            scoreBps: 0,
            revealed: false,
            paid: false
        });
        _validators[issueId].push(msg.sender);
        issue.validatorCount++;
        issue.validatorQuoteTotal += quote;
        emit ValidationCommitted(issueId, msg.sender, group, quote);
    }

    function revealValidation(
        bytes32 issueId,
        uint16 scoreBps,
        bytes32 evidenceDigest,
        bytes32 salt
    ) external {
        Issue storage issue = issues[issueId];
        if (
            issue.state != IssueState.VALIDATING ||
            block.timestamp <= issue.commitDeadline ||
            block.timestamp > issue.revealDeadline
        ) revert Deadline();
        Validation storage validation = validations[issueId][msg.sender];
        if (
            validation.commitment == bytes32(0) ||
            validation.revealed ||
            scoreBps > BPS ||
            evidenceDigest == bytes32(0) ||
            validationCommitment(
                issueId,
                msg.sender,
                issue.artifactDigest,
                scoreBps,
                evidenceDigest,
                salt
            ) != validation.commitment
        ) revert InvalidTerms();
        validation.revealed = true;
        validation.scoreBps = scoreBps;
        validation.evidenceDigest = evidenceDigest;
        issue.revealedCount++;
        if (scoreBps >= passScoreBps) issue.positiveCount++;
        if (!representedGroup[issueId][validation.group]) {
            representedGroup[issueId][validation.group] = true;
            issue.representedGroups++;
        }
        emit ValidationRevealed(
            issueId,
            msg.sender,
            scoreBps,
            evidenceDigest
        );
    }

    function finalizeIssue(bytes32 issueId) external nonReentrant {
        Issue storage issue = issues[issueId];
        if (
            issue.state != IssueState.VALIDATING ||
            block.timestamp <= issue.revealDeadline
        ) revert InvalidState();
        bool passed =
            issue.revealedCount >= minimumValidators &&
            issue.representedGroups >= minimumValidatorGroups &&
            uint256(issue.positiveCount) * 3 >=
                uint256(issue.revealedCount) * 2;
        uint256 payout;
        if (passed) {
            CandidateBid storage selected = _selectedCandidate(issueId);
            payout += issue.reporterQuote;
            payout += selected.quote;
            _pay(issueId, issue.reporter, "REPORTER", issue.reporterQuote);
            _pay(issueId, selected.author, "IMPLEMENTER", selected.quote);
            provenArtifact[issue.artifactDigest] = true;
            issue.state = IssueState.SETTLED;
        } else {
            issue.state = IssueState.REJECTED;
        }
        for (uint256 index; index < _validators[issueId].length; ++index) {
            address validator = _validators[issueId][index];
            Validation storage validation = validations[issueId][validator];
            if (!validation.revealed || validation.paid) continue;
            validation.paid = true;
            payout += validation.quote;
            _pay(issueId, validator, "VALIDATOR", validation.quote);
        }
        if (payout > issue.budgetCap) revert CapacityExceeded();
        _releaseReservation(issue, payout);
        emit IssueFinalized(
            issueId,
            passed,
            payout,
            uint256(issue.budgetCap) - payout
        );
    }

    function expireIssue(bytes32 issueId) external {
        Issue storage issue = issues[issueId];
        bool expired =
            (
                issue.state == IssueState.BIDDING &&
                block.timestamp > issue.bidDeadline &&
                issue.selectedCandidateId == 0
            ) ||
            (
                issue.state == IssueState.RUNNING &&
                block.timestamp > issue.deliveryDeadline
            );
        if (!expired) revert InvalidState();
        issue.state = IssueState.EXPIRED;
        uint256 released = issue.budgetCap;
        totalReserved -= released;
        dailyReserved[issue.openedDay] -= released;
        activeIssue[issue.reporter] = bytes32(0);
        emit IssueExpired(issueId, released);
    }

    function _selectedCandidate(
        bytes32 issueId
    ) private view returns (CandidateBid storage selected) {
        uint32 selectedId = issues[issueId].selectedCandidateId;
        if (
            selectedId == 0 ||
            selectedId > _candidateBids[issueId].length
        ) revert InvalidState();
        return _candidateBids[issueId][selectedId - 1];
    }

    function _pay(
        bytes32 issueId,
        address recipient,
        bytes32 role,
        uint256 amount
    ) private {
        if (amount == 0) return;
        token.safeTransfer(recipient, amount);
        emit RolePaid(issueId, recipient, role, amount);
    }

    function _releaseReservation(Issue storage issue, uint256 payout) private {
        uint256 unused = uint256(issue.budgetCap) - payout;
        totalReserved -= issue.budgetCap;
        totalPaid += payout;
        dailyReserved[issue.openedDay] -= unused;
        activeIssue[issue.reporter] = bytes32(0);
    }
}
