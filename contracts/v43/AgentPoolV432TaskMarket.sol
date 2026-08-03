// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {AgentPoolV43TaskMarket} from "./AgentPoolV43TaskMarket.sol";
import {
    IAgentPoolV43ContributionLedger
} from "./interfaces/IAgentPoolV43ContributionLedger.sol";
import {
    IAgentPoolV43EpochVault
} from "./interfaces/IAgentPoolV43EpochVault.sol";
import {
    IAgentPoolV43UserEscrow
} from "./interfaces/IAgentPoolV43UserEscrow.sol";
import {
    IAgentPoolV43ReleaseRegistry
} from "./interfaces/IAgentPoolV43ReleaseRegistry.sol";
import {
    IAgentPoolV43CapacityRegistry
} from "./interfaces/IAgentPoolV43CapacityRegistry.sol";
import {
    IAgentPoolV43ProofRegistry
} from "./interfaces/IAgentPoolV43ProofRegistry.sol";
import {
    IAgentPoolV43ObjectiveVerifier
} from "./interfaces/IAgentPoolV43ObjectiveVerifier.sol";
import {
    IAgentPoolV43SettlementRouter
} from "./interfaces/IAgentPoolV43SettlementRouter.sol";
import {
    IAgentPoolV43SystemIssueGate
} from "./interfaces/IAgentPoolV43SystemIssueGate.sol";
import {
    IAgentPoolV432ProofRegistry
} from "./interfaces/IAgentPoolV432ProofRegistry.sol";
import {
    IAgentPoolV432SystemIssueGate
} from "./interfaces/IAgentPoolV432SystemIssueGate.sol";
import {
    IAgentPoolV435SystemIssueGate
} from "./interfaces/IAgentPoolV435SystemIssueGate.sol";

