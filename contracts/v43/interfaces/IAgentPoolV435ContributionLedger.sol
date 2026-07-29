// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IAgentPoolV43ContributionLedger
} from "./IAgentPoolV43ContributionLedger.sol";

/// @notice Read-only phase counters exposed by the v4.3 contribution ledger.
///         The existing ledger already implements these getters through its
///         public state variables.
interface IAgentPoolV435ContributionLedger is
    IAgentPoolV43ContributionLedger
{
    function eligibleAgentCount() external view returns (uint32);

    function eligibleGroupCount() external view returns (uint32);

    function activeEpochCount() external view returns (uint16);

    function successfulSettlementCount() external view returns (uint64);
}
