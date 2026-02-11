// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { AccessControlEnumerableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlEnumerableUpgradeable.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title SymmioGlobalRelayer
/// @notice A cross-protocol bridge for transferring collateral between whitelisted Symmio instances
/// @dev Enables secure transfers of collateral tokens between different Symmio protocol
///      deployments while maintaining proper access controls and cooldown mechanisms

/// @notice Interface for Symmio protocol core contract
interface ISymmio {
	function getCollateral() external view returns (address);

	function coolDownsOfMA() external view returns (uint256, uint256, uint256, uint256);

	function setDeallocateCooldown(uint256 deallocateCooldown) external;

	function depositFor(address user, uint256 amount) external;

	function withdrawCooldownOf(address user) external view returns (uint256);
}

/// @notice Interface for multi-account management contract
interface IMultiAccount {
	function _call(address account, bytes[] memory _callDatas) external;

	function owners(address account) external view returns (address);
}

contract SymmioGlobalRelayer is AccessControlEnumerableUpgradeable, PausableUpgradeable {
	using SafeERC20 for IERC20;

	/* ─────────────────────────────── Roles ─────────────────────────────── */

	/// @notice Role for setting configuration parameters and whitelisted targets
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");

	/// @notice Role for pausing contract operations in emergency situations
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

	/// @notice Role for unpausing contract operations after emergency resolution
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

	/* ─────────────────────────────── Storage Variables ─────────────────────────────── */

	/// @notice Mapping of target protocol addresses to their whitelist status
	mapping(address => bool) public whitelistedTargets;

	/// @notice Mapping of target protocol addresses to their required withdraw cooldown periods
	mapping(address => uint256) public targetWithdrawCooldowns;

	/* ─────────────────────────────── Events ─────────────────────────────── */

	/// @notice Emitted when target protocol whitelist status is updated
	event SetWhitelistedTargets(address[] targets, bool[] states);

	/// @notice Emitted when target protocol withdraw cooldowns are updated
	event SetTargetWithdrawCooldowns(address[] targets, uint256[] cooldowns);

	/// @notice Emitted when a cross-protocol transfer is successfully executed
	event TransferExecuted(
		address collateral,
		address sender,
		address receiver,
		uint256 amount,
		address source,
		address sourceMultiAccount,
		address target
	);

	/* ─────────────────────────────── Errors ─────────────────────────────── */

	/// @notice Thrown when a zero address is provided where a valid address is required
	error InvalidAddress();

	/// @notice Thrown when attempting to transfer to a non-whitelisted target protocol
	error TargetNotWhitelisted();

	/// @notice Thrown when caller is not authorized to perform the requested action
	error Unauthorized();

	/// @notice Thrown when source and target protocols have different collateral tokens
	error MismatchedCollateral();

	/// @notice Thrown when the required withdraw cooldown period has not elapsed
	error WithdrawCooldownNotReached();

	/* ─────────────────────────────── Initialization ─────────────────────────────── */

	/// @notice Initializes the contract with admin role assignments
	/// @param admin Address to receive DEFAULT_ADMIN_ROLE, SETTER_ROLE, and UNPAUSER_ROLE
	function initialize(address admin) external initializer {
		__Pausable_init();
		__AccessControl_init();

		if (admin == address(0)) revert InvalidAddress();

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(SETTER_ROLE, admin);
		_grantRole(UNPAUSER_ROLE, admin);
	}

	/* ─────────────────────────────── Transfer Management ─────────────────────────────── */

	/// @notice Executes a cross-protocol collateral transfer between Symmio instances
	/// @param sender Address of the sub-account whose funds are being transferred
	/// @param receiver Address of the user who will receive funds on the target protocol
	/// @param amount Amount of collateral to transfer
	/// @param source Address of the source Symmio protocol instance
	/// @param sourceMultiAccount Address of the multi-account contract for the source
	/// @param target Address of the target Symmio protocol instance
	function transfer(
		address sender,
		address receiver,
		uint256 amount,
		address source,
		address sourceMultiAccount,
		address target
	) external whenNotPaused {
		// Input validation
		if (receiver == address(0) || source == address(0) || target == address(0) || sourceMultiAccount == address(0)) {
			revert InvalidAddress();
		}

		if (!whitelistedTargets[target]) revert TargetNotWhitelisted();

		// Authorization check
		if (msg.sender != IMultiAccount(sourceMultiAccount).owners(sender)) revert Unauthorized();

		// Collateral compatibility check
		address collateral = ISymmio(source).getCollateral();
		if (collateral != ISymmio(target).getCollateral()) revert MismatchedCollateral();

		// Cooldown validation
		(uint256 originalCooldown, , , ) = ISymmio(source).coolDownsOfMA();
		uint256 deallocateTimestamp = ISymmio(source).withdrawCooldownOf(sender);

		if (deallocateTimestamp + targetWithdrawCooldowns[target] > block.timestamp) {
			revert WithdrawCooldownNotReached();
		}

		// Temporarily disable cooldown for withdrawal
		ISymmio(source).setDeallocateCooldown(0);

		// Execute withdrawal via multi-account
		bytes[] memory withdrawCallData = new bytes[](1);
		withdrawCallData[0] = abi.encodeWithSignature("withdrawTo(address,uint256)", address(this), amount);
		IMultiAccount(sourceMultiAccount)._call(sender, withdrawCallData);

		// Restore original cooldown
		ISymmio(source).setDeallocateCooldown(originalCooldown);

		// Deposit to target protocol
		IERC20(collateral).approve(target, amount);
		ISymmio(target).depositFor(receiver, amount);

		emit TransferExecuted(collateral, sender, receiver, amount, source, sourceMultiAccount, target);
	}

	/* ─────────────────────────────── Admin Functions ─────────────────────────────── */

	/// @notice Updates the whitelist status for multiple target protocols
	/// @param targets Array of target protocol addresses to update
	/// @param states Array of whitelist states corresponding to each target
	function setWhitelistedTargets(address[] calldata targets, bool[] calldata states) external onlyRole(SETTER_ROLE) {
		for (uint256 i = 0; i < targets.length; i++) {
			whitelistedTargets[targets[i]] = states[i];
		}
		emit SetWhitelistedTargets(targets, states);
	}

	/// @notice Updates withdraw cooldown requirements for multiple target protocols
	/// @param targets Array of target protocol addresses to update
	/// @param cooldowns Array of cooldown periods in seconds corresponding to each target
	function setTargetWithdrawCooldowns(address[] calldata targets, uint256[] calldata cooldowns) external onlyRole(SETTER_ROLE) {
		for (uint256 i = 0; i < targets.length; i++) {
			targetWithdrawCooldowns[targets[i]] = cooldowns[i];
		}
		emit SetTargetWithdrawCooldowns(targets, cooldowns);
	}

	/// @notice Pauses all transfer operations
	function pause() external onlyRole(PAUSER_ROLE) {
		_pause();
	}

	/// @notice Unpauses transfer operations
	function unpause() external onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}
}
