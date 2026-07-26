// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAgentPoolResolver} from "./interfaces/IAgentPoolResolver.sol";
import {IAgentPoolEscrow} from "./interfaces/IAgentPoolEscrow.sol";
import {IAgentPoolRegistry} from "./interfaces/IAgentPoolRegistry.sol";

/// @notice APOOL job escrow with a buyer-funded validation levy and zero worker-price fee.
contract AgentPoolJobEscrow is Ownable, ReentrancyGuard, IAgentPoolEscrow {
    using SafeERC20 for IERC20;

    uint16 public constant PROTOCOL_FEE_BPS = 0;
    uint16 public constant VALIDATION_FEE_BPS = 300;
    uint16 public constant MIN_VALIDATION_FEE = 10;
    uint16 public constant VALIDATOR_SHARE_BPS = 7_000;
    uint16 public constant BURN_SHARE_BPS = 2_000;
    uint16 public constant SECURITY_SHARE_BPS = 1_000;
    uint16 public constant SELLER_BOND_BPS = 1_000;
    uint16 public constant MIN_SELLER_BOND = 10;
    uint64 public constant CHALLENGE_WINDOW = 2 hours;
    uint64 public constant RESOLUTION_GRACE = 3 days;

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
        uint128 validationFee;
        uint128 sellerBond;
        uint64 deadline;
        uint64 resolutionDeadline;
        uint64 challengeDeadline;
        State state;
        Outcome proposedOutcome;
        bytes32 requirementsHash;
        bytes32 deliveryHash;
        bytes32 verifierId;
    }

    IERC20 public immutable apool;
    ERC20Burnable private immutable burnableApool;
    IAgentPoolRegistry public immutable registry;
    address public resolver;
    address public immutable securityTreasury;
    uint256 public nextJobId = 1;
    mapping(uint256 => Job) public jobs;

    event JobFunded(
        uint256 indexed jobId,
        address indexed buyer,
        address indexed seller,
        uint256 price,
        uint256 validationFee
    );
    event JobAccepted(uint256 indexed jobId, uint256 sellerBond);
    event JobSubmitted(uint256 indexed jobId, bytes32 indexed deliveryHash);
    event OutcomeProposed(uint256 indexed jobId, Outcome outcome, uint64 challengeDeadline);
    event JobChallenged(uint256 indexed jobId);
    event JobSettled(uint256 indexed jobId, Outcome outcome, State state);
    error InvalidState();
    error Unauthorized();
    error InvalidTerms();
    error AlreadyConfigured();

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
        burnableApool = ERC20Burnable(address(token));
        registry = registry_;
        securityTreasury = securityTreasury_;
    }

    function setResolver(address resolver_) external onlyOwner {
        if (resolver != address(0)) revert AlreadyConfigured();
        if (resolver_ == address(0)) revert InvalidTerms();
        resolver = resolver_;
    }

    function fundJob(
        address seller,
        uint128 price,
        uint128 sellerBond,
        uint64 deadline,
        bytes32 requirementsHash,
        bytes32 verifierId
    ) external nonReentrant returns (uint256 jobId) {
        if (
            seller == address(0) ||
            seller == msg.sender ||
            price == 0 ||
            sellerBond < sellerBondFor(price) ||
            deadline <= block.timestamp ||
            requirementsHash == bytes32(0) ||
            verifierId == bytes32(0)
        ) revert InvalidTerms();
        if (!registry.isActiveVerifier(verifierId)) revert InvalidTerms();
        uint128 validationFee = uint128(validationFeeFor(price));
        jobId = nextJobId++;
        jobs[jobId] = Job({
            buyer: msg.sender,
            seller: seller,
            price: price,
            validationFee: validationFee,
            sellerBond: sellerBond,
            deadline: deadline,
            resolutionDeadline: 0,
            challengeDeadline: 0,
            state: State.FUNDED,
            proposedOutcome: Outcome.AMBIGUOUS,
            requirementsHash: requirementsHash,
            deliveryHash: bytes32(0),
            verifierId: verifierId
        });
        apool.safeTransferFrom(msg.sender, address(this), uint256(price) + validationFee);
        emit JobFunded(jobId, msg.sender, seller, price, validationFee);
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
        job.resolutionDeadline = uint64(block.timestamp + RESOLUTION_GRACE);
        job.state = State.SUBMITTED;
        emit JobSubmitted(jobId, deliveryHash);
    }

    function proposeOutcome(uint256 jobId, bytes32 verifierId, Outcome outcome) external {
        if (msg.sender != resolver) revert Unauthorized();
        Job storage job = jobs[jobId];
        if (
            job.state != State.SUBMITTED ||
            job.verifierId != verifierId ||
            block.timestamp > job.resolutionDeadline
        ) revert InvalidState();
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

    function finalizeUnchallenged(uint256 jobId, address[] calldata validatorReceivers)
        external
        nonReentrant
    {
        if (msg.sender != resolver) revert Unauthorized();
        Job storage job = jobs[jobId];
        if (job.state != State.PROPOSED || block.timestamp < job.challengeDeadline) revert InvalidState();
        _settle(jobId, job.proposedOutcome, validatorReceivers);
    }

    function resolveChallenge(uint256 jobId, Outcome outcome, address[] calldata validatorReceivers)
        external
        nonReentrant
    {
        if (msg.sender != resolver) revert Unauthorized();
        if (jobs[jobId].state != State.CHALLENGED) revert InvalidState();
        _settle(jobId, outcome, validatorReceivers);
    }

    function refundExpired(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (block.timestamp <= job.deadline) revert InvalidState();
        if (job.state != State.FUNDED && job.state != State.ACCEPTED) revert InvalidState();
        bool accepted = job.state == State.ACCEPTED;
        job.state = State.EXPIRED;
        apool.safeTransfer(job.buyer, uint256(job.price) + job.validationFee);
        if (accepted) apool.safeTransfer(securityTreasury, job.sellerBond);
        emit JobSettled(jobId, Outcome.AMBIGUOUS, State.EXPIRED);
    }

    /// @notice Releases both parties if the verifier never proposes an outcome.
    function refundStalledSubmission(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (
            job.state != State.SUBMITTED ||
            block.timestamp <= job.resolutionDeadline
        ) revert InvalidState();
        job.state = State.REFUNDED;
        apool.safeTransfer(job.buyer, uint256(job.price) + job.validationFee);
        apool.safeTransfer(job.seller, job.sellerBond);
        emit JobSettled(jobId, Outcome.AMBIGUOUS, State.REFUNDED);
    }

    function jobState(uint256 jobId) external view returns (State) {
        return jobs[jobId].state;
    }

    function validationFeeFor(uint256 price) public pure returns (uint256) {
        if (price == 0) return 0;
        uint256 percentageFee = (price * VALIDATION_FEE_BPS + 9_999) / 10_000;
        return percentageFee < MIN_VALIDATION_FEE ? MIN_VALIDATION_FEE : percentageFee;
    }

    function sellerBondFor(uint256 price) public pure returns (uint256) {
        if (price == 0) return 0;
        uint256 percentageBond =
            (price * SELLER_BOND_BPS + 9_999) / 10_000;
        return percentageBond < MIN_SELLER_BOND
            ? MIN_SELLER_BOND
            : percentageBond;
    }

    function _settle(
        uint256 jobId,
        Outcome outcome,
        address[] calldata validatorReceivers
    ) internal {
        Job storage job = jobs[jobId];
        if (outcome == Outcome.AMBIGUOUS) {
            job.state = State.REFUNDED;
            apool.safeTransfer(job.buyer, uint256(job.price) + job.validationFee);
            apool.safeTransfer(job.seller, job.sellerBond);
            emit JobSettled(jobId, outcome, job.state);
            return;
        }
        if (validatorReceivers.length == 0) revert InvalidTerms();
        uint256 validatorPayment =
            uint256(job.validationFee) * VALIDATOR_SHARE_BPS / 10_000;
        uint256 burnPayment = uint256(job.validationFee) * BURN_SHARE_BPS / 10_000;
        uint256 securityPayment =
            uint256(job.validationFee) - validatorPayment - burnPayment;
        _payValidators(validatorReceivers, validatorPayment);
        if (burnPayment != 0) burnableApool.burn(burnPayment);

        if (outcome == Outcome.PASS) {
            job.state = State.COMPLETED;
            apool.safeTransfer(job.seller, uint256(job.price) + job.sellerBond);
        } else {
            job.state = State.REJECTED;
            apool.safeTransfer(job.buyer, job.price);
            securityPayment += job.sellerBond;
        }
        apool.safeTransfer(securityTreasury, securityPayment);
        emit JobSettled(jobId, outcome, job.state);
    }

    function _payValidators(address[] calldata receivers, uint256 amount) internal {
        uint256 share = amount / receivers.length;
        uint256 remainder = amount - share * receivers.length;
        for (uint256 index = 0; index < receivers.length; index++) {
            address receiver = receivers[index];
            if (receiver == address(0)) revert InvalidTerms();
            uint256 payment = share + (index == 0 ? remainder : 0);
            if (payment != 0) apool.safeTransfer(receiver, payment);
        }
    }
}
