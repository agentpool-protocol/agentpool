// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {
    IAgentPoolV43ContributionLedger
} from "./interfaces/IAgentPoolV43ContributionLedger.sol";
import {
    IAgentPoolV435SystemIssueGate
} from "./interfaces/IAgentPoolV435SystemIssueGate.sol";
import {
    IAgentPoolV43ObjectiveVerifier
} from "./interfaces/IAgentPoolV43ObjectiveVerifier.sol";

/// @notice Finite testnet incubation market for the period where one operator
///         may be the only available AI. It never mints, writes Work Power, or
///         changes the recommended release. Distinct proven work items may pay
///         the same AI; duplicate evidence may not.
contract AgentPoolV437SelfBootstrapPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Scope {
        NONE,
        RUNNER,
        MCP,
        INDEXER,
        EXPLORER,
        VERIFIER_TESTS,
        ADAPTER
    }

    enum Role {
        NONE,
        PLANNER,
        REPRODUCER,
        IMPLEMENTER,
        VALIDATOR,
        KEEPER
    }

    enum IssueState {
        NONE,
        OPEN,
        SETTLED,
        EXPIRED
    }

    enum WorkState {
        NONE,
        PLANNED,
        COMPLETED,
        PAID
    }

    struct Issue {
        address proposer;
        Scope scope;
        IssueState state;
        uint64 openedBlock;
        uint64 planningDeadline;
        uint64 executionDeadline;
        uint64 settlementDeadline;
        uint64 openedDay;
        uint64 lastCompletedBlock;
        uint16 itemCount;
        uint128 budgetCap;
        uint128 plannedAmount;
        uint128 paidAmount;
        bool reproductionComplete;
        bool implementationComplete;
        bool validationComplete;
        bytes32 specificationHash;
        bytes32 parentRelease;
        bytes32 candidateRelease;
    }

    struct WorkItem {
        bytes32 issueId;
        address worker;
        Role role;
        WorkState state;
        uint128 quote;
        bytes32 specificationHash;
        bytes32 expectedEvidenceHash;
        bytes32 deliveryHash;
        bytes32 receiptHash;
    }

    IERC20 public immutable token;
    IAgentPoolV435SystemIssueGate public immutable stageGate;
    IAgentPoolV43ContributionLedger public immutable contributionLedger;
    IAgentPoolV43ObjectiveVerifier public immutable verifier;
    bytes32 public immutable financeInvariantHash;
    uint128 public immutable maxItemQuote;
    uint128 public immutable maxIssueBudget;
    uint128 public immutable dailyCap;
    uint128 public immutable lifetimeCap;
    uint16 public immutable maxItemsPerIssue;
    uint64 public immutable maxIssueLifetime;

    uint256 public totalFunded;
    uint256 public totalReserved;
    uint256 public totalPaid;
    bool public graduated;

    mapping(bytes32 => Issue) public issues;
    mapping(bytes32 => WorkItem) public workItems;
    mapping(bytes32 => bytes32[]) private issueItemIds;
    mapping(bytes32 => bool) public usedIssueHash;
    mapping(bytes32 => bool) public usedDeliveryHash;
    mapping(bytes32 => bool) public usedReceiptHash;
    mapping(bytes32 => bool) public incubationProvenRelease;
    mapping(address => bytes32) public activeIssue;
    mapping(uint64 => uint256) public dailyReserved;

    event Funded(address indexed funder, uint256 amount, uint256 totalFunded);
    event Graduated(uint256 totalPaid);
    event IssueOpened(
        bytes32 indexed issueId,
        address indexed proposer,
        Scope scope,
        uint256 budgetCap,
        bytes32 candidateRelease
    );
    event WorkBidAccepted(
        bytes32 indexed issueId,
        bytes32 indexed itemId,
        address indexed worker,
        Role role,
        uint256 quote
    );
    event WorkCompleted(
        bytes32 indexed issueId,
        bytes32 indexed itemId,
        address indexed worker,
        Role role,
        bytes32 deliveryHash,
        bytes32 receiptHash
    );
    event WorkPaid(
        bytes32 indexed issueId,
        bytes32 indexed itemId,
        address indexed worker,
        Role role,
        uint256 amount
    );
    event IncubationSettled(
        bytes32 indexed issueId,
        bytes32 indexed candidateRelease,
        uint256 totalPaid,
        uint256 unusedBudget
    );
    event IssueExpired(bytes32 indexed issueId, uint256 releasedBudget);

    error Unauthorized();
    error UnauthorizedStage();
    error InvalidTerms();
    error InvalidState();
    error InvalidProof();
    error Duplicate();
    error CapacityExceeded();
    error Deadline();
    error SameBlockStep();

    constructor(
        IERC20 token_,
        IAgentPoolV435SystemIssueGate stageGate_,
        IAgentPoolV43ContributionLedger contributionLedger_,
        IAgentPoolV43ObjectiveVerifier verifier_,
        bytes32 financeInvariantHash_,
        uint128 maxItemQuote_,
        uint128 maxIssueBudget_,
        uint128 dailyCap_,
        uint128 lifetimeCap_,
        uint16 maxItemsPerIssue_,
        uint64 maxIssueLifetime_
    ) {
        if (
            address(token_) == address(0) ||
            address(stageGate_) == address(0) ||
            address(contributionLedger_) == address(0) ||
            address(verifier_) == address(0) ||
            financeInvariantHash_ == bytes32(0) ||
            maxItemQuote_ == 0 ||
            maxIssueBudget_ < maxItemQuote_ ||
            dailyCap_ < maxIssueBudget_ ||
            lifetimeCap_ < dailyCap_ ||
            maxItemsPerIssue_ < 3 ||
            maxItemsPerIssue_ > 16 ||
            maxIssueLifetime_ == 0
        ) revert InvalidTerms();
        token = token_;
        stageGate = stageGate_;
        contributionLedger = contributionLedger_;
        verifier = verifier_;
        financeInvariantHash = financeInvariantHash_;
        maxItemQuote = maxItemQuote_;
        maxIssueBudget = maxIssueBudget_;
        dailyCap = dailyCap_;
        lifetimeCap = lifetimeCap_;
        maxItemsPerIssue = maxItemsPerIssue_;
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

    function syncGraduation() external returns (bool) {
        _syncGraduation();
        return graduated;
    }

    function selfBootstrapOpen() public view returns (bool) {
        return
            !graduated &&
            !stageGate.transitionReady() &&
            !contributionLedger.mature() &&
            totalPaid < lifetimeCap;
    }

    function issueWorkItems(
        bytes32 issueId
    ) external view returns (bytes32[] memory) {
        return issueItemIds[issueId];
    }

    function openIssue(
        bytes32 issueId,
        bytes32 issueHash,
        Scope scope,
        uint128 budgetCap,
        bytes32 specificationHash,
        bytes32 parentRelease,
        bytes32 candidateRelease,
        uint64 planningDeadline,
        uint64 executionDeadline,
        uint64 settlementDeadline
    ) external nonReentrant {
        _syncGraduation();
        if (!selfBootstrapOpen()) revert UnauthorizedStage();
        if (
            issueId == bytes32(0) ||
            issueHash == bytes32(0) ||
            scope == Scope.NONE ||
            budgetCap == 0 ||
            budgetCap > maxIssueBudget ||
            specificationHash == bytes32(0) ||
            parentRelease == bytes32(0) ||
            candidateRelease == bytes32(0) ||
            planningDeadline <= block.timestamp ||
            executionDeadline <= planningDeadline ||
            settlementDeadline <= executionDeadline ||
            settlementDeadline > block.timestamp + maxIssueLifetime
        ) revert InvalidTerms();
        if (
            issues[issueId].state != IssueState.NONE ||
            usedIssueHash[issueHash] ||
            incubationProvenRelease[candidateRelease] ||
            activeIssue[msg.sender] != bytes32(0)
        ) revert Duplicate();
        uint64 day = uint64(block.timestamp / 1 days);
        if (
            dailyReserved[day] + budgetCap > dailyCap ||
            totalPaid + totalReserved + budgetCap > totalFunded ||
            totalPaid + totalReserved + budgetCap > lifetimeCap
        ) revert CapacityExceeded();

        usedIssueHash[issueHash] = true;
        activeIssue[msg.sender] = issueId;
        dailyReserved[day] += budgetCap;
        totalReserved += budgetCap;
        issues[issueId] = Issue({
            proposer: msg.sender,
            scope: scope,
            state: IssueState.OPEN,
            openedBlock: uint64(block.number),
            planningDeadline: planningDeadline,
            executionDeadline: executionDeadline,
            settlementDeadline: settlementDeadline,
            openedDay: day,
            lastCompletedBlock: 0,
            itemCount: 0,
            budgetCap: budgetCap,
            plannedAmount: 0,
            paidAmount: 0,
            reproductionComplete: false,
            implementationComplete: false,
            validationComplete: false,
            specificationHash: specificationHash,
            parentRelease: parentRelease,
            candidateRelease: candidateRelease
        });
        emit IssueOpened(
            issueId,
            msg.sender,
            scope,
            budgetCap,
            candidateRelease
        );
    }

    /// @notice In SELF_BOOTSTRAP the proposer accepts an advertised quote.
    ///         The same address may fill several roles, but each item has an
    ///         independently committed specification and evidence hash.
    function acceptWorkBid(
        bytes32 issueId,
        bytes32 itemId,
        address worker,
        Role role,
        uint128 quote,
        bytes32 specificationHash,
        bytes32 expectedEvidenceHash
    ) external {
        Issue storage issue = issues[issueId];
        if (msg.sender != issue.proposer) revert Unauthorized();
        if (issue.state != IssueState.OPEN) revert InvalidState();
        if (block.timestamp > issue.planningDeadline) revert Deadline();
        if (
            itemId == bytes32(0) ||
            worker == address(0) ||
            role == Role.NONE ||
            quote == 0 ||
            quote > maxItemQuote ||
            specificationHash == bytes32(0) ||
            expectedEvidenceHash == bytes32(0)
        ) revert InvalidTerms();
        if (workItems[itemId].state != WorkState.NONE) revert Duplicate();
        if (
            issue.itemCount >= maxItemsPerIssue ||
            uint256(issue.plannedAmount) + quote > issue.budgetCap
        ) revert CapacityExceeded();

        issue.itemCount++;
        issue.plannedAmount += quote;
        issueItemIds[issueId].push(itemId);
        workItems[itemId] = WorkItem({
            issueId: issueId,
            worker: worker,
            role: role,
            state: WorkState.PLANNED,
            quote: quote,
            specificationHash: specificationHash,
            expectedEvidenceHash: expectedEvidenceHash,
            deliveryHash: bytes32(0),
            receiptHash: bytes32(0)
        });
        emit WorkBidAccepted(issueId, itemId, worker, role, quote);
    }

    function completeWork(
        bytes32 itemId,
        bytes32 deliveryHash,
        bytes calldata proof
    ) external {
        WorkItem storage item = workItems[itemId];
        Issue storage issue = issues[item.issueId];
        if (item.state != WorkState.PLANNED) revert InvalidState();
        if (msg.sender != item.worker) revert Unauthorized();
        if (issue.state != IssueState.OPEN) revert InvalidState();
        if (block.timestamp > issue.executionDeadline) revert Deadline();
        if (block.number <= issue.openedBlock) revert SameBlockStep();
        if (
            item.role == Role.IMPLEMENTER &&
            !issue.reproductionComplete
        ) revert InvalidState();
        if (
            item.role == Role.VALIDATOR &&
            !issue.implementationComplete
        ) revert InvalidState();
        if (deliveryHash == bytes32(0) || usedDeliveryHash[deliveryHash]) {
            revert Duplicate();
        }
        if (
            !verifier.verify(
                item.specificationHash,
                deliveryHash,
                item.expectedEvidenceHash,
                proof
            )
        ) revert InvalidProof();
        bytes32 receiptHash = keccak256(
            abi.encode(
                itemId,
                item.worker,
                item.role,
                item.specificationHash,
                deliveryHash,
                keccak256(proof)
            )
        );
        if (usedReceiptHash[receiptHash]) revert Duplicate();

        usedDeliveryHash[deliveryHash] = true;
        usedReceiptHash[receiptHash] = true;
        item.deliveryHash = deliveryHash;
        item.receiptHash = receiptHash;
        item.state = WorkState.COMPLETED;
        issue.lastCompletedBlock = uint64(block.number);
        if (item.role == Role.REPRODUCER) issue.reproductionComplete = true;
        if (item.role == Role.IMPLEMENTER) issue.implementationComplete = true;
        if (item.role == Role.VALIDATOR) issue.validationComplete = true;
        emit WorkCompleted(
            item.issueId,
            itemId,
            msg.sender,
            item.role,
            deliveryHash,
            receiptHash
        );
    }

    function settleIssue(bytes32 issueId) external nonReentrant {
        Issue storage issue = issues[issueId];
        if (issue.state != IssueState.OPEN) revert InvalidState();
        if (block.timestamp > issue.settlementDeadline) revert Deadline();
        if (
            !issue.reproductionComplete ||
            !issue.implementationComplete ||
            !issue.validationComplete
        ) revert InvalidProof();
        if (block.number <= issue.lastCompletedBlock) revert SameBlockStep();

        bytes32[] storage itemIds = issueItemIds[issueId];
        uint256 payout;
        for (uint256 index; index < itemIds.length; ++index) {
            bytes32 itemId = itemIds[index];
            WorkItem storage item = workItems[itemId];
            if (item.state != WorkState.COMPLETED) continue;
            item.state = WorkState.PAID;
            payout += item.quote;
            token.safeTransfer(item.worker, item.quote);
            emit WorkPaid(
                issueId,
                itemId,
                item.worker,
                item.role,
                item.quote
            );
        }
        if (payout == 0 || payout > issue.budgetCap) revert InvalidState();
        uint256 unused = uint256(issue.budgetCap) - payout;
        issue.state = IssueState.SETTLED;
        issue.paidAmount = uint128(payout);
        totalReserved -= issue.budgetCap;
        totalPaid += payout;
        dailyReserved[issue.openedDay] -= unused;
        activeIssue[issue.proposer] = bytes32(0);
        incubationProvenRelease[issue.candidateRelease] = true;
        emit IncubationSettled(
            issueId,
            issue.candidateRelease,
            payout,
            unused
        );
        _syncGraduation();
    }

    function expire(bytes32 issueId) external {
        Issue storage issue = issues[issueId];
        if (issue.state != IssueState.OPEN) revert InvalidState();
        if (block.timestamp <= issue.settlementDeadline) revert Deadline();
        issue.state = IssueState.EXPIRED;
        totalReserved -= issue.budgetCap;
        dailyReserved[issue.openedDay] -= issue.budgetCap;
        activeIssue[issue.proposer] = bytes32(0);
        emit IssueExpired(issueId, issue.budgetCap);
    }

    function _syncGraduation() internal {
        if (
            !graduated &&
            (
                stageGate.transitionReady() ||
                contributionLedger.mature() ||
                totalPaid >= lifetimeCap
            )
        ) {
            graduated = true;
            emit Graduated(totalPaid);
        }
    }
}
