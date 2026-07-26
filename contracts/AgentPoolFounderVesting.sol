// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {VestingWalletCliff} from "@openzeppelin/contracts/finance/VestingWalletCliff.sol";

/// @notice Founder allocation: 12-month cliff and 48-month linear vesting.
contract AgentPoolFounderVesting is VestingWalletCliff {
    uint64 public constant CLIFF_DURATION = 365 days;
    uint64 public constant VESTING_DURATION = 4 * 365 days;

    constructor(address beneficiary, uint64 startTimestamp)
        VestingWallet(beneficiary, startTimestamp, VESTING_DURATION)
        VestingWalletCliff(CLIFF_DURATION)
    {}
}
