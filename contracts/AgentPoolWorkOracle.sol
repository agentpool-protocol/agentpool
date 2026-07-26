// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAgentPoolResolver} from "./interfaces/IAgentPoolResolver.sol";
import {IAgentPoolEscrow} from "./interfaces/IAgentPoolEscrow.sol";
import {IAgentPoolRegistry} from "./interfaces/IAgentPoolRegistry.sol";
import {IRandomnessProvider} from "./interfaces/IRandomnessProvider.sol";

/// @notice Five-evaluator commit/reveal disputes with a minimum of three reveals.
contract AgentPoolWorkOracle is Ownable, IAgentPoolResolver {
    uint8 public constant EVALUATOR_COUNT = 5;
    uint8 public constant MINIMUM_REVEALS = 3;
    uint64 public constant COMMIT_DURATION = 60 minutes;
    uint64 public constant REVEAL_DURATION = 60 minutes;
    uint64 public constant SELECTION_TIMEOUT = 24 hours;

    struct Dispute {
        uint256 jobId;
        uint64 selectionDeadline;
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint8 reveals;
        uint8 passVotes;
        uint8 failVotes;
        bool selected;
        bool finalized;
    }

    IAgentPoolEscrow public escrow;
    IAgentPoolRegistry public immutable registry;
    IRandomnessProvider public immutable randomnessProvider;
    address[] public eligibleEvaluators;
    mapping(address => bool) public isEligible;
    mapping(address => bool) public isKnownEvaluator;
    mapping(uint256 => Dispute) public disputes;
    mapping(uint256 => uint256) public requestToDispute;
    mapping(uint256 => address[EVALUATOR_COUNT]) public selectedEvaluators;
    mapping(uint256 => mapping(address => bool)) public isSelected;
    mapping(uint256 => mapping(address => bytes32)) public commitments;
    mapping(uint256 => mapping(address => bool)) public revealed;
    mapping(uint256 => mapping(address => bool)) public revealedVote;
    mapping(uint256 => address) public outcomeProposer;
    uint256 public nextDisputeId = 1;

    event DisputeOpened(uint256 indexed disputeId, uint256 indexed jobId, uint256 requestId);
    event EvaluatorsSelected(uint256 indexed disputeId, address[EVALUATOR_COUNT] evaluators);
    event VoteCommitted(uint256 indexed disputeId, address indexed evaluator);
    event VoteRevealed(uint256 indexed disputeId, address indexed evaluator, bool pass);
    event DisputeFinalized(uint256 indexed disputeId, IAgentPoolEscrow.Outcome outcome);
    event DisputeUnavailable(uint256 indexed disputeId, uint256 indexed jobId);

    error Unauthorized();
    error InvalidPhase();
    error AlreadyConfigured();

    constructor(
        address governance,
        IAgentPoolRegistry registry_,
        IRandomnessProvider randomnessProvider_
    ) Ownable(governance) {
        if (
            address(registry_) == address(0) ||
            address(randomnessProvider_) == address(0)
        ) revert Unauthorized();
        registry = registry_;
        randomnessProvider = randomnessProvider_;
    }

    function setEscrow(IAgentPoolEscrow escrow_) external onlyOwner {
        if (address(escrow) != address(0)) revert AlreadyConfigured();
        if (address(escrow_) == address(0)) revert Unauthorized();
        escrow = escrow_;
    }

    function setEvaluator(address evaluator, bool eligible) external onlyOwner {
        if (evaluator == address(0)) revert Unauthorized();
        if (eligible && !isKnownEvaluator[evaluator]) {
            isKnownEvaluator[evaluator] = true;
            eligibleEvaluators.push(evaluator);
        }
        if (eligible) {
            isEligible[evaluator] = true;
        } else if (!eligible) {
            isEligible[evaluator] = false;
        }
    }

    function proposeOutcome(
        uint256 jobId,
        bytes32 verifierId,
        IAgentPoolEscrow.Outcome outcome
    ) external {
        if (!registry.isAuthorizedVerifier(verifierId, msg.sender)) revert Unauthorized();
        outcomeProposer[jobId] = msg.sender;
        escrow.proposeOutcome(jobId, verifierId, outcome);
    }

    function finalizeUnchallenged(uint256 jobId) external {
        address proposer = outcomeProposer[jobId];
        if (proposer == address(0)) revert InvalidPhase();
        address[] memory receivers = new address[](1);
        receivers[0] = proposer;
        escrow.finalizeUnchallenged(jobId, receivers);
    }

    function openDispute(uint256 jobId) external returns (uint256 disputeId) {
        if (msg.sender != address(escrow)) revert Unauthorized();
        disputeId = nextDisputeId++;
        disputes[disputeId].jobId = jobId;
        disputes[disputeId].selectionDeadline = uint64(
            block.timestamp + SELECTION_TIMEOUT
        );
        if (_activeEvaluatorCount() < EVALUATOR_COUNT) {
            _resolveUnavailable(disputeId, jobId);
            return disputeId;
        }
        try randomnessProvider.requestRandomness(disputeId) returns (uint256 requestId) {
            requestToDispute[requestId] = disputeId;
            emit DisputeOpened(disputeId, jobId, requestId);
        } catch {
            _resolveUnavailable(disputeId, jobId);
        }
    }

    /// @dev The configured VRF adapter must call this with its fulfilled random word.
    function fulfillRandomness(uint256 requestId, uint256 randomWord) external {
        if (msg.sender != address(randomnessProvider)) revert Unauthorized();
        uint256 disputeId = requestToDispute[requestId];
        Dispute storage dispute = disputes[disputeId];
        if (dispute.jobId == 0 || dispute.selected || dispute.finalized) {
            revert InvalidPhase();
        }
        if (block.timestamp > dispute.selectionDeadline) {
            _resolveUnavailable(disputeId, dispute.jobId);
            return;
        }

        uint256 activeCount = _activeEvaluatorCount();
        address[] memory candidates = new address[](activeCount);
        uint256 candidateCount;
        for (uint256 index = 0; index < eligibleEvaluators.length; index++) {
            address candidate = eligibleEvaluators[index];
            if (isEligible[candidate]) candidates[candidateCount++] = candidate;
        }

        address[EVALUATOR_COUNT] memory selected;
        for (uint256 cursor = 0; cursor < EVALUATOR_COUNT; cursor++) {
            uint256 selectedIndex = cursor +
                (
                    uint256(keccak256(abi.encode(randomWord, cursor))) %
                    (activeCount - cursor)
                );
            address candidate = candidates[selectedIndex];
            candidates[selectedIndex] = candidates[cursor];
            candidates[cursor] = candidate;
            selected[cursor] = candidate;
            isSelected[disputeId][candidate] = true;
        }
        selectedEvaluators[disputeId] = selected;
        dispute.selected = true;
        dispute.commitDeadline = uint64(block.timestamp + COMMIT_DURATION);
        dispute.revealDeadline = uint64(block.timestamp + COMMIT_DURATION + REVEAL_DURATION);
        emit EvaluatorsSelected(disputeId, selected);
    }

    /// @notice Refunds the job if the configured randomness adapter never responds.
    function finalizeUnselected(uint256 disputeId) external {
        Dispute storage dispute = disputes[disputeId];
        if (
            dispute.jobId == 0 ||
            dispute.selected ||
            dispute.finalized ||
            block.timestamp < dispute.selectionDeadline
        ) revert InvalidPhase();
        _resolveUnavailable(disputeId, dispute.jobId);
    }

    function commitVote(uint256 disputeId, bytes32 commitment) external {
        Dispute storage dispute = disputes[disputeId];
        if (
            !dispute.selected ||
            block.timestamp >= dispute.commitDeadline ||
            !isSelected[disputeId][msg.sender] ||
            commitment == bytes32(0) ||
            commitments[disputeId][msg.sender] != bytes32(0)
        ) revert InvalidPhase();
        commitments[disputeId][msg.sender] = commitment;
        emit VoteCommitted(disputeId, msg.sender);
    }

    function revealVote(uint256 disputeId, bool pass, bytes32 salt) external {
        Dispute storage dispute = disputes[disputeId];
        if (
            block.timestamp < dispute.commitDeadline ||
            block.timestamp >= dispute.revealDeadline ||
            commitments[disputeId][msg.sender] != keccak256(abi.encode(disputeId, msg.sender, pass, salt)) ||
            revealed[disputeId][msg.sender]
        ) revert InvalidPhase();
        revealed[disputeId][msg.sender] = true;
        revealedVote[disputeId][msg.sender] = pass;
        dispute.reveals++;
        if (pass) dispute.passVotes++;
        else dispute.failVotes++;
        emit VoteRevealed(disputeId, msg.sender, pass);
    }

    function finalize(uint256 disputeId) external {
        Dispute storage dispute = disputes[disputeId];
        if (
            dispute.finalized ||
            !dispute.selected ||
            block.timestamp < dispute.revealDeadline
        ) revert InvalidPhase();
        dispute.finalized = true;
        IAgentPoolEscrow.Outcome outcome;
        if (dispute.reveals < MINIMUM_REVEALS || dispute.passVotes == dispute.failVotes) {
            outcome = IAgentPoolEscrow.Outcome.AMBIGUOUS;
        } else if (dispute.passVotes > dispute.failVotes) {
            outcome = IAgentPoolEscrow.Outcome.PASS;
        } else {
            outcome = IAgentPoolEscrow.Outcome.FAIL;
        }
        address[] memory receivers = _winningEvaluators(disputeId, outcome);
        escrow.resolveChallenge(dispute.jobId, outcome, receivers);
        emit DisputeFinalized(disputeId, outcome);
    }

    function _winningEvaluators(uint256 disputeId, IAgentPoolEscrow.Outcome outcome)
        internal
        view
        returns (address[] memory receivers)
    {
        if (outcome == IAgentPoolEscrow.Outcome.AMBIGUOUS) {
            return new address[](0);
        }
        bool winningVote = outcome == IAgentPoolEscrow.Outcome.PASS;
        address[EVALUATOR_COUNT] memory selected = selectedEvaluators[disputeId];
        uint256 winnerCount;
        for (uint256 index = 0; index < EVALUATOR_COUNT; index++) {
            address evaluator = selected[index];
            if (revealed[disputeId][evaluator] && revealedVote[disputeId][evaluator] == winningVote) {
                winnerCount++;
            }
        }
        receivers = new address[](winnerCount);
        uint256 cursor;
        for (uint256 index = 0; index < EVALUATOR_COUNT; index++) {
            address evaluator = selected[index];
            if (revealed[disputeId][evaluator] && revealedVote[disputeId][evaluator] == winningVote) {
                receivers[cursor++] = evaluator;
            }
        }
    }

    function _activeEvaluatorCount() internal view returns (uint256 count) {
        for (uint256 i = 0; i < eligibleEvaluators.length; i++) {
            if (isEligible[eligibleEvaluators[i]]) count++;
        }
    }

    function _resolveUnavailable(uint256 disputeId, uint256 jobId) internal {
        disputes[disputeId].finalized = true;
        address[] memory receivers = new address[](0);
        escrow.resolveChallenge(
            jobId,
            IAgentPoolEscrow.Outcome.AMBIGUOUS,
            receivers
        );
        emit DisputeUnavailable(disputeId, jobId);
        emit DisputeFinalized(disputeId, IAgentPoolEscrow.Outcome.AMBIGUOUS);
    }
}
