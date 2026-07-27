// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAgentPoolV43UserEscrow} from "./interfaces/IAgentPoolV43UserEscrow.sol";

/// @notice Existing-token custody for external jobs. It cannot mint and the
///         one-time configured TaskMarket may only spend each job's deposit.
contract AgentPoolV43UserEscrowKernel is
    IAgentPoolV43UserEscrow,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    struct Deposit {
        address buyer;
        uint128 deposited;
        uint128 spent;
        bool closed;
    }

    IERC20 public immutable token;
    address public configurationAuthority;
    address public market;
    mapping(bytes32 => Deposit) public deposits;

    event MarketConfigured(address indexed market);
    event Locked(
        bytes32 indexed jobId,
        address indexed buyer,
        uint256 amount
    );
    event Paid(
        bytes32 indexed jobId,
        address indexed recipient,
        uint256 amount
    );
    event Refunded(
        bytes32 indexed jobId,
        address indexed buyer,
        uint256 amount
    );

    error Unauthorized();
    error InvalidTerms();
    error AlreadyConfigured();
    error BudgetExceeded();

    constructor(IERC20 token_, address configurationAuthority_) {
        if (
            address(token_) == address(0) ||
            configurationAuthority_ == address(0)
        ) revert InvalidTerms();
        token = token_;
        configurationAuthority = configurationAuthority_;
    }

    function configureMarket(address market_) external {
        if (msg.sender != configurationAuthority) revert Unauthorized();
        if (market != address(0)) revert AlreadyConfigured();
        if (market_ == address(0) || market_.code.length == 0) {
            revert InvalidTerms();
        }
        market = market_;
        configurationAuthority = address(0);
        emit MarketConfigured(market_);
    }

    function lock(
        bytes32 jobId,
        address buyer,
        uint128 amount
    ) external override nonReentrant {
        if (msg.sender != market) revert Unauthorized();
        if (
            jobId == bytes32(0) ||
            buyer == address(0) ||
            amount == 0 ||
            deposits[jobId].deposited != 0
        ) revert InvalidTerms();
        deposits[jobId] = Deposit({
            buyer: buyer,
            deposited: amount,
            spent: 0,
            closed: false
        });
        token.safeTransferFrom(buyer, address(this), amount);
        emit Locked(jobId, buyer, amount);
    }

    function pay(
        bytes32 jobId,
        address recipient,
        uint256 amount
    ) external override nonReentrant {
        if (msg.sender != market) revert Unauthorized();
        Deposit storage deposit = deposits[jobId];
        if (
            recipient == address(0) ||
            amount == 0 ||
            deposit.deposited == 0 ||
            deposit.closed
        ) revert InvalidTerms();
        if (uint256(deposit.spent) + amount > deposit.deposited) {
            revert BudgetExceeded();
        }
        deposit.spent += uint128(amount);
        token.safeTransfer(recipient, amount);
        emit Paid(jobId, recipient, amount);
    }

    function refundRemaining(
        bytes32 jobId,
        address buyer
    ) external override nonReentrant returns (uint256 refunded) {
        if (msg.sender != market) revert Unauthorized();
        Deposit storage deposit = deposits[jobId];
        if (
            deposit.deposited == 0 ||
            deposit.closed ||
            buyer != deposit.buyer
        ) revert InvalidTerms();
        deposit.closed = true;
        refunded = uint256(deposit.deposited) - deposit.spent;
        if (refunded != 0) token.safeTransfer(buyer, refunded);
        emit Refunded(jobId, buyer, refunded);
    }
}
