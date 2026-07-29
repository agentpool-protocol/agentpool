// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IAgentPoolV43EpochVault
} from "../../v43/interfaces/IAgentPoolV43EpochVault.sol";
import {
    IAgentPoolV43Token
} from "../../v43/interfaces/IAgentPoolV43Token.sol";

/// @notice Local-rehearsal-only caller used to prove that the configured
///         EpochVault can mint while an arbitrary contract cannot.
contract AgentPoolV44EpochVaultHarness {
    function reserve(
        IAgentPoolV43EpochVault vault,
        bytes32 reservationId,
        uint128 amount
    ) external {
        vault.reserve(reservationId, amount);
    }

    function settle(
        IAgentPoolV43EpochVault vault,
        bytes32 reservationId,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external returns (uint256 paid) {
        return vault.settle(reservationId, recipients, amounts);
    }

    function release(
        IAgentPoolV43EpochVault vault,
        bytes32 reservationId
    ) external returns (uint256 released) {
        return vault.release(reservationId);
    }

    function attemptDirectMint(
        IAgentPoolV43Token token,
        address recipient,
        uint256 amount
    ) external {
        token.mint(recipient, amount);
    }
}
