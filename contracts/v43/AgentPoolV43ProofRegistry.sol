// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentPoolV43ProofRegistry} from "./interfaces/IAgentPoolV43ProofRegistry.sol";

/// @notice Evidence-only validator registry. No payout amount or payout
///         recipient can be submitted here.
contract AgentPoolV43ProofRegistry is IAgentPoolV43ProofRegistry {
    struct Round {
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint16 committed;
        uint16 revealed;
        bool opened;
    }

    struct Evaluation {
        bytes32 commitment;
        bytes32 evidenceHash;
        uint16 scoreBps;
        bool revealed;
    }

    address public configurationAuthority;
    address public market;
    mapping(bytes32 => Round) public rounds;
    mapping(bytes32 => mapping(address => Evaluation)) public evaluations;
    mapping(bytes32 => uint16[]) private _scores;

    event MarketConfigured(address indexed market);
    event RoundOpened(
        bytes32 indexed roundId,
        uint64 commitDeadline,
        uint64 revealDeadline
    );
    event EvaluationCommitted(
        bytes32 indexed roundId,
        address indexed validator
    );
    event EvaluationRevealed(
        bytes32 indexed roundId,
        address indexed validator,
        uint16 scoreBps,
        bytes32 evidenceHash
    );

    error Unauthorized();
    error InvalidTerms();
    error InvalidState();
    error AlreadyConfigured();
    error DuplicateParticipation();

    constructor(address configurationAuthority_) {
        if (configurationAuthority_ == address(0)) revert InvalidTerms();
        configurationAuthority = configurationAuthority_;
    }

    function configureMarket(address market_) external {
        if (msg.sender != configurationAuthority) revert Unauthorized();
        if (market != address(0)) revert AlreadyConfigured();
        if (market_ == address(0) || market_.code.length == 0) {
            revert InvalidTerms();
        }
        market = market_;
        configurationAuthority = address(0);
        emit MarketConfigured(market_);
    }

    function openRound(
        bytes32 roundId,
        uint64 commitDeadline,
        uint64 revealDeadline
    ) external override {
        if (msg.sender != market) revert Unauthorized();
        if (
            roundId == bytes32(0) ||
            rounds[roundId].opened ||
            commitDeadline <= block.timestamp ||
            revealDeadline <= commitDeadline
        ) revert InvalidTerms();
        rounds[roundId] = Round({
            commitDeadline: commitDeadline,
            revealDeadline: revealDeadline,
            committed: 0,
            revealed: 0,
            opened: true
        });
        emit RoundOpened(roundId, commitDeadline, revealDeadline);
    }

    function commitmentFor(
        bytes32 roundId,
        address validator,
        uint16 scoreBps,
        bytes32 evidenceHash,
        bytes32 salt
    ) public pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    roundId,
                    validator,
                    scoreBps,
                    evidenceHash,
                    salt
                )
            );
    }

    function commit(bytes32 roundId, bytes32 commitment) external {
        Round storage round = rounds[roundId];
        Evaluation storage evaluation = evaluations[roundId][msg.sender];
        if (
            !round.opened ||
            block.timestamp > round.commitDeadline ||
            commitment == bytes32(0)
        ) revert InvalidState();
        if (evaluation.commitment != bytes32(0)) {
            revert DuplicateParticipation();
        }
        evaluation.commitment = commitment;
        round.committed++;
        emit EvaluationCommitted(roundId, msg.sender);
    }

    function reveal(
        bytes32 roundId,
        uint16 scoreBps,
        bytes32 evidenceHash,
        bytes32 salt
    ) external {
        Round storage round = rounds[roundId];
        Evaluation storage evaluation = evaluations[roundId][msg.sender];
        if (
            !round.opened ||
            block.timestamp <= round.commitDeadline ||
            block.timestamp > round.revealDeadline ||
            scoreBps > 10_000 ||
            evidenceHash == bytes32(0)
        ) revert InvalidState();
        if (
            evaluation.revealed ||
            evaluation.commitment !=
            commitmentFor(
                roundId,
                msg.sender,
                scoreBps,
                evidenceHash,
                salt
            )
        ) revert InvalidTerms();
        evaluation.revealed = true;
        evaluation.scoreBps = scoreBps;
        evaluation.evidenceHash = evidenceHash;
        round.revealed++;
        _scores[roundId].push(scoreBps);
        emit EvaluationRevealed(
            roundId,
            msg.sender,
            scoreBps,
            evidenceHash
        );
    }

    function revealCount(
        bytes32 roundId
    ) external view override returns (uint16) {
        return rounds[roundId].revealed;
    }

    function medianScore(
        bytes32 roundId
    ) external view override returns (uint16) {
        uint16[] memory scores = _scores[roundId];
        if (scores.length == 0) return 0;
        for (uint256 left = 1; left < scores.length; left++) {
            uint16 value = scores[left];
            uint256 right = left;
            while (right > 0 && scores[right - 1] > value) {
                scores[right] = scores[right - 1];
                right--;
            }
            scores[right] = value;
        }
        return scores[scores.length / 2];
    }

    function roundReady(
        bytes32 roundId
    ) external view override returns (bool) {
        Round storage round = rounds[roundId];
        return round.opened && block.timestamp > round.revealDeadline;
    }
}
