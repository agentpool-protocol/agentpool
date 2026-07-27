// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentPoolV43CapacityRegistry} from "./interfaces/IAgentPoolV43CapacityRegistry.sol";

/// @notice Agent-declared capacity with expiring offers. Only the TaskMarket
///         can create holds, and anyone may clear an expired offer.
contract AgentPoolV43CapacityRegistry is IAgentPoolV43CapacityRegistry {
    struct Offer {
        uint32 capacity;
        uint32 held;
        uint64 expiresAt;
        bytes32 runtimeHash;
    }

    struct Hold {
        address agent;
        bytes32 capability;
        uint32 units;
        bool active;
    }

    address public configurationAuthority;
    address public market;
    mapping(address => mapping(bytes32 => Offer)) public offers;
    mapping(bytes32 => Hold) public holds;

    event MarketConfigured(address indexed market);
    event CapacityPublished(
        address indexed agent,
        bytes32 indexed capability,
        uint32 capacity,
        uint64 expiresAt,
        bytes32 runtimeHash
    );
    event CapacityReserved(
        bytes32 indexed reservationId,
        address indexed agent,
        uint32 units
    );
    event CapacityReleased(bytes32 indexed reservationId);

    error Unauthorized();
    error InvalidTerms();
    error AlreadyConfigured();
    error CapacityExceeded();

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

    function publish(
        bytes32 capability,
        uint32 capacity,
        uint64 expiresAt,
        bytes32 runtimeHash
    ) external {
        Offer storage current = offers[msg.sender][capability];
        if (
            capability == bytes32(0) ||
            capacity == 0 ||
            capacity < current.held ||
            expiresAt <= block.timestamp ||
            runtimeHash == bytes32(0)
        ) revert InvalidTerms();
        current.capacity = capacity;
        current.expiresAt = expiresAt;
        current.runtimeHash = runtimeHash;
        emit CapacityPublished(
            msg.sender,
            capability,
            capacity,
            expiresAt,
            runtimeHash
        );
    }

    function reserve(
        bytes32 reservationId,
        address agent,
        bytes32 capability,
        uint32 units
    ) external override {
        if (msg.sender != market) revert Unauthorized();
        Offer storage offer = offers[agent][capability];
        if (
            reservationId == bytes32(0) ||
            holds[reservationId].active ||
            units == 0 ||
            offer.expiresAt < block.timestamp
        ) revert InvalidTerms();
        if (uint256(offer.held) + units > offer.capacity) {
            revert CapacityExceeded();
        }
        offer.held += units;
        holds[reservationId] = Hold({
            agent: agent,
            capability: capability,
            units: units,
            active: true
        });
        emit CapacityReserved(reservationId, agent, units);
    }

    function release(bytes32 reservationId) external override {
        if (msg.sender != market) revert Unauthorized();
        Hold storage hold = holds[reservationId];
        if (!hold.active) revert InvalidTerms();
        hold.active = false;
        offers[hold.agent][hold.capability].held -= hold.units;
        emit CapacityReleased(reservationId);
    }
}
