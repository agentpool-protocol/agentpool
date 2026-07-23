// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @notice Capped 520-week distribution vault. It transfers pre-funded APOOL and cannot mint.
contract AgentPoolMiningVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant EPOCHS = 520;
    uint256 public constant MINING_CAP = 500_000_000 ether;
    uint64 public constant EPOCH_DURATION = 7 days;
    uint64 public constant ROOT_CHALLENGE_PERIOD = 48 hours;
    uint64 public constant CLAIM_DELAY = 7 days;

    struct Epoch {
        uint128 budget;
        uint64 proposedAt;
        bytes32 rewardRoot;
        bytes32 evidenceHash;
        uint128 claimedAmount;
        bool challenged;
        bool finalized;
    }

    IERC20 public immutable apool;
    uint64 public immutable genesis;
    address public rootPublisher;
    uint256 public configuredBudget;
    mapping(uint16 => Epoch) public epochs;
    mapping(uint16 => mapping(address => bool)) public claimed;

    event EpochConfigured(uint16 indexed epoch, uint256 budget);
    event RootProposed(uint16 indexed epoch, bytes32 indexed root, bytes32 evidenceHash);
    event RootChallenged(uint16 indexed epoch, address indexed challenger, bytes32 evidenceHash);
    event RootResolved(uint16 indexed epoch, bool accepted, bytes32 replacementRoot);
    event RewardClaimed(uint16 indexed epoch, address indexed account, uint256 amount);
    event RootPublisherChanged(address indexed oldPublisher, address indexed newPublisher);

    error InvalidEpoch();
    error BudgetCapExceeded();
    error Unauthorized();
    error InvalidPhase();
    error InvalidProof();
    error EpochBudgetExceeded();

    constructor(IERC20 token, address governance, address rootPublisher_, uint64 genesis_)
        Ownable(governance)
    {
        if (address(token) == address(0) || rootPublisher_ == address(0) || genesis_ == 0) {
            revert Unauthorized();
        }
        apool = token;
        rootPublisher = rootPublisher_;
        genesis = genesis_;
    }

    function setRootPublisher(address newPublisher) external onlyOwner {
        if (newPublisher == address(0)) revert Unauthorized();
        address oldPublisher = rootPublisher;
        rootPublisher = newPublisher;
        emit RootPublisherChanged(oldPublisher, newPublisher);
    }

    function configureEpoch(uint16 epoch, uint128 budget) external onlyOwner {
        _configureEpoch(epoch, budget);
    }

    function configureEpochs(uint16 startEpoch, uint128[] calldata budgets) external onlyOwner {
        if (uint256(startEpoch) + budgets.length > EPOCHS) revert InvalidEpoch();
        for (uint256 index = 0; index < budgets.length; index++) {
            _configureEpoch(uint16(uint256(startEpoch) + index), budgets[index]);
        }
    }

    function _configureEpoch(uint16 epoch, uint128 budget) internal {
        if (epoch >= EPOCHS || budget == 0 || epochs[epoch].budget != 0) revert InvalidEpoch();
        configuredBudget += budget;
        if (configuredBudget > MINING_CAP) revert BudgetCapExceeded();
        epochs[epoch].budget = budget;
        emit EpochConfigured(epoch, budget);
    }

    function proposeRoot(uint16 epoch, bytes32 root, bytes32 evidenceHash) external {
        if (msg.sender != rootPublisher) revert Unauthorized();
        Epoch storage data = epochs[epoch];
        if (
            data.budget == 0 ||
            root == bytes32(0) ||
            evidenceHash == bytes32(0) ||
            block.timestamp < epochEnd(epoch) ||
            data.proposedAt != 0
        ) revert InvalidPhase();
        data.rewardRoot = root;
        data.evidenceHash = evidenceHash;
        data.proposedAt = uint64(block.timestamp);
        emit RootProposed(epoch, root, evidenceHash);
    }

    function challengeRoot(uint16 epoch, bytes32 evidenceHash) external {
        Epoch storage data = epochs[epoch];
        if (
            data.proposedAt == 0 ||
            block.timestamp >= data.proposedAt + ROOT_CHALLENGE_PERIOD ||
            data.challenged ||
            evidenceHash == bytes32(0)
        ) revert InvalidPhase();
        data.challenged = true;
        emit RootChallenged(epoch, msg.sender, evidenceHash);
    }

    function finalizeUnchallenged(uint16 epoch) external {
        Epoch storage data = epochs[epoch];
        if (
            data.proposedAt == 0 ||
            data.challenged ||
            data.finalized ||
            block.timestamp < data.proposedAt + ROOT_CHALLENGE_PERIOD
        ) revert InvalidPhase();
        data.finalized = true;
        emit RootResolved(epoch, true, data.rewardRoot);
    }

    function resolveChallenge(uint16 epoch, bool accepted, bytes32 replacementRoot) external onlyOwner {
        Epoch storage data = epochs[epoch];
        if (!data.challenged || data.finalized) revert InvalidPhase();
        if (!accepted && replacementRoot == bytes32(0)) revert InvalidProof();
        if (!accepted) data.rewardRoot = replacementRoot;
        data.finalized = true;
        emit RootResolved(epoch, accepted, data.rewardRoot);
    }

    function claim(uint16 epoch, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        Epoch storage data = epochs[epoch];
        if (
            !data.finalized ||
            claimed[epoch][msg.sender] ||
            amount == 0 ||
            block.timestamp < data.proposedAt + ROOT_CHALLENGE_PERIOD + CLAIM_DELAY
        ) revert InvalidPhase();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, amount))));
        if (!MerkleProof.verify(proof, data.rewardRoot, leaf)) revert InvalidProof();
        uint256 newClaimedAmount = uint256(data.claimedAmount) + amount;
        if (newClaimedAmount > data.budget) revert EpochBudgetExceeded();
        data.claimedAmount = uint128(newClaimedAmount);
        claimed[epoch][msg.sender] = true;
        apool.safeTransfer(msg.sender, amount);
        emit RewardClaimed(epoch, msg.sender, amount);
    }

    function epochEnd(uint16 epoch) public view returns (uint256) {
        if (epoch >= EPOCHS) revert InvalidEpoch();
        return uint256(genesis) + (uint256(epoch) + 1) * EPOCH_DURATION;
    }
}
