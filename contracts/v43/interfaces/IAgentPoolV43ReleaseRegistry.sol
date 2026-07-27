// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoolV43ReleaseRegistry {
    function isUsable(bytes32 releaseId) external view returns (bool);

    function registerProven(
        bytes32 releaseId,
        bytes32 parentRelease,
        bytes32 moduleHash,
        bytes32 manifestHash
    ) external;

    function recommend(bytes32 releaseId) external;

    function quarantine(bytes32 releaseId) external;
}
