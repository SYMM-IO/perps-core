// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import { DelegationInfo, FlexField, Operation, SignedOperation, Template } from "../../InstantLayerTypes.sol";
import { IExecutionFacet } from "./IExecutionFacet.sol";
import { InstantLayerAccessibility } from "../../utils/InstantLayerAccessibility.sol";
import { InstantLayerReentrancyGuard } from "../../utils/InstantLayerReentrancyGuard.sol";
import { InstantLayerStorage } from "../../storages/InstantLayerStorage.sol";
import { TemplateStorage } from "../../storages/TemplateStorage.sol";
import { LibInstantLayerAccessibility } from "../../libraries/LibInstantLayerAccessibility.sol";
import { LibInstantLayerEIP712 } from "../../libraries/LibInstantLayerEIP712.sol";
import { LibInstantLayerAccount } from "../../libraries/LibInstantLayerAccount.sol";
import { LibInstantLayerDelegation } from "../../libraries/LibInstantLayerDelegation.sol";
import { ISymmio } from "../../interfaces/ISymmio.sol";
import { ISymmioPartyB } from "../../interfaces/ISymmioPartyB.sol";
import { IDelegationFacet } from "../Delegation/IDelegationFacet.sol";
import { IAccountLayerDiamond } from "../../../accountLayer/interfaces/IAccountLayerDiamond.sol";
import { ICoreFacet } from "../../../accountLayer/facets/Core/ICoreFacet.sol";
import { ITimelockFacet } from "../../../accountLayer/facets/Timelock/ITimelockFacet.sol";

