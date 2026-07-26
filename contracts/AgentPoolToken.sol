// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @notice Fixed-supply governance and settlement token for AgentPool.
contract AgentPoolToken is ERC20, ERC20Burnable, ERC20Permit, ERC20Votes {
    uint256 public constant MAX_SUPPLY = 1_000_000_000_000;
    uint256 public constant BENCHMARK_REWARD_ALLOCATION = 400_000_000_000;
    uint256 public constant ECOSYSTEM_ALLOCATION = 200_000_000_000;
    uint256 public constant OPERATIONS_ALLOCATION = 100_000_000_000;
    uint256 public constant VALIDATOR_ALLOCATION = 60_000_000_000;
    uint256 public constant AUTHOR_ALLOCATION = 40_000_000_000;
    uint256 public constant LIQUIDITY_ALLOCATION = 100_000_000_000;
    uint256 public constant FOUNDER_ALLOCATION = 50_000_000_000;
    uint256 public constant SECURITY_ALLOCATION = 50_000_000_000;

    error ZeroAllocationWallet();
    error DuplicateAllocationWallet();

    constructor(
        address benchmarkRewardVault,
        address ecosystemTreasury,
        address operationsTreasury,
        address validatorTreasury,
        address authorTreasury,
        address liquidityTreasury,
        address founderVesting,
        address securityTreasury
    ) ERC20("AgentPool", "APOOL") ERC20Permit("AgentPool") {
        if (
            benchmarkRewardVault == address(0) ||
            ecosystemTreasury == address(0) ||
            operationsTreasury == address(0) ||
            validatorTreasury == address(0) ||
            authorTreasury == address(0) ||
            liquidityTreasury == address(0) ||
            founderVesting == address(0) ||
            securityTreasury == address(0)
        ) revert ZeroAllocationWallet();
        address[8] memory wallets = [
            benchmarkRewardVault,
            ecosystemTreasury,
            operationsTreasury,
            validatorTreasury,
            authorTreasury,
            liquidityTreasury,
            founderVesting,
            securityTreasury
        ];
        for (uint256 i = 0; i < wallets.length; i++) {
            for (uint256 j = i + 1; j < wallets.length; j++) {
                if (wallets[i] == wallets[j]) revert DuplicateAllocationWallet();
            }
        }

        _mint(benchmarkRewardVault, BENCHMARK_REWARD_ALLOCATION);
        _mint(ecosystemTreasury, ECOSYSTEM_ALLOCATION);
        _mint(operationsTreasury, OPERATIONS_ALLOCATION);
        _mint(validatorTreasury, VALIDATOR_ALLOCATION);
        _mint(authorTreasury, AUTHOR_ALLOCATION);
        _mint(liquidityTreasury, LIQUIDITY_ALLOCATION);
        _mint(founderVesting, FOUNDER_ALLOCATION);
        _mint(securityTreasury, SECURITY_ALLOCATION);
        assert(totalSupply() == MAX_SUPPLY);
    }

    /// @dev APOOL is intentionally displayed and settled as whole units.
    function decimals() public pure override returns (uint8) {
        return 0;
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
