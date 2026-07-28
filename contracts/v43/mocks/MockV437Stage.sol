// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockV437Stage {
    bool public transitionReady;
    bool public mature;

    function setTransitionReady(bool value) external {
        transitionReady = value;
    }

    function setMature(bool value) external {
        mature = value;
    }
}
