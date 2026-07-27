// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {
    IAgentPoolV43ContributionLedger
} from "./interfaces/IAgentPoolV43ContributionLedger.sol";
import {
    IAgentPoolV43SystemIssueGate
} from "./interfaces/IAgentPoolV43SystemIssueGate.sol";

/// @notice Admission and exposure control for reserve-funded AgentPool work.
///         BOOTSTRAP may consume only finite, precommitted issues. Once the
///         contribution ledger matures, new issues require Work Power
///         consensus and are still bounded by candidate and total budgets.
contract AgentPoolV43SystemIssueGate is IAgentPoolV43SystemIssueGate {
    struct Usage {
        bytes32 termsHash;
        uint128 committedBudget;
        uint16 candidates;
    }

    IAgentPoolV43ContributionLedger public immutable ledger;
    bytes32 public immutable bootstrapRoot;
    address public configurationAuthority;
    address public market;
    address public issueConsensus;

    mapping(bytes32 => bool) public matureApproval;
    mapping(bytes32 => Usage) public usage;

    event Configured(address indexed market, address indexed issueConsensus);
    event MatureIssueApproved(bytes32 indexed termsHash, bytes32 indexed issueId);
    event IssueConsumed(
        bytes32 indexed issueId,
        bytes32 indexed termsHash,
        uint256 requestedBudget,
        uint16 candidateNumber
    );

    error Unauthorized();
    error InvalidTerms();
    error AlreadyConfigured();
    error ExposureExceeded();

    constructor(
        IAgentPoolV43ContributionLedger ledger_,
        bytes32 bootstrapRoot_,
        address configurationAuthority_
    ) {
        if (
            address(ledger_) == address(0) ||
            bootstrapRoot_ == bytes32(0) ||
            configurationAuthority_ == address(0)
        ) revert InvalidTerms();
        ledger = ledger_;
        bootstrapRoot = bootstrapRoot_;
        configurationAuthority = configurationAuthority_;
    }

    function termsHash(
        IssueTerms calldata issue
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(issue));
    }

    function configure(
        address market_,
        address issueConsensus_
    ) external {
        if (msg.sender != configurationAuthority) revert Unauthorized();
        if (market != address(0) || issueConsensus != address(0)) {
            revert AlreadyConfigured();
        }
        if (
            market_ == address(0) ||
            market_.code.length == 0 ||
            issueConsensus_ == address(0) ||
            issueConsensus_.code.length == 0
        ) revert InvalidTerms();
        market = market_;
        issueConsensus = issueConsensus_;
        configurationAuthority = address(0);
        emit Configured(market_, issueConsensus_);
    }

    function approveMatureIssue(IssueTerms calldata issue) external {
        if (msg.sender != issueConsensus || !ledger.mature()) {
            revert Unauthorized();
        }
        _validate(issue);
        bytes32 hash = termsHash(issue);
        if (matureApproval[hash]) revert InvalidTerms();
        matureApproval[hash] = true;
        emit MatureIssueApproved(hash, issue.issueId);
    }

    function consume(
        IssueTerms calldata issue,
        uint128 requestedBudget,
        bytes32[] calldata bootstrapProof
    ) external override {
        if (msg.sender != market) revert Unauthorized();
        _validate(issue);
        if (
            requestedBudget == 0 ||
            requestedBudget > issue.candidateBudgetCap
        ) revert ExposureExceeded();
        bytes32 hash = termsHash(issue);
        bool bootstrapAllowed = MerkleProof.verifyCalldata(
            bootstrapProof,
            bootstrapRoot,
            hash
        );
        if (
            !bootstrapAllowed &&
            (!ledger.mature() || !matureApproval[hash])
        ) revert Unauthorized();

        Usage storage current = usage[issue.issueId];
        if (current.termsHash == bytes32(0)) current.termsHash = hash;
        else if (current.termsHash != hash) revert InvalidTerms();
        if (
            current.candidates >= issue.maxCandidates ||
            uint256(current.committedBudget) + requestedBudget >
                issue.totalBudgetCap
        ) revert ExposureExceeded();
        current.candidates++;
        current.committedBudget += requestedBudget;
        emit IssueConsumed(
            issue.issueId,
            hash,
            requestedBudget,
            current.candidates
        );
    }

    function _validate(IssueTerms calldata issue) internal view {
        if (
            issue.issueId == bytes32(0) ||
            issue.specificationHash == bytes32(0) ||
            issue.verifierCodehash == bytes32(0) ||
            issue.candidateBudgetCap == 0 ||
            issue.totalBudgetCap < issue.candidateBudgetCap ||
            issue.maxCandidates == 0 ||
            (issue.funding != 2 && issue.funding != 3) ||
            issue.expiresAt <= block.timestamp
        ) revert InvalidTerms();
    }
}
