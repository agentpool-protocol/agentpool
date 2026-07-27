// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoolV43ContributionLedger {
    function currentEpoch() external view returns (uint64);

    function operatorGroup(address agent) external view returns (bytes32);

    function isActiveSource(address source) external view returns (bool);

    function totalSuccessfulAt(
        uint64 endEpoch,
        uint8 lookback
    ) external view returns (uint256);

    function votingPowerAt(
        address agent,
        uint64 endEpoch,
        uint8 lookback
    ) external view returns (uint256);

    function setSource(address source, bool active) external;
}
