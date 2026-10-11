// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import { Account, DelegationInfo, SignedDelegation, ReplayAttackHeader } from "../../InstantLayerTypes.sol";
import { IDelegationFacet } from "./IDelegationFacet.sol";
import { InstantLayerStorage } from "../../storages/InstantLayerStorage.sol";
import { DelegationStorage } from "../../storages/DelegationStorage.sol";
import { LibInstantLayerEIP712 } from "../../libraries/LibInstantLayerEIP712.sol";
import { LibInstantLayerAccessibility } from "../../libraries/LibInstantLayerAccessibility.sol";
import { LibInstantLayerAccount } from "../../libraries/LibInstantLayerAccount.sol";
import { LibInstantLayerDelegation } from "../../libraries/LibInstantLayerDelegation.sol";

/// @notice Delegation lifecycle facet for the InstantLayer diamond
/// @dev Grants go through LibInstantLayerDelegation, which the execution facet shares.
contract DelegationFacet is IDelegationFacet {
	/// @notice Grant batch delegation permissions using a signature.
	function grantBatchDelegationBySig(SignedDelegation calldata signedDelegation, bytes calldata signature) external {
		DelegationInfo calldata info = signedDelegation.delegationInfo;
		ReplayAttackHeader calldata rh = signedDelegation.replayAttackHeader;

		if (info.account.isPartyB) revert InvalidDelegation();

		address delegator = LibInstantLayerAccount.canonicalDelegator(info.account.addr);
		address owner = LibInstantLayerAccount.getAccountOwner(delegator);

		// Validate delegation parameters
		if (info.delegatedSigner == owner) revert SelfDelegation();
		if (info.expiryTimestamp <= block.timestamp) revert DelegationExpired(info.expiryTimestamp);
		if (rh.deadline != 0 && block.timestamp > rh.deadline) revert DeadlineExpired(rh.deadline);
		if (info.selectors.length == 0) revert InvalidDelegation();

		// Verify and update nonce
		DelegationStorage.Layout storage l = DelegationStorage.layout();
		uint256 expected = l.delegationNonces[delegator];
		if (rh.nonce != expected + 1) revert InvalidNonce(delegator, expected, rh.nonce);
		l.delegationNonces[delegator] = expected + 1;
		emit DelegationNonceIncremented(delegator, expected + 1);

		// Verify signature
		bytes32 hash = LibInstantLayerEIP712.hashDelegation(signedDelegation);
		if (!SignatureChecker.isValidSignatureNow(owner, hash, signature)) revert InvalidSignature();

		// Check for replay attacks
		if (l.usedDelegationHashes[hash]) revert DelegationAlreadyExecuted(hash);
		l.usedDelegationHashes[hash] = true;

		LibInstantLayerDelegation.applyGrant(info, owner);
	}

	/// @notice Grant delegation permissions directly (no signature required).
	function grantDelegation(DelegationInfo calldata info) external {
		if (LibInstantLayerAccount.getAccountOwner(info.account.addr) != msg.sender) {
			revert NotOwnerOfAccount(msg.sender, info.account.addr);
		}
		if (info.account.isPartyB) revert InvalidDelegation();
		LibInstantLayerDelegation.applyGrant(info, msg.sender);
	}

	/// @notice Grant delegation to several delegates of one account in a single call.
	/// @dev Every entry must name the same account as the first.
	function grantDelegations(DelegationInfo[] calldata infos) external {
		if (infos.length == 0) revert InvalidDelegation();
		Account calldata account = infos[0].account;
		if (LibInstantLayerAccount.getAccountOwner(account.addr) != msg.sender) {
			revert NotOwnerOfAccount(msg.sender, account.addr);
		}
		for (uint256 i = 0; i < infos.length; i++) {
			LibInstantLayerDelegation.applyAccountGrant(infos[i], account.addr, msg.sender);
		}
	}

	/// @notice Schedule revocation of specific selectors; takes effect after the cooldown.
	/// @dev Who may schedule: account owner (delegator), the delegate themselves, or REVOKER_ROLE.
	function initiateRevokeDelegation(Account calldata account, address delegate, bytes4[] calldata selectors) external {
		address delegator = LibInstantLayerAccount.canonicalDelegator(account.addr);

		bool callerIsOwner = LibInstantLayerAccount.getAccountOwner(delegator) == msg.sender;
		bool callerIsDelegate = msg.sender == delegate;
		bool callerIsAdmin = LibInstantLayerAccessibility.hasRole(msg.sender, LibInstantLayerAccessibility.REVOKER_ROLE);
		if (!(callerIsOwner || callerIsDelegate || callerIsAdmin)) {
			revert NotOwnerOfAccount(msg.sender, account.addr);
		}

		DelegationStorage.Layout storage l = DelegationStorage.layout();
		uint256 cooldown = InstantLayerStorage.layout().revocationCooldown;
		for (uint256 i = 0; i < selectors.length; ++i) {
			bytes4 sel = selectors[i];
			// only schedule if currently active
			uint256 currentExpiry = l.delegations[delegator][delegate][sel];
			if (currentExpiry <= block.timestamp) continue;
			uint256 eta = block.timestamp + cooldown;
			l.pendingRevocationEta[delegator][delegate][sel] = eta;
			emit RevocationScheduled(delegator, delegate, sel, eta);
		}
	}

	/// @notice Finalizes a scheduled revocation after cooldown by deleting the delegation.
	/// @dev Anyone may call once the ETA has passed.
	function finalizeRevokeDelegation(Account calldata account, address delegate, bytes4[] calldata selectors) external {
		address delegator = LibInstantLayerAccount.canonicalDelegator(account.addr);

		DelegationStorage.Layout storage l = DelegationStorage.layout();
		for (uint256 i = 0; i < selectors.length; ++i) {
			bytes4 sel = selectors[i];
			uint256 eta = l.pendingRevocationEta[delegator][delegate][sel];
			if (eta == 0) continue; // not scheduled
			if (block.timestamp < eta) revert RevocationCooldownNotOver(eta); // still cooling

			// delete pending & active delegation
			delete l.pendingRevocationEta[delegator][delegate][sel];
			delete l.delegations[delegator][delegate][sel];
			emit DelegationSelectorRevoked(delegator, delegate, sel);
		}
	}
}
