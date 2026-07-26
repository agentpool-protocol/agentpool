// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Immediate APOOL rewards for deterministic AI benchmarks.
/// @dev Rewards are released from the fixed 400B reserve; this contract never mints.
contract AgentPoolBenchmarkRewardVault is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint8 public constant VALIDATOR_COUNT = 5;
    uint8 public constant VALIDATOR_QUORUM = 3;
    uint16 public constant MIN_ACCURACY_BPS = 8_000;
    uint16 public constant MAX_EFFICIENCY_BONUS_BPS = 2_000;
    uint16 public constant ACCOUNT_DAILY_CAP_BPS = 50; // 0.5%
    uint256 public constant YEAR_ONE_DAILY_CAP = 204_670_000;
    uint16 public constant ANNUAL_DECAY_BPS = 1_500;
    uint8 public constant REWARD_YEARS = 10;

    bytes32 public constant TRACK_CODE = keccak256("code");
    bytes32 public constant TRACK_DATA = keccak256("data");
    bytes32 public constant TRACK_MATH = keccak256("math");
    bytes32 public constant LEAGUE_CONTAINER = keccak256("container");
    bytes32 public constant LEAGUE_API = keccak256("api");
    bytes32 public constant REWARD_RECEIPT_TYPEHASH = keccak256(
        "RewardReceipt(bytes32 challengeId,bytes32 submissionHash,bytes32 minerId,address recipient,bytes32 trackId,bytes32 leagueId,uint32 policyVersion,uint16 accuracyBps,uint16 efficiencyBps,uint128 baseReward,uint128 reward,uint64 day,uint64 expiresAt)"
    );

    struct RewardReceipt {
        bytes32 challengeId;
        bytes32 submissionHash;
        bytes32 minerId;
        address recipient;
        bytes32 trackId;
        bytes32 leagueId;
        uint32 policyVersion;
        uint16 accuracyBps;
        uint16 efficiencyBps;
        uint128 baseReward;
        uint128 reward;
        uint64 day;
        uint64 expiresAt;
    }

    IERC20 public apool;
    uint64 public immutable genesis;
    uint32 public policyVersion;
    uint256 public dailyCap;
    mapping(address => bool) public isValidator;
    mapping(bytes32 => bool) public claimedChallenge;
    mapping(uint64 => uint256) public spentByDay;
    mapping(uint64 => mapping(address => uint256)) public spentByRecipient;
    mapping(uint64 => mapping(bytes32 => uint256)) public spentByBucket;

    event BenchmarkRewardClaimed(
        bytes32 indexed challengeId,
        bytes32 indexed minerId,
        address indexed recipient,
        bytes32 trackId,
        bytes32 leagueId,
        uint256 reward
    );
    event ValidatorReplaced(address indexed previousValidator, address indexed newValidator);
    event PolicyUpdated(uint32 indexed policyVersion, uint256 dailyCap);
    event TokenConfigured(address indexed token);

    error InvalidConfiguration();
    error InvalidReceipt();
    error InvalidSignatures();
    error RewardCapExceeded();
    error AlreadyClaimed();
    error MiningNotStarted();
    error TokenAlreadyConfigured();

    constructor(
        address governance,
        address[VALIDATOR_COUNT] memory validators,
        uint64 genesisTimestamp,
        uint32 initialPolicyVersion,
        uint256 initialDailyCap
    ) Ownable(governance) EIP712("AgentPool Benchmark Mining", "2") {
        if (
            governance == address(0) ||
            genesisTimestamp == 0 ||
            initialPolicyVersion == 0 ||
            initialDailyCap == 0 ||
            initialDailyCap > YEAR_ONE_DAILY_CAP
        ) revert InvalidConfiguration();
        for (uint256 index = 0; index < VALIDATOR_COUNT; index++) {
            address validator = validators[index];
            if (validator == address(0)) revert InvalidConfiguration();
            for (uint256 prior = 0; prior < index; prior++) {
                if (validators[prior] == validator) revert InvalidConfiguration();
            }
            isValidator[validator] = true;
        }
        genesis = genesisTimestamp;
        policyVersion = initialPolicyVersion;
        dailyCap = initialDailyCap;
    }

    function configureToken(IERC20 token) external onlyOwner {
        if (address(apool) != address(0)) revert TokenAlreadyConfigured();
        if (address(token) == address(0)) revert InvalidConfiguration();
        apool = token;
        emit TokenConfigured(address(token));
    }

    function claim(RewardReceipt calldata receipt, bytes[] calldata signatures)
        external
        nonReentrant
    {
        if (block.timestamp < genesis) revert MiningNotStarted();
        if (address(apool) == address(0)) revert InvalidConfiguration();
        if (claimedChallenge[receipt.challengeId]) revert AlreadyClaimed();
        uint64 currentDay = uint64((block.timestamp - genesis) / 1 days);
        if (
            receipt.challengeId == bytes32(0) ||
            receipt.submissionHash == bytes32(0) ||
            receipt.minerId == bytes32(0) ||
            receipt.recipient == address(0) ||
            receipt.policyVersion != policyVersion ||
            receipt.day != currentDay ||
            receipt.expiresAt < block.timestamp ||
            receipt.accuracyBps < MIN_ACCURACY_BPS ||
            receipt.accuracyBps > 10_000 ||
            receipt.efficiencyBps > MAX_EFFICIENCY_BONUS_BPS ||
            receipt.baseReward == 0 ||
            receipt.reward == 0 ||
            !_validTrack(receipt.trackId) ||
            !_validLeague(receipt.leagueId)
        ) revert InvalidReceipt();
        uint256 calculatedReward =
            uint256(receipt.baseReward) *
            (uint256(receipt.accuracyBps) + receipt.efficiencyBps) /
            10_000;
        if (calculatedReward != receipt.reward) revert InvalidReceipt();

        bytes32 digest = _hashTypedDataV4(_receiptHash(receipt));
        _verifyQuorum(digest, signatures);
        _consumeCaps(receipt, currentDay);
        claimedChallenge[receipt.challengeId] = true;
        apool.safeTransfer(receipt.recipient, receipt.reward);
        emit BenchmarkRewardClaimed(
            receipt.challengeId,
            receipt.minerId,
            receipt.recipient,
            receipt.trackId,
            receipt.leagueId,
            receipt.reward
        );
    }

    function replaceValidator(address previousValidator, address newValidator) external onlyOwner {
        if (
            !isValidator[previousValidator] ||
            newValidator == address(0) ||
            isValidator[newValidator]
        ) revert InvalidConfiguration();
        isValidator[previousValidator] = false;
        isValidator[newValidator] = true;
        emit ValidatorReplaced(previousValidator, newValidator);
    }

    function updatePolicy(uint32 newPolicyVersion, uint256 newDailyCap) external onlyOwner {
        if (
            newPolicyVersion <= policyVersion ||
            newDailyCap == 0 ||
            newDailyCap > YEAR_ONE_DAILY_CAP
        ) revert InvalidConfiguration();
        policyVersion = newPolicyVersion;
        dailyCap = newDailyCap;
        emit PolicyUpdated(newPolicyVersion, newDailyCap);
    }

    function bucketDailyCap(bytes32 trackId, bytes32 leagueId)
        public
        view
        returns (uint256)
    {
        if (block.timestamp < genesis) return 0;
        uint64 currentDay = uint64((block.timestamp - genesis) / 1 days);
        return bucketDailyCapForDay(trackId, leagueId, currentDay);
    }

    function bucketDailyCapForDay(bytes32 trackId, bytes32 leagueId, uint64 day)
        public
        view
        returns (uint256)
    {
        uint256 trackBps;
        if (trackId == TRACK_CODE) trackBps = 4_000;
        else if (trackId == TRACK_DATA || trackId == TRACK_MATH) trackBps = 3_000;
        else return 0;
        if (!_validLeague(leagueId)) return 0;
        return effectiveDailyCap(day) * trackBps * 5_000 / 100_000_000;
    }

    function effectiveDailyCap(uint64 day) public view returns (uint256) {
        uint256 year = uint256(day) / 365;
        if (year >= REWARD_YEARS) return 0;
        uint256 curveCap = YEAR_ONE_DAILY_CAP;
        for (uint256 cursor = 0; cursor < year; cursor++) {
            curveCap = curveCap * (10_000 - ANNUAL_DECAY_BPS) / 10_000;
        }
        return dailyCap < curveCap ? dailyCap : curveCap;
    }

    function receiptDigest(RewardReceipt calldata receipt) external view returns (bytes32) {
        return _hashTypedDataV4(_receiptHash(receipt));
    }

    function _consumeCaps(RewardReceipt calldata receipt, uint64 currentDay) internal {
        uint256 reward = receipt.reward;
        uint256 dayCap = effectiveDailyCap(currentDay);
        uint256 daySpent = spentByDay[currentDay] + reward;
        uint256 accountSpent = spentByRecipient[currentDay][receipt.recipient] + reward;
        bytes32 bucket = keccak256(abi.encode(receipt.trackId, receipt.leagueId));
        uint256 bucketSpent = spentByBucket[currentDay][bucket] + reward;
        if (
            dayCap == 0 ||
            daySpent > dayCap ||
            accountSpent > dayCap * ACCOUNT_DAILY_CAP_BPS / 10_000 ||
            bucketSpent > bucketDailyCapForDay(
                receipt.trackId,
                receipt.leagueId,
                currentDay
            )
        ) revert RewardCapExceeded();
        spentByDay[currentDay] = daySpent;
        spentByRecipient[currentDay][receipt.recipient] = accountSpent;
        spentByBucket[currentDay][bucket] = bucketSpent;
    }

    function _verifyQuorum(bytes32 digest, bytes[] calldata signatures) internal view {
        if (signatures.length != VALIDATOR_QUORUM) revert InvalidSignatures();
        address[VALIDATOR_QUORUM] memory recovered;
        for (uint256 index = 0; index < VALIDATOR_QUORUM; index++) {
            address signer = ECDSA.recoverCalldata(digest, signatures[index]);
            if (!isValidator[signer]) revert InvalidSignatures();
            for (uint256 prior = 0; prior < index; prior++) {
                if (recovered[prior] == signer) revert InvalidSignatures();
            }
            recovered[index] = signer;
        }
    }

    function _receiptHash(RewardReceipt calldata receipt) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                REWARD_RECEIPT_TYPEHASH,
                receipt.challengeId,
                receipt.submissionHash,
                receipt.minerId,
                receipt.recipient,
                receipt.trackId,
                receipt.leagueId,
                receipt.policyVersion,
                receipt.accuracyBps,
                receipt.efficiencyBps,
                receipt.baseReward,
                receipt.reward,
                receipt.day,
                receipt.expiresAt
            )
        );
    }

    function _validTrack(bytes32 trackId) internal pure returns (bool) {
        return trackId == TRACK_CODE || trackId == TRACK_DATA || trackId == TRACK_MATH;
    }

    function _validLeague(bytes32 leagueId) internal pure returns (bool) {
        return leagueId == LEAGUE_CONTAINER || leagueId == LEAGUE_API;
    }
}
