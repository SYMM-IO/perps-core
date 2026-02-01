// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Accessibility } from "../../utils/Accessibility.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { AccountStorage } from "../../storages/AccountStorage.sol";
import { ExternalTransferStorage } from "../../storages/ExternalTransferStorage.sol";
import { TradingModeStorage } from "../../storages/TradingModeStorage.sol";
import { WithdrawStorage } from "../../storages/WithdrawStorage.sol";
import { FundingStorage } from "../../storages/FundingStorage.sol";
import { IPauseControlFacet } from "./IPauseControlFacet.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";

contract PauseControlFacet is Accessibility, IPauseControlFacet {
	/// @notice Pauses all protocol operations globally. No trading, deposits, or withdrawals will be possible.
	function pauseGlobal() external onlyRole(LibAccessibility.PAUSER_ROLE) {
		GlobalAppStorage.layout().globalPaused = true;
		emit PauseGlobal();
	}

	/// @notice Pauses all liquidation operations. Positions cannot be liquidated while paused.
	function pauseLiquidation() external onlyRole(LibAccessibility.PAUSER_ROLE) {
		GlobalAppStorage.layout().liquidationPaused = true;
		emit PauseLiquidation();
	}

	/// @notice Pauses accounting operations including deposits, withdrawals, allocations, and deallocations.
	function pauseAccounting() external onlyRole(LibAccessibility.PAUSER_ROLE) {
		GlobalAppStorage.layout().accountingPaused = true;
		emit PauseAccounting();
	}

	/// @notice Pauses all Party A (trader) actions including sending quotes, closing positions, and other trading operations.
	function pausePartyAActions() external onlyRole(LibAccessibility.PAUSER_ROLE) {
		GlobalAppStorage.layout().partyAActionsPaused = true;
		emit PausePartyAActions();
	}

	/// @notice Pauses all Party B (market maker/hedger) actions including accepting quotes and filling positions.
	function pausePartyBActions() external onlyRole(LibAccessibility.PAUSER_ROLE) {
		GlobalAppStorage.layout().partyBActionsPaused = true;
		emit PausePartyBActions();
	}

	/// @notice Restricts Party B to closing positions only; opening positions and locking quotes are blocked.
	function pausePartyBOpenPositions() external onlyRole(LibAccessibility.PAUSER_ROLE) {
		GlobalAppStorage.layout().partyBOpenPositionsPaused = true;
		emit PausePartyBOpenPositions();
	}

	/// @notice Pauses internal transfers between accounts within the protocol.
	function pauseInternalTransfer() external onlyRole(LibAccessibility.PAUSER_ROLE) {
		GlobalAppStorage.layout().internalTransferPaused = true;
		emit PauseInternalTransfer();
	}

	/// @notice Pauses external transfers to addresses outside the protocol (e.g., to other protocols or wallets).
	function pauseExternalTransfer() external onlyRole(LibAccessibility.PAUSER_ROLE) {
		ExternalTransferStorage.layout().externalTransferPaused = true;
		emit PauseExternalTransfer();
	}

	/// @notice Pauses instant layer operations for bound PartyAs.
	function pauseInstantLayer() external onlyRole(LibAccessibility.PAUSER_ROLE) {
		TradingModeStorage.layout().instantLayerPaused = true;
		emit PauseInstantLayer();
	}

	/// @notice Activates emergency mode which enables emergency withdrawals and restricts normal protocol operations.
	function activeEmergencyMode() external onlyRole(LibAccessibility.EMERGENCY_ADMIN_ROLE) {
		GlobalAppStorage.layout().emergencyMode = true;
		emit ActiveEmergencyMode();
	}

	/// @notice Resumes all protocol operations after a global pause. Trading, deposits, and withdrawals become available.
	function unpauseGlobal() external onlyRole(LibAccessibility.UNPAUSER_ROLE) {
		GlobalAppStorage.layout().globalPaused = false;
		emit UnpauseGlobal();
	}

	/// @notice Resumes liquidation operations, allowing undercollateralized positions to be liquidated again.
	function unpauseLiquidation() external onlyRole(LibAccessibility.UNPAUSER_ROLE) {
		GlobalAppStorage.layout().liquidationPaused = false;
		emit UnpauseLiquidation();
	}

	/// @notice Resumes accounting operations including deposits, withdrawals, allocations, and deallocations.
	function unpauseAccounting() external onlyRole(LibAccessibility.UNPAUSER_ROLE) {
		GlobalAppStorage.layout().accountingPaused = false;
		emit UnpauseAccounting();
	}

	/// @notice Resumes all Party A (trader) actions including sending quotes, closing positions, and other trading operations.
	function unpausePartyAActions() external onlyRole(LibAccessibility.UNPAUSER_ROLE) {
		GlobalAppStorage.layout().partyAActionsPaused = false;
		emit UnpausePartyAActions();
	}

	/// @notice Resumes all Party B (market maker/hedger) actions including accepting quotes and filling positions.
	function unpausePartyBActions() external onlyRole(LibAccessibility.UNPAUSER_ROLE) {
		GlobalAppStorage.layout().partyBActionsPaused = false;
		emit UnpausePartyBActions();
	}

	/// @notice Restores Party B's ability to open new positions and lock quotes.
	function unpausePartyBOpenPositions() external onlyRole(LibAccessibility.UNPAUSER_ROLE) {
		GlobalAppStorage.layout().partyBOpenPositionsPaused = false;
		emit UnpausePartyBOpenPositions();
	}

	/// @notice Resumes internal transfers between accounts within the protocol.
	function unpauseInternalTransfer() external onlyRole(LibAccessibility.UNPAUSER_ROLE) {
		GlobalAppStorage.layout().internalTransferPaused = false;
		emit UnpauseInternalTransfer();
	}

	/// @notice Resumes external transfers to addresses outside the protocol.
	function unpauseExternalTransfer() external onlyRole(LibAccessibility.UNPAUSER_ROLE) {
		ExternalTransferStorage.layout().externalTransferPaused = false;
		emit UnpauseExternalTransfer();
	}

	/// @notice Resumes instant layer operations for bound PartyAs.
	function unpauseInstantLayer() external onlyRole(LibAccessibility.UNPAUSER_ROLE) {
		TradingModeStorage.layout().instantLayerPaused = false;
		emit UnpauseInstantLayer();
	}

	/// @notice Deactivates emergency mode, returning the protocol to normal operations and disabling emergency withdrawals.
	function deactiveEmergencyMode() external onlyRole(LibAccessibility.EMERGENCY_ADMIN_ROLE) {
		GlobalAppStorage.layout().emergencyMode = false;
		emit DeactiveEmergencyMode();
	}

	/// @notice Suspends a user's address, preventing them from performing any protocol actions until unsuspended.
	/// @param user The address of the user to suspend.
	function suspendedAddress(address user) external onlyRole(LibAccessibility.SUSPENDER_ROLE) {
		require(user != address(0), "PauseControlFacet: Zero address");
		emit SetSuspendedAddress(user, true);
		AccountStorage.layout().suspendedAddresses[user] = true;
	}

	/// @notice Removes suspension from a user's address, restoring their ability to interact with the protocol.
	/// @param user The address of the user to unsuspend.
	function unsuspendedAddress(address user) external onlyRole(LibAccessibility.UNSUSPENDER_ROLE) {
		require(user != address(0), "PauseControlFacet: Zero address");
		emit SetSuspendedAddress(user, false);
		AccountStorage.layout().suspendedAddresses[user] = false;
	}

	/// @notice Sets the emergency status for multiple Party B addresses, enabling or disabling their emergency mode operations.
	/// @param partyBs Array of Party B addresses to update emergency status for.
	/// @param status True to enable emergency status, false to disable.
	function setPartyBEmergencyStatus(address[] memory partyBs, bool status) external onlyRole(LibAccessibility.EMERGENCY_ADMIN_ROLE) {
		for (uint256 i; i < partyBs.length; i++) {
			require(partyBs[i] != address(0), "PauseControlFacet: Zero address");
			GlobalAppStorage.layout().partyBEmergencyStatus[partyBs[i]] = status;
			emit SetPartyBEmergencyStatus(partyBs[i], status);
		}
	}

	/// @notice Deprecates the legacy withdrawal mechanism, forcing users to use the new withdrawal system.
	function deprecateLegacyWithdrawal() external onlyRole(LibAccessibility.MIGRATION_ROLE) {
		WithdrawStorage.layout().legacyWithdrawalDeprecated = true;
		emit LegacyWithdrawalDeprecated();
	}

	/// @notice Deprecates the legacy iterative funding fee calculation, preparing for migration to accumulative funding rates.
	function deprecateLegacyFunding() external onlyRole(LibAccessibility.MIGRATION_ROLE) {
		FundingStorage.layout().legacyFundingDeprecated = true;
		emit LegacyFundingDeprecated();
	}

	/// @notice Activates the new accumulated funding rate system which calculates funding more efficiently using stored rates.
	function activateAccumulatedFunding() external onlyRole(LibAccessibility.MIGRATION_ROLE) {
		FundingStorage.layout().accumulatedFundingActivated = true;
		emit AccumulatedFundingActivated();
	}
}
