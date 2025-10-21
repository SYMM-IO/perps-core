// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
pragma solidity >=0.8.18;

import "../storages/AccountStorage.sol";
import "../storages/QuoteStorage.sol";
import "../storages/SymbolStorage.sol";

library LibConnections {
	/**
	 * @notice Adds a connection between partyA and partyB if not already connected
	 */
	function addConnection(address partyA, address partyB) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		if (!accountLayout.isConnectedPartyB[partyA][partyB]) {
			accountLayout.connectedPartyBs[partyA].push(partyB);
			accountLayout.isConnectedPartyB[partyA][partyB] = true;
		}
	}

	/**
	 * @notice Removes a connection between partyA and partyB if no positions remain
	 */
	function removeConnectionIfNoPositions(address partyA, address partyB) internal {
		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		// Check if any positions remain
		if (quoteLayout.partyBPositionsCount[partyB][partyA] == 0) {
			if (accountLayout.isConnectedPartyB[partyA][partyB]) {
				// Remove from array
				address[] storage connections = accountLayout.connectedPartyBs[partyA];
				for (uint256 i = 0; i < connections.length; i++) {
					if (connections[i] == partyB) {
						connections[i] = connections[connections.length - 1];
						connections.pop();
						break;
					}
				}
				accountLayout.isConnectedPartyB[partyA][partyB] = false;
			}
		}
	}

	/**
	 * @notice Checks if a symbol is allowed for partyA based on their connections
	 */
	function isSymbolAllowedForPartyA(address partyA, uint256 symbolId) internal view returns (bool) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		SymbolStorage.Layout storage symbolLayout = SymbolStorage.layout();

		// If partyA is bound, skip connection restrictions
		if (accountLayout.bindState[partyA].status == BindStatus.BOUND) {
			return true;
		}

		address[] storage connections = accountLayout.connectedPartyBs[partyA];

		// If no connections, allow any symbol
		if (connections.length == 0) {
			return true;
		}

		// All connected PartyBs must whitelist either this symbol or this symbol type
		uint256 symbolType = symbolLayout.symbolTypes[symbolId];
		for (uint256 i = 0; i < connections.length; i++) {
			address partyB = connections[i];
			if (!accountLayout.partyBWhitelistedSymbolTypes[partyB][symbolType] && !accountLayout.partyBWhitelistedSymbols[partyB][symbolId]) {
				return false;
			}
		}
		return true;
	}
}
