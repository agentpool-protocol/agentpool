// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAgentPoolRegistry} from "./interfaces/IAgentPoolRegistry.sol";

/// @notice Wallet-owned agent identities and governance-approved verifier adapters.
contract AgentPoolRegistry is Ownable, IAgentPoolRegistry {
    struct Agent {
        address owner;
        address delegate;
        bytes32 metadataHash;
        bytes32 encryptionKeyHash;
        uint64 registeredAt;
        bool active;
    }

    struct Verifier {
        address adapter;
        bytes32 implementationHash;
        uint64 registeredAt;
        bool miningEligible;
        bool active;
    }

    mapping(bytes32 => Agent) public agents;
    mapping(address => bytes32) public ownerAgent;
    mapping(bytes32 => Verifier) public verifiers;

    event AgentRegistered(bytes32 indexed agentId, address indexed owner, address indexed delegate);
    event AgentUpdated(bytes32 indexed agentId, address indexed delegate, bytes32 metadataHash);
    event VerifierConfigured(
        bytes32 indexed verifierId,
        address indexed adapter,
        bool miningEligible,
        bool active
    );

    error AgentAlreadyRegistered();
    error OwnerAlreadyRegistered();
    error NotAgentOwner();
    error InvalidAgent();
    error InvalidVerifier();

    constructor(address governance) Ownable(governance) {}

    function registerAgent(
        bytes32 agentId,
        address delegate,
        bytes32 metadataHash,
        bytes32 encryptionKeyHash
    ) external {
        if (agentId == bytes32(0) || delegate == address(0) || encryptionKeyHash == bytes32(0)) {
            revert InvalidAgent();
        }
        if (agents[agentId].owner != address(0)) revert AgentAlreadyRegistered();
        if (ownerAgent[msg.sender] != bytes32(0)) revert OwnerAlreadyRegistered();
        agents[agentId] = Agent({
            owner: msg.sender,
            delegate: delegate,
            metadataHash: metadataHash,
            encryptionKeyHash: encryptionKeyHash,
            registeredAt: uint64(block.timestamp),
            active: true
        });
        ownerAgent[msg.sender] = agentId;
        emit AgentRegistered(agentId, msg.sender, delegate);
    }

    function updateAgent(bytes32 agentId, address delegate, bytes32 metadataHash, bytes32 encryptionKeyHash)
        external
    {
        Agent storage agent = agents[agentId];
        if (agent.owner != msg.sender) revert NotAgentOwner();
        if (delegate == address(0) || encryptionKeyHash == bytes32(0)) revert InvalidAgent();
        agent.delegate = delegate;
        agent.metadataHash = metadataHash;
        agent.encryptionKeyHash = encryptionKeyHash;
        emit AgentUpdated(agentId, delegate, metadataHash);
    }

    function configureVerifier(
        bytes32 verifierId,
        address adapter,
        bytes32 implementationHash,
        bool miningEligible,
        bool active
    ) external onlyOwner {
        if (
            verifierId == bytes32(0) ||
            adapter == address(0) ||
            implementationHash == bytes32(0)
        ) revert InvalidVerifier();
        verifiers[verifierId] = Verifier({
            adapter: adapter,
            implementationHash: implementationHash,
            registeredAt: uint64(block.timestamp),
            miningEligible: miningEligible,
            active: active
        });
        emit VerifierConfigured(verifierId, adapter, miningEligible, active);
    }

    function isAuthorized(bytes32 agentId, address account) external view returns (bool) {
        Agent memory agent = agents[agentId];
        return agent.active && (account == agent.owner || account == agent.delegate);
    }

    function isActiveVerifier(bytes32 verifierId) external view returns (bool) {
        return verifiers[verifierId].active;
    }

    function isAuthorizedVerifier(bytes32 verifierId, address account)
        external
        view
        returns (bool)
    {
        Verifier memory verifier = verifiers[verifierId];
        return verifier.active && account == verifier.adapter;
    }

    function isMiningVerifier(bytes32 verifierId) external view returns (bool) {
        Verifier memory verifier = verifiers[verifierId];
        return verifier.active && verifier.miningEligible;
    }
}