/// @notice Security-compatible v4.3.2 settlement market. It keeps the v4.3.1
///         finance kernel but makes system evidence and validator membership
///         part of the admitted Issue instead of proposer-selected inputs.
contract AgentPoolV432TaskMarket is AgentPoolV43TaskMarket {
    /// @notice Governance-eligible reserve work is deliberately one objective
    ///         per admission before MATURE. Multi-step plans must use separate
    ///         Issues so the 49-exposure safety bound is exact on chain.
    uint32 public constant MAX_GOVERNANCE_MILESTONES = 1;
    using SafeERC20 for IERC20;

    struct ValidationPolicy {
        bytes32 validatorRoot;
        uint16 minimumOperatorGroups;
    }

    IAgentPoolV432ProofRegistry private immutable proofRegistryV2;
    IAgentPoolV435SystemIssueGate private immutable systemIssueGateV2;
    mapping(bytes32 => mapping(uint32 => ValidationPolicy))
        private validationPolicies;
    mapping(bytes32 => mapping(uint32 => uint32)) private dependencyMasks;
    mapping(bytes32 => uint32) private settledMasks;
    mapping(bytes32 => uint32) private activeMilestones;
    mapping(bytes32 => uint32) private settledMilestoneCount;
    mapping(bytes32 => bool) public jobGovernanceEligible;

    event SlashReused(bytes32 indexed jobId, uint256 amount);
    event DependencyGraphPinned(bytes32 indexed jobId, uint32 milestoneCount);

    constructor(
        IERC20 token_,
        IAgentPoolV43UserEscrow userEscrow_,
        IAgentPoolV43EpochVault coreEpochVault_,
        IAgentPoolV43EpochVault evolutionEpochVault_,
        IAgentPoolV43ContributionLedger contributionLedger_,
        IAgentPoolV43ReleaseRegistry releaseRegistry_,
        IAgentPoolV43CapacityRegistry capacityRegistry_,
        IAgentPoolV432ProofRegistry proofRegistry_,
        IAgentPoolV43SettlementRouter settlementRouter_,
        IAgentPoolV435SystemIssueGate systemIssueGate_,
        bytes32 financeInvariantHash_
    )
        AgentPoolV43TaskMarket(
            token_,
            userEscrow_,
            coreEpochVault_,
            evolutionEpochVault_,
            contributionLedger_,
            releaseRegistry_,
            capacityRegistry_,
            IAgentPoolV43ProofRegistry(address(proofRegistry_)),
            settlementRouter_,
            IAgentPoolV43SystemIssueGate(address(systemIssueGate_)),
            financeInvariantHash_
        )
    {
        proofRegistryV2 = proofRegistry_;
        systemIssueGateV2 = systemIssueGate_;
    }

    function createExternalJob(
        uint128,
        bytes32,
        bytes32,
        MilestoneTerms[] calldata
    ) external pure override returns (bytes32) {
        revert Unauthorized();
    }

    function createSystemJob(
        Funding,
        uint128,
        bytes32,
        bytes32,
        IAgentPoolV43SystemIssueGate.IssueTerms calldata,
        bytes32[] calldata,
        MilestoneTerms[] calldata
    ) external pure override returns (bytes32) {
        revert Unauthorized();
    }

    function createExternalJobV2(
        uint128 budget,
        bytes32 planHash,
        bytes32 releaseId,
        MilestoneTerms[] calldata terms,
        ValidationPolicy[] calldata policies,
        uint32[] calldata dependencies
    ) external nonReentrant returns (bytes32 jobId) {
        _validatePlan(terms, policies, dependencies);
        jobId = _createJob(
            Funding.EXTERNAL,
            budget,
            planHash,
            releaseId,
            bytes32(0),
            terms
        );
        _storePolicies(jobId, policies);
        _storeDependencies(jobId, dependencies);
        userEscrow.lock(jobId, msg.sender, budget);
    }

    function createSystemJobV2(
        Funding funding,
        uint128 budget,
        bytes32 planHash,
        bytes32 releaseId,
        IAgentPoolV432SystemIssueGate.IssueTerms calldata issue,
        bytes32[] calldata bootstrapProof,
        MilestoneTerms[] calldata terms,
        ValidationPolicy[] calldata policies,
        uint32[] calldata dependencies,
        bytes32[][] calldata objectiveProofs
    ) external nonReentrant returns (bytes32 jobId) {
        if (
            funding != Funding.CORE &&
            funding != Funding.EVOLUTION
        ) revert InvalidTerms();
        if (!contributionLedger.mature() && funding != Funding.EVOLUTION) {
            revert Unauthorized();
        }
        if (issue.funding != uint8(funding)) revert InvalidTerms();
        if (
            issue.bootstrapProposer == address(0) &&
            terms.length != MAX_GOVERNANCE_MILESTONES
        ) revert InvalidTerms();
        _validatePlan(terms, policies, dependencies);
        if (objectiveProofs.length != terms.length) revert InvalidTerms();
        for (uint256 index = 0; index < terms.length; index++) {
            MilestoneTerms calldata term = terms[index];
            ValidationPolicy calldata policy = policies[index];
            if (
                term.verifier != issue.verifier ||
                term.minimumReveals != issue.minimumReveals ||
                term.passScoreBps != issue.passScoreBps ||
                policy.validatorRoot != issue.validatorRoot ||
                policy.minimumOperatorGroups !=
                    issue.minimumValidatorGroups ||
                term.deadline > issue.expiresAt ||
                !MerkleProof.verifyCalldata(
                    objectiveProofs[index],
                    issue.objectiveRoot,
                    objectiveLeaf(term, policy)
                )
            ) revert Unauthorized();
            for (uint256 prior = 0; prior < index; prior++) {
                if (
                    objectiveLeaf(terms[prior], policies[prior]) ==
                    objectiveLeaf(term, policy)
                ) revert InvalidTerms();
            }
        }
        uint128 reservedBudget = _committedBudget(terms);
        if (reservedBudget > budget) {
            revert BudgetExceeded();
        }
        bool bootstrapAdmitted = systemIssueGateV2.consumeFor(
            issue,
            reservedBudget,
            msg.sender,
            bootstrapProof
        );
        jobId = _createJob(
            funding,
            reservedBudget,
            planHash,
            releaseId,
            issue.issueId,
            terms
        );
        jobGovernanceEligible[jobId] = !bootstrapAdmitted;
        _storePolicies(jobId, policies);
        _storeDependencies(jobId, dependencies);
        _vault(funding).reserve(jobId, reservedBudget);
    }

    function objectiveLeaf(
        MilestoneTerms calldata term,
        ValidationPolicy calldata policy
    ) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(
            term.verifier,
            term.capability,
            term.specificationHash,
            term.expectedEvidenceHash,
            term.capacityUnits,
            term.minimumReveals,
            term.passScoreBps,
            term.commitWindow,
            term.revealWindow,
            policy.validatorRoot,
            policy.minimumOperatorGroups
        ))));
    }

    function holdBudget(
        bytes32 jobId,
        bytes32 reasonHash
    ) external override {
        Job storage job = jobs[jobId];
        if (
            msg.sender != job.creator ||
            reasonHash == bytes32(0) ||
            (
                job.state != JobState.OPEN &&
                job.state != JobState.RUNNING
            ) ||
            activeMilestones[jobId] != 0 ||
            settledMilestoneCount[jobId] == job.milestoneCount
        ) revert Unauthorized();
        job.state = JobState.BUDGET_HOLD;
        emit BudgetHeld(jobId, reasonHash);
    }

    function replan(
        bytes32,
        bytes32,
        MilestoneTerms[] calldata
    ) external pure override {
        revert Unauthorized();
    }

    function replanRemainingV2(
        bytes32,
        bytes32,
        MilestoneTerms[] calldata,
        ValidationPolicy[] calldata,
        uint32[] calldata,
        bytes32[][] calldata
    ) external pure {
        // Replanning creates a new continuation job. Existing jobs remain
        // immutable so prices, workers, proofs, and payout roots cannot change.
        revert Unauthorized();
    }

    function acceptMilestone(
        bytes32 jobId,
        uint32 milestoneIndex
    ) external override nonReentrant {
        Job storage job = jobs[jobId];
        Milestone storage milestone = milestones[jobId][milestoneIndex];
        uint32 dependencies = dependencyMasks[jobId][milestoneIndex];
        if (
            (
                job.state != JobState.OPEN &&
                job.state != JobState.RUNNING
            ) ||
            milestoneIndex >= job.milestoneCount ||
            milestone.state != MilestoneState.PENDING ||
            (settledMasks[jobId] & dependencies) != dependencies ||
            block.timestamp > milestone.deadline
        ) revert InvalidState();
        if (msg.sender != milestone.worker) revert Unauthorized();
        if (contributionLedger.operatorGroup(msg.sender) == bytes32(0)) {
            revert Unauthorized();
        }
        capacityRegistry.reserve(
            _capacityHoldId(jobId, milestoneIndex),
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
        activeMilestones[jobId]++;
        job.state = JobState.RUNNING;
        emit MilestoneAccepted(jobId, milestoneIndex, msg.sender);
    }

    function deliver(
        bytes32 jobId,
        uint32 milestoneIndex,
        bytes32 deliveryHash
    ) external override {
        Job storage job = jobs[jobId];
        Milestone storage milestone = milestones[jobId][milestoneIndex];
        if (
            job.state != JobState.RUNNING ||
            milestoneIndex >= job.milestoneCount ||
            milestone.state != MilestoneState.ACCEPTED ||
            block.timestamp > milestone.deadline ||
            deliveryHash == bytes32(0)
        ) revert InvalidState();
        if (msg.sender != milestone.worker) revert Unauthorized();
        milestone.deliveryHash = deliveryHash;
        milestone.state = MilestoneState.DELIVERED;
        bytes32 roundId = _proofRoundId(jobId, milestoneIndex);
        if (milestone.minimumReveals != 0) {
            ValidationPolicy storage policy =
                validationPolicies[jobId][milestoneIndex];
            uint64 commitDeadline =
                uint64(block.timestamp + milestone.commitWindow);
            proofRegistryV2.openRoundWithPolicy(
                roundId,
                commitDeadline,
                commitDeadline + milestone.revealWindow,
                policy.validatorRoot,
                contributionLedger.operatorGroup(milestone.worker),
                policy.minimumOperatorGroups
            );
            milestone.deadline = commitDeadline + milestone.revealWindow;
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
    ) external override nonReentrant {
        Job storage job = jobs[jobId];
        Milestone storage milestone = milestones[jobId][milestoneIndex];
        if (
            job.state != JobState.RUNNING ||
            milestoneIndex >= job.milestoneCount ||
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
        // A caller-selected invalid proof must never be able to reject another
        // agent's delivery. Invalid deterministic evidence is a no-op; a bad
        // delivery is eventually handled by the validator result or the
        // permissionless expiry/refund path.
        if (!passed) revert VerificationFailed();
        if (milestone.minimumReveals != 0) {
            bytes32 roundId = _proofRoundId(jobId, milestoneIndex);
            ValidationPolicy storage policy =
                validationPolicies[jobId][milestoneIndex];
            uint8 proofStatus = proofRegistryV2.resolutionStatus(
                roundId,
                milestone.minimumReveals,
                policy.minimumOperatorGroups,
                milestone.passScoreBps
            );
            if (proofStatus == 1) {
                _abortJob(
                    jobId,
                    milestoneIndex,
                    MilestoneState.REFUNDED,
                    JobState.REFUNDED
                );
                return;
            }
            passed = proofStatus == 3;
        }
        if (!passed) {
            _abortJob(
                jobId,
                milestoneIndex,
                MilestoneState.REJECTED,
                JobState.REJECTED
            );
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
            _settleSystem(
                jobId,
                job.funding,
                recipients,
                amounts,
                msg.sender,
                milestone.keeperFee
            );
        }
        milestone.state = MilestoneState.SETTLED;
        _releaseWorker(jobId, milestoneIndex, milestone, true);
        _recordVerifiedOutcome(
            jobId,
            keccak256(
                abi.encode(
                    "AGENTPOOL_V432_SETTLEMENT",
                    jobId,
                    milestoneIndex
                )
            ),
            milestone.worker,
            milestone.capability,
            milestone.capacityUnits,
            true
        );
        emit MilestoneSettled(
            jobId,
            milestoneIndex,
            totalPaid,
            msg.sender
        );
        uint32 bit = uint32(1) << milestoneIndex;
        settledMasks[jobId] |= bit;
        settledMilestoneCount[jobId]++;
        activeMilestones[jobId]--;
        if (settledMilestoneCount[jobId] == job.milestoneCount) {
            _releaseIssueAdmission(job);
            _closeSuccessful(jobId, job);
        }
    }

    function refundExpired(
        bytes32 jobId,
        uint32 milestoneIndex
    ) external override nonReentrant {
        Job storage job = jobs[jobId];
        Milestone storage milestone = milestones[jobId][milestoneIndex];
        if (
            (
                job.state != JobState.OPEN &&
                job.state != JobState.RUNNING &&
                job.state != JobState.BUDGET_HOLD
            ) ||
            milestoneIndex >= job.milestoneCount ||
            block.timestamp <= uint256(milestone.deadline) + REFUND_GRACE ||
            (
                milestone.state != MilestoneState.PENDING &&
                milestone.state != MilestoneState.ACCEPTED &&
                milestone.state != MilestoneState.DELIVERED
            )
        ) revert InvalidState();
        bool validatorFailure =
            milestone.state == MilestoneState.DELIVERED &&
            milestone.minimumReveals != 0;
        if (validatorFailure) {
            ValidationPolicy storage policy =
                validationPolicies[jobId][milestoneIndex];
            uint8 proofStatus = proofRegistryV2.resolutionStatus(
                _proofRoundId(jobId, milestoneIndex),
                milestone.minimumReveals,
                policy.minimumOperatorGroups,
                milestone.passScoreBps
            );
            if (proofStatus == 2) {
                _abortJob(
                    jobId,
                    milestoneIndex,
                    MilestoneState.REJECTED,
                    JobState.REJECTED
                );
                return;
            }
        }
        _abortJob(
            jobId,
            milestoneIndex,
            MilestoneState.REFUNDED,
            validatorFailure ? JobState.REFUNDED : JobState.EXPIRED
        );
    }

    function _validatePlan(
        MilestoneTerms[] calldata terms,
        ValidationPolicy[] calldata policies,
        uint32[] calldata dependencies
    ) private pure {
        if (
            terms.length != policies.length ||
            terms.length != dependencies.length
        ) revert InvalidTerms();
        for (uint256 index = 0; index < terms.length; index++) {
            MilestoneTerms calldata term = terms[index];
            ValidationPolicy calldata policy = policies[index];
            uint256 allowedDependencies =
                index == 0 ? 0 : (uint256(1) << index) - 1;
            if (
                uint256(dependencies[index]) > allowedDependencies ||
                (
                    term.minimumReveals == 0 &&
                    (
                        policy.validatorRoot != bytes32(0) ||
                        policy.minimumOperatorGroups != 0
                    )
                ) ||
                (
                    term.minimumReveals != 0 &&
                    (
                        policy.validatorRoot == bytes32(0) ||
                        policy.minimumOperatorGroups == 0 ||
                        policy.minimumOperatorGroups >
                            term.minimumReveals
                    )
                )
            ) revert InvalidTerms();
        }
    }

    function _storePolicies(
        bytes32 jobId,
        ValidationPolicy[] calldata policies
    ) private {
        for (uint32 index = 0; index < policies.length; index++) {
            validationPolicies[jobId][index] = policies[index];
        }
    }

    function _storeDependencies(
        bytes32 jobId,
        uint32[] calldata dependencies
    ) private {
        for (uint32 index = 0; index < dependencies.length; index++) {
            dependencyMasks[jobId][index] = dependencies[index];
        }
        emit DependencyGraphPinned(jobId, uint32(dependencies.length));
    }

    function _abortJob(
        bytes32 jobId,
        uint32 failedIndex,
        MilestoneState failedState,
        JobState finalState
    ) private {
        Job storage job = jobs[jobId];
        for (uint32 index = 0; index < job.milestoneCount; index++) {
            Milestone storage current = milestones[jobId][index];
            if (
                current.state == MilestoneState.ACCEPTED ||
                current.state == MilestoneState.DELIVERED
            ) {
                _releaseWorker(
                    jobId,
                    index,
                    current,
                    index != failedIndex ||
                        finalState == JobState.REFUNDED
                );
            }
            if (
                current.state == MilestoneState.PENDING ||
                current.state == MilestoneState.ACCEPTED ||
                current.state == MilestoneState.DELIVERED
            ) {
                current.state =
                    index == failedIndex
                        ? failedState
                        : MilestoneState.REFUNDED;
            }
        }
        activeMilestones[jobId] = 0;
        if (failedState == MilestoneState.REJECTED) {
            Milestone storage failed = milestones[jobId][failedIndex];
            _recordVerifiedOutcome(
                jobId,
                keccak256(
                    abi.encode(
                        "AGENTPOOL_V432_REJECTION",
                        jobId,
                        failedIndex
                    )
                ),
                failed.worker,
                failed.capability,
                failed.capacityUnits,
                false
            );
        }
        _releaseIssueAdmission(job);
        _returnRemaining(jobId, job, finalState);
    }

    function _releaseIssueAdmission(Job storage job) private {
        if (job.funding != Funding.EXTERNAL) {
            systemIssueGateV2.releaseFor(
                job.issueId,
                job.budget,
                job.creator
            );
        }
    }

    function _committedBudget(
        MilestoneTerms[] calldata terms
    ) private pure returns (uint128) {
        uint256 committed;
        for (uint256 index = 0; index < terms.length; index++) {
            committed +=
                uint256(terms[index].allocation) +
                terms[index].keeperFee;
        }
        if (committed > type(uint128).max) revert BudgetExceeded();
        return uint128(committed);
    }

    function _recordVerifiedOutcome(
        bytes32 jobId,
        bytes32 receiptId,
        address agent,
        bytes32 capability,
        uint128 units,
        bool successful
    ) private {
        if (jobs[jobId].funding == Funding.EXTERNAL) {
            settlementRouter.recordPerformanceOutcome(
                receiptId,
                agent,
                capability,
                units,
                successful
            );
        } else if (!jobGovernanceEligible[jobId]) {
            settlementRouter.recordBootstrapOutcome(
                receiptId,
                agent,
                capability,
                units,
                successful
            );
        } else {
            settlementRouter.recordOutcome(
                receiptId,
                agent,
                capability,
                units,
                successful
            );
        }
    }

    function _settleSystem(
        bytes32 jobId,
        Funding funding,
        address[] calldata recipients,
        uint256[] calldata amounts,
        address keeper,
        uint256 keeperFee
    ) private {
        uint256 count = recipients.length + 1;
        address[] memory allRecipients = new address[](count);
        uint256[] memory allAmounts = new uint256[](count);
        uint256 remainingCount;
        uint256 reusable = slashPool;
        uint256 reused;

        for (uint256 index = 0; index < count; index++) {
            address recipient =
                index < recipients.length ? recipients[index] : keeper;
            uint256 amount =
                index < amounts.length ? amounts[index] : keeperFee;
            uint256 fromSlash = reusable < amount ? reusable : amount;
            if (fromSlash != 0) {
                reusable -= fromSlash;
                reused += fromSlash;
                token.safeTransfer(recipient, fromSlash);
            }
            if (amount > fromSlash) remainingCount++;
            allRecipients[index] = recipient;
            allAmounts[index] = amount - fromSlash;
        }
        slashPool = reusable;
        if (reused != 0) emit SlashReused(jobId, reused);
        if (remainingCount == 0) return;

        address[] memory mintRecipients = new address[](remainingCount);
        uint256[] memory mintAmounts = new uint256[](remainingCount);
        uint256 cursor;
        for (uint256 index = 0; index < count; index++) {
            if (allAmounts[index] == 0) continue;
            mintRecipients[cursor] = allRecipients[index];
            mintAmounts[cursor] = allAmounts[index];
            cursor++;
        }
        _vault(funding).settle(jobId, mintRecipients, mintAmounts);
    }
}
