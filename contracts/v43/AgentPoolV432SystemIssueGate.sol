// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {
    IAgentPoolV43ContributionLedger
} from "./interfaces/IAgentPoolV43ContributionLedger.sol";
import {
    IAgentPoolV43SystemIssueGate
} from "./interfaces/IAgentPoolV43SystemIssueGate.sol";
import {
    IAgentPoolV432SystemIssueGate
} from "./interfaces/IAgentPoolV432SystemIssueGate.sol";

/// @notice v4.3.2 issue admission. BOOTSTRAP work must match a finite Merkle
///         catalog that fixes the verifier address, evidence digest and
///         validator policy. MATURE work must first pass Work Power consensus.
contract AgentPoolV432SystemIssueGate is IAgentPoolV432SystemIssueGate {
    struct Usage {
        bytes32 termsHash;
        uint128 committedBudget;
        uint16 candidates;
    }

    bytes32 public immutable bootstrapRoot;
    IAgentPoolV43ContributionLedger public immutable ledger;
    address public configurationAuthority;
    address public market;
    address public consensus;

    mapping(bytes32 => Usage) public usage;
    mapping(bytes32 => bool) public approvedIssueHash;
    mapping(bytes32 => mapping(bytes32 => bool)) public groupUsed;

    event MarketConfigured(address indexed market);
    event ConsensusConfigured(address indexed consensus);
    event IssueApproved(bytes32 indexed issueHash);
    event IssueConsumed(
        bytes32 indexed issueId,
        bytes32 indexed operatorGroup,
        address indexed proposer,
        uint256 budget,
        uint256 candidates
    );

    error Unauthorized();
    error InvalidTerms();
    error BudgetExceeded();
    error AlreadyConfigured();
    error DuplicateGroup();

    constructor(
        bytes32 bootstrapRoot_,
        IAgentPoolV43ContributionLedger ledger_,
        address configurationAuthority_
    ) {
        if (
            bootstrapRoot_ == bytes32(0) ||
            address(ledger_) == address(0) ||
            configurationAuthority_ == address(0)
        ) revert InvalidTerms();
        bootstrapRoot = bootstrapRoot_;
        ledger = ledger_;
        configurationAuthority = configurationAuthority_;
    }

    function configure(
        address market_,
        address consensus_
    ) external {
        if (msg.sender != configurationAuthority) revert Unauthorized();
        if (market != address(0) || consensus != address(0)) {
            revert AlreadyConfigured();
        }
        if (
            market_ == address(0) ||
            market_.code.length == 0 ||
            consensus_ == address(0) ||
            consensus_.code.length == 0
        ) revert InvalidTerms();
        market = market_;
        consensus = consensus_;
        configurationAuthority = address(0);
        emit MarketConfigured(market_);
        emit ConsensusConfigured(consensus_);
    }

    function hashIssue(
        IssueTerms calldata issue
    ) public pure override returns (bytes32) {
        return keccak256(abi.encode(issue));
    }

    function consumeFor(
        IssueTerms calldata issue,
        uint128 budget,
        address proposer,
        bytes32[] calldata bootstrapProof
    ) external override returns (bool bootstrapAdmitted) {
        if (msg.sender != market) revert Unauthorized();
        bytes32 termsHash = hashIssue(issue);
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
        bootstrapAdmitted = MerkleProof.verifyCalldata(
            bootstrapProof,
            bootstrapRoot,
            termsHash
        );
        if (
            bootstrapAdmitted &&
            (
                issue.bootstrapProposer == address(0) ||
                proposer != issue.bootstrapProposer
            )
        ) revert Unauthorized();
        if (!bootstrapAdmitted && !approvedIssueHash[termsHash]) {
            revert Unauthorized();
        }

        bytes32 operatorGroup = ledger.operatorGroup(proposer);
        if (operatorGroup == bytes32(0)) revert Unauthorized();
        if (groupUsed[issue.issueId][operatorGroup]) revert DuplicateGroup();

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
        emit IssueConsumed(
            issue.issueId,
            operatorGroup,
            proposer,
            budget,
            current.candidates
        );
        return bootstrapAdmitted;
    }

    function approveIssueHash(bytes32 issueHash) external override {
        if (msg.sender != consensus || !ledger.mature()) {
            revert Unauthorized();
        }
        if (issueHash == bytes32(0) || approvedIssueHash[issueHash]) {
            revert InvalidTerms();
        }
        approvedIssueHash[issueHash] = true;
        emit IssueApproved(issueHash);
    }

    /// @dev The v4.3.1 gate interface is intentionally rejected so callers
    ///      cannot omit the evidence and validator policy added in v4.3.2.
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
