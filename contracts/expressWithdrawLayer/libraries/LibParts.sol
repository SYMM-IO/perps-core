// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { ComputedAmounts } from "../types/OptionTypes.sol";
import { WithdrawReceiverPart } from "../../core/storages/WithdrawStorage.sol";

import { LibErrors } from "./LibErrors.sol";

import { GlobalStorage } from "../storages/GlobalStorage.sol";

/// @title LibParts
/// @notice Withdrawal parts iteration logic — computes amounts and transfers.
/// @dev Accesses storage directly via GlobalStorage.layout().
library LibParts {
	using SafeERC20 for IERC20;

	error InvalidAddressBytesLength();

	/// @dev Computes how much comes from express pools vs credit line.
	function computeAmounts(
		WithdrawReceiverPart[] memory parts,
		uint256 affiliateAmount,
		uint256 creditAmount
	) internal view returns (ComputedAmounts memory amounts) {
		for (uint256 i = 0; i < parts.length; i++) {
			if (parts[i].expressProvider == address(this)) {
				if (parts[i].virtualProvider != address(0)) revert LibErrors.VirtualProviderMustBeZero();
				amounts.expressAmount += parts[i].amount;
			}
		}
		if (affiliateAmount + creditAmount > amounts.expressAmount) revert LibErrors.FundingSplitExceedsExpress();
		amounts.generalAmount = amounts.expressAmount - affiliateAmount - creditAmount;
	}

	/// @dev Iterates parts and transfers funds to each receiver, deducting the userFee.
	function transferToReceivers(WithdrawReceiverPart[] memory parts, uint256 userFee) internal {
		IERC20 collateral = GlobalStorage.layout().collateral;
		uint256 feeRemaining = userFee;

		for (uint256 i = 0; i < parts.length; i++) {
			if (parts[i].expressProvider != address(this)) continue;
			if (parts[i].virtualProvider != address(0)) revert LibErrors.VirtualProviderMustBeZero();

			address receiver = bytesToAddress(parts[i].receiver);

			uint256 deduction = feeRemaining < parts[i].amount ? feeRemaining : parts[i].amount;
			feeRemaining -= deduction;

			uint256 toSend = parts[i].amount - deduction;
			if (toSend > 0) collateral.safeTransfer(receiver, toSend);
		}
	}

	/// @dev Converts a 20-byte `bytes` value to an `address`.
	function bytesToAddress(bytes memory data) internal pure returns (address addr) {
		if (data.length != 20) revert InvalidAddressBytesLength();
		assembly {
			addr := shr(96, mload(add(data, 32)))
		}
	}
}
