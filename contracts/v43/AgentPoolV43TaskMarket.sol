// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAgentPoolV43ContributionLedger} from "./interfaces/IAgentPoolV43ContributionLedger.sol";
import {IAgentPoolV43EpochVault} from "./interfaces/IAgentPoolV43EpochVault.sol";
import {IAgentPoolV43UserEscrow} from "./interfaces/IAgentPoolV43UserEscrow.sol";
import {IAgentPoolV43ReleaseRegistry} from "./interfaces/IAgentPoolV43ReleaseRegistry.sol";
import {IAgentPoolV43CapacityRegistry} from "./interfaces/IAgentPoolV43CapacityRegistry.sol";
import {IAgentPoolV43ProofRegistry} from "./interfaces/IAgentPoolV43ProofRegistry.sol";
import {IAgentPoolV43ObjectiveVerifier} from "./interfaces/IAgentPoolV43ObjectiveVerifier.sol";
import {IAgentPoolV43SettlementRouter} from "./interfaces/IAgentPoolV43SettlementRouter.sol";
import {
    IAgentPoolV43SystemIssueGate
} from "./interfaces/IAgentPoolV43SystemIssueGate.sol";

/// @notice Shared settlement market for external buyer work and bounded
///         AgentPool improvement work. Auctions and DAG composition happen
///         through the public MCP; this contract pins the winning plan,
///         reserves funds/capacity, verifies evidence, and conserves funds.
contract AgentPoolV43TaskMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Funding {
        NONE,
        EXTERNAL,
        CORE,
        EVOLUTION
    }

    enum JobState {
        NONE,
        OPEN,
        RUNNING,
        BUDGET_HOLD,
        SETTLED,
        REJECTED,
        REFUNDED,
        EXPIRED
    }

    enum MilestoneState {
        NONE,
        PENDING,
        ACCEPTED,
        DELIVERED,
        SETTLED,
        REJECTED,
        REFUNDED
    }

    struct Job {
        address creator;
        Funding funding;
        JobState state;
        bytes32 planHash;
        bytes32 releaseId;
        bytes32 issueId;
        uint128 budget;
        uint128 paid;
        uint32 nextMilestone;
        uint32 milestoneCount;
        uint64 createdAt;
    }

    struct Milestone {
        address worker;
        address verifier;
        bytes32 capability;
        bytes32 specificationHash;
        bytes32 expectedEvidenceHash;
        bytes32 payoutRoot;
        bytes32 deliveryHash;
        uint128 allocation;
        uint128 workerBond;
        uint128 keeperFee;
        uint64 deadline;
        uint32 capacityUnits;
        uint16 minimumReveals;
        uint16 passScoreBps;
        uint32 commitWindow;
        uint32 revealWindow;
        MilestoneState state;
        bool candidateAttested;
        bool adoptionRecorded;
    }

    struct MilestoneTerms {
        address worker;
        address verifier;
        bytes32 capability;
        bytes32 specificationHash;
        bytes32 expectedEvidenceHash;
        bytes32 payoutRoot;
        uint128 allocation;
        uint128 workerBond;
        uint128 keeperFee;
        uint64 deadline;
        uint32 capacityUnits;
        uint16 minimumReveals;
        uint16 passScoreBps;
        uint32 commitWindow;
        uint32 revealWindow;
    }

    IERC20 public immutable token;
    IAgentPoolV43UserEscrow public immutable userEscrow;
    IAgentPoolV43EpochVault public immutable coreEpochVault;
    IAgentPoolV43EpochVault public immutable evolutionEpochVault;
    IAgentPoolV43ContributionLedger public immutable contributionLedger;
    IAgentPoolV43ReleaseRegistry public immutable releaseRegistry;
    IAgentPoolV43CapacityRegistry public immutable capacityRegistry;
    IAgentPoolV43ProofRegistry public immutable proofRegistry;
    IAgentPoolV43SettlementRouter public immutable settlementRouter;
    IAgentPoolV43SystemIssueGate public immutable systemIssueGate;
    bytes32 public immutable financeInvariantHash;

    uint64 public constant REFUND_GRACE = 1 days;
    uint32 public constant MIN_PROOF_WINDOW = 60;
    uint32 public constant MAX_PROOF_WINDOW = 3 days;
    uint16 public constant BPS = 10_000;
    bytes32 public constant SYSTEM_IMPROVEMENT_CAPABILITY =
        0x805bcba7d015dd2c50bd6727020ab95dd6bbc7b5dade14d865bcc962f4e4cff8;
    uint16 public constant MAX_MILESTONES = 32;

    uint256 public nextJobNonce = 1;
    uint256 public slashPool;
    mapping(bytes32 => Job) public jobs;
    mapping(bytes32 => mapping(uint32 => Milestone)) public milestones;

    event JobCreated(
        bytes32 indexed jobId,
        address indexed creator,
        Funding funding,
        uint256 budget,
        bytes32 releaseId,
        bytes32 planHash,
        bytes32 issueId
    );
    event BudgetHeld(bytes32 indexed jobId, bytes32 reasonHash);
    event JobReplanned(bytes32 indexed jobId, bytes32 newPlanHash);
    event MilestoneAccepted(
        bytes32 indexed jobId,
        uint32 indexed milestone,
        address indexed worker
    );
    event MilestoneDelivered(
        bytes32 indexed jobId,
        uint32 indexed milestone,
        bytes32 deliveryHash,
        bytes32 proofRoundId
    );
    event MilestoneSettled(
        bytes32 indexed jobId,
        uint32 indexed milestone,
        uint256 paid,
        address indexed keeper
    );
    event JobClosed(
        bytes32 indexed jobId,
        JobState state,
        uint256 paid,
        uint256 returnedOrReleased
    );
    event CandidateAttested(
        bytes32 indexed jobId,
        uint32 indexed milestone,
        bytes32 indexed receiptId
    );
    event AdoptionRecorded(
        bytes32 indexed jobId,
        uint256 indexed proposalId,
        bytes32 indexed receiptId
    );

    error InvalidTerms();
    error InvalidState();
    error Unauthorized();
    error BudgetExceeded();
    error VerificationFailed();

    constructor(
        IERC20 token_,
        IAgentPoolV43UserEscrow userEscrow_,
        IAgentPoolV43EpochVault coreEpochVault_,
        IAgentPoolV43EpochVault evolutionEpochVault_,
        IAgentPoolV43ContributionLedger contributionLedger_,
        IAgentPoolV43ReleaseRegistry releaseRegistry_,
        IAgentPoolV43CapacityRegistry capacityRegistry_,
        IAgentPoolV43ProofRegistry proofRegistry_,
        IAgentPoolV43SettlementRouter settlementRouter_,
        IAgentPoolV43SystemIssueGate systemIssueGate_,
        bytes32 financeInvariantHash_
    ) {
        if (
            address(token_) == address(0) ||
            address(userEscrow_) == address(0) ||
            address(coreEpochVault_) == address(0) ||
            address(evolutionEpochVault_) == address(0) ||
            address(contributionLedger_) == address(0) ||
            address(releaseRegistry_) == address(0) ||
            address(capacityRegistry_) == address(0) ||
            address(proofRegistry_) == address(0) ||
            address(settlementRouter_) == address(0) ||
            address(systemIssueGate_) == address(0) ||
            financeInvariantHash_ == bytes32(0)
        ) revert InvalidTerms();
        token = token_;
        userEscrow = userEscrow_;
        coreEpochVault = coreEpochVault_;
        evolutionEpochVault = evolutionEpochVault_;
        contributionLedger = contributionLedger_;
        releaseRegistry = releaseRegistry_;
        capacityRegistry = capacityRegistry_;
        proofRegistry = proofRegistry_;
        settlementRouter = settlementRouter_;
        systemIssueGate = systemIssueGate_;
        financeInvariantHash = financeInvariantHash_;
    }

    function createExternalJob(
        uint128 budget,
        bytes32 planHash,
        bytes32 releaseId,
        MilestoneTerms[] calldata terms
    ) external virtual nonReentrant returns (bytes32 jobId) {
        jobId = _createJob(
            Funding.EXTERNAL,
            budget,
            planHash,
            releaseId,
            bytes32(0),
            terms
        );
        userEscrow.lock(jobId, msg.sender, budget);
    }

    function createSystemJob(
        Funding funding,
        uint128 budget,
        bytes32 planHash,
        bytes32 releaseId,
        IAgentPoolV43SystemIssueGate.IssueTerms calldata issue,
        bytes32[] calldata bootstrapProof,
        MilestoneTerms[] calldata terms
    ) external virtual returns (bytes32 jobId) {
        if (
            funding != Funding.CORE &&
            funding != Funding.EVOLUTION
        ) revert InvalidTerms();
        if (!contributionLedger.mature() && funding != Funding.EVOLUTION) {
            revert Unauthorized();
        }
        if (issue.funding != uint8(funding)) revert InvalidTerms();
        for (uint256 index = 0; index < terms.length; index++) {
            if (
                terms[index].specificationHash !=
                    issue.specificationHash ||
                terms[index].verifier.codehash !=
                    issue.verifierCodehash ||
                terms[index].deadline > issue.expiresAt
            ) {
                revert Unauthorized();
            }
        }
        systemIssueGate.consume(issue, budget, bootstrapProof);
        jobId = _createJob(
            funding,
            budget,
            planHash,
            releaseId,
            issue.issueId,
            terms
        );
        _vault(funding).reserve(jobId, budget);
    }

    function holdBudget(
        bytes32 jobId,
        bytes32 reasonHash
    ) external virtual {
        Job storage job = jobs[jobId];
        if (
            msg.sender != job.creator ||
            reasonHash == bytes32(0) ||
            (
                job.state != JobState.OPEN &&
                job.state != JobState.RUNNING
            )
        ) revert Unauthorized();
        Milestone storage current = milestones[jobId][job.nextMilestone];
        if (current.state != MilestoneState.PENDING) revert InvalidState();
        job.state = JobState.BUDGET_HOLD;
        emit BudgetHeld(jobId, reasonHash);
    }

    function replan(
        bytes32 jobId,
        bytes32 newPlanHash,
        MilestoneTerms[] calldata newTerms
    ) external virtual {
        Job storage job = jobs[jobId];
        if (
            msg.sender != job.creator ||
            job.state != JobState.BUDGET_HOLD ||
            job.nextMilestone != 0 ||
            newPlanHash == bytes32(0) ||
            newTerms.length != job.milestoneCount
        ) revert Unauthorized();
        uint256 committed = _writeTerms(jobId, newTerms, true);
        if (committed > job.budget) revert BudgetExceeded();
        job.planHash = newPlanHash;
        job.state = JobState.OPEN;
        emit JobReplanned(jobId, newPlanHash);
    }

    function acceptMilestone(bytes32 jobId, uint32 milestoneIndex)
        external
        virtual
        nonReentrant
    {
        Job storage job = jobs[jobId];
        Milestone storage milestone = milestones[jobId][milestoneIndex];
        if (
            (
                job.state != JobState.OPEN &&
                job.state != JobState.RUNNING
            ) ||
            milestoneIndex != job.nextMilestone ||
            milestone.state != MilestoneState.PENDING ||
            block.timestamp > milestone.deadline
        ) revert InvalidState();
        if (msg.sender != milestone.worker) revert Unauthorized();
        bytes32 holdId = _capacityHoldId(jobId, milestoneIndex);
        capacityRegistry.reserve(
            holdId,
            msg.sender,
            milestone.capability,
            milestone.capacityUnits
        );
        if (milestone.workerBond != 0) {
            token.safeTransferFrom(
                msg.sender,
                address(this),
                milestone.workerBond
            );
        }
        milestone.state = MilestoneState.ACCEPTED;
        job.state = JobState.RUNNING;
        emit MilestoneAccepted(jobId, milestoneIndex, msg.sender);
    }

    function deliver(
        bytes32 jobId,
        uint32 milestoneIndex,
        bytes32 deliveryHash
    ) external virtual {
        Job storage job = jobs[jobId];
        Milestone storage milestone = milestones[jobId][milestoneIndex];
        if (
            job.state != JobState.RUNNING ||
            milestoneIndex != job.nextMilestone ||
            milestone.state != MilestoneState.ACCEPTED ||
            block.timestamp > milestone.deadline ||
            deliveryHash == bytes32(0)
        ) revert InvalidState();
        if (msg.sender != milestone.worker) revert Unauthorized();
        milestone.deliveryHash = deliveryHash;
        milestone.state = MilestoneState.DELIVERED;
        bytes32 roundId = _proofRoundId(jobId, milestoneIndex);
        if (milestone.minimumReveals != 0) {
            uint64 commitDeadline =
                uint64(block.timestamp + milestone.commitWindow);
            proofRegistry.openRound(
                roundId,
                commitDeadline,
                commitDeadline + milestone.revealWindow
            );
        }
        emit MilestoneDelivered(
            jobId,
            milestoneIndex,
            deliveryHash,
            roundId
        );
    }

    function resolve(
        bytes32 jobId,
        uint32 milestoneIndex,
        bytes calldata proof,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external virtual nonReentrant {
        Job storage job = jobs[jobId];
        Milestone storage milestone = milestones[jobId][milestoneIndex];
        if (
            job.state != JobState.RUNNING ||
            milestoneIndex != job.nextMilestone ||
            milestone.state != MilestoneState.DELIVERED ||
            recipients.length == 0 ||
            recipients.length != amounts.length ||
            keccak256(abi.encode(recipients, amounts)) !=
                milestone.payoutRoot
        ) revert InvalidState();
        uint256 payoutTotal;
        for (uint256 index = 0; index < amounts.length; index++) {
            if (recipients[index] == address(0) || amounts[index] == 0) {
                revert InvalidTerms();
            }
            payoutTotal += amounts[index];
        }
        if (payoutTotal != milestone.allocation) revert BudgetExceeded();

        bool passed = IAgentPoolV43ObjectiveVerifier(milestone.verifier)
            .verify(
                milestone.specificationHash,
                milestone.deliveryHash,
                milestone.expectedEvidenceHash,
                proof
            );
        if (milestone.minimumReveals != 0) {
            bytes32 roundId = _proofRoundId(jobId, milestoneIndex);
            if (
                !proofRegistry.roundReady(roundId) ||
                proofRegistry.revealCount(roundId) <
                    milestone.minimumReveals ||
                proofRegistry.medianScore(roundId) <
                    milestone.passScoreBps
            ) passed = false;
        }
        if (!passed) {
            _reject(jobId, milestoneIndex);
            return;
        }

        uint256 totalPaid = payoutTotal + milestone.keeperFee;
        job.paid += uint128(totalPaid);
        if (job.paid > job.budget) revert BudgetExceeded();
        if (job.funding == Funding.EXTERNAL) {
            for (uint256 index = 0; index < recipients.length; index++) {
                userEscrow.pay(jobId, recipients[index], amounts[index]);
            }
            userEscrow.pay(jobId, msg.sender, milestone.keeperFee);
        } else {
            address[] memory allRecipients =
                new address[](recipients.length + 1);
            uint256[] memory allAmounts =
                new uint256[](amounts.length + 1);
            for (uint256 index = 0; index < recipients.length; index++) {
                allRecipients[index] = recipients[index];
                allAmounts[index] = amounts[index];
            }
            allRecipients[recipients.length] = msg.sender;
            allAmounts[amounts.length] = milestone.keeperFee;
            _vault(job.funding).settle(
                jobId,
                allRecipients,
                allAmounts
            );
        }
        milestone.state = MilestoneState.SETTLED;
        _releaseWorker(jobId, milestoneIndex, milestone, true);
        settlementRouter.recordOutcome(
            keccak256(
                abi.encode(
                    "AGENTPOOL_V43_SETTLEMENT",
                    jobId,
                    milestoneIndex
                )
            ),
            milestone.worker,
            milestone.capacityUnits,
            true
        );
        emit MilestoneSettled(
            jobId,
            milestoneIndex,
            totalPaid,
            msg.sender
        );
        job.nextMilestone++;
        if (job.nextMilestone == job.milestoneCount) {
            _closeSuccessful(jobId, job);
        }
    }

    function refundExpired(
        bytes32 jobId,
        uint32 milestoneIndex
    ) external virtual nonReentrant {
        Job storage job = jobs[jobId];
        Milestone storage milestone = milestones[jobId][milestoneIndex];
        if (
            (
                job.state != JobState.OPEN &&
                job.state != JobState.RUNNING &&
                job.state != JobState.BUDGET_HOLD
            ) ||
            milestoneIndex != job.nextMilestone ||
            block.timestamp <= uint256(milestone.deadline) + REFUND_GRACE ||
            (
                milestone.state != MilestoneState.PENDING &&
                milestone.state != MilestoneState.ACCEPTED &&
                milestone.state != MilestoneState.DELIVERED
            )
        ) revert InvalidState();
        bool accepted = milestone.state != MilestoneState.PENDING;
        milestone.state = MilestoneState.REFUNDED;
        if (accepted) {
            _releaseWorker(jobId, milestoneIndex, milestone, false);
        }
        _returnRemaining(jobId, job, JobState.EXPIRED);
    }

    function attestCandidate(
        bytes32 jobId,
        uint32 milestoneIndex,
        bytes32 receiptId,
        bytes32 moduleHash,
        bytes32 manifestHash,
        uint16 qualityBps,
        uint16 baselineQualityBps,
        uint64 cost,
        uint64 baselineCost,
        uint64 latency,
        uint64 baselineLatency,
        uint16 securityRegressions
    ) external {
        Job storage job = jobs[jobId];
        Milestone storage milestone = milestones[jobId][milestoneIndex];
        if (
            (
                job.funding == Funding.EXTERNAL &&
                milestone.capability != SYSTEM_IMPROVEMENT_CAPABILITY
            ) ||
            milestone.state != MilestoneState.SETTLED ||
            milestone.candidateAttested ||
            msg.sender != milestone.worker
        ) revert Unauthorized();
        milestone.candidateAttested = true;
        settlementRouter.attestCandidate(
            receiptId,
            msg.sender,
            moduleHash,
            manifestHash,
            qualityBps,
            baselineQualityBps,
            cost,
            baselineCost,
            latency,
            baselineLatency,
            securityRegressions
        );
        emit CandidateAttested(jobId, milestoneIndex, receiptId);
    }

    function recordReleaseAdoption(
        bytes32 jobId,
        uint32 milestoneIndex,
        uint256 proposalId,
        bytes32 receiptId
    ) external {
        Job storage job = jobs[jobId];
        Milestone storage milestone = milestones[jobId][milestoneIndex];
        if (
            job.state != JobState.SETTLED ||
            milestone.state != MilestoneState.SETTLED ||
            milestone.adoptionRecorded ||
            msg.sender != milestone.worker
        ) revert Unauthorized();
        milestone.adoptionRecorded = true;
        settlementRouter.recordAdoption(
            proposalId,
            msg.sender,
            receiptId
        );
        emit AdoptionRecorded(jobId, proposalId, receiptId);
    }

    function _createJob(
        Funding funding,
        uint128 budget,
        bytes32 planHash,
        bytes32 releaseId,
        bytes32 issueId,
        MilestoneTerms[] calldata terms
    ) internal returns (bytes32 jobId) {
        if (
            funding == Funding.NONE ||
            budget == 0 ||
            planHash == bytes32(0) ||
            !releaseRegistry.isUsable(releaseId) ||
            terms.length == 0 ||
            terms.length > MAX_MILESTONES
        ) revert InvalidTerms();
        uint256 nonce = nextJobNonce++;
        jobId = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                msg.sender,
                nonce,
                planHash
            )
        );
        jobs[jobId] = Job({
            creator: msg.sender,
            funding: funding,
            state: JobState.OPEN,
            planHash: planHash,
            releaseId: releaseId,
            issueId: issueId,
            budget: budget,
            paid: 0,
            nextMilestone: 0,
            milestoneCount: uint32(terms.length),
            createdAt: uint64(block.timestamp)
        });
        uint256 committed = _writeTerms(jobId, terms, false);
        if (committed > budget) revert BudgetExceeded();
        emit JobCreated(
            jobId,
            msg.sender,
            funding,
            budget,
            releaseId,
            planHash,
            issueId
        );
    }

    function _writeTerms(
        bytes32 jobId,
        MilestoneTerms[] calldata terms,
        bool replacing
    ) internal returns (uint256 committed) {
        uint64 previousDeadline;
        for (uint32 index = 0; index < terms.length; index++) {
            MilestoneTerms calldata term = terms[index];
            if (
                term.worker == address(0) ||
                term.worker == jobs[jobId].creator ||
                term.verifier == address(0) ||
                term.verifier.code.length == 0 ||
                term.capability == bytes32(0) ||
                term.specificationHash == bytes32(0) ||
                term.expectedEvidenceHash == bytes32(0) ||
                term.payoutRoot == bytes32(0) ||
                term.allocation == 0 ||
                term.keeperFee == 0 ||
                term.deadline <= block.timestamp ||
                term.deadline <= previousDeadline ||
                term.capacityUnits == 0 ||
                term.passScoreBps > BPS ||
                (
                    term.minimumReveals != 0 &&
                    (
                        term.commitWindow < MIN_PROOF_WINDOW ||
                        term.revealWindow < MIN_PROOF_WINDOW ||
                        term.commitWindow > MAX_PROOF_WINDOW ||
                        term.revealWindow > MAX_PROOF_WINDOW
                    )
                )
            ) revert InvalidTerms();
            previousDeadline = term.deadline;
            Milestone storage current = milestones[jobId][index];
            if (
                replacing &&
                current.state != MilestoneState.PENDING
            ) revert InvalidState();
            milestones[jobId][index] = Milestone({
                worker: term.worker,
                verifier: term.verifier,
                capability: term.capability,
                specificationHash: term.specificationHash,
                expectedEvidenceHash: term.expectedEvidenceHash,
                payoutRoot: term.payoutRoot,
                deliveryHash: bytes32(0),
                allocation: term.allocation,
                workerBond: term.workerBond,
                keeperFee: term.keeperFee,
                deadline: term.deadline,
                capacityUnits: term.capacityUnits,
                minimumReveals: term.minimumReveals,
                passScoreBps: term.passScoreBps,
                commitWindow: term.commitWindow,
                revealWindow: term.revealWindow,
                state: MilestoneState.PENDING,
                candidateAttested: false,
                adoptionRecorded: false
            });
            committed += uint256(term.allocation) + term.keeperFee;
        }
    }

    function _reject(bytes32 jobId, uint32 milestoneIndex) internal {
        Job storage job = jobs[jobId];
        Milestone storage milestone = milestones[jobId][milestoneIndex];
        milestone.state = MilestoneState.REJECTED;
        _releaseWorker(jobId, milestoneIndex, milestone, false);
        settlementRouter.recordOutcome(
            keccak256(
                abi.encode(
                    "AGENTPOOL_V43_REJECTION",
                    jobId,
                    milestoneIndex
                )
            ),
            milestone.worker,
            milestone.capacityUnits,
            false
        );
        _returnRemaining(jobId, job, JobState.REJECTED);
    }

    function _releaseWorker(
        bytes32 jobId,
        uint32 milestoneIndex,
        Milestone storage milestone,
        bool success
    ) internal {
        capacityRegistry.release(_capacityHoldId(jobId, milestoneIndex));
        uint256 bond = milestone.workerBond;
        milestone.workerBond = 0;
        if (bond == 0) return;
        if (success) token.safeTransfer(milestone.worker, bond);
        else if (jobs[jobId].funding == Funding.EXTERNAL) {
            token.safeTransfer(jobs[jobId].creator, bond);
        } else {
            slashPool += bond;
        }
    }

    function _closeSuccessful(bytes32 jobId, Job storage job) internal {
        job.state = JobState.SETTLED;
        uint256 returned = _releaseFunding(jobId, job);
        emit JobClosed(
            jobId,
            JobState.SETTLED,
            job.paid,
            returned
        );
    }

    function _returnRemaining(
        bytes32 jobId,
        Job storage job,
        JobState state
    ) internal {
        job.state = state;
        uint256 returned = _releaseFunding(jobId, job);
        emit JobClosed(jobId, state, job.paid, returned);
    }

    function _releaseFunding(
        bytes32 jobId,
        Job storage job
    ) internal returns (uint256 returned) {
        if (job.funding == Funding.EXTERNAL) {
            returned = userEscrow.refundRemaining(
                jobId,
                job.creator
            );
        } else {
            returned = _vault(job.funding).release(jobId);
        }
    }

    function _vault(
        Funding funding
    ) internal view returns (IAgentPoolV43EpochVault) {
        if (funding == Funding.CORE) return coreEpochVault;
        if (funding == Funding.EVOLUTION) return evolutionEpochVault;
        revert InvalidTerms();
    }

    function _capacityHoldId(
        bytes32 jobId,
        uint32 milestoneIndex
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode("CAPACITY", jobId, milestoneIndex));
    }

    function _proofRoundId(
        bytes32 jobId,
        uint32 milestoneIndex
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode("PROOF", jobId, milestoneIndex));
    }
}
