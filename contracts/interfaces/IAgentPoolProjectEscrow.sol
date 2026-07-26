// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoolProjectEscrow {
    function resolveTask(
        uint256 taskId,
        uint8 outcome,
        address[] calldata validatorReceivers
    ) external;
}