/// @notice Operator-gated execution facet for the InstantLayer diamond
/// @dev executeBatch and executeTemplate are the diamond's only reentrancy-guarded entry points:
///      each opens a core authority scope for the whole call and must close it before returning,
///      so a reentrant call mid-batch could otherwise nest authority scopes or leave one open.
///      Delegation reads and grant writes go through LibInstantLayerDelegation, shared with the
///      delegation and view facets.
contract ExecutionFacet is IExecutionFacet, InstantLayerAccessibility, InstantLayerReentrancyGuard {
	/// @notice Execute a sequence of operations using a predefined template.
	/// @dev Operations are executed in order with automatic result injection.
	///      All operations must succeed for the transaction to complete.
	function executeTemplate(
		uint256 templateId,
		SignedOperation[] calldata signedOps,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexFillerSignatures
	) external nonReentrant onlyRole(LibInstantLayerAccessibility.OPERATOR_ROLE) returns (bytes[] memory results) {
		TemplateStorage.Layout storage tl = TemplateStorage.layout();
		if (templateId >= tl.nextTemplateId) revert InvalidTemplate(templateId);
		if (signedOps.length != signatures.length) revert ArrayLengthMismatch();
		if (signedOps.length != fills.length) revert ArrayLengthMismatch();
		if (signedOps.length != flexFillerSignatures.length) revert ArrayLengthMismatch();

		Template storage template = tl.templates[templateId];
		if (!template.active) revert TemplateNotActive(templateId);
		if (signedOps.length != template.operations.length) revert TemplateOperationLengthMismatch();

		// One core authority scope wraps the entire template. The flag selects between
		// the native begin/end interface and the historical setter-compatible interface;
		// both routes use transient storage in this build.
		ISymmio symmio = ISymmio(InstantLayerStorage.layout().symmio);
		bool useInstantOpen = tl.templateInstantOpenMode[templateId];
		bool usesNativeContextSelectors = InstantLayerStorage.layout().transientContextEnabled;
		if (usesNativeContextSelectors) {
			symmio.beginInstantLayerExecution(useInstantOpen);
		} else {
			symmio.setCallFromInstantLayer(true);
			if (useInstantOpen) {
				symmio.setInstantOpenMode(true);
			}
		}

		results = new bytes[](signedOps.length);

		bool success = true;
		for (uint256 i = 0; i < signedOps.length && success; i++) {
			Operation memory op = template.operations[i];
			SignedOperation calldata signedOp = signedOps[i];

			// Verify operation signature and parameters
			bytes32 opHash = _verifySignedOperation(signedOp, signatures[i]);

			// Apply flex field fills first, then inject template results
			bytes memory finalCallData = _applyFlexFills(signedOp, fills[i], flexFillerSignatures[i], opHash);
			finalCallData = _insertResults(finalCallData, op.insertionPoints, op.sourceIndices, op.sourceOffsets, results);

			// Execute the operation and capture result
			(success, results[i]) = _executeOperationSafe(signedOp, finalCallData, usesNativeContextSelectors);

			if (!success) {
				revert OperationFailed(i, results[i]);
			}
		}

		// Close the same mechanism that opened the scope, so a later call in an outer
		// multicast cannot inherit this batch's authority.
		if (usesNativeContextSelectors) {
			symmio.endInstantLayerExecution();
		} else {
			if (useInstantOpen) {
				symmio.setInstantOpenMode(false);
			}
			symmio.setCallFromInstantLayer(false);
		}
	}

	/// @notice Execute a batch of independent operations.
	/// @dev Operations are executed sequentially without result chaining.
	///      All operations must succeed for the transaction to complete.
	function executeBatch(
		SignedOperation[] calldata signedOps,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexFillerSignatures
	) external nonReentrant onlyRole(LibInstantLayerAccessibility.OPERATOR_ROLE) returns (bytes[] memory results) {
		if (signedOps.length == 0) revert EmptyBatch();
		if (signedOps.length != signatures.length) revert ArrayLengthMismatch();
		if (signedOps.length != fills.length) revert ArrayLengthMismatch();
		if (signedOps.length != flexFillerSignatures.length) revert ArrayLengthMismatch();

		// Independent batches still need one shared routing-authority scope, but never
		// enable the atomic-open accounting mode reserved for configured templates.
		ISymmio symmio = ISymmio(InstantLayerStorage.layout().symmio);
		bool usesNativeContextSelectors = InstantLayerStorage.layout().transientContextEnabled;
		if (usesNativeContextSelectors) {
			symmio.beginInstantLayerExecution(false);
		} else {
			symmio.setCallFromInstantLayer(true);
		}

		results = new bytes[](signedOps.length);

		bool success = true;
		for (uint256 i = 0; i < signedOps.length && success; i++) {
			// Verify each operation independently
			bytes32 opHash = _verifySignedOperation(signedOps[i], signatures[i]);

			// Apply flex field fills
			bytes memory callData = _applyFlexFills(signedOps[i], fills[i], flexFillerSignatures[i], opHash);

			// Execute with (potentially modified) calldata
			(success, results[i]) = _executeOperationSafe(signedOps[i], callData, usesNativeContextSelectors);

			if (!success) {
				revert OperationFailed(i, results[i]);
			}
		}

		if (usesNativeContextSelectors) {
			symmio.endInstantLayerExecution();
		} else {
			symmio.setCallFromInstantLayer(false);
		}
	}

	/// @dev Verifies operation signatures and parameters.
	///
	/// Verification Steps:
	/// 1. Check deadline hasn't expired
	/// 2. Validate calldata minimum length
	/// 3. Verify target is whitelisted, or is the layer itself carrying a delegation grant
	/// 4. Verify PartyB registration or resolve the PartyA account owner (delegation is checked on final calldata)
	/// 5. Verify EIP-712 signature
	/// 6. Prevent replay attacks
	/// 7. Update nonce if required
	function _verifySignedOperation(SignedOperation calldata signedOp, bytes calldata sigCallData) private returns (bytes32) {
		// Check expiry
		if (signedOp.replayAttackHeader.deadline != 0 && signedOp.replayAttackHeader.deadline < block.timestamp)
			revert DeadlineExpired(signedOp.replayAttackHeader.deadline);

		// Validate calldata has at least selector
		if (signedOp.callData.length < 4) revert CallDataLengthMismatch();

		InstantLayerStorage.Layout storage l = InstantLayerStorage.layout();

		if (signedOp.target == address(this)) {
			// Self-targeted operations are only valid as delegation grants
			_verifyGrantOperation(signedOp);
		} else if (!l.whitelistedTargets[signedOp.target]) {
			revert TargetNotWhitelisted(signedOp.target);
		}

		bytes32 hash = LibInstantLayerEIP712.hashOperation(signedOp);
		address signer = signedOp.signer;

		if (signedOp.signerAccount.isPartyB) {
			if (signer != signedOp.signerAccount.addr) revert MismatchSignerAndAccount(signer, signedOp.signerAccount.addr);
			if (!l.registeredPartyBs[signer]) revert UnregisteredPartyB(signer);
		} else {
			// Resolve the signed account now; selector authorization follows all calldata mutations.
			LibInstantLayerAccount.getAccountOwner(signedOp.signerAccount.addr);
		}

		// Verify signature - skip if signer is the executor (msg.sender proves identity)
		// PartyA delegation is checked immediately before executing the final calldata.
		if (signer != msg.sender) {
			if (!SignatureChecker.isValidSignatureNow(signer, hash, sigCallData)) {
				revert InvalidSignature();
			}
		}

		// Replay protection: unified for all operations via maxUses
		uint256 currentUsage = l.operationUsageCount[hash];
		if (signedOp.maxUses > 0 && currentUsage >= signedOp.maxUses) {
			revert MaxUsesExceeded(hash, signedOp.maxUses);
		}
		l.operationUsageCount[hash] = currentUsage + 1;

		// Handle nonce if enabled (non-zero)
		if (signedOp.replayAttackHeader.nonce != 0) {
			uint256 expectedNonce = l.nonces[signedOp.signerAccount.addr] + 1;
			if (signedOp.replayAttackHeader.nonce != expectedNonce) {
				revert InvalidNonce(signedOp.signerAccount.addr, expectedNonce, signedOp.replayAttackHeader.nonce);
			}
			l.nonces[signedOp.signerAccount.addr]++;
			emit NonceIncremented(signedOp.signerAccount.addr, l.nonces[signedOp.signerAccount.addr]);
		}

		return hash;
	}

	/// @dev Resolves delegation from the final calldata, after flex fills and template insertions. Nested timelock
	///      wrappers carry approvals, so authorization follows their inner calldata rather than the wrapper selector.
	function _delegatedSelector(address target, bytes memory callData) private view returns (bytes4 selector) {
		address accountLayer = InstantLayerStorage.layout().accountLayer;
		uint256 start;
		uint256 length = callData.length;
		if (length < 4) revert InvalidDelegation();
		assembly ("memory-safe") {
			selector := mload(add(callData, 32))
		}
		while (target == accountLayer && selector == ITimelockFacet.executeTimelockOp.selector) {
			// Offsets are relative to this wrapper's arguments, including when it is nested.
			if (length < 68) revert InvalidDelegation();
			uint256 innerOffset;
			assembly ("memory-safe") {
				innerOffset := mload(add(callData, add(start, 68)))
			}
			if (innerOffset > length - 36) revert InvalidDelegation();
			uint256 dataPos = start + 36 + innerOffset;
			uint256 innerLength;
			assembly ("memory-safe") {
				innerLength := mload(add(callData, dataPos))
			}
			if (innerLength < 4 || innerLength > length - 36 - innerOffset) revert InvalidDelegation();
			start = dataPos;
			length = innerLength;
			assembly ("memory-safe") {
				selector := mload(add(callData, add(start, 32)))
			}
		}
	}

	/// @dev Signed-operation verification authenticates the signer; authorization must use the bytes about to execute.
	function _verifyFinalDelegation(SignedOperation calldata signedOp, bytes memory callData) private view {
		if (signedOp.signerAccount.isPartyB) return;
		if (LibInstantLayerAccount.getAccountOwner(signedOp.signerAccount.addr) == signedOp.signer) return;
		bytes4 selector = _delegatedSelector(signedOp.target, callData);
		address delegator = LibInstantLayerAccount.canonicalDelegator(signedOp.signerAccount.addr);
		if (!LibInstantLayerDelegation.isDelegationActive(delegator, signedOp.signer, selector)) revert InvalidDelegation();
	}

	/// @dev Validates the shape of a self-targeted delegation-grant operation.
	///
	/// Grant Operation Rules:
	/// - Only the `grantDelegation` and `grantDelegations` selectors may target the layer.
	/// - The signer must be the account owner. A delegate can never mint further delegations.
	/// - maxUses must be 1: re-granting clears pending revocations, so a replayable grant
	///   could silently cancel a scheduled revocation.
	/// - Flex fields are forbidden so no third party can modify the grant after signing.
	function _verifyGrantOperation(SignedOperation calldata signedOp) private view {
		bytes calldata callData = signedOp.callData;
		bytes4 selector;
		assembly ("memory-safe") {
			selector := calldataload(callData.offset)
		}
		if (selector != IDelegationFacet.grantDelegation.selector && selector != IDelegationFacet.grantDelegations.selector) {
			revert InvalidGrantOperation();
		}
		if (signedOp.signerAccount.isPartyB) revert InvalidDelegation();
		if (signedOp.flexFields.length != 0 || signedOp.maxUses != 1) revert InvalidGrantOperation();
		if (LibInstantLayerAccount.getAccountOwner(signedOp.signerAccount.addr) != signedOp.signer) revert InvalidDelegation();
	}

	/// @dev Applies a delegation grant carried as a signed operation.
	///      Decodes from the original signed calldata, never the fill- or injection-modified copy,
	///      so neither flex fills nor template result-injection can alter the grant parameters.
	function _executeGrantOperation(SignedOperation calldata signedOp) private returns (bool success, bytes memory result) {
		address account = signedOp.signerAccount.addr;
		if (bytes4(signedOp.callData[:4]) == IDelegationFacet.grantDelegation.selector) {
			DelegationInfo memory info = abi.decode(signedOp.callData[4:], (DelegationInfo));
			LibInstantLayerDelegation.applyAccountGrant(info, account, signedOp.signer);
		} else {
			DelegationInfo[] memory infos = abi.decode(signedOp.callData[4:], (DelegationInfo[]));
			if (infos.length == 0) revert InvalidDelegation();
			for (uint256 i = 0; i < infos.length; i++) {
				LibInstantLayerDelegation.applyAccountGrant(infos[i], account, signedOp.signer);
			}
		}
		return (true, result);
	}

	/// @dev Execute an operation with proper routing and error handling.
	/// @param signedOp Signed operation containing routing information
	/// @param callData Prepared calldata (may include injected results)
	/// @param usesNativeContextSelectors Whether this batch began with the native begin/end selector path
	/// @return success True if operation succeeded
	/// @return result  Return data from the operation
	function _executeOperationSafe(
		SignedOperation calldata signedOp,
		bytes memory callData,
		bool usesNativeContextSelectors
	) private returns (bool success, bytes memory result) {
		if (signedOp.target == address(this)) {
			// Delegation grant carried as a signed operation; validated in _verifyGrantOperation
			return _executeGrantOperation(signedOp);
		}

		_verifyFinalDelegation(signedOp, callData);

		bytes[] memory callDatas = new bytes[](1);
		callDatas[0] = callData;

		bool decodeNestedResult;
		InstantLayerStorage.Layout storage l = InstantLayerStorage.layout();
		address accountLayer = l.accountLayer;

		if (signedOp.signerAccount.isPartyB) {
			// Route to PartyB
			(success, result) = signedOp.signer.call(abi.encodeWithSelector(ISymmioPartyB._call.selector, callDatas));
		} else if (signedOp.target == l.symmio || signedOp.target == accountLayer) {
			// Route to AccountLayer (wrapping Symmio calls via _call, or direct AL calls)
			if (accountLayer == address(0)) revert AccountLayerNotSet();
			address owner = LibInstantLayerAccount.getAccountOwner(signedOp.signerAccount.addr);
			// The AccountLayer signer is the owner, which by itself authorizes every account that owner
			// holds. When a delegate is driving the operation, hand the AccountLayer the account family
			// the delegation was granted over so it can reject anything outside it. Owners stay unscoped.
			// AccountLayer must use the same signer lifetime as the surrounding core scope. Mixing
			// the two selector protocols would leave ambiguous authority.
			address scope = signedOp.signer == owner ? address(0) : LibInstantLayerAccount.canonicalDelegator(signedOp.signerAccount.addr);
			if (usesNativeContextSelectors) {
				IAccountLayerDiamond(accountLayer).setTransientSignerScoped(owner, scope);
			} else {
				IAccountLayerDiamond(accountLayer).setSignerScoped(owner, scope);
			}
			if (signedOp.target == l.symmio) {
				(success, result) = accountLayer.call(abi.encodeWithSelector(ICoreFacet._call.selector, signedOp.signerAccount.addr, callDatas));
				decodeNestedResult = true;
			} else {
				(success, result) = accountLayer.call(callData);
			}
			if (usesNativeContextSelectors) {
				IAccountLayerDiamond(accountLayer).setTransientSigner(address(0));
			} else {
				IAccountLayerDiamond(accountLayer).setSigner(address(0));
			}
		} else {
			// Route to a whitelisted target
			(success, result) = signedOp.target.call(callData);
		}

		// Decode nested result array
		if (decodeNestedResult && success && result.length > 0) {
			bytes[] memory arr = abi.decode(result, (bytes[]));
			result = arr[0];
		}
	}

	/// @dev Inject results from previous operations into calldata.
	///
	/// This function enables complex operation chaining by automatically
	/// inserting return values from earlier operations into the calldata
	/// of later operations at specified byte offsets.
	function _insertResults(
		bytes memory callData,
		uint256[] memory insertionPoints,
		uint256[] memory sourceIndices,
		uint256[] memory sourceOffsets,
		bytes[] memory results
	) private pure returns (bytes memory) {
		if (insertionPoints.length == 0) return callData;

		// Work directly on the memory buffer (already mutable)
		bytes memory modifiedCallData = callData;

		// Insert each result at its designated position
		for (uint256 i = 0; i < insertionPoints.length; i++) {
			if (sourceIndices[i] < results.length) {
				bytes memory res = results[sourceIndices[i]];
				uint256 sourceOffset = sourceOffsets[i];

				if (res.length == 0) revert MissingSourceResult();
				if (res.length < sourceOffset + 32) revert BadSourceResultLength(res, res.length);

				// Extract 32 bytes from the result at the specified offset
				bytes32 value;
				assembly ("memory-safe") {
					value := mload(add(add(res, 32), sourceOffset))
				}

				uint256 offset = insertionPoints[i];
				if (offset + 36 > modifiedCallData.length) revert InsertionPointOutOfBounds(offset + 32, modifiedCallData.length);

				// Insert at calldata offset + 4 (selector) + 32 (length); the bounds check above
				// guarantees this 32-byte write lands entirely within modifiedCallData's declared
				// length, so it never touches memory the allocation doesn't already own.
				assembly ("memory-safe") {
					mstore(add(modifiedCallData, add(36, offset)), value)
				}
			} else {
				revert InvalidSourceIndex(sourceIndices[i]);
			}
		}

		return modifiedCallData;
	}

	/// @dev Apply flex field fill values to operation calldata.
	/// @param signedOp       The signed operation with flex field definitions
	/// @param fill           Fill values from flex fillers (one per flex field; empty bytes to skip)
	/// @param flexFillerSigs Per-field flex filler signatures (empty if filler == msg.sender)
	/// @param opHash         The operation hash (for flex filler auth verification)
	/// @return callData      Modified calldata with fill values injected
	function _applyFlexFills(
		SignedOperation calldata signedOp,
		bytes[] calldata fill,
		bytes[] calldata flexFillerSigs,
		bytes32 opHash
	) private view returns (bytes memory callData) {
		callData = signedOp.callData; // copy to memory

		if (signedOp.flexFields.length == 0) return callData;

		if (fill.length != signedOp.flexFields.length) {
			revert InvalidFlexFillLength(signedOp.flexFields.length, fill.length);
		}
		if (flexFillerSigs.length != signedOp.flexFields.length) revert ArrayLengthMismatch();

		for (uint256 i = 0; i < signedOp.flexFields.length; i++) {
			FlexField calldata field = signedOp.flexFields[i];
			bytes calldata value = fill[i];

			// Validate field bounds within calldata (always, even for empty fills)
			if (field.offset + field.length + 4 > callData.length) {
				revert FlexFieldOutOfBounds(field.offset, field.length, callData.length);
			}

			// Empty fill value = keep original calldata bytes (filler accepts user's value)
			if (value.length == 0) continue;

			// Validate fill value length matches field length
			if (value.length != field.length) {
				revert InvalidFlexFillValueLength(i, field.length, value.length);
			}

			// Verify flex filler authorization
			if (field.authorizedFlexFiller != msg.sender) {
				bytes32 fillHash = LibInstantLayerEIP712.hashFlexFillAuth(opHash, i, value);
				if (!SignatureChecker.isValidSignatureNow(field.authorizedFlexFiller, fillHash, flexFillerSigs[i])) {
					revert InvalidFlexFillerSignature(i);
				}
			}

			// Inject fill value at the specified offset (after 4-byte selector)
			uint256 insertPos = 4 + field.offset;
			assembly ("memory-safe") {
				calldatacopy(add(add(callData, 32), insertPos), value.offset, value.length)
			}
		}
	}
}
