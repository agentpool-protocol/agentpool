// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {
    IAgentPoolV43ContributionLedger
} from "./interfaces/IAgentPoolV43ContributionLedger.sol";
import {
    IAgentPoolV432ProofRegistry
} from "./interfaces/IAgentPoolV432ProofRegistry.sol";

/// @notice Evidence-only validator rounds with an immutable per-milestone
///         allowlist and operator-group diversity. Evaluators still cannot
///         submit a payout or recipient.
contract AgentPoolV432ProofRegistry is IAgentPoolV432ProofRegistry {
    uint16 public constant MAX_REVEALS = 15;

    struct Round {
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint16 committed;
        uint16 revealed;
        uint16 representedGroups;
        uint16 minimumGroups;
        bytes32 validatorRoot;
        bytes32 excludedGroup;
        bool opened;
    }

    struct Evaluation {
        bytes32 commitment;
        bytes32 evidenceHash;
        bytes32 operatorGroup;
        uint16 scoreBps;
        bool revealed;
    }

    IAgentPoolV43ContributionLedger public immutable ledger;
    address public configurationAuthority;
    address public market;
    mapping(bytes32 => Round) public rounds;
    mapping(bytes32 => mapping(address => Evaluation)) public evaluations;
    mapping(bytes32 => mapping(bytes32 => bool)) public representedGroup;
    mapping(bytes32 => uint16[]) private _scores;

    event MarketConfigured(address indexed market);
    event RoundOpened(
        bytes32 indexed roundId,
        uint64 commitDeadline,
        uint64 revealDeadline,
        bytes32 validatorRoot,
        uint16 minimumGroups
    );
    event EvaluationCommitted(
        bytes32 indexed roundId,
        address indexed validator,
        bytes32 indexed operatorGroup
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

    constructor(
        IAgentPoolV43ContributionLedger ledger_,
        address configurationAuthority_
    ) {
        if (
            address(ledger_) == address(0) ||
            configurationAuthority_ == address(0)
        ) revert InvalidTerms();
        ledger = ledger_;
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
        bytes32,
        uint64,
        uint64
    ) external pure override {
        revert Unauthorized();
    }

    function openRoundWithPolicy(
        bytes32 roundId,
        uint64 commitDeadline,
        uint64 revealDeadline,
        bytes32 validatorRoot,
        bytes32 excludedGroup,
        uint16 minimumGroups
    ) external override {
        if (msg.sender != market) revert Unauthorized();
        if (
            roundId == bytes32(0) ||
            rounds[roundId].opened ||
            commitDeadline <= block.timestamp ||
            revealDeadline <= commitDeadline ||
            validatorRoot == bytes32(0) ||
            minimumGroups == 0
        ) revert InvalidTerms();
        rounds[roundId] = Round({
            commitDeadline: commitDeadline,
            revealDeadline: revealDeadline,
            committed: 0,
            revealed: 0,
            representedGroups: 0,
            minimumGroups: minimumGroups,
            validatorRoot: validatorRoot,
            excludedGroup: excludedGroup,
            opened: true
        });
        emit RoundOpened(
            roundId,
            commitDeadline,
            revealDeadline,
            validatorRoot,
            minimumGroups
        );
    }

    function commitmentFor(
        bytes32 roundId,
        address validator,
        uint16 scoreBps,
        bytes32 evidenceHash,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                roundId,
                validator,
                scoreBps,
                evidenceHash,
                salt
            )
        );
    }

    function validatorLeaf(
        address validator,
        bytes32 operatorGroup
    ) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(
            validator,
            operatorGroup
        ))));
    }

    function commitWithProof(
        bytes32 roundId,
        bytes32 commitment,
        bytes32[] calldata validatorProof
    ) external override {
        Round storage round = rounds[roundId];
        Evaluation storage evaluation = evaluations[roundId][msg.sender];
        bytes32 group = ledger.operatorGroup(msg.sender);
        if (
            !round.opened ||
            block.timestamp > round.commitDeadline ||
            round.committed >= MAX_REVEALS ||
            commitment == bytes32(0) ||
            group == bytes32(0) ||
            group == round.excludedGroup ||
            !MerkleProof.verifyCalldata(
                validatorProof,
                round.validatorRoot,
                validatorLeaf(msg.sender, group)
            )
        ) revert InvalidState();
        if (evaluation.commitment != bytes32(0)) {
            revert DuplicateParticipation();
        }
        evaluation.commitment = commitment;
        evaluation.operatorGroup = group;
        round.committed++;
        emit EvaluationCommitted(roundId, msg.sender, group);
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
            representedGroup[roundId][evaluation.operatorGroup] ||
            evaluation.commitment != commitmentFor(
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
        bytes32 group = evaluation.operatorGroup;
        representedGroup[roundId][group] = true;
        round.representedGroups++;
        _scores[roundId].push(scoreBps);
        emit EvaluationRevealed(
            roundId,
            msg.sender,
            scoreBps,
            evidenceHash
        );
    }

    function resolutionStatus(
        bytes32 roundId,
        uint16 minimumReveals,
        uint16 minimumGroups,
        uint16 passScoreBps
    ) external view override returns (uint8) {
        Round storage round = rounds[roundId];
        if (!round.opened || block.timestamp <= round.revealDeadline) {
            revert InvalidState();
        }
        if (
            round.revealed < minimumReveals ||
            round.representedGroups < minimumGroups
        ) return 1;
        return _medianScore(roundId) < passScoreBps ? 2 : 3;
    }

    function revealCount(
        bytes32 roundId
    ) external view override returns (uint16) {
        return rounds[roundId].revealed;
    }

    function groupCount(
        bytes32 roundId
    ) external view override returns (uint16) {
        return rounds[roundId].representedGroups;
    }

    function medianScore(
        bytes32 roundId
    ) external view override returns (uint16) {
        return _medianScore(roundId);
    }

    function _medianScore(
        bytes32 roundId
    ) private view returns (uint16) {
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
        return scores[(scores.length - 1) / 2];
    }

    function roundReady(
        bytes32 roundId
    ) external view override returns (bool) {
        Round storage round = rounds[roundId];
        return
            round.opened &&
            block.timestamp > round.revealDeadline &&
            round.representedGroups >= round.minimumGroups;
    }
}
