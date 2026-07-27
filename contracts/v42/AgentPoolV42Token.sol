// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Zero-premint test token whose only issuance path is the immutable
///         v4.2 improvement kernel.
contract AgentPoolV42Token is ERC20 {
    uint256 public constant MAX_SUPPLY = 1_000_000_000_000 ether;

    address public immutable genesisConfigurator;
    address public improvementKernel;

    error Unauthorized();
    error AlreadyConfigured();
    error InvalidKernel();
    error SupplyCapExceeded();

    constructor(address genesisConfigurator_)
        ERC20("AgentPool Improvement Test", "tAPOOL")
    {
        if (genesisConfigurator_ == address(0)) revert InvalidKernel();
        genesisConfigurator = genesisConfigurator_;
    }

    function setImprovementKernel(address kernel) external {
        if (msg.sender != genesisConfigurator) revert Unauthorized();
        if (improvementKernel != address(0)) revert AlreadyConfigured();
        if (kernel == address(0) || kernel.code.length == 0) {
            revert InvalidKernel();
        }
        improvementKernel = kernel;
    }

    function mint(address recipient, uint256 amount) external {
        if (msg.sender != improvementKernel) revert Unauthorized();
        if (
            recipient == address(0) ||
            amount == 0 ||
            totalSupply() + amount > MAX_SUPPLY
        ) revert SupplyCapExceeded();
        _mint(recipient, amount);
    }
}
