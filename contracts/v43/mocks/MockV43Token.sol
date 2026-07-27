// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockV43Token is ERC20 {
    constructor() ERC20("Mock AgentPool", "mAPOOL") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}
