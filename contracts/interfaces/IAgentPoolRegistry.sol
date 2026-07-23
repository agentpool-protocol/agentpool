// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoolRegistry {
    function isActiveVerifier(bytes32 verifierId) external view returns (bool);
    function isAuthorizedVerifier(bytes32 verifierId, address account) external view returns (bool);
}
