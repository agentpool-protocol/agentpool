// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAgentPoolResolver} from "./interfaces/IAgentPoolResolver.sol";
import {IAgentPoolEscrow} from "./interfaces/IAgentPoolEscrow.sol";
import {IAgentPoolRegistry} from "./interfaces/IAgentPoolRegistry.sol";

/// @notice APOOL job escrow. Human checkout and arbitrary ERC-20 assets are deliberately unsupported.
contract AgentPoolJobEscrow is Ownable, ReentrancyGuard, IAgentPoolEscrow {
    using SafeERC20 for IERC20;

    uint16 public constant PROTOCOL_FEE_BPS = 0;
    uint16 public constant EVALUATOR_SHARE_BPS = 9_000;
    uint16 public constant SECURITY_SHARE_BPS = 1_000;
    uint64 public constant CHALLENGE_WINDOW = 2 hours;

    enum State {
        NONE,
        FUNDED,
        ACCEPTED,
        SUBMITTED,
        PROPOSED,
        CHALLENGED,
        COMPLETED,
        REJECTED,
        REFUNDED,
        EXPIRED
    }

    struct Job {
        address buyer;
        address seller;
        uint128 price;
        uint128 evaluationBudget;
        uint128 sellerBond;
        uint64 deadline;
        uint64 challengeDeadline;
        State state;
        Outcome proposedOutcome;
        bytes32 requirementsHash;
        bytes32 deliveryHash;
        bytes32 verifierId;
    }

    IERC20 public immutable apool;
    IAgentPoolRegistry public immutable registry;
    address public resolver;
    address public securityTreasury;
    uint256 public nextJobId = 1;
    mapping(uint256 => Job) public jobs;

    event JobFunded(uint256 indexed jobId, address indexed buyer, address indexed seller, uint256 price);
    event JobAccepted(uint256 indexed jobId, uint256 sellerBond);
    event JobSubmitted(uint256 indexed jobId, bytes32 indexed deliveryHash);
    event OutcomeProposed(uint256 indexed jobId, Outcome outcome, uint64 challengeDeadline);
    event JobChallenged(uint256 indexed jobId);
    event JobSettled(uint256 indexed jobId, Outcome outcome, State state);
    error InvalidState();
    error Unauthorized();
    error InvalidTerms();

    constructor(
        IERC20 token,
        IAgentPoolRegistry registry_,
        address governance,
        address securityTreasury_
    ) Ownable(governance) {
        if (
            address(token) == address(0) ||
            address(registry_) == address(0) ||
            securityTreasury_ == address(0)
        ) revert InvalidTerms();
        apool = token;
        registry = registry_;
        securityTreasury = securityTreasury_;
    }

    function setResolver(address resolver_) external onlyOwner {
        if (resolver_ == address(0)) revert InvalidTerms();
        resolver = resolver_;
    }

    function fundJob(
        address seller,
        uint128 price,
        uint128 evaluationBudget,
        uint128 sellerBond,
        uint64 deadline,
        bytes32 requirementsHash,
        bytes32 verifierId
    ) external nonReentrant returns (uint256 jobId) {
        if (
            seller == address(0) ||
            seller == msg.sender ||
            price == 0 ||
            evaluationBudget == 0 ||
            sellerBond == 0 ||
            deadline <= block.timestamp ||
            requirementsHash == bytes32(0) ||
            verifierId == bytes32(0)
        ) revert InvalidTerms();
        if (!registry.isActiveVerifier(verifierId)) revert InvalidTerms();
        jobId = nextJobId++;
        jobs[jobId] = Job({
            buyer: msg.sender,
            seller: seller,
            price: price,
            evaluationBudget: evaluationBudget,
            sellerBond: sellerBond,
            deadline: deadline,
            challengeDeadline: 0,
            state: State.FUNDED,
            proposedOutcome: Outcome.AMBIGUOUS,
            requirementsHash: requirementsHash,
            deliveryHash: bytes32(0),
            verifierId: verifierId
        });
        apool.safeTransferFrom(msg.sender, address(this), uint256(price) + evaluationBudget);
        emit JobFunded(jobId, msg.sender, seller, price);
    }

    function acceptJob(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (job.state != State.FUNDED) revert InvalidState();
        if (job.seller != msg.sender) revert Unauthorized();
        job.state = State.ACCEPTED;
        apool.safeTransferFrom(msg.sender, address(this), job.sellerBond);
        emit JobAccepted(jobId, job.sellerBond);
    }

    function submitJob(uint256 jobId, bytes32 deliveryHash) external {
        Job storage job = jobs[jobId];
        if (job.state != State.ACCEPTED || block.timestamp > job.deadline) revert InvalidState();
        if (job.seller != msg.sender) revert Unauthorized();
        if (deliveryHash == bytes32(0)) revert InvalidTerms();
        job.deliveryHash = deliveryHash;
        job.state = State.SUBMITTED;
        emit JobSubmitted(jobId, deliveryHash);
    }

    function proposeOutcome(uint256 jobId, bytes32 verifierId, Outcome outcome) external {
        if (msg.sender != resolver) revert Unauthorized();
        Job storage job = jobs[jobId];
        if (job.state != State.SUBMITTED || job.verifierId != verifierId) revert InvalidState();
        job.proposedOutcome = outcome;
        job.challengeDeadline = uint64(block.timestamp + CHALLENGE_WINDOW);
        job.state = State.PROPOSED;
        emit OutcomeProposed(jobId, outcome, job.challengeDeadline);
    }

    function challenge(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (
            job.state != State.PROPOSED ||
            msg.sender != job.buyer ||
            block.timestamp >= job.challengeDeadline
        ) revert InvalidState();
        job.state = State.CHALLENGED;
        emit JobChallenged(jobId);
        IAgentPoolResolver(resolver).openDispute(jobId);
    }

    function finalizeUnchallenged(uint256 jobId, address evaluatorReceiver) external nonReentrant {
        if (msg.sender != resolver) revert Unauthorized();
        Job storage job = jobs[jobId];
        if (job.state != State.PROPOSED || block.timestamp < job.challengeDeadline) revert InvalidState();
        _settle(jobId, job.proposedOutcome, evaluatorReceiver);
    }

    function resolveChallenge(uint256 jobId, Outcome outcome, address evaluatorReceiver)
        external
        nonReentrant
    {
        if (msg.sender != resolver) revert Unauthorized();
        if (jobs[jobId].state != State.CHALLENGED) revert InvalidState();
        _settle(jobId, outcome, evaluatorReceiver);
    }

    function refundExpired(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (block.timestamp <= job.deadline) revert InvalidState();
        if (job.state != State.FUNDED && job.state != State.ACCEPTED) revert InvalidState();
        if (msg.sender != job.buyer) revert Unauthorized();
        bool accepted = job.state == State.ACCEPTED;
        job.state = State.EXPIRED;
        apool.safeTransfer(job.buyer, uint256(job.price) + job.evaluationBudget);
        if (accepted) apool.safeTransfer(securityTreasury, job.sellerBond);
        emit JobSettled(jobId, Outcome.AMBIGUOUS, State.EXPIRED);
    }

    function jobState(uint256 jobId) external view returns (State) {
        return jobs[jobId].state;
    }

    function _settle(uint256 jobId, Outcome outcome, address evaluatorReceiver) internal {
        if (evaluatorReceiver == address(0)) revert InvalidTerms();
        Job storage job = jobs[jobId];
        uint256 evaluatorPayment = uint256(job.evaluationBudget) * EVALUATOR_SHARE_BPS / 10_000;
        uint256 securityPayment = uint256(job.evaluationBudget) - evaluatorPayment;
        apool.safeTransfer(evaluatorReceiver, evaluatorPayment);

        if (outcome == Outcome.PASS) {
            job.state = State.COMPLETED;
            apool.safeTransfer(job.seller, uint256(job.price) + job.sellerBond);
        } else {
            job.state = outcome == Outcome.FAIL ? State.REJECTED : State.REFUNDED;
            apool.safeTransfer(job.buyer, job.price);
            securityPayment += job.sellerBond;
        }
        apool.safeTransfer(securityTreasury, securityPayment);
        emit JobSettled(jobId, outcome, job.state);
    }
}
