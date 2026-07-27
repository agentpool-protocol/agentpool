// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {
    IAgentPoolV41ObjectiveVerifier
} from "./interfaces/IAgentPoolV41.sol";

/// @notice Existing-token escrow for external jobs. It has no reference to the
///         emission controller and therefore can never create tAPOOL.
contract AgentPoolV41UserEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State {
        NONE,
        FUNDED,
        ACCEPTED,
        DELIVERED,
        SETTLED,
        REJECTED,
        REFUNDED
    }

    struct Job {
        address buyer;
        address worker;
        address verifier;
        uint128 budget;
        uint128 workerBond;
        uint64 deadline;
        State state;
        bytes32 specificationHash;
        bytes32 expectedEvidenceHash;
        bytes32 payoutRoot;
        bytes32 deliveryHash;
    }

    IERC20 public immutable token;
    uint64 public constant VERIFIER_GRACE = 3 days;
    uint256 public nextJobId = 1;
    mapping(uint256 => Job) public jobs;

    event JobFunded(
        uint256 indexed jobId,
        address indexed buyer,
        address indexed worker,
        uint256 budget
    );
    event JobAccepted(uint256 indexed jobId);
    event JobDelivered(uint256 indexed jobId, bytes32 deliveryHash);
    event JobSettled(uint256 indexed jobId, bool passed);
    event JobRefunded(uint256 indexed jobId);

    error InvalidTerms();
    error InvalidState();
    error Unauthorized();

    constructor(IERC20 token_) {
        if (address(token_) == address(0)) revert InvalidTerms();
        token = token_;
    }

    function fundJob(
        address worker,
        address verifier,
        uint128 budget,
        uint128 workerBond,
        uint64 deadline,
        bytes32 specificationHash,
        bytes32 expectedEvidenceHash,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external nonReentrant returns (uint256 jobId) {
        if (
            worker == address(0) ||
            worker == msg.sender ||
            verifier == address(0) ||
            verifier.code.length == 0 ||
            budget == 0 ||
            deadline <= block.timestamp ||
            specificationHash == bytes32(0) ||
            expectedEvidenceHash == bytes32(0) ||
            recipients.length == 0 ||
            recipients.length != amounts.length
        ) revert InvalidTerms();
        uint256 total;
        for (uint256 index = 0; index < amounts.length; index++) {
            if (recipients[index] == address(0) || amounts[index] == 0) {
                revert InvalidTerms();
            }
            total += amounts[index];
        }
        if (total != budget) revert InvalidTerms();
        jobId = nextJobId++;
        jobs[jobId] = Job({
            buyer: msg.sender,
            worker: worker,
            verifier: verifier,
            budget: budget,
            workerBond: workerBond,
            deadline: deadline,
            state: State.FUNDED,
            specificationHash: specificationHash,
            expectedEvidenceHash: expectedEvidenceHash,
            payoutRoot: keccak256(abi.encode(recipients, amounts)),
            deliveryHash: bytes32(0)
        });
        token.safeTransferFrom(msg.sender, address(this), budget);
        emit JobFunded(jobId, msg.sender, worker, budget);
    }

    function accept(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (job.state != State.FUNDED || block.timestamp > job.deadline) {
            revert InvalidState();
        }
        if (msg.sender != job.worker) revert Unauthorized();
        job.state = State.ACCEPTED;
        if (job.workerBond != 0) {
            token.safeTransferFrom(msg.sender, address(this), job.workerBond);
        }
        emit JobAccepted(jobId);
    }

    function deliver(uint256 jobId, bytes32 deliveryHash) external {
        Job storage job = jobs[jobId];
        if (
            job.state != State.ACCEPTED ||
            block.timestamp > job.deadline ||
            deliveryHash == bytes32(0)
        ) revert InvalidState();
        if (msg.sender != job.worker) revert Unauthorized();
        job.deliveryHash = deliveryHash;
        job.state = State.DELIVERED;
        emit JobDelivered(jobId, deliveryHash);
    }

    function resolve(
        uint256 jobId,
        bytes calldata proof,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external nonReentrant {
        Job storage job = jobs[jobId];
        if (
            job.state != State.DELIVERED ||
            recipients.length == 0 ||
            recipients.length != amounts.length ||
            keccak256(abi.encode(recipients, amounts)) != job.payoutRoot
        ) revert InvalidState();
        bool passed = IAgentPoolV41ObjectiveVerifier(job.verifier).verify(
            job.specificationHash,
            job.deliveryHash,
            job.expectedEvidenceHash,
            proof
        );
        if (passed) {
            job.state = State.SETTLED;
            uint256 total;
            for (uint256 index = 0; index < amounts.length; index++) {
                total += amounts[index];
                token.safeTransfer(recipients[index], amounts[index]);
            }
            if (total != job.budget) revert InvalidTerms();
            if (job.workerBond != 0) {
                token.safeTransfer(job.worker, job.workerBond);
            }
        } else {
            job.state = State.REJECTED;
            token.safeTransfer(
                job.buyer,
                uint256(job.budget) + job.workerBond
            );
        }
        emit JobSettled(jobId, passed);
    }

    function refundExpired(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (
            block.timestamp <= uint256(job.deadline) + VERIFIER_GRACE ||
            (
                job.state != State.FUNDED &&
                job.state != State.ACCEPTED &&
                job.state != State.DELIVERED
            )
        ) revert InvalidState();
        bool workerAccepted =
            job.state == State.ACCEPTED || job.state == State.DELIVERED;
        job.state = State.REFUNDED;
        token.safeTransfer(job.buyer, job.budget);
        if (workerAccepted && job.workerBond != 0) {
            token.safeTransfer(job.buyer, job.workerBond);
        }
        emit JobRefunded(jobId);
    }
}
