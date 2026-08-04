// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockV439GroupRegistry {
    mapping(address => bytes32) public operatorGroup;

    function setOperatorGroup(address agent, bytes32 group) external {
        operatorGroup[agent] = group;
    }
}
