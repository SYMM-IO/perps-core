// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
pragma solidity >=0.8.18;

import { AccountStorage } from "../storages/AccountStorage.sol";
import { TradingModeStorage, BindStatus } from "../storages/TradingModeStorage.sol";
import { PartyBControlStorage } from "../storages/PartyBControlStorage.sol";
import { QuoteStorage } from "../storages/QuoteStorage.sol";
import { SymbolStorage } from "../storages/SymbolStorage.sol";
import { MAStorage } from "../storages/MAStorage.sol";

library LibConnections {
	/**
	 * @notice Adds a connection between partyA and partyB if not already connected
	 */
	function addConnection(address partyA, address partyB) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		MAStorage.Layout storage maLayout = MAStorage.layout();

		if (!accountLayout.isConnectedPartyB[partyA][partyB]) {
			require(
				accountLayout.connectedPartyBs[partyA].length < maLayout.maxPartyAConnectionLimit,
				"AccountFacet: PartyA max connection limit exceeded"
			);
			accountLayout.connectedPartyBs[partyA].push(partyB);
			accountLayout.isConnectedPartyB[partyA][partyB] = true;
		}
	}

	/**
	 * @notice Removes a connection between partyA and partyB if no positions remain
	 */
	function removeConnectionIfNoPositions(address partyA, address partyB) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		if (QuoteStorage.layout().partyBOpenPositions[partyB][partyA].length == 0) {
			if (accountLayout.isConnectedPartyB[partyA][partyB]) {
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
		TradingModeStorage.Layout storage tradingLayout = TradingModeStorage.layout();
		PartyBControlStorage.Layout storage partyBLayout = PartyBControlStorage.layout();
		address[] storage connections = accountLayout.connectedPartyBs[partyA];

		if (
			(tradingLayout.bindState[partyA].status == BindStatus.BOUND && tradingLayout.isPartyBBindable[tradingLayout.bindState[partyA].partyB]) ||
			connections.length == 0
		) {
			return true;
		}

		uint256 symbolType = SymbolStorage.layout().symbolTypes[symbolId];
		for (uint256 i = 0; i < connections.length; i++) {
			address partyB = connections[i];

			if (
				partyBLayout.partyBBlacklistedSymbols[partyB][symbolId] ||
				(!partyBLayout.partyBWhitelistedSymbols[partyB][symbolId] && !partyBLayout.partyBWhitelistedSymbolTypes[partyB][symbolType])
			) {
				return false;
			}
		}
		return true;
	}

	/**
	 * @notice Checks if a symbol is allowed for partyA based on their connections
	 */
	function isSymbolAllowedForPartyB(address partyB, uint256 symbolId) internal view returns (bool) {
		PartyBControlStorage.Layout storage partyBLayout = PartyBControlStorage.layout();

		uint256 symbolType = SymbolStorage.layout().symbolTypes[symbolId];
		return (!partyBLayout.partyBBlacklistedSymbols[partyB][symbolId] &&
			(partyBLayout.partyBWhitelistedSymbols[partyB][symbolId] || partyBLayout.partyBWhitelistedSymbolTypes[partyB][symbolType]));
	}
}
