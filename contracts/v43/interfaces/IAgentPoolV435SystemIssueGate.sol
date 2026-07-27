// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IAgentPoolV432SystemIssueGate
} from "./IAgentPoolV432SystemIssueGate.sol";

interface IAgentPoolV435SystemIssueGate is
    IAgentPoolV432SystemIssueGate
{
    function transitionReady() external view returns (bool);

    function validateTransitionIssue(
        IssueTerms calldata issue
    ) external view returns (bool);

    function approveTransitionIssue(
        IssueTerms calldata issue
    ) external;
}
