// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IAgentPoolV42ImprovementVerifier
} from "./interfaces/IAgentPoolV42ImprovementVerifier.sol";

/// @notice Deterministic bootstrap verifier used by the public testnet.
/// @dev Production verifier implementations should replay a sandboxed test
///      transcript or verify a succinct proof. This implementation intentionally
///      accepts only precommitted digests and cannot influence settlement.
contract AgentPoolV42HashImprovementVerifier is
    IAgentPoolV42ImprovementVerifier
{
    function verifyIssue(
        bytes32 issueHash,
        bytes32 evidenceHash,
        address reproducer,
        bytes calldata proof
    ) external pure returns (bool) {
        return
            keccak256(abi.encode(issueHash, reproducer, keccak256(proof))) ==
            evidenceHash;
    }

    function scoreCandidate(
        bytes32 issueHash,
        bytes32 codeHash,
        bytes32 manifestHash,
        bytes32 deliveryHash,
        address author,
        bytes calldata proof
    ) external pure returns (uint16 scoreBps) {
        if (
            keccak256(
                abi.encode(
                    issueHash,
                    codeHash,
                    manifestHash,
                    author,
                    keccak256(proof)
                )
            ) != deliveryHash
        ) return 0;
        return 10_000;
    }
}
