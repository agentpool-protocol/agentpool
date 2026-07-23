// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAgentPoolResolver} from "./interfaces/IAgentPoolResolver.sol";
import {IAgentPoolEscrow} from "./interfaces/IAgentPoolEscrow.sol";
import {IRandomnessProvider} from "./interfaces/IRandomnessProvider.sol";

/// @notice Five-evaluator commit/reveal disputes with a minimum of three reveals.
contract AgentPoolWorkOracle is Ownable, IAgentPoolResolver {
    uint8 public constant EVALUATOR_COUNT = 5;
    uint8 public constant MINIMUM_REVEALS = 3;
    uint64 public constant COMMIT_DURATION = 60 minutes;
    uint64 public constant REVEAL_DURATION = 60 minutes;

    struct Dispute {
        uint256 jobId;
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint8 reveals;
        uint8 passVotes;
        uint8 failVotes;
        bool selected;
        bool finalized;
    }

    IAgentPoolEscrow public escrow;
    IRandomnessProvider public randomnessProvider;
    address public evaluatorTreasury;
    address[] public eligibleEvaluators;
    mapping(address => bool) public isEligible;
    mapping(uint256 => Dispute) public disputes;
    mapping(uint256 => uint256) public requestToDispute;
    mapping(uint256 => address[EVALUATOR_COUNT]) public selectedEvaluators;
    mapping(uint256 => mapping(address => bool)) public isSelected;
    mapping(uint256 => mapping(address => bytes32)) public commitments;
    mapping(uint256 => mapping(address => bool)) public revealed;
    uint256 public nextDisputeId = 1;

    event DisputeOpened(uint256 indexed disputeId, uint256 indexed jobId, uint256 requestId);
    event EvaluatorsSelected(uint256 indexed disputeId, address[EVALUATOR_COUNT] evaluators);
    event VoteCommitted(uint256 indexed disputeId, address indexed evaluator);
    event VoteRevealed(uint256 indexed disputeId, address indexed evaluator, bool pass);
    event DisputeFinalized(uint256 indexed disputeId, IAgentPoolEscrow.Outcome outcome);

    error Unauthorized();
    error InvalidPhase();
    error InsufficientEvaluatorPool();
    error AlreadyConfigured();

    constructor(
        address governance,
        IRandomnessProvider randomnessProvider_,
        address evaluatorTreasury_
    ) Ownable(governance) {
        randomnessProvider = randomnessProvider_;
        evaluatorTreasury = evaluatorTreasury_;
    }

    function setEscrow(IAgentPoolEscrow escrow_) external onlyOwner {
        if (address(escrow) != address(0)) revert AlreadyConfigured();
        escrow = escrow_;
    }

    function setEvaluator(address evaluator, bool eligible) external onlyOwner {
        if (eligible && !isEligible[evaluator]) {
            isEligible[evaluator] = true;
            eligibleEvaluators.push(evaluator);
        } else if (!eligible) {
            isEligible[evaluator] = false;
        }
    }

    function setEvaluatorTreasury(address treasury) external onlyOwner {
        if (treasury == address(0)) revert Unauthorized();
        evaluatorTreasury = treasury;
    }

    function openDispute(uint256 jobId) external returns (uint256 disputeId) {
        if (msg.sender != address(escrow)) revert Unauthorized();
        if (_activeEvaluatorCount() < EVALUATOR_COUNT) revert InsufficientEvaluatorPool();
        disputeId = nextDisputeId++;
        disputes[disputeId].jobId = jobId;
        uint256 requestId = randomnessProvider.requestRandomness(disputeId);
        requestToDispute[requestId] = disputeId;
        emit DisputeOpened(disputeId, jobId, requestId);
    }

    /// @dev The configured VRF adapter must call this with its fulfilled random word.
    function fulfillRandomness(uint256 requestId, uint256 randomWord) external {
        if (msg.sender != address(randomnessProvider)) revert Unauthorized();
        uint256 disputeId = requestToDispute[requestId];
        Dispute storage dispute = disputes[disputeId];
        if (dispute.jobId == 0 || dispute.selected) revert InvalidPhase();

        address[EVALUATOR_COUNT] memory selected;
        uint256 cursor;
        uint256 nonce;
        while (cursor < EVALUATOR_COUNT) {
            address candidate = eligibleEvaluators[
                uint256(keccak256(abi.encode(randomWord, nonce++))) % eligibleEvaluators.length
            ];
            if (!isEligible[candidate] || isSelected[disputeId][candidate]) continue;
            selected[cursor] = candidate;
            isSelected[disputeId][candidate] = true;
            cursor++;
        }
        selectedEvaluators[disputeId] = selected;
        dispute.selected = true;
        dispute.commitDeadline = uint64(block.timestamp + COMMIT_DURATION);
        dispute.revealDeadline = uint64(block.timestamp + COMMIT_DURATION + REVEAL_DURATION);
        emit EvaluatorsSelected(disputeId, selected);
    }

    function commitVote(uint256 disputeId, bytes32 commitment) external {
        Dispute storage dispute = disputes[disputeId];
        if (
            !dispute.selected ||
            block.timestamp >= dispute.commitDeadline ||
            !isSelected[disputeId][msg.sender] ||
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
        escrow.resolveChallenge(dispute.jobId, outcome, evaluatorTreasury);
        emit DisputeFinalized(disputeId, outcome);
    }

    function _activeEvaluatorCount() internal view returns (uint256 count) {
        for (uint256 i = 0; i < eligibleEvaluators.length; i++) {
            if (isEligible[eligibleEvaluators[i]]) count++;
        }
    }
}
