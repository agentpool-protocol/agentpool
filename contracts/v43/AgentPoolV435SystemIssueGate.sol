// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {
    IAgentPoolV43SystemIssueGate
} from "./interfaces/IAgentPoolV43SystemIssueGate.sol";
import {
    IAgentPoolV432SystemIssueGate
} from "./interfaces/IAgentPoolV432SystemIssueGate.sol";
import {
    IAgentPoolV435ContributionLedger
} from "./interfaces/IAgentPoolV435ContributionLedger.sol";
import {
    IAgentPoolV435SystemIssueGate
} from "./interfaces/IAgentPoolV435SystemIssueGate.sol";

/// @notice v4.3.5 admission gate with three explicit safety levels.
///         BOOTSTRAP accepts only the finite catalog committed at deployment.
///         TRANSITION accepts tightly capped Issues approved by independent
///         contribution voters. MATURE accepts Work Power approved Issues.
///         Every dynamic Issue remains restricted to the verifier code hash
///         and financial caps fixed in this contract. TRANSITION also uses the
///         deployment validator root; MATURE Work Power may approve a new root
///         without changing the settlement or reserve contracts.
contract AgentPoolV435SystemIssueGate is
    IAgentPoolV435SystemIssueGate
{
    using SafeERC20 for IERC20;

    struct Usage {
        bytes32 termsHash;
        uint128 committedBudget;
        uint16 candidates;
    }

    uint16 public constant MIN_TRANSITION_AGENTS = 3;
    uint16 public constant MIN_TRANSITION_GROUPS = 2;
    uint64 public constant MIN_TRANSITION_SETTLEMENTS = 20;
    uint16 public constant MIN_TRANSITION_EPOCHS = 2;
    uint16 public constant MIN_DYNAMIC_REVEALS = 3;
    uint16 public constant MAX_DYNAMIC_REVEALS = 15;
    uint16 public constant MIN_DYNAMIC_GROUPS = 2;
    uint16 public constant MIN_DYNAMIC_PASS_SCORE_BPS = 8_000;

    bytes32 public immutable bootstrapRoot;
    bytes32 public immutable dynamicVerifierCodehash;
    bytes32 public immutable dynamicValidatorRoot;
    uint128 public immutable dynamicCandidateBudgetCap;
    uint128 public immutable dynamicIssueBudgetCap;
    uint16 public immutable dynamicMaxCandidates;
    uint64 public immutable dynamicMaxLifetime;
    uint128 public immutable dynamicCandidateBond;
    IERC20 public immutable token;
    IAgentPoolV435ContributionLedger public immutable ledger;

    address public configurationAuthority;
    address public market;
    address public transitionConsensus;
    address public matureConsensus;

    mapping(bytes32 => Usage) public usage;
    mapping(bytes32 => bool) public transitionApprovedIssueHash;
    mapping(bytes32 => bool) public approvedIssueHash;
    mapping(bytes32 => mapping(bytes32 => bool)) public groupUsed;
    mapping(bytes32 => mapping(bytes32 => bool)) public candidateFinalized;
    mapping(bytes32 => mapping(bytes32 => uint128)) public candidateBond;

    event Configured(
        address indexed market,
        address indexed transitionConsensus,
        address indexed matureConsensus
    );
    event TransitionIssueApproved(bytes32 indexed issueHash);
    event MatureIssueApproved(bytes32 indexed issueHash);
    event IssueConsumed(
        bytes32 indexed issueId,
        bytes32 indexed operatorGroup,
        address indexed proposer,
        uint256 budget,
        uint256 candidates
    );
    event IssueReleased(
        bytes32 indexed issueId,
        bytes32 indexed operatorGroup,
        address indexed proposer,
        uint256 budget,
        uint256 returnedBond,
        uint256 candidates
    );

    error Unauthorized();
    error InvalidTerms();
    error BudgetExceeded();
    error AlreadyConfigured();
    error DuplicateGroup();

    constructor(
        bytes32 bootstrapRoot_,
        IERC20 token_,
        IAgentPoolV435ContributionLedger ledger_,
        address configurationAuthority_,
        bytes32 dynamicVerifierCodehash_,
        bytes32 dynamicValidatorRoot_,
        uint128 dynamicCandidateBudgetCap_,
        uint128 dynamicIssueBudgetCap_,
        uint16 dynamicMaxCandidates_,
        uint64 dynamicMaxLifetime_,
        uint128 dynamicCandidateBond_
    ) {
        if (
            bootstrapRoot_ == bytes32(0) ||
            address(token_) == address(0) ||
            address(ledger_) == address(0) ||
            configurationAuthority_ == address(0) ||
            dynamicVerifierCodehash_ == bytes32(0) ||
            dynamicValidatorRoot_ == bytes32(0) ||
            dynamicCandidateBudgetCap_ == 0 ||
            dynamicIssueBudgetCap_ < dynamicCandidateBudgetCap_ ||
            dynamicMaxCandidates_ == 0 ||
            dynamicMaxLifetime_ < 1 days ||
            dynamicCandidateBond_ == 0
        ) revert InvalidTerms();
        bootstrapRoot = bootstrapRoot_;
        token = token_;
        ledger = ledger_;
        configurationAuthority = configurationAuthority_;
        dynamicVerifierCodehash = dynamicVerifierCodehash_;
        dynamicValidatorRoot = dynamicValidatorRoot_;
        dynamicCandidateBudgetCap = dynamicCandidateBudgetCap_;
        dynamicIssueBudgetCap = dynamicIssueBudgetCap_;
        dynamicMaxCandidates = dynamicMaxCandidates_;
        dynamicMaxLifetime = dynamicMaxLifetime_;
        dynamicCandidateBond = dynamicCandidateBond_;
    }

    function configure(
        address market_,
        address transitionConsensus_,
        address matureConsensus_
    ) external {
        if (msg.sender != configurationAuthority) revert Unauthorized();
        if (
            market != address(0) ||
            transitionConsensus != address(0) ||
            matureConsensus != address(0)
        ) revert AlreadyConfigured();
        if (
            market_ == address(0) ||
            market_.code.length == 0 ||
            transitionConsensus_ == address(0) ||
            transitionConsensus_.code.length == 0 ||
            matureConsensus_ == address(0) ||
            matureConsensus_.code.length == 0
        ) revert InvalidTerms();
        market = market_;
        transitionConsensus = transitionConsensus_;
        matureConsensus = matureConsensus_;
        configurationAuthority = address(0);
        emit Configured(market_, transitionConsensus_, matureConsensus_);
    }

    function transitionReady() public view override returns (bool) {
        return
            !ledger.mature() &&
            ledger.bootstrapSuccessfulSettlementCount() >=
                MIN_TRANSITION_SETTLEMENTS &&
            ledger.bootstrapActiveEpochCount() >= MIN_TRANSITION_EPOCHS;
    }

    function hashIssue(
        IssueTerms calldata issue
    ) public pure override returns (bytes32) {
        return keccak256(abi.encode(issue));
    }

    function approveTransitionIssue(
        IssueTerms calldata issue
    ) external override {
        if (msg.sender != transitionConsensus) revert Unauthorized();
        _validateDynamicIssue(issue, true);
        bytes32 issueHash = hashIssue(issue);
        if (
            transitionApprovedIssueHash[issueHash] ||
            approvedIssueHash[issueHash]
        ) revert InvalidTerms();
        transitionApprovedIssueHash[issueHash] = true;
        emit TransitionIssueApproved(issueHash);
    }

    function validateTransitionIssue(
        IssueTerms calldata issue
    ) external view override returns (bool) {
        _validateDynamicIssue(issue, true);
        return true;
    }

    function approveIssueHash(bytes32 issueHash) external override {
        if (msg.sender != matureConsensus || !ledger.mature()) {
            revert Unauthorized();
        }
        if (
            issueHash == bytes32(0) ||
            approvedIssueHash[issueHash] ||
            transitionApprovedIssueHash[issueHash]
        ) revert InvalidTerms();
        approvedIssueHash[issueHash] = true;
        emit MatureIssueApproved(issueHash);
    }

    function consumeFor(
        IssueTerms calldata issue,
        uint128 budget,
        address proposer,
        bytes32[] calldata bootstrapProof
    ) external override returns (bool bootstrapAdmitted) {
        if (msg.sender != market) revert Unauthorized();
        _validateBaseIssue(issue);
        bytes32 termsHash = hashIssue(issue);
        bootstrapAdmitted = MerkleProof.verifyCalldata(
            bootstrapProof,
            bootstrapRoot,
            termsHash
        );
        if (bootstrapAdmitted) {
            if (
                issue.bootstrapProposer == address(0) ||
                proposer != issue.bootstrapProposer
            ) revert Unauthorized();
        } else {
            if (
                !transitionApprovedIssueHash[termsHash] &&
                !approvedIssueHash[termsHash]
            ) revert Unauthorized();
            _validateDynamicIssue(
                issue,
                transitionApprovedIssueHash[termsHash]
            );
            // TRANSITION candidates are admitted by the immutable validator
            // committee because BOOTSTRAP work deliberately creates no Work
            // Power. Once MATURE governance exists, candidate proposers must
            // have verified Work Power at the committed snapshot.
            if (approvedIssueHash[termsHash]) {
                uint64 snapshotEpoch = ledger.governanceSnapshotEpoch();
                if (
                    ledger.votingPowerAt(
                        proposer,
                        snapshotEpoch,
                        8
                    ) == 0
                ) revert Unauthorized();
            }
        }

        bytes32 operatorGroup = ledger.operatorGroup(proposer);
        if (operatorGroup == bytes32(0)) revert Unauthorized();
        if (groupUsed[issue.issueId][operatorGroup]) {
            revert DuplicateGroup();
        }

        Usage storage current = usage[issue.issueId];
        if (
            current.termsHash != bytes32(0) &&
            current.termsHash != termsHash
        ) revert InvalidTerms();
        if (
            budget == 0 ||
            budget > issue.candidateBudgetCap ||
            uint256(current.committedBudget) + budget >
                issue.totalBudgetCap ||
            current.candidates >= issue.maxCandidates
        ) revert BudgetExceeded();
        current.termsHash = termsHash;
        current.committedBudget += budget;
        current.candidates++;
        groupUsed[issue.issueId][operatorGroup] = true;
        if (!bootstrapAdmitted) {
            candidateBond[issue.issueId][operatorGroup] =
                dynamicCandidateBond;
            token.safeTransferFrom(
                proposer,
                address(this),
                dynamicCandidateBond
            );
        }
        emit IssueConsumed(
            issue.issueId,
            operatorGroup,
            proposer,
            budget,
            current.candidates
        );
        return bootstrapAdmitted;
    }

    function releaseFor(
        bytes32 issueId,
        uint128 budget,
        address proposer
    ) external override {
        if (msg.sender != market) revert Unauthorized();
        bytes32 operatorGroup = ledger.operatorGroup(proposer);
        Usage storage current = usage[issueId];
        if (
            issueId == bytes32(0) ||
            proposer == address(0) ||
            operatorGroup == bytes32(0) ||
            !groupUsed[issueId][operatorGroup] ||
            candidateFinalized[issueId][operatorGroup] ||
            budget == 0 ||
            current.candidates == 0 ||
            current.committedBudget < budget
        ) revert InvalidTerms();

        // The Issue budget and candidate count are lifetime admission caps,
        // not concurrent-work counters. A terminal candidate returns only its
        // refundable bond. Keeping the spent admission and operator-group
        // lock prevents the same finite Issue from being replayed until the
        // epoch vault is drained.
        candidateFinalized[issueId][operatorGroup] = true;
        uint128 returnedBond = candidateBond[issueId][operatorGroup];
        if (returnedBond != 0) {
            candidateBond[issueId][operatorGroup] = 0;
            token.safeTransfer(proposer, returnedBond);
        }
        emit IssueReleased(
            issueId,
            operatorGroup,
            proposer,
            budget,
            returnedBond,
            current.candidates
        );
    }

    function _validateBaseIssue(
        IssueTerms calldata issue
    ) private view {
        if (
            issue.issueId == bytes32(0) ||
            issue.specificationHash == bytes32(0) ||
            issue.verifier == address(0) ||
            issue.verifier.code.length == 0 ||
            issue.expectedEvidenceHash == bytes32(0) ||
            issue.objectiveRoot == bytes32(0) ||
            issue.candidateBudgetCap == 0 ||
            issue.totalBudgetCap < issue.candidateBudgetCap ||
            issue.maxCandidates == 0 ||
            issue.funding < 2 ||
            issue.funding > 3 ||
            issue.expiresAt <= block.timestamp ||
            issue.passScoreBps > 10_000 ||
            issue.minimumReveals > MAX_DYNAMIC_REVEALS ||
            issue.minimumValidatorGroups > issue.minimumReveals ||
            (
                issue.minimumReveals == 0 &&
                (
                    issue.validatorRoot != bytes32(0) ||
                    issue.minimumValidatorGroups != 0
                )
            ) ||
            (
                issue.minimumReveals != 0 &&
                (
                    issue.validatorRoot == bytes32(0) ||
                    issue.minimumValidatorGroups == 0
                )
            )
        ) revert InvalidTerms();
    }

    function _validateDynamicIssue(
        IssueTerms calldata issue,
        bool transition
    ) private view {
        _validateBaseIssue(issue);
        if (
            issue.bootstrapProposer != address(0) ||
            issue.verifier.codehash != dynamicVerifierCodehash ||
            (transition && issue.validatorRoot != dynamicValidatorRoot) ||
            issue.candidateBudgetCap > dynamicCandidateBudgetCap ||
            issue.totalBudgetCap > dynamicIssueBudgetCap ||
            issue.maxCandidates > dynamicMaxCandidates ||
            issue.minimumReveals < MIN_DYNAMIC_REVEALS ||
            issue.minimumValidatorGroups < MIN_DYNAMIC_GROUPS ||
            issue.passScoreBps < MIN_DYNAMIC_PASS_SCORE_BPS ||
            uint256(issue.expiresAt) >
                block.timestamp + dynamicMaxLifetime ||
            (transition && issue.funding != 3)
        ) revert InvalidTerms();
    }

    /// @dev Reject the older admission interface so evidence and validator
    ///      policy cannot be omitted.
    function consume(
        IAgentPoolV43SystemIssueGate.IssueTerms calldata,
        uint128,
        bytes32[] calldata
    ) external pure {
        revert Unauthorized();
    }

    function approveIssue(
        IAgentPoolV43SystemIssueGate.IssueTerms calldata
    ) external pure {
        revert Unauthorized();
    }
}
