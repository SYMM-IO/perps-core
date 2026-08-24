// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

import { IGaslessLayer } from "../interfaces/IGaslessLayer.sol";
import { ISymmioCore } from "../interfaces/ISymmioCore.sol";

/// @title GaslessOperationalFeeLib
/// @notice Compatibility and quoting helpers for core-owned operational-fee allowance state.
library GaslessOperationalFeeLib {
	uint256 internal constant FEE_MULTIPLIER_BASE = 10000;

	/// @notice Read the effective multiplier from either supported core allowance-view response.
	/// @dev The current checkout returns six words with the multiplier sixth. The latest consumable-
	///      allowance core returns four words with the multiplier fourth.
	function coreOperationalFeeMultiplier(address core, address account, address charger) external view returns (uint256 feeMultiplier) {
		return _coreOperationalFeeMultiplier(core, account, charger);
	}

	/// @notice Quote an approval-only batch against the multiplier it establishes before fee collection.
	function postApprovalOperationalFee(
		address core,
		address account,
		address charger,
		bytes calldata callData,
		uint256 baseFee
	) external view returns (uint256 fee) {
		bytes4 selector = bytes4(callData[:4]);
		uint256 feeMultiplier = _coreOperationalFeeMultiplier(core, account, charger);
		if (selector == ISymmioCore.approveOperationalFeeWithMultiplier.selector) {
			(address[] memory chargers, uint256[] memory amounts, uint256[] memory feeMultipliers) = abi.decode(
				callData[4:],
				(address[], uint256[], uint256[])
			);
			if (chargers.length != amounts.length || chargers.length != feeMultipliers.length) revert IGaslessLayer.ArrayLengthMismatch();
			for (uint256 i = 0; i < chargers.length; i++) {
				if (chargers[i] == charger) {
					feeMultiplier = feeMultipliers[i] == 0 ? FEE_MULTIPLIER_BASE : feeMultipliers[i];
				}
			}
		}
		fee = (baseFee * feeMultiplier) / FEE_MULTIPLIER_BASE;
	}

	function _coreOperationalFeeMultiplier(address core, address account, address charger) private view returns (uint256 feeMultiplier) {
		(bool success, bytes memory result) = core.staticcall(
			abi.encodeWithSelector(ISymmioCore.getOperationalFeeAllowance.selector, account, charger)
		);
		if (!success) {
			assembly ("memory-safe") {
				revert(add(result, 32), mload(result))
			}
		}
		if (result.length == 4 * 32) {
			assembly ("memory-safe") {
				feeMultiplier := mload(add(result, 128))
			}
		} else if (result.length == 6 * 32) {
			assembly ("memory-safe") {
				feeMultiplier := mload(add(result, 192))
			}
		} else {
			revert();
		}
	}
}
