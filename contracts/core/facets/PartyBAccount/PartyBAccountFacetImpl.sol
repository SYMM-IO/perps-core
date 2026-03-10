// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountStorage } from "../../storages/AccountStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { ClearingHouseStorage } from "../../storages/ClearingHouseStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { LibMuon } from "../../libraries/muon/LibMuon.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { SingleUpnlSig } from "../../storages/MuonStorage.sol";
import { MuonFunction } from "../../interfaces/IMuonSignatureVerifier.sol";

library PartyBAccountFacetImpl {
	/// @notice Moves collateral from Party B's balance to allocated balance for a given Party A
	function allocateForPartyB(uint256 amount, address partyA) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();
		address signer = LibSigner.getSigner();
		require(!maLayout.crossModeEnabledForPartyB[signer] || partyA == address(0), "PartyBFacet: Cross partyB mode is active");
		require(accountLayout.balances[signer] >= amount, "AccountFacet: Insufficient balance");
		require(
			!maLayout.partyBLiquidationStatus[signer][partyA] && !ClearingHouseStorage.layout().crossLiquidationDetails[signer].inProgress,
			"AccountFacet: PartyB isn't solvent"
		);
		accountLayout.balances[signer] -= amount;
		accountLayout.partyBAllocatedBalances[signer][partyA] += amount;
	}

	/// @notice Moves collateral from Party B's allocated balance back to free balance after solvency check
	function deallocateForPartyB(uint256 amount, address partyA, SingleUpnlSig memory upnlSig) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(!MAStorage.layout().crossModeEnabledForPartyB[signer] || partyA == address(0), "PartyBFacet: Cross partyB mode is active");
		require(accountLayout.partyBAllocatedBalances[signer][partyA] >= amount, "AccountFacet: Insufficient allocated balance");
		LibMuon.verifyPartyBUpnl(upnlSig, signer, partyA, true, MuonFunction.AccountManagement); // Here the nonce is always from cross partyB mode nonce if enabled
		int256 availableBalance = LibAccount.partyBAvailableForQuote(upnlSig.upnl, signer, partyA);
		require(availableBalance >= 0, "AccountFacet: Available balance is lower than zero");
		require(uint256(availableBalance) >= amount, "AccountFacet: Will be liquidatable");

		accountLayout.partyBAllocatedBalances[signer][partyA] -= amount;
		accountLayout.balances[signer] += amount;
		accountLayout.deallocateTimestamp[signer] = block.timestamp;
	}

	/// @notice Transfers Party B's allocated balance from one Party A to another after solvency check
	function transferAllocation(uint256 amount, address origin, address recipient, SingleUpnlSig memory upnlSig) internal {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		ClearingHouseStorage.Layout storage chLayout = ClearingHouseStorage.layout();
		address signer = LibSigner.getSigner();
		require(!maLayout.partyBLiquidationStatus[signer][origin], "PartyBFacet: PartyB isn't solvent");
		require(!maLayout.partyBLiquidationStatus[signer][recipient], "PartyBFacet: PartyB isn't solvent");
		require(!maLayout.liquidationStatus[origin], "PartyBFacet: Origin isn't solvent");
		require(!maLayout.liquidationStatus[recipient], "PartyBFacet: Recipient isn't solvent");
		require(!chLayout.crossLiquidationDetails[signer].inProgress, "PartyBFacet: PartyB isn't solvent");

		// Not to be in cross partyB mode as when it's activated there is no point on transferAllocation
		require(!maLayout.crossModeEnabledForPartyB[signer], "PartyBFacet: Cross partyB mode is active");

		// deallocate from origin
		require(accountLayout.partyBAllocatedBalances[signer][origin] >= amount, "PartyBFacet: Insufficient allocated balance");
		LibMuon.verifyPartyBUpnl(upnlSig, signer, origin, true, MuonFunction.AccountManagement); // Here the nonce is always from cross partyB mode nonce if enabled
		int256 availableBalance = LibAccount.partyBAvailableForQuote(upnlSig.upnl, signer, origin);
		require(availableBalance >= 0, "PartyBFacet: Available balance is lower than zero");
		require(uint256(availableBalance) >= amount, "PartyBFacet: Will be liquidatable");

		accountLayout.partyBAllocatedBalances[signer][origin] -= amount;
		// allocate for recipient
		accountLayout.partyBAllocatedBalances[signer][recipient] += amount;
	}

	/// @notice Deposits from the caller's balance into the specified partyB's emergency reserve vault
	function depositToReserveVault(uint256 amount, address partyB) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(amount <= accountLayout.balances[signer], "AccountFacet: Insufficient balance");
		require(MAStorage.layout().partyBStatus[partyB], "AccountFacet: Should be partyB");
		accountLayout.balances[signer] -= amount;
		accountLayout.reserveVault[partyB] += amount;
	}

	/// @notice Withdraws from the caller's emergency reserve vault back to free balance
	function withdrawFromReserveVault(uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(amount > 0 && amount <= accountLayout.reserveVault[signer], "AccountFacet: Insufficient balance");
		accountLayout.reserveVault[signer] -= amount;
		accountLayout.balances[signer] += amount;
		accountLayout.deallocateTimestamp[signer] = block.timestamp;
	}

	/// @notice Enables cross partyB mode by setting a flag (balance consolidation is handled by the migration function)
	function activateCrossPartyB() internal {
		require(GlobalAppStorage.layout().crossPartyBModeActivated, "AccountFacet: Cross disabled");
		MAStorage.Layout storage maLayout = MAStorage.layout();
		address signer = LibSigner.getSigner();
		require(!maLayout.crossModeEnabledForPartyB[signer], "AccountFacet: Cross partyB mode is active");
		maLayout.crossModeEnabledForPartyB[signer] = true;
	}
}
