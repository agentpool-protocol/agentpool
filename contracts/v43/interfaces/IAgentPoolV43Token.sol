// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPoolV43Token {
    function MAX_SUPPLY() external view returns (uint256);

    function totalSupply() external view returns (uint256);

    function mint(address recipient, uint256 amount) external;
}
