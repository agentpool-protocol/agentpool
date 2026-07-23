// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/// @notice Agent-issued digital licenses and service credits.
contract AgentPoolLicense is ERC1155 {
    mapping(uint256 => bytes32) public termsHash;
    mapping(uint256 => bool) public transferable;
    mapping(uint256 => address) public issuer;

    event LicenseDefined(
        uint256 indexed tokenId,
        address indexed issuer,
        uint256 indexed localId,
        bytes32 licenseTermsHash,
        bool transferable
    );
    event CreditRedeemed(
        uint256 indexed tokenId,
        address indexed holder,
        address indexed issuer,
        uint256 amount,
        bytes32 requestHash
    );

    error NonTransferable();
    error TermsAlreadySet();
    error InvalidLicense();
    error UnauthorizedIssuer();

    constructor(string memory metadataUri) ERC1155(metadataUri) {}

    function tokenIdFor(address issuer_, uint256 localId) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(issuer_, localId)));
    }

    function defineLicense(uint256 localId, bytes32 licenseTermsHash, bool isTransferable)
        external
        returns (uint256 tokenId)
    {
        if (licenseTermsHash == bytes32(0)) revert InvalidLicense();
        tokenId = tokenIdFor(msg.sender, localId);
        if (termsHash[tokenId] != bytes32(0)) revert TermsAlreadySet();
        termsHash[tokenId] = licenseTermsHash;
        transferable[tokenId] = isTransferable;
        issuer[tokenId] = msg.sender;
        emit LicenseDefined(tokenId, msg.sender, localId, licenseTermsHash, isTransferable);
    }

    function issue(address recipient, uint256 tokenId, uint256 amount, bytes calldata data)
        external
    {
        if (msg.sender != issuer[tokenId]) revert UnauthorizedIssuer();
        if (recipient == address(0) || amount == 0 || termsHash[tokenId] == bytes32(0)) {
            revert InvalidLicense();
        }
        _mint(recipient, tokenId, amount, data);
    }

    function redeem(uint256 tokenId, uint256 amount, bytes32 requestHash) external {
        if (amount == 0 || requestHash == bytes32(0) || issuer[tokenId] == address(0)) {
            revert InvalidLicense();
        }
        _burn(msg.sender, tokenId, amount);
        emit CreditRedeemed(tokenId, msg.sender, issuer[tokenId], amount, requestHash);
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
