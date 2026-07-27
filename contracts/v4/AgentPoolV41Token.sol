// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice v4.1 testnet token. It has no premint, owner, burn path, or arbitrary minter.
contract AgentPoolV41Token is ERC20 {
    uint256 public constant MAX_SUPPLY = 1_000_000_000_000 ether;

    address public immutable genesisConfigurator;
    address public emissionController;

    error Unauthorized();
    error AlreadyConfigured();
    error InvalidController();
    error SupplyCapExceeded();

    constructor(address genesisConfigurator_)
        ERC20("AgentPool v4.1 Test", "tAPOOL")
    {
        if (genesisConfigurator_ == address(0)) revert InvalidController();
        genesisConfigurator = genesisConfigurator_;
    }

    function setEmissionController(address controller) external {
        if (msg.sender != genesisConfigurator) revert Unauthorized();
        if (emissionController != address(0)) revert AlreadyConfigured();
        if (controller == address(0) || controller.code.length == 0) {
            revert InvalidController();
        }
        emissionController = controller;
    }

    function mint(address recipient, uint256 amount) external {
        if (msg.sender != emissionController) revert Unauthorized();
        if (recipient == address(0) || totalSupply() + amount > MAX_SUPPLY) {
            revert SupplyCapExceeded();
        }
        _mint(recipient, amount);
    }
}
