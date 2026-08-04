// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentPoolV43Token} from "./interfaces/IAgentPoolV43Token.sol";
import {IAgentPoolV43EpochVault} from "./interfaces/IAgentPoolV43EpochVault.sol";

/// @notice Ownerless bounded emission lane. Reservations expire unminted when
///         work fails; only the configured TaskMarket may reserve and settle.
contract AgentPoolV43EpochVault is IAgentPoolV43EpochVault {
    struct Reservation {
        uint128 reserved;
        uint128 spent;
        uint64 epoch;
        bool closed;
    }

    uint64 public constant EPOCH_DURATION = 7 days;

    IAgentPoolV43Token public immutable token;
    bytes32 public immutable lane;
    uint64 public immutable genesisStart;
    uint128 public immutable weeklyCap;
    uint256 public immutable lifetimeCap;

    address public configurationAuthority;
    address public market;
    uint256 public totalEmitted;
    uint256 public totalReserved;

    mapping(uint64 => uint256) public epochEmitted;
    mapping(uint64 => uint256) public epochReserved;
    mapping(bytes32 => Reservation) public reservations;

    event MarketConfigured(address indexed market);
    event Reserved(
        bytes32 indexed reservationId,
        uint64 indexed epoch,
        uint256 amount
    );
    event Settled(bytes32 indexed reservationId, uint256 amount);
    event Released(bytes32 indexed reservationId, uint256 amount);

    error Unauthorized();
    error InvalidTerms();
    error AlreadyConfigured();
    error BudgetExceeded();
    error EmissionNotStarted();

    constructor(
        IAgentPoolV43Token token_,
        bytes32 lane_,
        uint64 genesisStart_,
        uint128 weeklyCap_,
        uint256 lifetimeCap_,
        address configurationAuthority_
    ) {
        if (
            address(token_) == address(0) ||
            lane_ == bytes32(0) ||
            genesisStart_ < block.timestamp ||
            weeklyCap_ == 0 ||
            lifetimeCap_ < weeklyCap_ ||
            configurationAuthority_ == address(0)
        ) revert InvalidTerms();
        token = token_;
        lane = lane_;
        genesisStart = genesisStart_;
        weeklyCap = weeklyCap_;
        lifetimeCap = lifetimeCap_;
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

    function currentEpoch() public view returns (uint64) {
        if (block.timestamp < genesisStart) return 0;
        return
            uint64((block.timestamp - uint256(genesisStart)) / EPOCH_DURATION);
    }

    function available(uint64 epoch) external view returns (uint256) {
        uint256 used = epochEmitted[epoch] + totalReserved;
        return used >= weeklyCap ? 0 : weeklyCap - used;
    }

    function reserve(bytes32 reservationId, uint128 amount) external override {
        if (msg.sender != market) revert Unauthorized();
        if (block.timestamp < genesisStart) revert EmissionNotStarted();
        if (
            reservationId == bytes32(0) ||
            amount == 0 ||
            reservations[reservationId].reserved != 0
        ) revert InvalidTerms();
        uint64 epoch = currentEpoch();
        if (
            epochEmitted[epoch] + totalReserved + amount > weeklyCap ||
            totalEmitted + totalReserved + amount > lifetimeCap
        ) revert BudgetExceeded();
        reservations[reservationId] = Reservation({
            reserved: amount,
            spent: 0,
            epoch: epoch,
            closed: false
        });
        epochReserved[epoch] += amount;
        totalReserved += amount;
        emit Reserved(reservationId, epoch, amount);
    }

    function settle(
        bytes32 reservationId,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external override returns (uint256 paid) {
        if (msg.sender != market) revert Unauthorized();
        if (block.timestamp < genesisStart) revert EmissionNotStarted();
        Reservation storage reservation = reservations[reservationId];
        if (
            reservation.reserved == 0 ||
            reservation.closed ||
            recipients.length == 0 ||
            recipients.length != amounts.length
        ) revert InvalidTerms();
        for (uint256 index = 0; index < amounts.length; index++) {
            if (recipients[index] == address(0) || amounts[index] == 0) {
                revert InvalidTerms();
            }
            paid += amounts[index];
        }
        uint256 remaining =
            uint256(reservation.reserved) - reservation.spent;
        if (paid > remaining) revert BudgetExceeded();
        uint64 settlementEpoch = currentEpoch();
        if (epochEmitted[settlementEpoch] + paid > weeklyCap) {
            revert BudgetExceeded();
        }
        reservation.spent += uint128(paid);
        epochReserved[reservation.epoch] -= paid;
        totalReserved -= paid;
        epochEmitted[settlementEpoch] += paid;
        totalEmitted += paid;
        for (uint256 index = 0; index < recipients.length; index++) {
            token.mint(recipients[index], amounts[index]);
        }
        emit Settled(reservationId, paid);
    }

    function release(
        bytes32 reservationId
    ) external override returns (uint256 released) {
        if (msg.sender != market) revert Unauthorized();
        Reservation storage reservation = reservations[reservationId];
        if (reservation.reserved == 0 || reservation.closed) {
            revert InvalidTerms();
        }
        released = uint256(reservation.reserved) - reservation.spent;
        reservation.closed = true;
        if (released != 0) {
            epochReserved[reservation.epoch] -= released;
            totalReserved -= released;
        }
        emit Released(reservationId, released);
    }
}
