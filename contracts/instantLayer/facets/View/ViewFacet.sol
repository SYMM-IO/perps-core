// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Account, DelegationInfo, Operation, Template, SignedOperation, SignedDelegation } from "../../InstantLayerTypes.sol";
import { IInstantLayerViewFacet } from "./IViewFacet.sol";
import { InstantLayerStorage } from "../../storages/InstantLayerStorage.sol";
import { DelegationStorage } from "../../storages/DelegationStorage.sol";
import { TemplateStorage } from "../../storages/TemplateStorage.sol";
import { LibInstantLayerAccessibility } from "../../libraries/LibInstantLayerAccessibility.sol";
import { LibInstantLayerEIP712 } from "../../libraries/LibInstantLayerEIP712.sol";
import { LibInstantLayerAccount } from "../../libraries/LibInstantLayerAccount.sol";
import { LibInstantLayerDelegation } from "../../libraries/LibInstantLayerDelegation.sol";
import { LibDiamond } from "../../../diamond/libraries/LibDiamond.sol";

/// @notice Read-only facet for the InstantLayer diamond
/// @dev No modifiers: every function here is a view. hasRole(bytes32,address) is deliberately
///      absent — ControlFacet already declares that selector, and a diamond cannot route one
///      selector to two facets.
contract ViewFacet is IInstantLayerViewFacet {
	// ==================== Moved view functions ====================

	/// @inheritdoc IInstantLayerViewFacet
	function isPartyBRegistered(address addr) external view returns (bool) {
		return InstantLayerStorage.layout().registeredPartyBs[addr];
	}

	/// @inheritdoc IInstantLayerViewFacet
	function isDelegationActive(address delegator, address delegate, bytes4 selector) external view returns (bool) {
		return LibInstantLayerDelegation.isDelegationActive(delegator, delegate, selector);
	}

	/// @inheritdoc IInstantLayerViewFacet
	function getActiveDelegations(
		Account calldata _delegator,
		address[] calldata delegates,
		bytes4[][] calldata selectors
	) external view returns (DelegationInfo[] memory activeDelegates) {
		if (delegates.length != selectors.length) revert ArrayLengthMismatch();
		address delegator = LibInstantLayerAccount.canonicalDelegator(_delegator.addr);
		DelegationStorage.Layout storage l = DelegationStorage.layout();
		uint256 activeCount = 0;

		// Count active delegations
		for (uint256 i = 0; i < delegates.length; i++) {
			bytes4[] calldata sels = selectors[i];
			bool anyActive = false;
			for (uint256 j = 0; j < sels.length; j++) {
				if (LibInstantLayerDelegation.isDelegationActive(delegator, delegates[i], sels[j])) {
					anyActive = true;
					break;
				}
			}
			if (anyActive) activeCount++;
		}

		// Build result array
		activeDelegates = new DelegationInfo[](activeCount);
		uint256 k = 0;

		for (uint256 i = 0; i < delegates.length; i++) {
			bytes4[] calldata sels = selectors[i];

			// Count active selectors for this delegate
			uint256 c = 0;
			for (uint256 j = 0; j < sels.length; j++) {
				if (LibInstantLayerDelegation.isDelegationActive(delegator, delegates[i], sels[j])) {
					c++;
				}
			}
			if (c == 0) continue;

			// Collect active selectors
			bytes4[] memory activeSels = new bytes4[](c);
			uint256 idx = 0;
			uint256 minExpiry = type(uint256).max;

			for (uint256 j = 0; j < sels.length; j++) {
				bytes4 sel = sels[j];
				if (LibInstantLayerDelegation.isDelegationActive(delegator, delegates[i], sel)) {
					activeSels[idx++] = sel;
					uint256 exp = l.delegations[delegator][delegates[i]][sel];
					if (exp < minExpiry) minExpiry = exp; // Track earliest expiry
				}
			}

			activeDelegates[k++] = DelegationInfo({
				account: _delegator,
				delegatedSigner: delegates[i],
				selectors: activeSels,
				expiryTimestamp: minExpiry
			});
		}
	}

	/// @inheritdoc IInstantLayerViewFacet
	function domainSeparator() external view returns (bytes32) {
		return LibInstantLayerEIP712.domainSeparator();
	}

	/// @inheritdoc IInstantLayerViewFacet
	function eip712Domain()
		external
		view
		returns (
			bytes1 fields,
			string memory name,
			string memory version,
			uint256 chainId,
			address verifyingContract,
			bytes32 salt,
			uint256[] memory extensions
		)
	{
		// 0x0f marks name, version, chainId and verifyingContract as the fields in use.
		return (hex"0f", "SymmioInstantLayer", "1", block.chainid, address(this), bytes32(0), new uint256[](0));
	}

	/// @inheritdoc IInstantLayerViewFacet
	function getTemplate(uint256 templateId) external view returns (Template memory) {
		return TemplateStorage.layout().templates[templateId];
	}

	/// @inheritdoc IInstantLayerViewFacet
	function getNextTemplateId() external view returns (uint256) {
		return TemplateStorage.layout().nextTemplateId;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function getTemplateOperations(uint256 templateId) external view returns (Operation[] memory) {
		return TemplateStorage.layout().templates[templateId].operations;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function getTemplates(uint256 startId, uint256 limit) external view returns (Template[] memory) {
		TemplateStorage.Layout storage l = TemplateStorage.layout();
		if (startId >= l.nextTemplateId) return new Template[](0);

		uint256 end = startId + limit;
		if (end > l.nextTemplateId) end = l.nextTemplateId;

		Template[] memory result = new Template[](end - startId);
		for (uint256 i = startId; i < end; i++) {
			result[i - startId] = l.templates[i];
		}
		return result;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function getOperationHash(SignedOperation memory signedOp) public view returns (bytes32 msgDigest) {
		return LibInstantLayerEIP712.hashOperation(signedOp);
	}

	/// @inheritdoc IInstantLayerViewFacet
	function getFlexFillAuthHash(bytes32 opHash, uint256 fieldIndex, bytes memory value) public view returns (bytes32 msgDigest) {
		return LibInstantLayerEIP712.hashFlexFillAuth(opHash, fieldIndex, value);
	}

	/// @inheritdoc IInstantLayerViewFacet
	function getDelegationHash(SignedDelegation memory signedDelegation) public view returns (bytes32 msgDigest) {
		return LibInstantLayerEIP712.hashDelegation(signedDelegation);
	}

	// ==================== Ownership ====================

	/// @inheritdoc IInstantLayerViewFacet
	function getOwner() external view returns (address) {
		return LibDiamond.contractOwner();
	}

	/// @inheritdoc IInstantLayerViewFacet
	function pendingOwner() external view returns (address) {
		return LibDiamond.diamondStorage().pendingOwner;
	}

	// ==================== Explicit getters (auto-getter replacements) ====================

	/// @inheritdoc IInstantLayerViewFacet
	function nonces(address account) external view returns (uint256) {
		return InstantLayerStorage.layout().nonces[account];
	}

	/// @inheritdoc IInstantLayerViewFacet
	function registeredPartyBs(address partyB) external view returns (bool) {
		return InstantLayerStorage.layout().registeredPartyBs[partyB];
	}

	/// @inheritdoc IInstantLayerViewFacet
	function whitelistedTargets(address target) external view returns (bool) {
		return InstantLayerStorage.layout().whitelistedTargets[target];
	}

	/// @inheritdoc IInstantLayerViewFacet
	function accountLayer() external view returns (address) {
		return InstantLayerStorage.layout().accountLayer;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function symmio() external view returns (address) {
		return InstantLayerStorage.layout().symmio;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function operationUsageCount(bytes32 opHash) external view returns (uint256) {
		return InstantLayerStorage.layout().operationUsageCount[opHash];
	}

	/// @inheritdoc IInstantLayerViewFacet
	function templateInstantOpenMode(uint256 templateId) external view returns (bool) {
		return TemplateStorage.layout().templateInstantOpenMode[templateId];
	}

	/// @inheritdoc IInstantLayerViewFacet
	function usedDelegationHashes(bytes32 hash) external view returns (bool) {
		return DelegationStorage.layout().usedDelegationHashes[hash];
	}

	/// @inheritdoc IInstantLayerViewFacet
	function delegations(address delegator, address delegate, bytes4 selector) external view returns (uint256) {
		return DelegationStorage.layout().delegations[delegator][delegate][selector];
	}

	/// @inheritdoc IInstantLayerViewFacet
	function delegationNonces(address delegator) external view returns (uint256) {
		return DelegationStorage.layout().delegationNonces[delegator];
	}

	/// @inheritdoc IInstantLayerViewFacet
	function pendingRevocationEta(address delegator, address delegate, bytes4 selector) external view returns (uint256) {
		return DelegationStorage.layout().pendingRevocationEta[delegator][delegate][selector];
	}

	/// @inheritdoc IInstantLayerViewFacet
	function revocationCooldown() external view returns (uint256) {
		return InstantLayerStorage.layout().revocationCooldown;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function nextTemplateId() external view returns (uint256) {
		return TemplateStorage.layout().nextTemplateId;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function transientContextEnabled() external view returns (bool) {
		return InstantLayerStorage.layout().transientContextEnabled;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function templates(uint256 templateId) external view returns (string memory name, bool active) {
		Template storage t = TemplateStorage.layout().templates[templateId];
		return (t.name, t.active);
	}

	// ==================== Constant getters ====================

	/// @inheritdoc IInstantLayerViewFacet
	function DEFAULT_ADMIN_ROLE() external view returns (bytes32) {
		return LibInstantLayerAccessibility.DEFAULT_ADMIN_ROLE;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function isRoleAdmin(address user, bytes32 role) external view returns (bool) {
		return LibInstantLayerAccessibility.isRoleAdmin(user, role);
	}

	/// @inheritdoc IInstantLayerViewFacet
	function SETTER_ROLE() external view returns (bytes32) {
		return LibInstantLayerAccessibility.SETTER_ROLE;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function TEMPLATE_MANAGER_ROLE() external view returns (bytes32) {
		return LibInstantLayerAccessibility.TEMPLATE_MANAGER_ROLE;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function OPERATOR_ROLE() external view returns (bytes32) {
		return LibInstantLayerAccessibility.OPERATOR_ROLE;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function REVOKER_ROLE() external view returns (bytes32) {
		return LibInstantLayerAccessibility.REVOKER_ROLE;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function ACCOUNT_TYPEHASH() external view returns (bytes32) {
		return LibInstantLayerEIP712.ACCOUNT_TYPEHASH;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function REPLAY_HEADER_TYPEHASH() external view returns (bytes32) {
		return LibInstantLayerEIP712.REPLAY_HEADER_TYPEHASH;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function FLEX_FIELD_TYPEHASH() external view returns (bytes32) {
		return LibInstantLayerEIP712.FLEX_FIELD_TYPEHASH;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function FLEX_FILL_AUTH_TYPEHASH() external view returns (bytes32) {
		return LibInstantLayerEIP712.FLEX_FILL_AUTH_TYPEHASH;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function DELEGATION_INFO_TYPEHASH() external view returns (bytes32) {
		return LibInstantLayerEIP712.DELEGATION_INFO_TYPEHASH;
	}

	/// @inheritdoc IInstantLayerViewFacet
	function SIGNED_DELEGATION_TYPEHASH() external view returns (bytes32) {
		return LibInstantLayerEIP712.SIGNED_DELEGATION_TYPEHASH;
	}
}
