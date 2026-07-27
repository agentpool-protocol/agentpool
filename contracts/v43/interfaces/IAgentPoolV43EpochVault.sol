// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoolV43EpochVault {
    function reserve(bytes32 reservationId, uint128 amount) external;

    function settle(
        bytes32 reservationId,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external returns (uint256 paid);

    function release(bytes32 reservationId) external returns (uint256 released);
}
