// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountStorage } from "../../storages/AccountStorage.sol";
import { GlobalAppStorage } from "../../storages/GlobalAppStorage.sol";
import { MAStorage } from "../../storages/MAStorage.sol";
import { MasterAccountMigrationStorage } from "../../storages/MasterAccountMigrationStorage.sol";
import { LibMuon } from "../../libraries/muon/LibMuon.sol";
import { LibAccount } from "../../libraries/LibAccount.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { SingleUpnlSig } from "../../storages/MuonStorage.sol";

library PartyBAccountFacetImpl {
	function allocateForPartyB(uint256 amount, address partyA) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(!accountLayout.masterAccountMode[signer] || partyA == address(0), "PartyBFacet: Master account mode is active");
		require(accountLayout.balances[signer] >= amount, "AccountFacet: Insufficient balance");
		require(
			!MAStorage.layout().partyBLiquidationStatus[signer][partyA] && !accountLayout.crossLiquidationDetails[signer].inProgress,
			"AccountFacet: PartyB isn't solvent"
		);
		accountLayout.balances[signer] -= amount;
		accountLayout.partyBAllocatedBalances[signer][partyA] += amount;
	}

	function deallocateForPartyB(uint256 amount, address partyA, SingleUpnlSig memory upnlSig) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(accountLayout.partyBAllocatedBalances[signer][partyA] >= amount, "AccountFacet: Insufficient allocated balance");
		LibMuon.verifyPartyBUpnl(upnlSig, signer, partyA, true); // Here the nonce is always from master account mode nonce if enabled
		int256 availableBalance = LibAccount.partyBAvailableForQuote(upnlSig.upnl, signer, partyA);
		require(availableBalance >= 0, "AccountFacet: Available balance is lower than zero");
		require(uint256(availableBalance) >= amount, "AccountFacet: Will be liquidatable");

		accountLayout.partyBAllocatedBalances[signer][partyA] -= amount;
		accountLayout.balances[signer] += amount;
		accountLayout.withdrawCooldown[signer] = block.timestamp;
	}

	function transferAllocation(uint256 amount, address origin, address recipient, SingleUpnlSig memory upnlSig) internal {
		MAStorage.Layout storage maLayout = MAStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(!maLayout.partyBLiquidationStatus[signer][origin], "PartyBFacet: PartyB isn't solvent");
		require(!maLayout.partyBLiquidationStatus[signer][recipient], "PartyBFacet: PartyB isn't solvent");
		require(!maLayout.liquidationStatus[origin], "PartyBFacet: Origin isn't solvent");
		require(!maLayout.liquidationStatus[recipient], "PartyBFacet: Recipient isn't solvent");
		require(!accountLayout.crossLiquidationDetails[signer].inProgress, "PartyBFacet: PartyB isn't solvent");

		// Not to be in master account mode as when the MA is activated there is no point on transferAllocation
		require(!accountLayout.masterAccountMode[signer], "PartyBFacet: Master account mode is active");

		// deallocate from origin
		require(accountLayout.partyBAllocatedBalances[signer][origin] >= amount, "PartyBFacet: Insufficient allocated balance");
		LibMuon.verifyPartyBUpnl(upnlSig, signer, origin, true); // Here the nonce is always from master account mode nonce if enabled
		int256 availableBalance = LibAccount.partyBAvailableForQuote(upnlSig.upnl, signer, origin);
		require(availableBalance >= 0, "PartyBFacet: Available balance is lower than zero");
		require(uint256(availableBalance) >= amount, "PartyBFacet: Will be liquidatable");

		accountLayout.partyBAllocatedBalances[signer][origin] -= amount;
		// allocate for recipient
		accountLayout.partyBAllocatedBalances[signer][recipient] += amount;
	}

	function depositToReserveVault(uint256 amount, address partyB) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(amount <= accountLayout.balances[signer], "AccountFacet: Insufficient balance");
		require(MAStorage.layout().partyBStatus[partyB], "AccountFacet: Should be partyB");
		accountLayout.balances[signer] -= amount;
		accountLayout.reserveVault[partyB] += amount;
	}

	function withdrawFromReserveVault(uint256 amount) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(amount > 0 && amount <= accountLayout.reserveVault[signer], "AccountFacet: Insufficient balance");
		accountLayout.reserveVault[signer] -= amount;
		accountLayout.balances[signer] += amount;
		accountLayout.withdrawCooldown[signer] = block.timestamp;
	}

	function activateMasterAccountMode() internal {
		require(GlobalAppStorage.layout().masterAccountEnabled, "AccountFacet: Master account disabled");
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		require(MasterAccountMigrationStorage.layout().partyBMigrationComplete[signer], "AccountFacet: Master account migration incomplete");
		require(!accountLayout.masterAccountMode[signer], "AccountFacet: Master account mode is active");
		accountLayout.masterAccountMode[signer] = true;
	}
}
