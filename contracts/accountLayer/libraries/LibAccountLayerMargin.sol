// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountStorage, VirtualAccountIsolationType, SubAccountIsolationType } from "../storages/AccountStorage.sol";
import { LibAccountLayerUtils } from "./LibAccountLayerUtils.sol";
import { QuoteParams } from "./LibQuoteParams.sol";
import { ISymmio } from "../interfaces/ISymmio.sol";
import { IAccountLayerErrors } from "../interfaces/IAccountLayerErrors.sol";

/// @notice Shared logic for pre-funding the next virtual account of a sub-account.
///         Used by MarginFacet.addMarginToNextVA and CoreFacet._callWithMargin.
library LibAccountLayerMargin {
	/// @dev Same signature as IMarginFacetEvents.AddMargin so both emit the identical topic.
	event AddMargin(address indexed virtualAccount, address indexed subAccount, uint256 amount);

	/// @notice Validates the isolation key and transfers deposited balance from the sub-account
	///         to the predicted next virtual account's allocated balance.
	function addMarginToNextVA(address subAccount, VirtualAccountIsolationType isolationType, uint256 symbolId, uint256 amount) internal {
		if (amount == 0) revert IAccountLayerErrors.ZeroAmount();

		AccountStorage.Layout storage ahLayout = AccountStorage.layout();
		if (!ahLayout.subAccounts[subAccount].isExists) revert IAccountLayerErrors.AccountDoesNotExist();
		SubAccountIsolationType subIsolation = ahLayout.subAccounts[subAccount].isolationType;

		bool validIsolation = false;
		if (subIsolation == SubAccountIsolationType.POSITION) {
			validIsolation = isolationType == VirtualAccountIsolationType.POSITION;
		} else if (subIsolation == SubAccountIsolationType.MARKET) {
			validIsolation = isolationType == VirtualAccountIsolationType.MARKET;
		} else if (subIsolation == SubAccountIsolationType.MARKET_DIRECTION) {
			validIsolation = isolationType == VirtualAccountIsolationType.MARKET_LONG || isolationType == VirtualAccountIsolationType.MARKET_SHORT;
		}

		if (!validIsolation) revert IAccountLayerErrors.InvalidIsolationType();

		address predictedVA = predictNextVirtualAccountAddress(subAccount, isolationType, symbolId);

		LibAccountLayerUtils.executeWithSigner(subAccount, abi.encodeWithSelector(ISymmio.internalTransfer.selector, predictedVA, amount));

		emit AddMargin(predictedVA, subAccount, amount);
	}

	/// @notice Validates that a sendQuote routes to the same virtual-account key the margin was sent to.
	/// @dev The routing in CoreFacet picks the VA from the isolation type and quote symbol. For
	///      MARKET_DIRECTION, it also uses the quote's position type. A quote whose key differs from the margin
	///      key would leave the margin on a VA the quote never uses, so reject the mismatch up front.
	function validateQuoteMatchesMarginKey(QuoteParams memory p, VirtualAccountIsolationType isolationType, uint256 symbolId) internal pure {
		if (p.symbolId != symbolId) revert IAccountLayerErrors.MarginKeyMismatch();
		if (isolationType == VirtualAccountIsolationType.MARKET_LONG && p.positionType != ISymmio.PositionType.LONG) {
			revert IAccountLayerErrors.MarginKeyMismatch();
		}
		if (isolationType == VirtualAccountIsolationType.MARKET_SHORT && p.positionType != ISymmio.PositionType.SHORT) {
			revert IAccountLayerErrors.MarginKeyMismatch();
		}
	}

	/// @notice Predicts the virtual account address the next sendQuote will create or reuse for this isolation key
	function predictNextVirtualAccountAddress(
		address subAccount,
		VirtualAccountIsolationType isolationType,
		uint256 symbolId
	) internal view returns (address) {
		AccountStorage.Layout storage ahLayout = AccountStorage.layout();

		if (ahLayout.subAccounts[subAccount].singleVAMode) {
			address existingVA = ahLayout.activeVAByKey[subAccount][isolationType][symbolId];
			if (existingVA != address(0) && ahLayout.virtualAccounts[existingVA].isExists) {
				return existingVA;
			}
		}

		address[] storage pool = ahLayout.deletedVirtualAccountsPool[subAccount][isolationType][symbolId];
		if (pool.length > 0) {
			return pool[pool.length - 1];
		}

		uint256 nextNonce = ahLayout.subAccountVirtualNonces[subAccount] + 1;
		return LibAccountLayerUtils.generateVirtualAccountAddress(subAccount, nextNonce);
	}
}
