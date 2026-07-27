// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {AgentPoolV42Token} from "./AgentPoolV42Token.sol";
import {
    IAgentPoolV42ImprovementVerifier
} from "./interfaces/IAgentPoolV42ImprovementVerifier.sol";

/// @notice Ownerless emission kernel. New tAPOOL can only be released after an
///         issue is reproduced, candidates compete, and an independent canary
///         panel reveals a passing result. There is no generic mining lane.
contract AgentPoolV42ImprovementKernel is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum IssueState {
        NONE,
        REPRODUCING,
        AUCTION,
        CANARY,
        PROVEN,
        REJECTED,
        EXPIRED
    }

    struct Issue {
        address reporter;
        address verifier;
        bytes32 issueHash;
        bytes32 evidenceHash;
        uint64 epoch;
        uint64 reproductionDeadline;
        uint64 candidateDeadline;
        uint64 canaryDeadline;
        uint128 maxBudget;
        uint128 reporterAsk;
        uint128 keeperReward;
        uint128 reporterBond;
        uint32 selectedCandidateId;
        IssueState state;
        bool genesis;
        bool promotesVerifier;
    }

    struct Reproduction {
        address agent;
        bytes32 commitment;
        bytes32 evidenceHash;
        uint128 feeAsk;
        uint128 bond;
        bool revealed;
        bool passed;
    }

    struct Candidate {
        address author;
        address planner;
        bytes32 codeHash;
        bytes32 manifestHash;
        bytes32 deliveryHash;
        bytes32 proofHash;
        uint128 authorBid;
        uint128 plannerBid;
        uint128 validatorFeeCap;
        uint128 bond;
        uint16 objectiveScoreBps;
        bool delivered;
    }

    struct Evaluation {
        address evaluator;
        bytes32 commitment;
        bytes32 evidenceHash;
        uint128 feeAsk;
        uint128 bond;
        uint16 scoreBps;
        bool revealed;
    }

    struct ProvenModule {
        address author;
        bytes32 issueHash;
        bytes32 codeHash;
        bytes32 manifestHash;
        bytes32 deliveryHash;
        bytes32 proofHash;
        uint64 provenAt;
    }

    uint64 public constant EPOCH_DURATION = 7 days;
    uint64 public constant GENESIS_DURATION = 180 days;
    uint64 public constant HALF_LIFE = 8 * 365 days;
    uint256 public constant WAD = 1e18;
    uint256 public constant WEEKLY_DECAY_WAD = 998_340_000_000_000_000;
    uint16 public constant ISSUE_CAP_BPS = 1_000;
    uint16 public constant PASS_SCORE_BPS = 6_000;
    uint8 public constant MIN_REPRODUCTIONS = 3;
    uint8 public constant MIN_EVALUATIONS = 3;
    uint8 public constant MAX_REPRODUCTIONS = 7;
    uint8 public constant MAX_CANDIDATES = 8;
    uint8 public constant MAX_EVALUATIONS = 7;
    uint256 public constant MIN_BOND = 10 ether;

    AgentPoolV42Token public immutable token;
    bytes32 public immutable genesisIssueRoot;
    uint64 public immutable genesisStart;
    uint256 public immutable genesisCap;
    uint256 public immutable genesisWeeklyCap;

    uint256 public nextIssueId = 1;
    mapping(uint256 => Issue) public issues;
    mapping(bytes32 => uint256) public issueForEvidence;
    mapping(uint256 => Reproduction[]) private _reproductions;
    mapping(uint256 => mapping(address => bool)) public reproducedBy;
    mapping(uint256 => Candidate[]) private _candidates;
    mapping(uint256 => mapping(address => bool)) public candidateBy;
    mapping(uint256 => Evaluation[]) private _evaluations;
    mapping(uint256 => mapping(address => bool)) public evaluatedBy;
    mapping(bytes32 => ProvenModule) public provenModules;
    mapping(bytes32 => bool) public approvedVerifierCodehash;

    mapping(uint64 => uint256) public epochReserved;
    mapping(uint64 => uint256) public epochMinted;
    mapping(uint64 => mapping(bytes32 => uint256)) public issueReserved;
    mapping(uint64 => mapping(bytes32 => uint256)) public issueMinted;
    uint256 public genesisReserved;
    uint256 public genesisMinted;
    uint256 public slashPool;

    event IssueOpened(
        uint256 indexed issueId,
        address indexed reporter,
        bytes32 indexed issueHash,
        uint256 maxBudget,
        bool genesis
    );
    event ReproductionCommitted(
        uint256 indexed issueId,
        address indexed agent,
        uint256 feeAsk
    );
    event ReproductionRevealed(
        uint256 indexed issueId,
        address indexed agent,
        bool passed,
        bytes32 evidenceHash
    );
    event IssueReproduced(uint256 indexed issueId, uint256 reservedBudget);
    event CandidateSubmitted(
        uint256 indexed issueId,
        uint32 indexed candidateId,
        address indexed author,
        uint256 quotedCost
    );
    event CandidateAwarded(
        uint256 indexed issueId,
        uint32 indexed candidateId
    );
    event CandidateDelivered(
        uint256 indexed issueId,
        uint32 indexed candidateId,
        bytes32 deliveryHash
    );
    event EvaluationCommitted(
        uint256 indexed issueId,
        address indexed evaluator,
        uint256 feeAsk
    );
    event EvaluationRevealed(
        uint256 indexed issueId,
        address indexed evaluator,
        uint16 scoreBps,
        bytes32 evidenceHash
    );
    event ImprovementProven(
        uint256 indexed issueId,
        bytes32 indexed moduleId,
        uint16 medianScoreBps,
        uint256 totalPaid,
        uint256 newlyMinted
    );
    event VerifierApproved(bytes32 indexed codeHash, uint256 indexed issueId);
    event IssueClosed(uint256 indexed issueId, IssueState state);

    error InvalidTerms();
    error InvalidState();
    error Unauthorized();
    error DuplicateParticipant();
    error BudgetExceeded();
    error InsufficientEvidence();

    constructor(
        AgentPoolV42Token token_,
        bytes32 genesisIssueRoot_,
        uint64 genesisStart_,
        bytes32 genesisVerifierCodehash_
    ) {
        if (
            address(token_) == address(0) ||
            genesisIssueRoot_ == bytes32(0) ||
            genesisStart_ < block.timestamp ||
            genesisVerifierCodehash_ == bytes32(0)
        ) revert InvalidTerms();
        token = token_;
        genesisIssueRoot = genesisIssueRoot_;
        genesisStart = genesisStart_;
        genesisCap = token_.MAX_SUPPLY() / 200;
        genesisWeeklyCap =
            (genesisCap * EPOCH_DURATION) /
            GENESIS_DURATION;
        approvedVerifierCodehash[genesisVerifierCodehash_] = true;
    }

    function genesisIssueLeaf(
        bytes32 issueHash,
        bytes32 evidenceHash,
        bytes32 verifierCodehash,
        uint128 maxBudget,
        bool promotesVerifier
    ) public pure returns (bytes32) {
        return
            keccak256(
                bytes.concat(
                    keccak256(
                        abi.encode(
                            issueHash,
                            evidenceHash,
                            verifierCodehash,
                            maxBudget,
                            promotesVerifier
                        )
                    )
                )
            );
    }

    function currentEpoch() public view returns (uint64) {
        if (block.timestamp <= genesisStart) return 0;
        return uint64((block.timestamp - genesisStart) / EPOCH_DURATION);
    }

    function epochStart(uint64 epoch) public view returns (uint256) {
        return uint256(genesisStart) + uint256(epoch) * EPOCH_DURATION;
    }

    function epochAllowance(uint64 epoch) public view returns (uint256) {
        uint256 start = epochStart(epoch);
        uint256 genesisEnd = uint256(genesisStart) + GENESIS_DURATION;
        if (start < genesisEnd) return genesisWeeklyCap;
        uint256 weeksAfter = (start - genesisEnd) / EPOCH_DURATION;
        return
            (genesisWeeklyCap * _rpow(WEEKLY_DECAY_WAD, weeksAfter, WAD)) /
            WAD;
    }

    function openIssue(
        bytes32 issueHash,
        bytes32 evidenceHash,
        address verifier,
        uint128 maxBudget,
        uint128 reporterAsk,
        uint128 keeperReward,
        uint128 reporterBond,
        uint64 reproductionDeadline,
        uint64 candidateDeadline,
        uint64 canaryDeadline,
        bool promotesVerifier,
        bytes calldata issueProof,
        bytes32[] calldata genesisProof
    ) external nonReentrant returns (uint256 issueId) {
        bytes32 verifierCodehash = verifier.codehash;
        bool genesis = MerkleProof.verify(
            genesisProof,
            genesisIssueRoot,
            genesisIssueLeaf(
                issueHash,
                evidenceHash,
                verifierCodehash,
                maxBudget,
                promotesVerifier
            )
        );
        bytes32 evidenceKey = keccak256(abi.encode(issueHash, evidenceHash));
        uint64 epoch = currentEpoch();
        uint256 issueCap = epochAllowance(epoch) * ISSUE_CAP_BPS / 10_000;
        if (
            issueHash == bytes32(0) ||
            evidenceHash == bytes32(0) ||
            verifier == address(0) ||
            verifierCodehash == bytes32(0) ||
            !approvedVerifierCodehash[verifierCodehash] ||
            issueForEvidence[evidenceKey] != 0 ||
            maxBudget == 0 ||
            maxBudget > issueCap ||
            uint256(reporterAsk) + keeperReward >= maxBudget ||
            reproductionDeadline <= block.timestamp ||
            candidateDeadline <= reproductionDeadline ||
            canaryDeadline <= candidateDeadline ||
            canaryDeadline > block.timestamp + 30 days ||
            (!genesis && reporterBond < MIN_BOND) ||
            (genesis && reporterBond != 0)
        ) revert InvalidTerms();
        if (
            !IAgentPoolV42ImprovementVerifier(verifier).verifyIssue(
                issueHash,
                evidenceHash,
                msg.sender,
                issueProof
            )
        ) revert InsufficientEvidence();
        if (reporterBond != 0) {
            IERC20(address(token)).safeTransferFrom(
                msg.sender,
                address(this),
                reporterBond
            );
        }
        issueId = nextIssueId++;
        issueForEvidence[evidenceKey] = issueId;
        issues[issueId] = Issue({
            reporter: msg.sender,
            verifier: verifier,
            issueHash: issueHash,
            evidenceHash: evidenceHash,
            epoch: epoch,
            reproductionDeadline: reproductionDeadline,
            candidateDeadline: candidateDeadline,
            canaryDeadline: canaryDeadline,
            maxBudget: maxBudget,
            reporterAsk: reporterAsk,
            keeperReward: keeperReward,
            reporterBond: reporterBond,
            selectedCandidateId: 0,
            state: IssueState.REPRODUCING,
            genesis: genesis,
            promotesVerifier: promotesVerifier
        });
        emit IssueOpened(issueId, msg.sender, issueHash, maxBudget, genesis);
    }

    function commitReproduction(
        uint256 issueId,
        bytes32 commitment,
        uint128 feeAsk,
        uint128 bond
    ) external nonReentrant {
        Issue storage issue = issues[issueId];
        if (
            issue.state != IssueState.REPRODUCING ||
            block.timestamp > issue.reproductionDeadline ||
            commitment == bytes32(0) ||
            feeAsk == 0 ||
            feeAsk > issue.maxBudget / MIN_REPRODUCTIONS ||
            reproducedBy[issueId][msg.sender] ||
            _reproductions[issueId].length >= MAX_REPRODUCTIONS ||
            (!issue.genesis && bond < MIN_BOND) ||
            (issue.genesis && bond != 0) ||
            msg.sender == issue.reporter
        ) revert InvalidTerms();
        reproducedBy[issueId][msg.sender] = true;
        if (bond != 0) {
            IERC20(address(token)).safeTransferFrom(
                msg.sender,
                address(this),
                bond
            );
        }
        _reproductions[issueId].push(
            Reproduction({
                agent: msg.sender,
                commitment: commitment,
                evidenceHash: bytes32(0),
                feeAsk: feeAsk,
                bond: bond,
                revealed: false,
                passed: false
            })
        );
        emit ReproductionCommitted(issueId, msg.sender, feeAsk);
    }

    function revealReproduction(
        uint256 issueId,
        bytes32 evidenceHash,
        bytes calldata proof,
        bytes32 salt
    ) external {
        Issue storage issue = issues[issueId];
        if (
            issue.state != IssueState.REPRODUCING ||
            block.timestamp > issue.reproductionDeadline ||
            evidenceHash == bytes32(0)
        ) revert InvalidState();
        Reproduction storage reproduction = _reproductionFor(
            issueId,
            msg.sender
        );
        if (
            reproduction.revealed ||
            keccak256(
                abi.encode(evidenceHash, keccak256(proof), salt)
            ) !=
            reproduction.commitment
        ) revert InvalidTerms();
        bool passed = IAgentPoolV42ImprovementVerifier(issue.verifier)
            .verifyIssue(
                issue.issueHash,
                evidenceHash,
                msg.sender,
                proof
            );
        reproduction.revealed = true;
        reproduction.passed = passed;
        reproduction.evidenceHash = evidenceHash;
        emit ReproductionRevealed(
            issueId,
            msg.sender,
            passed,
            evidenceHash
        );
    }

    function finalizeReproduction(uint256 issueId) external nonReentrant {
        Issue storage issue = issues[issueId];
        if (
            issue.state != IssueState.REPRODUCING ||
            block.timestamp <= issue.reproductionDeadline
        ) revert InvalidState();
        (uint256 revealed, uint256 positive, uint256 reproductionFees) =
            _reproductionSummary(issueId);
        if (
            revealed < MIN_REPRODUCTIONS ||
            positive * 3 < revealed * 2
        ) {
            issue.state = IssueState.REJECTED;
            _settleIssueBonds(issueId, true, false);
            emit IssueClosed(issueId, IssueState.REJECTED);
            return;
        }
        if (
            uint256(issue.reporterAsk) +
                issue.keeperReward +
                reproductionFees >=
            issue.maxBudget
        ) revert BudgetExceeded();
        _reserve(issue);
        issue.state = IssueState.AUCTION;
        emit IssueReproduced(issueId, issue.maxBudget);
    }

    function submitCandidate(
        uint256 issueId,
        address planner,
        bytes32 codeHash,
        bytes32 manifestHash,
        uint128 authorBid,
        uint128 plannerBid,
        uint128 validatorFeeCap,
        uint128 bond
    ) external nonReentrant returns (uint32 candidateId) {
        Issue storage issue = issues[issueId];
        (, , uint256 reproductionFees) = _reproductionSummary(issueId);
        uint256 quoted = uint256(issue.reporterAsk) +
            issue.keeperReward +
            reproductionFees +
            authorBid +
            plannerBid +
            uint256(validatorFeeCap) * MIN_EVALUATIONS;
        if (
            issue.state != IssueState.AUCTION ||
            block.timestamp > issue.candidateDeadline ||
            codeHash == bytes32(0) ||
            manifestHash == bytes32(0) ||
            authorBid == 0 ||
            validatorFeeCap == 0 ||
            quoted > issue.maxBudget ||
            candidateBy[issueId][msg.sender] ||
            _candidates[issueId].length >= MAX_CANDIDATES ||
            (!issue.genesis && bond < MIN_BOND) ||
            (issue.genesis && bond != 0) ||
            msg.sender == issue.reporter ||
            reproducedBy[issueId][msg.sender] ||
            (
                plannerBid != 0 &&
                (
                    planner == address(0) ||
                    planner == msg.sender ||
                    planner == issue.reporter ||
                    reproducedBy[issueId][planner]
                )
            )
        ) revert InvalidTerms();
        candidateBy[issueId][msg.sender] = true;
        if (bond != 0) {
            IERC20(address(token)).safeTransferFrom(
                msg.sender,
                address(this),
                bond
            );
        }
        _candidates[issueId].push(
            Candidate({
                author: msg.sender,
                planner: planner,
                codeHash: codeHash,
                manifestHash: manifestHash,
                deliveryHash: bytes32(0),
                proofHash: bytes32(0),
                authorBid: authorBid,
                plannerBid: plannerBid,
                validatorFeeCap: validatorFeeCap,
                bond: bond,
                objectiveScoreBps: 0,
                delivered: false
            })
        );
        candidateId = uint32(_candidates[issueId].length);
        uint32 selected = issue.selectedCandidateId;
        if (
            selected == 0 ||
            _candidateQuotedCost(issueId, candidateId) <
            _candidateQuotedCost(issueId, selected)
        ) {
            issue.selectedCandidateId = candidateId;
        }
        emit CandidateSubmitted(issueId, candidateId, msg.sender, quoted);
    }

    function awardCandidate(uint256 issueId) external nonReentrant {
        Issue storage issue = issues[issueId];
        if (
            issue.state != IssueState.AUCTION ||
            block.timestamp <= issue.candidateDeadline ||
            issue.selectedCandidateId == 0
        ) revert InvalidState();
        issue.state = IssueState.CANARY;
        Candidate[] storage candidates = _candidates[issueId];
        for (uint256 index = 0; index < candidates.length; index++) {
            if (index + 1 != issue.selectedCandidateId) {
                _refund(candidates[index].author, candidates[index].bond);
                candidates[index].bond = 0;
            }
        }
        emit CandidateAwarded(issueId, issue.selectedCandidateId);
    }

    function deliverCandidate(
        uint256 issueId,
        bytes32 deliveryHash,
        bytes calldata proof
    ) external {
        Issue storage issue = issues[issueId];
        if (
            issue.state != IssueState.CANARY ||
            block.timestamp > issue.canaryDeadline ||
            deliveryHash == bytes32(0) ||
            proof.length == 0
        ) revert InvalidState();
        Candidate storage candidate = _selectedCandidate(issueId);
        if (msg.sender != candidate.author || candidate.delivered) {
            revert Unauthorized();
        }
        uint16 objectiveScore = IAgentPoolV42ImprovementVerifier(
            issue.verifier
        ).scoreCandidate(
            issue.issueHash,
            candidate.codeHash,
            candidate.manifestHash,
            deliveryHash,
            candidate.author,
            proof
        );
        if (objectiveScore < PASS_SCORE_BPS) {
            revert InsufficientEvidence();
        }
        candidate.deliveryHash = deliveryHash;
        candidate.proofHash = keccak256(proof);
        candidate.objectiveScoreBps = objectiveScore;
        candidate.delivered = true;
        emit CandidateDelivered(
            issueId,
            issue.selectedCandidateId,
            deliveryHash
        );
    }

    function commitEvaluation(
        uint256 issueId,
        bytes32 commitment,
        uint128 feeAsk,
        uint128 bond
    ) external nonReentrant {
        Issue storage issue = issues[issueId];
        Candidate storage candidate = _selectedCandidate(issueId);
        if (
            issue.state != IssueState.CANARY ||
            !candidate.delivered ||
            block.timestamp > issue.canaryDeadline ||
            commitment == bytes32(0) ||
            feeAsk == 0 ||
            feeAsk > candidate.validatorFeeCap ||
            evaluatedBy[issueId][msg.sender] ||
            _evaluations[issueId].length >= MAX_EVALUATIONS ||
            (!issue.genesis && bond < MIN_BOND) ||
            (issue.genesis && bond != 0) ||
            msg.sender == issue.reporter ||
            msg.sender == candidate.author ||
            msg.sender == candidate.planner ||
            reproducedBy[issueId][msg.sender]
        ) revert InvalidTerms();
        evaluatedBy[issueId][msg.sender] = true;
        if (bond != 0) {
            IERC20(address(token)).safeTransferFrom(
                msg.sender,
                address(this),
                bond
            );
        }
        _evaluations[issueId].push(
            Evaluation({
                evaluator: msg.sender,
                commitment: commitment,
                evidenceHash: bytes32(0),
                feeAsk: feeAsk,
                bond: bond,
                scoreBps: 0,
                revealed: false
            })
        );
        emit EvaluationCommitted(issueId, msg.sender, feeAsk);
    }

    function revealEvaluation(
        uint256 issueId,
        uint16 scoreBps,
        bytes32 evidenceHash,
        bytes32 salt
    ) external {
        Issue storage issue = issues[issueId];
        if (
            issue.state != IssueState.CANARY ||
            block.timestamp > issue.canaryDeadline ||
            scoreBps > 10_000 ||
            evidenceHash == bytes32(0)
        ) revert InvalidState();
        Evaluation storage evaluation = _evaluationFor(issueId, msg.sender);
        if (
            evaluation.revealed ||
            keccak256(abi.encode(scoreBps, evidenceHash, salt)) !=
            evaluation.commitment
        ) revert InvalidTerms();
        evaluation.revealed = true;
        evaluation.scoreBps = scoreBps;
        evaluation.evidenceHash = evidenceHash;
        emit EvaluationRevealed(
            issueId,
            msg.sender,
            scoreBps,
            evidenceHash
        );
    }

    function finalizeImprovement(uint256 issueId) external nonReentrant {
        Issue storage issue = issues[issueId];
        if (
            issue.state != IssueState.CANARY ||
            block.timestamp <= issue.canaryDeadline
        ) revert InvalidState();
        Candidate storage candidate = _selectedCandidate(issueId);
        (uint16 medianScore, uint256 revealed, uint256 evaluatorFees) =
            _evaluationSummary(issueId);
        if (
            !candidate.delivered ||
            candidate.objectiveScoreBps < PASS_SCORE_BPS ||
            revealed < MIN_EVALUATIONS ||
            revealed % 2 == 0 ||
            medianScore < PASS_SCORE_BPS
        ) {
            issue.state = IssueState.REJECTED;
            _release(issue);
            _settleIssueBonds(issueId, true, candidate.delivered);
            emit IssueClosed(issueId, IssueState.REJECTED);
            return;
        }
        (, , uint256 reproductionFees) = _reproductionSummary(issueId);
        uint256 total = uint256(issue.reporterAsk) +
            issue.keeperReward +
            reproductionFees +
            candidate.authorBid +
            candidate.plannerBid +
            evaluatorFees;
        if (total > issue.maxBudget) revert BudgetExceeded();
        issue.state = IssueState.PROVEN;
        _settleIssueBonds(issueId, true, true);
        uint256 reused = slashPool < total ? slashPool : total;
        uint256 newlyMinted = total - reused;
        _consume(issue, newlyMinted);

        _pay(issue.reporter, issue.reporterAsk);
        _pay(candidate.author, candidate.authorBid);
        if (candidate.plannerBid != 0) {
            _pay(candidate.planner, candidate.plannerBid);
        }
        Reproduction[] storage reproductions = _reproductions[issueId];
        for (uint256 index = 0; index < reproductions.length; index++) {
            if (
                reproductions[index].revealed &&
                reproductions[index].passed
            ) {
                _pay(
                    reproductions[index].agent,
                    reproductions[index].feeAsk
                );
            }
        }
        Evaluation[] storage evaluations = _evaluations[issueId];
        for (uint256 index = 0; index < evaluations.length; index++) {
            if (evaluations[index].revealed) {
                _pay(
                    evaluations[index].evaluator,
                    evaluations[index].feeAsk
                );
            }
        }
        _pay(msg.sender, issue.keeperReward);

        bytes32 moduleId = keccak256(
            abi.encode(
                candidate.author,
                candidate.codeHash,
                candidate.manifestHash,
                issue.issueHash
            )
        );
        if (provenModules[moduleId].provenAt != 0) revert InvalidTerms();
        provenModules[moduleId] = ProvenModule({
            author: candidate.author,
            issueHash: issue.issueHash,
            codeHash: candidate.codeHash,
            manifestHash: candidate.manifestHash,
            deliveryHash: candidate.deliveryHash,
            proofHash: candidate.proofHash,
            provenAt: uint64(block.timestamp)
        });
        if (issue.promotesVerifier) {
            approvedVerifierCodehash[candidate.codeHash] = true;
            emit VerifierApproved(candidate.codeHash, issueId);
        }
        emit ImprovementProven(
            issueId,
            moduleId,
            medianScore,
            total,
            newlyMinted
        );
    }

    function expireIssue(uint256 issueId) external nonReentrant {
        Issue storage issue = issues[issueId];
        (uint256 reproduced, uint256 positive, ) = _reproductionSummary(
            issueId
        );
        (, uint256 evaluated, ) = _evaluationSummary(issueId);
        bool reproducible =
            reproduced >= MIN_REPRODUCTIONS &&
            positive * 3 >= reproduced * 2;
        bool canFinalize =
            issue.state == IssueState.CANARY &&
            _selectedCandidate(issueId).delivered &&
            evaluated >= MIN_EVALUATIONS &&
            evaluated % 2 == 1;
        bool expired =
            (
                issue.state == IssueState.REPRODUCING &&
                block.timestamp > issue.reproductionDeadline &&
                !reproducible
            ) ||
            (
                issue.state == IssueState.AUCTION &&
                block.timestamp > issue.candidateDeadline &&
                issue.selectedCandidateId == 0
            ) ||
            (
                issue.state == IssueState.CANARY &&
                block.timestamp > issue.canaryDeadline &&
                !canFinalize
            );
        if (!expired) revert InvalidState();
        if (
            issue.state == IssueState.AUCTION ||
            issue.state == IssueState.CANARY
        ) {
            _release(issue);
        }
        issue.state = IssueState.EXPIRED;
        bool candidateDelivered =
            issue.selectedCandidateId != 0 &&
            _selectedCandidate(issueId).delivered;
        _settleIssueBonds(issueId, true, candidateDelivered);
        emit IssueClosed(issueId, IssueState.EXPIRED);
    }

    function reproductionCount(uint256 issueId) external view returns (uint256) {
        return _reproductions[issueId].length;
    }

    function reproductionAt(
        uint256 issueId,
        uint256 index
    ) external view returns (Reproduction memory) {
        return _reproductions[issueId][index];
    }

    function candidateCount(uint256 issueId) external view returns (uint256) {
        return _candidates[issueId].length;
    }

    function candidateAt(
        uint256 issueId,
        uint256 index
    ) external view returns (Candidate memory) {
        return _candidates[issueId][index];
    }

    function evaluationCount(uint256 issueId) external view returns (uint256) {
        return _evaluations[issueId].length;
    }

    function evaluationAt(
        uint256 issueId,
        uint256 index
    ) external view returns (Evaluation memory) {
        return _evaluations[issueId][index];
    }

    function _reserve(Issue storage issue) internal {
        uint256 allowance = epochAllowance(issue.epoch);
        uint256 issueCap = allowance * ISSUE_CAP_BPS / 10_000;
        if (
            epochMinted[issue.epoch] +
                epochReserved[issue.epoch] +
                issue.maxBudget >
            allowance ||
            issueMinted[issue.epoch][issue.issueHash] +
                issueReserved[issue.epoch][issue.issueHash] +
                issue.maxBudget >
            issueCap
        ) revert BudgetExceeded();
        if (
            epochStart(issue.epoch) <
            uint256(genesisStart) + GENESIS_DURATION
        ) {
            if (
                genesisMinted + genesisReserved + issue.maxBudget >
                genesisCap
            ) revert BudgetExceeded();
            genesisReserved += issue.maxBudget;
        }
        epochReserved[issue.epoch] += issue.maxBudget;
        issueReserved[issue.epoch][issue.issueHash] += issue.maxBudget;
    }

    function _release(Issue storage issue) internal {
        epochReserved[issue.epoch] -= issue.maxBudget;
        issueReserved[issue.epoch][issue.issueHash] -= issue.maxBudget;
        if (
            epochStart(issue.epoch) <
            uint256(genesisStart) + GENESIS_DURATION
        ) {
            genesisReserved -= issue.maxBudget;
        }
    }

    function _consume(Issue storage issue, uint256 total) internal {
        epochReserved[issue.epoch] -= issue.maxBudget;
        epochMinted[issue.epoch] += total;
        issueReserved[issue.epoch][issue.issueHash] -= issue.maxBudget;
        issueMinted[issue.epoch][issue.issueHash] += total;
        if (
            epochStart(issue.epoch) <
            uint256(genesisStart) + GENESIS_DURATION
        ) {
            genesisReserved -= issue.maxBudget;
            genesisMinted += total;
        }
    }

    function _reproductionFor(
        uint256 issueId,
        address agent
    ) internal view returns (Reproduction storage reproduction) {
        Reproduction[] storage entries = _reproductions[issueId];
        for (uint256 index = 0; index < entries.length; index++) {
            if (entries[index].agent == agent) return entries[index];
        }
        revert Unauthorized();
    }

    function _evaluationFor(
        uint256 issueId,
        address evaluator
    ) internal view returns (Evaluation storage evaluation) {
        Evaluation[] storage entries = _evaluations[issueId];
        for (uint256 index = 0; index < entries.length; index++) {
            if (entries[index].evaluator == evaluator) return entries[index];
        }
        revert Unauthorized();
    }

    function _selectedCandidate(
        uint256 issueId
    ) internal view returns (Candidate storage candidate) {
        uint32 selected = issues[issueId].selectedCandidateId;
        if (selected == 0) revert InvalidState();
        return _candidates[issueId][selected - 1];
    }

    function _candidateQuotedCost(
        uint256 issueId,
        uint32 candidateId
    ) internal view returns (uint256) {
        Candidate storage candidate = _candidates[issueId][candidateId - 1];
        return
            uint256(candidate.authorBid) +
            candidate.plannerBid +
            uint256(candidate.validatorFeeCap) * MIN_EVALUATIONS;
    }

    function _reproductionSummary(
        uint256 issueId
    )
        internal
        view
        returns (uint256 revealed, uint256 positive, uint256 fees)
    {
        Reproduction[] storage entries = _reproductions[issueId];
        for (uint256 index = 0; index < entries.length; index++) {
            if (!entries[index].revealed) continue;
            revealed++;
            if (entries[index].passed) {
                positive++;
                fees += entries[index].feeAsk;
            }
        }
    }

    function _evaluationSummary(
        uint256 issueId
    )
        internal
        view
        returns (uint16 medianScore, uint256 revealed, uint256 fees)
    {
        Evaluation[] storage entries = _evaluations[issueId];
        uint16[] memory scores = new uint16[](entries.length);
        for (uint256 index = 0; index < entries.length; index++) {
            if (!entries[index].revealed) continue;
            scores[revealed] = entries[index].scoreBps;
            fees += entries[index].feeAsk;
            revealed++;
        }
        for (uint256 left = 1; left < revealed; left++) {
            uint16 value = scores[left];
            uint256 right = left;
            while (right > 0 && scores[right - 1] > value) {
                scores[right] = scores[right - 1];
                right--;
            }
            scores[right] = value;
        }
        if (revealed != 0) medianScore = scores[revealed / 2];
    }

    function _settleIssueBonds(
        uint256 issueId,
        bool refundReporter,
        bool refundSelectedCandidate
    ) internal {
        Issue storage issue = issues[issueId];
        if (refundReporter) {
            _refund(issue.reporter, issue.reporterBond);
        } else {
            slashPool += issue.reporterBond;
        }
        issue.reporterBond = 0;
        Reproduction[] storage reproductions = _reproductions[issueId];
        for (uint256 index = 0; index < reproductions.length; index++) {
            if (
                reproductions[index].revealed &&
                reproductions[index].passed
            ) {
                _refund(
                    reproductions[index].agent,
                    reproductions[index].bond
                );
            } else {
                slashPool += reproductions[index].bond;
            }
            reproductions[index].bond = 0;
        }
        Candidate[] storage candidates = _candidates[issueId];
        for (uint256 index = 0; index < candidates.length; index++) {
            if (
                index + 1 == issue.selectedCandidateId &&
                refundSelectedCandidate &&
                candidates[index].delivered
            ) {
                _refund(candidates[index].author, candidates[index].bond);
            } else {
                slashPool += candidates[index].bond;
            }
            candidates[index].bond = 0;
        }
        Evaluation[] storage evaluations = _evaluations[issueId];
        for (uint256 index = 0; index < evaluations.length; index++) {
            if (evaluations[index].revealed) {
                _refund(
                    evaluations[index].evaluator,
                    evaluations[index].bond
                );
            } else {
                slashPool += evaluations[index].bond;
            }
            evaluations[index].bond = 0;
        }
    }

    function _pay(address recipient, uint256 amount) internal {
        if (amount == 0) return;
        uint256 reused = slashPool < amount ? slashPool : amount;
        if (reused != 0) {
            slashPool -= reused;
            IERC20(address(token)).safeTransfer(recipient, reused);
        }
        uint256 emission = amount - reused;
        if (emission != 0) token.mint(recipient, emission);
    }

    function _refund(address recipient, uint256 amount) internal {
        if (amount != 0) {
            IERC20(address(token)).safeTransfer(recipient, amount);
        }
    }

    function _rpow(
        uint256 base,
        uint256 exponent,
        uint256 scalar
    ) internal pure returns (uint256 result) {
        result = scalar;
        while (exponent != 0) {
            if ((exponent & 1) != 0) {
                result = (result * base + scalar / 2) / scalar;
            }
            exponent >>= 1;
            if (exponent != 0) {
                base = (base * base + scalar / 2) / scalar;
            }
        }
    }
}
