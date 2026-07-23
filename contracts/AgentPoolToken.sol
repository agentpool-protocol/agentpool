// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @notice Fixed-supply governance and settlement token for AgentPool.
contract AgentPoolToken is ERC20, ERC20Permit, ERC20Votes {
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;
    uint256 public constant MINING_ALLOCATION = 500_000_000 ether;
    uint256 public constant OPERATOR_ALLOCATION = 200_000_000 ether;
    uint256 public constant ECOSYSTEM_ALLOCATION = 150_000_000 ether;
    uint256 public constant LIQUIDITY_ALLOCATION = 100_000_000 ether;
    uint256 public constant SECURITY_ALLOCATION = 50_000_000 ether;

    error ZeroAllocationWallet();
    error DuplicateAllocationWallet();

    constructor(
        address miningReserve,
        address operatorWallet,
        address ecosystemTreasury,
        address liquidityTreasury,
        address securityTreasury
    ) ERC20("AgentPool", "APOOL") ERC20Permit("AgentPool") {
        if (
            miningReserve == address(0) ||
            operatorWallet == address(0) ||
            ecosystemTreasury == address(0) ||
            liquidityTreasury == address(0) ||
            securityTreasury == address(0)
        ) revert ZeroAllocationWallet();
        address[5] memory wallets = [
            miningReserve,
            operatorWallet,
            ecosystemTreasury,
            liquidityTreasury,
            securityTreasury
        ];
        for (uint256 i = 0; i < wallets.length; i++) {
            for (uint256 j = i + 1; j < wallets.length; j++) {
                if (wallets[i] == wallets[j]) revert DuplicateAllocationWallet();
            }
        }

        _mint(miningReserve, MINING_ALLOCATION);
        _mint(operatorWallet, OPERATOR_ALLOCATION);
        _delegate(operatorWallet, operatorWallet);
        _mint(ecosystemTreasury, ECOSYSTEM_ALLOCATION);
        _mint(liquidityTreasury, LIQUIDITY_ALLOCATION);
        _mint(securityTreasury, SECURITY_ALLOCATION);
        assert(totalSupply() == MAX_SUPPLY);
    }

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Votes)
    {
        super._update(from, to, value);
    }

    function nonces(address owner)
        public
        view
        override(ERC20Permit, Nonces)
        returns (uint256)
    {
        return super.nonces(owner);
    }
}
