// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoolV43CapacityRegistry {
    function reserve(
        bytes32 reservationId,
        address agent,
        bytes32 capability,
        uint32 units
    ) external;

    function release(bytes32 reservationId) external;
}
