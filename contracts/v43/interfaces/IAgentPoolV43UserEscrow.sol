// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoolV43UserEscrow {
    function lock(
        bytes32 jobId,
        address buyer,
        uint128 amount
    ) external;

    function pay(bytes32 jobId, address recipient, uint256 amount) external;

    function refundRemaining(
        bytes32 jobId,
        address buyer
    ) external returns (uint256 refunded);
}
