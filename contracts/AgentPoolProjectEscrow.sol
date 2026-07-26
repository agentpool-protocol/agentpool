// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IAgentPoolRegistry} from "./interfaces/IAgentPoolRegistry.sol";

/// @notice Escrow for signed multi-agent DAG plans with parallel leaf tasks.
contract AgentPoolProjectEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant VALIDATOR_SHARE_BPS = 9_000;
    uint16 public constant BURN_SHARE_BPS = 0;
    uint16 public constant SECURITY_SHARE_BPS = 1_000;
    uint16 public constant WORKER_BOND_BPS = 1_000;
    uint16 public constant MIN_WORKER_BOND = 10;
    uint128 public constant MIN_VERIFIED_TASK_PRICE = 1_000;
    uint128 public constant MAX_VALIDATION_FEE = 30;
    uint16 public constant STAGE_PAYMENT_BPS = 8_000;
    uint8 public constant MAX_TASKS = 32;
    uint64 public constant RESOLUTION_GRACE = 3 days;

    enum ProjectState {
        NONE,
        CREATED,
        PLANNED,
        ACTIVE,
        COMPLETED,
        CANCELLED
    }

    enum TaskState {
        NONE,
        LISTED,
        ACCEPTED,
        SUBMITTED,
        PASSED,
        FAILED,
        AMBIGUOUS,
        EXPIRED
    }

    enum Outcome {
        PASS,
        FAIL,
        AMBIGUOUS
    }

    struct Project {
        address buyer;
        address coordinator;
        uint128 maxWorkerBudget;
        uint128 validationReserve;
        uint128 workerFundsRemaining;
        uint128 feeFundsRemaining;
        uint128 committedWorker;
        uint128 committedFees;
        uint64 deadline;
        uint8 maxTasks;
        uint8 taskCount;
        uint8 terminalTaskCount;
        ProjectState state;
        bytes32 briefHash;
        bytes32 planRoot;
        uint8 minWorkers;
        uint8 workerCount;
        uint8 plannedTaskCount;
        bool planApproved;
    }

    struct ProjectTask {
        uint256 projectId;
        address worker;
        uint128 price;
        uint128 validationFee;
        uint128 workerBond;
        uint128 holdback;
        uint64 deadline;
        uint64 resolutionDeadline;
        TaskState state;
        bytes32 requirementsHash;
        bytes32 dependenciesHash;
        bytes32 verifierId;
        bytes32 deliveryHash;
    }

    IERC20 public immutable apool;
    IAgentPoolRegistry public immutable registry;
    address public resolver;
    address public immutable securityTreasury;
    uint256 public nextProjectId = 1;
    uint256 public nextTaskId = 1;
    mapping(uint256 => Project) public projects;
    mapping(uint256 => ProjectTask) public tasks;
    mapping(uint256 => uint256[]) private projectTaskIds;
    mapping(uint256 => uint256[]) private taskDependencies;
    mapping(uint256 => mapping(address => bool)) private projectWorkerSeen;
    mapping(uint256 => mapping(bytes32 => bool)) public consumedPlanLeaf;

    event ProjectCreated(
        uint256 indexed projectId,
        address indexed buyer,
        address indexed coordinator,
        uint256 maxWorkerBudget,
        uint256 validationReserve,
        uint256 minWorkers
    );
    event ProjectPlanned(
        uint256 indexed projectId,
        bytes32 indexed planRoot,
        uint256 plannedTaskCount
    );
    event ProjectPlanApproved(uint256 indexed projectId, bytes32 indexed planRoot);
    event TaskAdded(
        uint256 indexed projectId,
        uint256 indexed taskId,
        address indexed worker,
        uint256 price,
        uint256 validationFee
    );
    event TaskAccepted(uint256 indexed taskId, uint256 workerBond);
    event TaskSubmitted(uint256 indexed taskId, bytes32 indexed deliveryHash);
    event TaskResolved(uint256 indexed taskId, Outcome outcome, TaskState state);
    event ProjectFinalized(uint256 indexed projectId, uint256 buyerRefund);
    event ProjectCancelled(uint256 indexed projectId, uint256 buyerRefund);

    error InvalidState();
    error Unauthorized();
    error InvalidTerms();
    error BudgetExceeded();

    constructor(
        IERC20 token,
        IAgentPoolRegistry registry_,
        address governance,
        address securityTreasury_
    ) Ownable(governance) {
        if (
            address(token) == address(0) ||
            address(registry_) == address(0) ||
            securityTreasury_ == address(0)
        ) revert InvalidTerms();
        apool = token;
        registry = registry_;
        securityTreasury = securityTreasury_;
    }

    function setResolver(address resolver_) external onlyOwner {
        if (resolver != address(0)) revert InvalidState();
        if (resolver_ == address(0)) revert InvalidTerms();
        resolver = resolver_;
    }

    function createProject(
        address coordinator,
        uint128 maxWorkerBudget,
        uint8 minWorkers,
        uint8 maxTasks,
        uint64 deadline,
        bytes32 briefHash
    ) external nonReentrant returns (uint256 projectId) {
        if (
            coordinator == address(0) ||
            coordinator == msg.sender ||
            maxWorkerBudget < uint256(maxTasks) * MIN_VERIFIED_TASK_PRICE ||
            minWorkers == 0 ||
            maxTasks == 0 ||
            minWorkers > maxTasks ||
            maxTasks > MAX_TASKS ||
            deadline <= block.timestamp ||
            briefHash == bytes32(0)
        ) revert InvalidTerms();
        uint128 validationReserve = uint128(
            uint256(maxTasks) * MAX_VALIDATION_FEE
        );
        projectId = nextProjectId++;
        projects[projectId] = Project({
            buyer: msg.sender,
            coordinator: coordinator,
            maxWorkerBudget: maxWorkerBudget,
            validationReserve: validationReserve,
            workerFundsRemaining: maxWorkerBudget,
            feeFundsRemaining: validationReserve,
            committedWorker: 0,
            committedFees: 0,
            deadline: deadline,
            maxTasks: maxTasks,
            taskCount: 0,
            terminalTaskCount: 0,
            state: ProjectState.CREATED,
            briefHash: briefHash,
            planRoot: bytes32(0),
            minWorkers: minWorkers,
            workerCount: 0,
            plannedTaskCount: 0,
            planApproved: false
        });
        apool.safeTransferFrom(
            msg.sender,
            address(this),
            uint256(maxWorkerBudget) + validationReserve
        );
        emit ProjectCreated(
            projectId,
            msg.sender,
            coordinator,
            maxWorkerBudget,
            validationReserve,
            minWorkers
        );
    }

    function postPlan(
        uint256 projectId,
        bytes32 planRoot,
        uint8 plannedTaskCount
    ) external {
        Project storage project = projects[projectId];
        if (project.state != ProjectState.CREATED) revert InvalidState();
        if (msg.sender != project.coordinator) revert Unauthorized();
        if (
            planRoot == bytes32(0) ||
            plannedTaskCount < project.minWorkers ||
            plannedTaskCount > project.maxTasks
        ) revert InvalidTerms();
        project.planRoot = planRoot;
        project.plannedTaskCount = plannedTaskCount;
        project.state = ProjectState.PLANNED;
        emit ProjectPlanned(projectId, planRoot, plannedTaskCount);
    }

    function approvePlan(uint256 projectId) external {
        Project storage project = projects[projectId];
        if (project.state != ProjectState.PLANNED) revert InvalidState();
        if (msg.sender != project.buyer) revert Unauthorized();
        project.planApproved = true;
        project.state = ProjectState.ACTIVE;
        emit ProjectPlanApproved(projectId, project.planRoot);
    }

    function addTask(
        uint256 projectId,
        address worker,
        uint128 price,
        uint64 deadline,
        bytes32 requirementsHash,
        uint256[] calldata dependencyTaskIds,
        bytes32 verifierId,
        bytes32[] calldata planProof
    ) external returns (uint256 taskId) {
        Project storage project = projects[projectId];
        if (project.state != ProjectState.ACTIVE || !project.planApproved) revert InvalidState();
        if (msg.sender != project.coordinator) revert Unauthorized();
        if (
            worker == address(0) ||
            worker == project.buyer ||
            price < MIN_VERIFIED_TASK_PRICE ||
            deadline <= block.timestamp ||
            deadline > project.deadline ||
            requirementsHash == bytes32(0) ||
            verifierId == bytes32(0) ||
            project.taskCount >= project.plannedTaskCount ||
            dependencyTaskIds.length >= project.plannedTaskCount ||
            !registry.isActiveVerifier(verifierId)
        ) revert InvalidTerms();
        for (uint256 index = 0; index < dependencyTaskIds.length; index++) {
            uint256 dependencyTaskId = dependencyTaskIds[index];
            if (tasks[dependencyTaskId].projectId != projectId) revert InvalidTerms();
            for (uint256 prior = 0; prior < index; prior++) {
                if (dependencyTaskIds[prior] == dependencyTaskId) revert InvalidTerms();
            }
        }
        bytes32 dependenciesHash = keccak256(abi.encode(dependencyTaskIds));
        bytes32 leaf = taskLeaf(
            projectId,
            worker,
            price,
            deadline,
            requirementsHash,
            dependenciesHash,
            verifierId
        );
        if (!MerkleProof.verifyCalldata(planProof, project.planRoot, leaf)) {
            revert InvalidTerms();
        }
        if (consumedPlanLeaf[projectId][leaf]) revert InvalidTerms();
        consumedPlanLeaf[projectId][leaf] = true;
        uint128 validationFee = uint128(validationFeeFor(verifierId));
        uint128 workerBond = uint128(workerBondFor(price));
        if (
            uint256(project.committedWorker) + price > project.maxWorkerBudget ||
            uint256(project.committedFees) + validationFee > project.validationReserve
        ) revert BudgetExceeded();
        taskId = nextTaskId++;
        tasks[taskId] = ProjectTask({
            projectId: projectId,
            worker: worker,
            price: price,
            validationFee: validationFee,
            workerBond: workerBond,
            holdback: 0,
            deadline: deadline,
            resolutionDeadline: 0,
            state: TaskState.LISTED,
            requirementsHash: requirementsHash,
            dependenciesHash: dependenciesHash,
            verifierId: verifierId,
            deliveryHash: bytes32(0)
        });
        for (uint256 index = 0; index < dependencyTaskIds.length; index++) {
            taskDependencies[taskId].push(dependencyTaskIds[index]);
        }
        projectTaskIds[projectId].push(taskId);
        if (!projectWorkerSeen[projectId][worker]) {
            projectWorkerSeen[projectId][worker] = true;
            project.workerCount++;
        }
        project.committedWorker += price;
        project.committedFees += validationFee;
        project.taskCount++;
        emit TaskAdded(projectId, taskId, worker, price, validationFee);
    }

    function acceptTask(uint256 taskId) external nonReentrant {
        ProjectTask storage task = tasks[taskId];
        if (task.state != TaskState.LISTED) revert InvalidState();
        if (msg.sender != task.worker) revert Unauthorized();
        uint256[] storage dependencies = taskDependencies[taskId];
        for (uint256 index = 0; index < dependencies.length; index++) {
            if (tasks[dependencies[index]].state != TaskState.PASSED) {
                revert InvalidState();
            }
        }
        task.state = TaskState.ACCEPTED;
        apool.safeTransferFrom(msg.sender, address(this), task.workerBond);
        emit TaskAccepted(taskId, task.workerBond);
    }

    function submitTask(uint256 taskId, bytes32 deliveryHash) external {
        ProjectTask storage task = tasks[taskId];
        if (task.state != TaskState.ACCEPTED || block.timestamp > task.deadline) {
            revert InvalidState();
        }
        if (msg.sender != task.worker) revert Unauthorized();
        if (deliveryHash == bytes32(0)) revert InvalidTerms();
        task.deliveryHash = deliveryHash;
        task.resolutionDeadline = uint64(block.timestamp + RESOLUTION_GRACE);
        task.state = TaskState.SUBMITTED;
        emit TaskSubmitted(taskId, deliveryHash);
    }

    function resolveTask(
        uint256 taskId,
        Outcome outcome,
        address[] calldata validatorReceivers
    ) external nonReentrant {
        if (msg.sender != resolver) revert Unauthorized();
        ProjectTask storage task = tasks[taskId];
        if (task.state != TaskState.SUBMITTED) revert InvalidState();
        Project storage project = projects[task.projectId];
        if (outcome == Outcome.AMBIGUOUS) {
            task.state = TaskState.AMBIGUOUS;
            apool.safeTransfer(task.worker, task.workerBond);
        } else {
            if (validatorReceivers.length == 0) revert InvalidTerms();
            _settleValidationFee(project, task.validationFee, validatorReceivers);
            if (outcome == Outcome.PASS) {
                uint128 stagePayment = uint128(
                    uint256(task.price) * STAGE_PAYMENT_BPS / 10_000
                );
                task.holdback = task.price - stagePayment;
                task.state = TaskState.PASSED;
                project.workerFundsRemaining -= stagePayment;
                apool.safeTransfer(task.worker, uint256(stagePayment) + task.workerBond);
            } else {
                task.state = TaskState.FAILED;
                apool.safeTransfer(securityTreasury, task.workerBond);
            }
        }
        project.terminalTaskCount++;
        emit TaskResolved(taskId, outcome, task.state);
    }

    function expireTask(uint256 taskId) external nonReentrant {
        ProjectTask storage task = tasks[taskId];
        Project storage project = projects[task.projectId];
        if (task.state == TaskState.LISTED && block.timestamp > task.deadline) {
            task.state = TaskState.EXPIRED;
        } else if (task.state == TaskState.ACCEPTED && block.timestamp > task.deadline) {
            task.state = TaskState.EXPIRED;
            apool.safeTransfer(securityTreasury, task.workerBond);
        } else if (
            task.state == TaskState.SUBMITTED &&
            block.timestamp > task.resolutionDeadline
        ) {
            task.state = TaskState.AMBIGUOUS;
            apool.safeTransfer(task.worker, task.workerBond);
        } else {
            revert InvalidState();
        }
        project.terminalTaskCount++;
        emit TaskResolved(taskId, Outcome.AMBIGUOUS, task.state);
    }

    function finalizeProject(uint256 projectId) external nonReentrant {
        Project storage project = projects[projectId];
        if (
            project.state != ProjectState.ACTIVE ||
            project.taskCount == 0 ||
            project.taskCount != project.plannedTaskCount ||
            project.workerCount < project.minWorkers ||
            project.terminalTaskCount != project.taskCount
        ) revert InvalidState();
        uint256[] storage taskIds = projectTaskIds[projectId];
        for (uint256 index = 0; index < taskIds.length; index++) {
            ProjectTask storage task = tasks[taskIds[index]];
            if (task.holdback != 0) {
                uint128 holdback = task.holdback;
                task.holdback = 0;
                project.workerFundsRemaining -= holdback;
                apool.safeTransfer(task.worker, holdback);
            }
        }
        uint256 buyerRefund =
            uint256(project.workerFundsRemaining) + project.feeFundsRemaining;
        project.workerFundsRemaining = 0;
        project.feeFundsRemaining = 0;
        project.state = ProjectState.COMPLETED;
        if (buyerRefund != 0) apool.safeTransfer(project.buyer, buyerRefund);
        emit ProjectFinalized(projectId, buyerRefund);
    }

    function cancelUnplannedProject(uint256 projectId) external nonReentrant {
        Project storage project = projects[projectId];
        if (
            project.state != ProjectState.CREATED &&
            !(project.state == ProjectState.PLANNED && project.taskCount == 0) &&
            !(project.state == ProjectState.ACTIVE && project.taskCount == 0)
        ) revert InvalidState();
        if (msg.sender != project.buyer) revert Unauthorized();
        uint256 buyerRefund =
            uint256(project.workerFundsRemaining) + project.feeFundsRemaining;
        project.workerFundsRemaining = 0;
        project.feeFundsRemaining = 0;
        project.state = ProjectState.CANCELLED;
        apool.safeTransfer(project.buyer, buyerRefund);
        emit ProjectCancelled(projectId, buyerRefund);
    }

    function validationFeeFor(bytes32 verifierId) public view returns (uint256) {
        return registry.validationFeeForVerifier(verifierId);
    }

    function getProjectTaskIds(uint256 projectId) external view returns (uint256[] memory) {
        return projectTaskIds[projectId];
    }

    function getTaskDependencies(uint256 taskId) external view returns (uint256[] memory) {
        return taskDependencies[taskId];
    }

    /// @notice Standard double-hashed leaf used with OpenZeppelin's sorted Merkle proofs.
    function taskLeaf(
        uint256 projectId,
        address worker,
        uint128 price,
        uint64 deadline,
        bytes32 requirementsHash,
        bytes32 dependenciesHash,
        bytes32 verifierId
    ) public pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        projectId,
                        worker,
                        price,
                        workerBondFor(price),
                        deadline,
                        requirementsHash,
                        dependenciesHash,
                        verifierId
                    )
                )
            )
        );
    }

    function workerBondFor(uint256 price) public pure returns (uint256) {
        if (price == 0) return 0;
        uint256 percentageBond =
            (price * WORKER_BOND_BPS + 9_999) / 10_000;
        return percentageBond < MIN_WORKER_BOND
            ? MIN_WORKER_BOND
            : percentageBond;
    }

    function _settleValidationFee(
        Project storage project,
        uint128 fee,
        address[] calldata receivers
    ) internal {
        uint256 validatorPayment = uint256(fee) * VALIDATOR_SHARE_BPS / 10_000;
        uint256 securityPayment = uint256(fee) - validatorPayment;
        project.feeFundsRemaining -= fee;
        _payValidators(receivers, validatorPayment);
        if (securityPayment != 0) apool.safeTransfer(securityTreasury, securityPayment);
    }

    function _payValidators(address[] calldata receivers, uint256 amount) internal {
        uint256 share = amount / receivers.length;
        uint256 remainder = amount - share * receivers.length;
        for (uint256 index = 0; index < receivers.length; index++) {
            address receiver = receivers[index];
            if (receiver == address(0)) revert InvalidTerms();
            for (uint256 prior = 0; prior < index; prior++) {
                if (receivers[prior] == receiver) revert InvalidTerms();
            }
            uint256 payment = share + (index == 0 ? remainder : 0);
            if (payment != 0) apool.safeTransfer(receiver, payment);
        }
    }
}
