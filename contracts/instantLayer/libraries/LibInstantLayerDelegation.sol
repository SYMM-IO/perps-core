// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { DelegationInfo } from "../InstantLayerTypes.sol";
import { InstantLayerStorage } from "../storages/InstantLayerStorage.sol";
import { DelegationStorage } from "../storages/DelegationStorage.sol";
import { LibInstantLayerAccount } from "./LibInstantLayerAccount.sol";
import { IInstantLayerErrors } from "../interfaces/IInstantLayerErrors.sol";
import { IInstantLayerEvents } from "../interfaces/IInstantLayerEvents.sol";
import { ITimelockFacet } from "../../accountLayer/facets/Timelock/ITimelockFacet.sol";

/// @notice Delegation rules shared by the delegation, execution and view facets: what counts as
///         an active delegation, what a delegate needs to execute a call, and how grants are written
/// @dev Neither grant function checks who is calling. Each caller proves the grantor owns the
///      account before calling: the direct paths compare the owner with msg.sender, the signed
///      paths verify the owner's signature.
library LibInstantLayerDelegation {
	/// @notice Whether a delegation is unexpired and has no revocation that has taken effect
	function isDelegationActive(address delegator, address delegate, bytes4 selector) internal view returns (bool) {
		DelegationStorage.Layout storage l = DelegationStorage.layout();
		uint256 expiry = l.delegations[delegator][delegate][selector];
		uint256 eta = l.pendingRevocationEta[delegator][delegate][selector];
		return expiry > block.timestamp && (eta == 0 || eta > block.timestamp);
	}

	/// @notice Revert unless `signer` may execute `callData` on `target` for the PartyA `account`
	/// @dev The account owner always may. Anyone else needs an active delegation, granted under the
	///      account's canonical delegator, for the selector the calldata resolves to.
	function requireAuthorized(address account, address signer, address target, bytes memory callData) internal view {
		if (LibInstantLayerAccount.getAccountOwner(account) == signer) return;
		bytes4 selector = delegatedSelector(target, callData);
		address delegator = LibInstantLayerAccount.canonicalDelegator(account);
		if (!isDelegationActive(delegator, signer, selector)) revert IInstantLayerErrors.InvalidDelegation();
	}

	/// @notice The selector a delegate must hold to execute `callData` on `target`
	/// @dev Nested timelock wrappers carry approvals, so authorization follows their inner calldata
	///      rather than the wrapper selector.
	function delegatedSelector(address target, bytes memory callData) internal view returns (bytes4 selector) {
		address accountLayer = InstantLayerStorage.layout().accountLayer;
		uint256 start;
		uint256 length = callData.length;
		if (length < 4) revert IInstantLayerErrors.InvalidDelegation();
		assembly ("memory-safe") {
			selector := mload(add(callData, 32))
		}
		while (target == accountLayer && selector == ITimelockFacet.executeTimelockOp.selector) {
			// Offsets are relative to this wrapper's arguments, including when it is nested.
			if (length < 68) revert IInstantLayerErrors.InvalidDelegation();
			uint256 innerOffset;
			assembly ("memory-safe") {
				innerOffset := mload(add(callData, add(start, 68)))
			}
			if (innerOffset > length - 36) revert IInstantLayerErrors.InvalidDelegation();
			uint256 dataPos = start + 36 + innerOffset;
			uint256 innerLength;
			assembly ("memory-safe") {
				innerLength := mload(add(callData, dataPos))
			}
			if (innerLength < 4 || innerLength > length - 36 - innerOffset) revert IInstantLayerErrors.InvalidDelegation();
			start = dataPos;
			length = innerLength;
			assembly ("memory-safe") {
				selector := mload(add(callData, add(start, 32)))
			}
		}
	}

	/// @notice Apply one grant after pinning it to `account`
	/// @dev The entry must name that account and the account must be PartyA.
	function applyAccountGrant(DelegationInfo memory info, address account, address owner) internal {
		if (info.account.addr != account || info.account.isPartyB) revert IInstantLayerErrors.InvalidDelegation();
		applyGrant(info, owner);
	}

	/// @notice Validate a grant against `owner`, write it under the canonical delegator, and clear pending revocations
	function applyGrant(DelegationInfo memory info, address owner) internal {
		address delegate = info.delegatedSigner;
		uint256 expiry = info.expiryTimestamp;

		if (delegate == owner) revert IInstantLayerErrors.SelfDelegation();
		if (expiry <= block.timestamp) revert IInstantLayerErrors.DelegationExpired(expiry);
		if (info.selectors.length == 0) revert IInstantLayerErrors.InvalidDelegation();

		address delegator = LibInstantLayerAccount.canonicalDelegator(info.account.addr);
		DelegationStorage.Layout storage l = DelegationStorage.layout();
		mapping(bytes4 => uint256) storage slot = l.delegations[delegator][delegate];

		for (uint256 i = 0; i < info.selectors.length; i++) {
			bytes4 selector = info.selectors[i];
			slot[selector] = expiry;
			delete l.pendingRevocationEta[delegator][delegate][selector];
			emit IInstantLayerEvents.DelegationGranted(delegator, delegate, selector, expiry);
		}
	}
}
