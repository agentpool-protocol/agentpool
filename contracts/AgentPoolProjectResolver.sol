// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IAgentPoolProjectEscrow} from "./interfaces/IAgentPoolProjectEscrow.sol";

/// @notice Three-of-five reproducible validation receipts for project leaf tasks.
contract AgentPoolProjectResolver is Ownable, EIP712 {
    uint8 public constant VALIDATOR_COUNT = 5;
    uint8 public constant VALIDATOR_QUORUM = 3;
    bytes32 public constant RESOLUTION_TYPEHASH = keccak256(
        "TaskResolution(uint256 taskId,uint8 outcome,bytes32 evidenceHash,uint32 policyVersion,uint64 expiresAt)"
    );

    struct TaskResolution {
        uint256 taskId;
        uint8 outcome;
        bytes32 evidenceHash;
        uint32 policyVersion;
        uint64 expiresAt;
    }

    IAgentPoolProjectEscrow public projectEscrow;
    uint32 public policyVersion;
    mapping(address => bool) public isValidator;
    mapping(bytes32 => bool) public consumedReceipt;

    event ProjectEscrowConfigured(address indexed projectEscrow);
    event ValidatorReplaced(address indexed previousValidator, address indexed newValidator);
    event PolicyVersionUpdated(uint32 indexed policyVersion);
    event TaskResolutionSubmitted(
        uint256 indexed taskId,
        uint8 outcome,
        bytes32 indexed evidenceHash
    );

    error InvalidConfiguration();
    error InvalidResolution();
    error InvalidSignatures();
    error AlreadyConfigured();
    error AlreadyConsumed();

    constructor(
        address governance,
        address[VALIDATOR_COUNT] memory validators,
        uint32 initialPolicyVersion
    ) Ownable(governance) EIP712("AgentPool Project Resolver", "2") {
        if (governance == address(0) || initialPolicyVersion == 0) {
            revert InvalidConfiguration();
        }
        for (uint256 index = 0; index < VALIDATOR_COUNT; index++) {
            address validator = validators[index];
            if (validator == address(0)) revert InvalidConfiguration();
            for (uint256 prior = 0; prior < index; prior++) {
                if (validators[prior] == validator) revert InvalidConfiguration();
            }
            isValidator[validator] = true;
        }
        policyVersion = initialPolicyVersion;
    }

    function configureProjectEscrow(IAgentPoolProjectEscrow escrow) external onlyOwner {
        if (address(projectEscrow) != address(0)) revert AlreadyConfigured();
        if (address(escrow) == address(0)) revert InvalidConfiguration();
        projectEscrow = escrow;
        emit ProjectEscrowConfigured(address(escrow));
    }

    function resolve(TaskResolution calldata resolution, bytes[] calldata signatures)
        external
    {
        if (address(projectEscrow) == address(0)) revert InvalidConfiguration();
        if (
            resolution.taskId == 0 ||
            resolution.outcome > 2 ||
            resolution.evidenceHash == bytes32(0) ||
            resolution.policyVersion != policyVersion ||
            resolution.expiresAt < block.timestamp
        ) revert InvalidResolution();
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RESOLUTION_TYPEHASH,
                    resolution.taskId,
                    resolution.outcome,
                    resolution.evidenceHash,
                    resolution.policyVersion,
                    resolution.expiresAt
                )
            )
        );
        if (consumedReceipt[digest]) revert AlreadyConsumed();
        address[] memory validators = _verifyQuorum(digest, signatures);
        consumedReceipt[digest] = true;
        projectEscrow.resolveTask(resolution.taskId, resolution.outcome, validators);
        emit TaskResolutionSubmitted(
            resolution.taskId,
            resolution.outcome,
            resolution.evidenceHash
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

    function updatePolicyVersion(uint32 newPolicyVersion) external onlyOwner {
        if (newPolicyVersion <= policyVersion) revert InvalidConfiguration();
        policyVersion = newPolicyVersion;
        emit PolicyVersionUpdated(newPolicyVersion);
    }

    function resolutionDigest(TaskResolution calldata resolution)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RESOLUTION_TYPEHASH,
                    resolution.taskId,
                    resolution.outcome,
                    resolution.evidenceHash,
                    resolution.policyVersion,
                    resolution.expiresAt
                )
            )
        );
    }

    function _verifyQuorum(bytes32 digest, bytes[] calldata signatures)
        internal
        view
        returns (address[] memory validators)
    {
        if (signatures.length != VALIDATOR_QUORUM) revert InvalidSignatures();
        validators = new address[](VALIDATOR_QUORUM);
        for (uint256 index = 0; index < VALIDATOR_QUORUM; index++) {
            address signer = ECDSA.recoverCalldata(digest, signatures[index]);
            if (!isValidator[signer]) revert InvalidSignatures();
            for (uint256 prior = 0; prior < index; prior++) {
                if (validators[prior] == signer) revert InvalidSignatures();
            }
            validators[index] = signer;
        }
    }
}
