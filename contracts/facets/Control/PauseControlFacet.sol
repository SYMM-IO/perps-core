// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../../utils/Accessibility.sol";
import "../../storages/GlobalAppStorage.sol";
import "../../storages/AccountStorage.sol";
import "./IPauseControlFacet.sol";

contract PauseControlFacet is Accessibility, IPauseControlFacet {
	/// @notice Pauses global operations.
	function pauseGlobal() external onlyRole(LibAccessibility.PAUSER_ROLE) {
		GlobalAppStorage.layout().globalPaused = true;
		emit PauseGlobal();
	}

	/// @notice Pauses liquidation operations.
	function pauseLiquidation() external onlyRole(LibAccessibility.PAUSER_ROLE) {
		GlobalAppStorage.layout().liquidationPaused = true;
		emit PauseLiquidation();
	}

	/// @notice Pauses accounting operations.
	function pauseAccounting() external onlyRole(LibAccessibility.PAUSER_ROLE) {
		GlobalAppStorage.layout().accountingPaused = true;
		emit PauseAccounting();
	}

	/// @notice Pauses Party A actions.
	function pausePartyAActions() external onlyRole(LibAccessibility.PAUSER_ROLE) {
		GlobalAppStorage.layout().partyAActionsPaused = true;
		emit PausePartyAActions();
	}

	/// @notice Pauses Party B actions.
	function pausePartyBActions() external onlyRole(LibAccessibility.PAUSER_ROLE) {
		GlobalAppStorage.layout().partyBActionsPaused = true;
		emit PausePartyBActions();
	}

	/// @notice Pauses internal transfers.
	function pauseInternalTransfer() external onlyRole(LibAccessibility.PAUSER_ROLE) {
		GlobalAppStorage.layout().internalTransferPaused = true;
		emit PauseInternalTransfer();
	}

	/// @notice Pauses external transfers.
	function pauseExternalTransfer() external onlyRole(LibAccessibility.PAUSER_ROLE) {
		GlobalAppStorage.layout().externalTransferPaused = true;
		emit PauseExternalTransfer();
	}

	/// @notice Activates emergency mode.
	function activeEmergencyMode() external onlyRole(LibAccessibility.DEFAULT_ADMIN_ROLE) {
		GlobalAppStorage.layout().emergencyMode = true;
		emit ActiveEmergencyMode();
	}

	/// @notice Unpauses global operations.
	function unpauseGlobal() external onlyRole(LibAccessibility.UNPAUSER_ROLE) {
		GlobalAppStorage.layout().globalPaused = false;
		emit UnpauseGlobal();
	}

	/// @notice Unpauses liquidation operations.
	function unpauseLiquidation() external onlyRole(LibAccessibility.UNPAUSER_ROLE) {
		GlobalAppStorage.layout().liquidationPaused = false;
		emit UnpauseLiquidation();
	}

	/// @notice Unpauses accounting operations.
	function unpauseAccounting() external onlyRole(LibAccessibility.UNPAUSER_ROLE) {
		GlobalAppStorage.layout().accountingPaused = false;
		emit UnpauseAccounting();
	}

	/// @notice Unpauses Party A actions.
	function unpausePartyAActions() external onlyRole(LibAccessibility.UNPAUSER_ROLE) {
		GlobalAppStorage.layout().partyAActionsPaused = false;
		emit UnpausePartyAActions();
	}

	/// @notice Unpauses Party B actions.
	function unpausePartyBActions() external onlyRole(LibAccessibility.UNPAUSER_ROLE) {
		GlobalAppStorage.layout().partyBActionsPaused = false;
		emit UnpausePartyBActions();
	}

	/// @notice Unpauses internal transfers.
	function unpauseInternalTransfer() external onlyRole(LibAccessibility.UNPAUSER_ROLE) {
		GlobalAppStorage.layout().internalTransferPaused = false;
		emit UnpauseInternalTransfer();
	}

	/// @notice Unpauses external transfers.
	function unpauseExternalTransfer() external onlyRole(LibAccessibility.UNPAUSER_ROLE) {
		GlobalAppStorage.layout().externalTransferPaused = false;
		emit UnpauseExternalTransfer();
	}

	/// @notice Deactivates emergency mode.
	function deactiveEmergencyMode() external onlyRole(LibAccessibility.DEFAULT_ADMIN_ROLE) {
		GlobalAppStorage.layout().emergencyMode = false;
		emit DeactiveEmergencyMode();
	}

	/// @notice Suspends a user's address.
	function suspendedAddress(address user) external onlyRole(LibAccessibility.SUSPENDER_ROLE) {
		require(user != address(0), "PauseControlFacet: Zero address");
		emit SetSuspendedAddress(user, true);
		AccountStorage.layout().suspendedAddresses[user] = true;
	}

	/// @notice Unsuspends a user's address.
	function unsuspendedAddress(address user) external onlyRole(LibAccessibility.DEFAULT_ADMIN_ROLE) {
		require(user != address(0), "PauseControlFacet: Zero address");
		emit SetSuspendedAddress(user, false);
		AccountStorage.layout().suspendedAddresses[user] = false;
	}

	/// @notice Sets the emergency status for Party B addresses.
	function setPartyBEmergencyStatus(address[] memory partyBs, bool status) external onlyRole(LibAccessibility.DEFAULT_ADMIN_ROLE) {
		for (uint256 i; i < partyBs.length; i++) {
			require(partyBs[i] != address(0), "PauseControlFacet: Zero address");
			GlobalAppStorage.layout().partyBEmergencyStatus[partyBs[i]] = status;
			emit SetPartyBEmergencyStatus(partyBs[i], status);
		}
	}

	function deprecateOldWithdrawal() external onlyRole(LibAccessibility.SETTER_ROLE) {
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		appLayout.deprecateOldWithdrawalPaused = true;
		emit DeprecateOldWithdrawalPaused();
	}

	function deprecateOldFundingFee() external onlyRole(LibAccessibility.SETTER_ROLE) {
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		appLayout.iterativeFundingDeprecationFlag = true;
		emit DeprecateOldFundingFee();
	}

	function enableNewFundingFee() external onlyRole(LibAccessibility.SETTER_ROLE) {
		GlobalAppStorage.Layout storage appLayout = GlobalAppStorage.layout();
		appLayout.accumulativeFundingRateActivationFlag = true;
		emit EnableNewFundingFee();
	}
}
