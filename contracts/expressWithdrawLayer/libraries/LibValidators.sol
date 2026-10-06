// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import { ISymmio } from "../interfaces/ISymmio.sol";
import { LibAccessControl } from "./LibAccessControl.sol";
import { LibErrors } from "./LibErrors.sol";
import { GlobalStorage } from "../storages/GlobalStorage.sol";
import { ValidatorStorage } from "../storages/ValidatorStorage.sol";

/// @title LibValidators
/// @notice Shared validator-quorum verification for the ExpressProvider diamond.
library LibValidators {
	/// @dev Returns the minValidatorSignatures for the affiliate, falling back to address(0) default.
	function getMinValidatorSignatures(address affiliate) internal view returns (uint256) {
		ValidatorStorage.Layout storage v = ValidatorStorage.layout();
		uint256 val = v.minValidatorSignatures[affiliate];
		if (val > 0) return val;
		return v.minValidatorSignatures[address(0)];
	}

	/// @dev Returns the validatorApprovalTimeout for the affiliate, falling back to address(0) default.
	function getValidatorApprovalTimeout(address affiliate) internal view returns (uint256) {
		ValidatorStorage.Layout storage v = ValidatorStorage.layout();
		uint256 val = v.validatorApprovalTimeout[affiliate];
		if (val > 0) return val;
		return v.validatorApprovalTimeout[address(0)];
	}

	/// @dev Returns true if signer is a validator for the affiliate or the default (address(0)).
	function isValidator(address affiliate, address signer) internal view returns (bool) {
		ValidatorStorage.Layout storage v = ValidatorStorage.layout();
		return v.validators[affiliate][signer] || v.validators[address(0)][signer];
	}

	/// @notice Verifies the validator quorum for a withdraw acceptance. Every approval must be
	///         signed strictly after the user's last protocol-internal balance credit
	///         (deallocate / internalTransferToBalance), read from core as
	///         `withdrawCooldownOf(user)`, so PnL landing in the withdrawable balance after
	///         attestation invalidates the approval and forces re-validation.
	function validateWithdrawApprovals(address affiliate, address user, uint256 nonce, uint256 amount, bytes memory validatorData) internal view {
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		(bytes[] memory signatures, uint256[] memory timestamps) = abi.decode(validatorData, (bytes[], uint256[]));
		_checkQuorumShape(affiliate, signatures.length, timestamps.length);

		uint256 lastBalanceCredit = ISymmio(g.symmio).withdrawCooldownOf(user);
		uint256 timeout = getValidatorApprovalTimeout(affiliate);
		address lastSigner = address(0);
		for (uint256 i = 0; i < signatures.length; i++) {
			_checkTimestamp(timestamps[i], timeout);
			if (timestamps[i] <= lastBalanceCredit) revert LibErrors.StaleValidatorApproval();

			bytes32 structHash = keccak256(abi.encode(LibAccessControl.VALIDATOR_APPROVAL_TYPEHASH, user, nonce, amount, timestamps[i], g.symmio));
			lastSigner = _recoverAndCheck(affiliate, structHash, signatures[i], lastSigner);
		}
	}

	/// @notice Verifies the validator quorum for accelerating a STANDARD withdrawal. Approvals bind
	///         the frozen request (user, requestId, partsHash). The payout amount cannot change,
	///         since requestWithdraw already debited the balance and pinned the parts.
	/// @dev    The same last-balance-credit freshness rule as the accept path applies here, and it
	///         matters more, not less: STANDARD acceptance skips validators entirely, so this is the
	///         first and only attestation this withdrawal ever gets, and it gates the moment credit
	///         is advanced and pools are drained. Acceleration is permissionless, so without this a
	///         user could front-run their own accelerate tx with a dirty deallocate and have funds
	///         advanced against a state no validator ever saw. The approval timeout alone does not
	///         close that window.
	function validateAccelerateApprovals(
		address affiliate,
		address user,
		uint256 requestId,
		bytes32 partsHash,
		bytes memory validatorData
	) internal view {
		GlobalStorage.Layout storage g = GlobalStorage.layout();
		(bytes[] memory signatures, uint256[] memory timestamps) = abi.decode(validatorData, (bytes[], uint256[]));
		_checkQuorumShape(affiliate, signatures.length, timestamps.length);

		uint256 lastBalanceCredit = ISymmio(g.symmio).withdrawCooldownOf(user);
		uint256 timeout = getValidatorApprovalTimeout(affiliate);
		address lastSigner = address(0);
		for (uint256 i = 0; i < signatures.length; i++) {
			_checkTimestamp(timestamps[i], timeout);
			if (timestamps[i] <= lastBalanceCredit) revert LibErrors.StaleValidatorApproval();

			bytes32 structHash = keccak256(
				abi.encode(LibAccessControl.VALIDATOR_ACCELERATE_APPROVAL_TYPEHASH, user, requestId, partsHash, timestamps[i], g.symmio)
			);
			lastSigner = _recoverAndCheck(affiliate, structHash, signatures[i], lastSigner);
		}
	}

	function _checkQuorumShape(address affiliate, uint256 sigCount, uint256 tsCount) private view {
		if (sigCount != tsCount) revert LibErrors.ArrayLengthMismatch();
		if (sigCount < getMinValidatorSignatures(affiliate)) revert LibErrors.InsufficientValidatorSignatures();
	}

	function _checkTimestamp(uint256 timestamp, uint256 timeout) private view {
		if (timestamp > block.timestamp || block.timestamp - timestamp > timeout) revert LibErrors.ValidatorApprovalExpired();
	}

	function _recoverAndCheck(
		address affiliate,
		bytes32 structHash,
		bytes memory signature,
		address lastSigner
	) private view returns (address signer) {
		signer = ECDSA.recover(LibAccessControl.hashTypedDataV4(structHash), signature);
		if (!isValidator(affiliate, signer)) revert LibErrors.InvalidValidator();
		if (signer <= lastSigner) revert LibErrors.DuplicateValidator();
	}
}
