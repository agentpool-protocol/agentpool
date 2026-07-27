// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentPoolV41Token} from "./AgentPoolV41Token.sol";
import {AgentPoolV41EpochVault} from "./AgentPoolV41EpochVault.sol";
import {
    IAgentPoolV41EmissionController
} from "./interfaces/IAgentPoolV41.sol";

/// @notice Immutable, permissionless emission kernel for objective protocol work.
/// @dev It has no owner, pause, fee, emergency withdrawal, or arbitrary mint path.
contract AgentPoolV41EmissionController {
    enum WorkLane {
        CAPABILITY,
        BASIC,
        SYSTEM,
        VALIDATION
    }

    struct VaultMetadata {
        uint64 epoch;
        WorkLane lane;
        bytes32 issueHash;
        bool experimentalProof;
        bool active;
    }

    uint64 public constant EPOCH_DURATION = 7 days;
    uint64 public constant GENESIS_DURATION = 180 days;
    uint64 public constant HALF_LIFE = 8 * 365 days;
    uint256 public constant WAD = 1e18;
    uint256 public constant WEEKLY_DECAY_WAD = 998_340_000_000_000_000;
    uint16 public constant CAPABILITY_CAP_BPS = 500;
    uint16 public constant EXPERIMENT_CAP_BPS = 100;
    uint16 public constant ISSUE_CAP_BPS = 1_000;

    AgentPoolV41Token public immutable token;
    address public immutable genesisConfigurator;
    address public immutable objectiveVerifier;
    uint64 public immutable genesisStart;
    uint256 public immutable genesisCap;
    uint256 public immutable genesisWeeklyCap;
    uint8 public immutable catalogQuorum;

    address public releaseRegistry;
    address public artifactRegistry;

    mapping(address => bool) public isCatalogSigner;
    mapping(address => VaultMetadata) public vaults;
    mapping(uint64 => uint256) public epochMinted;
    mapping(uint64 => uint256) public epochReserved;
    mapping(uint64 => mapping(WorkLane => uint256)) public laneMinted;
    mapping(uint64 => mapping(WorkLane => uint256)) public laneReserved;
    mapping(uint64 => uint256) public experimentalMinted;
    mapping(uint64 => uint256) public experimentalReserved;
    mapping(uint64 => mapping(bytes32 => uint256)) public issueMinted;
    mapping(uint64 => mapping(bytes32 => uint256)) public issueReserved;
    mapping(address => uint256) public vaultReserved;
    uint256 public genesisMinted;
    uint256 public genesisReserved;

    event EpochVaultCreated(
        address indexed vault,
        uint64 indexed epoch,
        WorkLane indexed lane,
        bytes32 issueHash,
        bool experimentalProof
    );
    event EmissionReserved(address indexed vault, uint64 indexed epoch, uint256 amount);
    event EmissionReleased(address indexed vault, uint64 indexed epoch, uint256 amount);
    event EmissionSettled(address indexed vault, uint64 indexed epoch, uint256 amount);

    error Unauthorized();
    error InvalidTerms();
    error AlreadyConfigured();
    error EpochCapExceeded();
    error LaneCapExceeded();
    error SupplyCapExceeded();

    constructor(
        AgentPoolV41Token token_,
        address genesisConfigurator_,
        address objectiveVerifier_,
        address[5] memory catalogSigners,
        uint8 quorum,
        uint64 genesisStart_
    ) {
        if (
            address(token_) == address(0) ||
            genesisConfigurator_ == address(0) ||
            objectiveVerifier_ == address(0) ||
            objectiveVerifier_.code.length == 0 ||
            quorum < 3 ||
            quorum > catalogSigners.length
        ) revert InvalidTerms();
        token = token_;
        genesisConfigurator = genesisConfigurator_;
        objectiveVerifier = objectiveVerifier_;
        genesisStart = genesisStart_;
        genesisCap = token_.MAX_SUPPLY() / 200;
        genesisWeeklyCap =
            (genesisCap * EPOCH_DURATION) /
            GENESIS_DURATION;
        catalogQuorum = quorum;

        address previous;
        for (uint256 index = 0; index < catalogSigners.length; index++) {
            address signer = catalogSigners[index];
            if (signer == address(0) || signer <= previous) revert InvalidTerms();
            isCatalogSigner[signer] = true;
            previous = signer;
        }
    }

    function configureRegistries(
        address releaseRegistry_,
        address artifactRegistry_
    ) external {
        if (msg.sender != genesisConfigurator) revert Unauthorized();
        if (releaseRegistry != address(0) || artifactRegistry != address(0)) {
            revert AlreadyConfigured();
        }
        if (
            releaseRegistry_ == address(0) ||
            artifactRegistry_ == address(0) ||
            releaseRegistry_.code.length == 0 ||
            artifactRegistry_.code.length == 0
        ) revert InvalidTerms();
        releaseRegistry = releaseRegistry_;
        artifactRegistry = artifactRegistry_;
    }

    function currentEpoch() public view returns (uint64) {
        if (block.timestamp <= genesisStart) return 0;
        return uint64((block.timestamp - genesisStart) / EPOCH_DURATION);
    }

    function epochStart(uint64 epoch) public view returns (uint256) {
        return uint256(genesisStart) + uint256(epoch) * EPOCH_DURATION;
    }

    function epochAllowance(uint64 epoch) public view returns (uint256) {
        uint256 start = epochStart(epoch);
        uint256 genesisEnd = uint256(genesisStart) + GENESIS_DURATION;
        if (start < genesisEnd) return genesisWeeklyCap;
        uint256 weeksAfter = (start - genesisEnd) / EPOCH_DURATION;
        return
            (genesisWeeklyCap * _rpow(WEEKLY_DECAY_WAD, weeksAfter, WAD)) /
            WAD;
    }

    function createEpochVault(
        uint64 epoch,
        WorkLane lane,
        bytes32 issueHash,
        bool experimentalProof,
        bytes32 salt
    ) external returns (address vault) {
        uint64 nowEpoch = currentEpoch();
        if (
            epoch < nowEpoch ||
            epoch > nowEpoch + 1 ||
            (lane == WorkLane.SYSTEM && issueHash == bytes32(0)) ||
            (lane != WorkLane.SYSTEM && issueHash != bytes32(0)) ||
            (experimentalProof && lane != WorkLane.SYSTEM)
        ) revert InvalidTerms();
        vault = address(
            new AgentPoolV41EpochVault{salt: salt}(
                IAgentPoolV41EmissionController(address(this)),
                epoch,
                uint8(lane),
                issueHash,
                experimentalProof
            )
        );
        vaults[vault] = VaultMetadata({
            epoch: epoch,
            lane: lane,
            issueHash: issueHash,
            experimentalProof: experimentalProof,
            active: true
        });
        emit EpochVaultCreated(
            vault,
            epoch,
            lane,
            issueHash,
            experimentalProof
        );
    }

    function isVault(address candidate) external view returns (bool) {
        return vaults[candidate].active;
    }

    function isSystemVault(address candidate) external view returns (bool) {
        VaultMetadata memory metadata = vaults[candidate];
        return metadata.active && metadata.lane == WorkLane.SYSTEM;
    }

    function reserveFromVault(uint256 amount) external {
        VaultMetadata memory metadata = vaults[msg.sender];
        if (!metadata.active || amount == 0) revert Unauthorized();
        _checkAndUpdateReservation(metadata, amount, true);
        vaultReserved[msg.sender] += amount;
        emit EmissionReserved(msg.sender, metadata.epoch, amount);
    }

    function releaseReservationFromVault(uint256 amount) external {
        VaultMetadata memory metadata = vaults[msg.sender];
        if (!metadata.active || amount == 0 || vaultReserved[msg.sender] < amount) {
            revert Unauthorized();
        }
        _checkAndUpdateReservation(metadata, amount, false);
        vaultReserved[msg.sender] -= amount;
        emit EmissionReleased(msg.sender, metadata.epoch, amount);
    }

    function mintBatchFromVault(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external {
        VaultMetadata memory metadata = vaults[msg.sender];
        if (!metadata.active || recipients.length == 0 || recipients.length != amounts.length) {
            revert Unauthorized();
        }
        uint256 total;
        for (uint256 index = 0; index < amounts.length; index++) {
            if (recipients[index] == address(0) || amounts[index] == 0) {
                revert InvalidTerms();
            }
            total += amounts[index];
        }
        if (vaultReserved[msg.sender] < total) revert EpochCapExceeded();

        _consumeReservation(metadata, total);
        vaultReserved[msg.sender] -= total;
        if (token.totalSupply() + total > token.MAX_SUPPLY()) {
            revert SupplyCapExceeded();
        }
        for (uint256 index = 0; index < amounts.length; index++) {
            token.mint(recipients[index], amounts[index]);
        }
        emit EmissionSettled(msg.sender, metadata.epoch, total);
    }

    function _checkAndUpdateReservation(
        VaultMetadata memory metadata,
        uint256 amount,
        bool add
    ) internal {
        uint64 epoch = metadata.epoch;
        uint256 allowance = epochAllowance(epoch);
        if (add) {
            if (epochMinted[epoch] + epochReserved[epoch] + amount > allowance) {
                revert EpochCapExceeded();
            }
            if (epochStart(epoch) < uint256(genesisStart) + GENESIS_DURATION) {
                if (genesisMinted + genesisReserved + amount > genesisCap) {
                    revert EpochCapExceeded();
                }
                genesisReserved += amount;
            }
            uint256 laneCap = allowance;
            if (metadata.lane == WorkLane.CAPABILITY) {
                laneCap = allowance * CAPABILITY_CAP_BPS / 10_000;
            }
            if (
                laneMinted[epoch][metadata.lane] +
                    laneReserved[epoch][metadata.lane] +
                    amount >
                laneCap
            ) revert LaneCapExceeded();
            if (metadata.experimentalProof) {
                uint256 experimentCap = allowance * EXPERIMENT_CAP_BPS / 10_000;
                if (
                    experimentalMinted[epoch] +
                        experimentalReserved[epoch] +
                        amount >
                    experimentCap
                ) revert LaneCapExceeded();
                experimentalReserved[epoch] += amount;
            }
            if (metadata.lane == WorkLane.SYSTEM) {
                uint256 issueCap = allowance * ISSUE_CAP_BPS / 10_000;
                if (
                    issueMinted[epoch][metadata.issueHash] +
                        issueReserved[epoch][metadata.issueHash] +
                        amount >
                    issueCap
                ) revert LaneCapExceeded();
                issueReserved[epoch][metadata.issueHash] += amount;
            }
            epochReserved[epoch] += amount;
            laneReserved[epoch][metadata.lane] += amount;
        } else {
            epochReserved[epoch] -= amount;
            laneReserved[epoch][metadata.lane] -= amount;
            if (epochStart(epoch) < uint256(genesisStart) + GENESIS_DURATION) {
                genesisReserved -= amount;
            }
            if (metadata.experimentalProof) experimentalReserved[epoch] -= amount;
            if (metadata.lane == WorkLane.SYSTEM) {
                issueReserved[epoch][metadata.issueHash] -= amount;
            }
        }
    }

    function _consumeReservation(
        VaultMetadata memory metadata,
        uint256 amount
    ) internal {
        uint64 epoch = metadata.epoch;
        epochReserved[epoch] -= amount;
        epochMinted[epoch] += amount;
        laneReserved[epoch][metadata.lane] -= amount;
        laneMinted[epoch][metadata.lane] += amount;
        if (epochStart(epoch) < uint256(genesisStart) + GENESIS_DURATION) {
            genesisReserved -= amount;
            genesisMinted += amount;
        }
        if (metadata.experimentalProof) {
            experimentalReserved[epoch] -= amount;
            experimentalMinted[epoch] += amount;
        }
        if (metadata.lane == WorkLane.SYSTEM) {
            issueReserved[epoch][metadata.issueHash] -= amount;
            issueMinted[epoch][metadata.issueHash] += amount;
        }
    }

    function _rpow(
        uint256 base,
        uint256 exponent,
        uint256 scalar
    ) internal pure returns (uint256 result) {
        result = scalar;
        while (exponent != 0) {
            if ((exponent & 1) != 0) {
                result = (result * base + scalar / 2) / scalar;
            }
            exponent >>= 1;
            if (exponent != 0) {
                base = (base * base + scalar / 2) / scalar;
            }
        }
    }
}
