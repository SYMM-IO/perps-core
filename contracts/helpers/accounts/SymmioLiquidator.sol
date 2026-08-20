// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/interfaces/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import { IPartyALiquidationFacet } from "../../core/facets/PartyALiquidation/IPartyALiquidationFacet.sol";
import { IPartyALiquidationSnapshotFacet } from "../../core/facets/PartyALiquidationSnapshot/IPartyALiquidationSnapshotFacet.sol";
import { IPartyBLiquidationFacet } from "../../core/facets/PartyBLiquidation/IPartyBLiquidationFacet.sol";

/// @notice Proxy call contract for liquidation bots. Operators execute liquidation calls
///         against the Symmio core, while fee collection/withdrawal is restricted to
///         a separate manager role (operators cannot move funds).
contract SymmioLiquidator is Initializable, PausableUpgradeable, AccessControlUpgradeable, UUPSUpgradeable {
	using SafeERC20Upgradeable for IERC20Upgradeable;

	bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
	bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

	/// @notice Address of the Symmio core diamond
	address public symmioAddress;

	/// @notice Selectors on the Symmio core that operators are allowed to invoke.
	///         Operators cannot call selectors outside this admin-controlled allowlist.
	mapping(bytes4 => bool) public allowedSelectors;

	event SetSymmioAddress(address oldSymmioAddress, address newSymmioAddress);
	event SetAllowedSelector(bytes4 indexed selector, bool state);
	event FeeWithdrawn(address indexed token, address indexed to, uint256 amount);

	error ZeroAddress();
	error ArrayLengthMismatch();
	error InvalidCallData();
	error SelectorNotAllowed(bytes4 selector);
	error ExecutionReverted();

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	/// @notice Initializes the contract
	/// @param admin Address granted DEFAULT_ADMIN_ROLE and MANAGER_ROLE
	/// @param symmioAddress_ Address of the Symmio core diamond
	function initialize(address admin, address symmioAddress_) public initializer {
		__Pausable_init();
		__AccessControl_init();
		__UUPSUpgradeable_init();

		if (admin == address(0)) revert ZeroAddress();
		if (symmioAddress_ == address(0)) revert ZeroAddress();

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(MANAGER_ROLE, admin);
		symmioAddress = symmioAddress_;

		_setAllowedSelector(IPartyALiquidationFacet.liquidatePartyA.selector, true);
		_setAllowedSelector(IPartyALiquidationFacet.setSymbolsPrice.selector, true);
		_setAllowedSelector(IPartyALiquidationSnapshotFacet.liquidatePartyAWithSnapshot.selector, true);
		_setAllowedSelector(IPartyALiquidationSnapshotFacet.setSymbolsPriceWithSnapshot.selector, true);
		_setAllowedSelector(IPartyALiquidationSnapshotFacet.liquidatePendingPositionsPartyAWithSnapshot.selector, true);
		_setAllowedSelector(IPartyALiquidationSnapshotFacet.liquidatePositionsPartyAWithSnapshot.selector, true);
		_setAllowedSelector(IPartyALiquidationSnapshotFacet.settlePartyALiquidationWithSnapshot.selector, true);
		_setAllowedSelector(IPartyALiquidationSnapshotFacet.singleStepLiquidatePartyAWithSnapshot.selector, true);
		_setAllowedSelector(IPartyALiquidationFacet.deferredLiquidatePartyA.selector, true);
		_setAllowedSelector(IPartyALiquidationFacet.deferredSetSymbolsPrice.selector, true);
		_setAllowedSelector(IPartyALiquidationFacet.liquidatePendingPositionsPartyA.selector, true);
		_setAllowedSelector(IPartyALiquidationFacet.liquidatePositionsPartyA.selector, true);
		_setAllowedSelector(IPartyALiquidationFacet.settlePartyALiquidation.selector, true);
		_setAllowedSelector(IPartyBLiquidationFacet.liquidatePartyB.selector, true);
		_setAllowedSelector(IPartyBLiquidationFacet.liquidatePositionsPartyB.selector, true);
	}

	function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

	/* ──────────────────────────── Admin config ──────────────────────────── */

	/// @notice Updates the Symmio core address
	function setSymmioAddress(address addr) external onlyRole(DEFAULT_ADMIN_ROLE) {
		if (addr == address(0)) revert ZeroAddress();
		emit SetSymmioAddress(symmioAddress, addr);
		symmioAddress = addr;
	}

	/// @notice Allow or disallow an operator-invokable selector on Symmio core
	/// @param selector Function selector on Symmio core
	/// @param state True to allow, false to disallow
	function setAllowedSelector(bytes4 selector, bool state) external onlyRole(DEFAULT_ADMIN_ROLE) {
		_setAllowedSelector(selector, state);
	}

	/// @notice Batch variant of {setAllowedSelector}
	function setAllowedSelectors(bytes4[] calldata selectors, bool[] calldata states) external onlyRole(DEFAULT_ADMIN_ROLE) {
		if (selectors.length != states.length) revert ArrayLengthMismatch();
		for (uint256 i = 0; i < selectors.length; i++) _setAllowedSelector(selectors[i], states[i]);
	}

	function _setAllowedSelector(bytes4 selector, bool state) internal {
		allowedSelectors[selector] = state;
		emit SetAllowedSelector(selector, state);
	}

	/* ─────────────────────────── Operator calls ─────────────────────────── */

	/// @notice Executes a batch of liquidation calls against the Symmio core.
	///         Each call's selector must be in {allowedSelectors}. Reverts atomically on failure.
	function call(bytes[] calldata callDatas) external whenNotPaused onlyRole(OPERATOR_ROLE) {
		address target = symmioAddress;
		for (uint256 i = 0; i < callDatas.length; i++) {
			bytes calldata callData = callDatas[i];
			if (callData.length < 4) revert InvalidCallData();
			bytes4 selector = bytes4(callData[:4]);
			if (!allowedSelectors[selector]) revert SelectorNotAllowed(selector);

			(bool success, bytes memory resultData) = target.call(callData);
			if (!success) {
				if (resultData.length == 0) revert ExecutionReverted();
				assembly {
					revert(add(resultData, 32), mload(resultData))
				}
			}
		}
	}

	/* ─────────────────────────── Manager calls ─────────────────────────── */

	/// @notice Manager-only passthrough to the Symmio core, bypassing the operator allowlist.
	///         Intended for treasury operations needed to collect liquidation fees, such as
	///         `deallocate` and `withdraw` on core. Operators cannot invoke these functions.
	///         Calls are made as this contract, so deallocate/withdraw act on fees credited here.
	function managerCall(bytes[] calldata callDatas) external onlyRole(MANAGER_ROLE) {
		address target = symmioAddress;
		for (uint256 i = 0; i < callDatas.length; i++) {
			bytes calldata callData = callDatas[i];
			if (callData.length < 4) revert InvalidCallData();

			(bool success, bytes memory resultData) = target.call(callData);
			if (!success) {
				if (resultData.length == 0) revert ExecutionReverted();
				assembly {
					revert(add(resultData, 32), mload(resultData))
				}
			}
		}
	}

	/* ─────────────────────────── Fee withdrawal ─────────────────────────── */

	/// @notice Withdraws accumulated liquidation fees (ERC20) to `to`.
	///         Only MANAGER_ROLE may call this; operators cannot.
	function withdrawERC20(address token, address to, uint256 amount) external onlyRole(MANAGER_ROLE) {
		if (to == address(0)) revert ZeroAddress();
		IERC20Upgradeable(token).safeTransfer(to, amount);
		emit FeeWithdrawn(token, to, amount);
	}

	/* ──────────────────────────────── Pause ─────────────────────────────── */

	function pause() external onlyRole(PAUSER_ROLE) {
		_pause();
	}

	function unpause() external onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}
}
