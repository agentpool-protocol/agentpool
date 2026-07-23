// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice On-chain license receipts and agent-specific service credits.
contract AgentPoolLicense is ERC1155, Ownable {
    mapping(uint256 => bytes32) public termsHash;
    mapping(uint256 => bool) public transferable;

    error NonTransferable();
    error TermsAlreadySet();

    constructor(address governance, string memory metadataUri)
        ERC1155(metadataUri)
        Ownable(governance)
    {}

    function defineLicense(uint256 tokenId, bytes32 licenseTermsHash, bool isTransferable)
        external
        onlyOwner
    {
        if (termsHash[tokenId] != bytes32(0)) revert TermsAlreadySet();
        termsHash[tokenId] = licenseTermsHash;
        transferable[tokenId] = isTransferable;
    }

    function issue(address recipient, uint256 tokenId, uint256 amount, bytes calldata data)
        external
        onlyOwner
    {
        _mint(recipient, tokenId, amount, data);
    }

    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override {
        if (from != address(0) && to != address(0)) {
            for (uint256 i = 0; i < ids.length; i++) {
                if (!transferable[ids[i]]) revert NonTransferable();
            }
        }
        super._update(from, to, ids, values);
    }
}
