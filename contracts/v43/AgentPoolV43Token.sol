// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAgentPoolV43Token} from "./interfaces/IAgentPoolV43Token.sol";

/// @notice Zero-premint Base Sepolia token. Only the two immutable epoch lanes
///         selected during one-time deployment wiring can emit tAPOOL.
contract AgentPoolV43Token is ERC20, IAgentPoolV43Token {
    uint256 public constant override MAX_SUPPLY =
        1_000_000_000_000 ether;

    address public configurationAuthority;
    address public coreEpochVault;
    address public evolutionEpochVault;

    error Unauthorized();
    error InvalidTerms();
    error AlreadyConfigured();
    error SupplyCapExceeded();

    constructor(address configurationAuthority_)
        ERC20("AgentPool v4.3 Test", "tAPOOL")
    {
        if (configurationAuthority_ == address(0)) revert InvalidTerms();
        configurationAuthority = configurationAuthority_;
    }

    function configureMinters(
        address coreEpochVault_,
        address evolutionEpochVault_
    ) external {
        if (msg.sender != configurationAuthority) revert Unauthorized();
        if (
            coreEpochVault != address(0) ||
            evolutionEpochVault != address(0)
        ) revert AlreadyConfigured();
        if (
            coreEpochVault_ == address(0) ||
            evolutionEpochVault_ == address(0) ||
            coreEpochVault_ == evolutionEpochVault_ ||
            coreEpochVault_.code.length == 0 ||
            evolutionEpochVault_.code.length == 0
        ) revert InvalidTerms();
        coreEpochVault = coreEpochVault_;
        evolutionEpochVault = evolutionEpochVault_;
        configurationAuthority = address(0);
    }

    function mint(address recipient, uint256 amount) external override {
        if (
            msg.sender != coreEpochVault &&
            msg.sender != evolutionEpochVault
        ) revert Unauthorized();
        if (
            recipient == address(0) ||
            amount == 0 ||
            totalSupply() + amount > MAX_SUPPLY
        ) revert SupplyCapExceeded();
        _mint(recipient, amount);
    }

    function totalSupply()
        public
        view
        override(ERC20, IAgentPoolV43Token)
        returns (uint256)
    {
        return super.totalSupply();
    }
}
