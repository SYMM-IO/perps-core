// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license

pragma solidity >=0.8.18;

import "../interfaces/IExpressProvider.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISymmioCore {
	function acceptWithdrawRequest(address user, uint256 requestId) external;
	function acceptWithdrawCancelRequest(address user, uint256 requestId) external;
	function finalizeWithdrawRequest(address user, uint256 requestId) external;
}

contract ExpressProvider is IExpressProvider {
	address public symmioAddress;

	constructor(address _symmioAddress) {
		symmioAddress = _symmioAddress;
	}

	function finalizeWithdrawRequest(address user, uint256 requestId) external {
		ISymmioCore(symmioAddress).finalizeWithdrawRequest(user, requestId);
	}

	function acceptWithdrawRequest(address user, uint256 requestId) external {
		ISymmioCore(symmioAddress).acceptWithdrawRequest(user, requestId);
	}

	function acceptWithdrawCancelRequest(address user, uint256 requestId) external {
		ISymmioCore(symmioAddress).acceptWithdrawCancelRequest(user, requestId);
	}

	function onWithdrawRequest(WithdrawRequest memory withdrawRequest, address collateral) external {
		bool isExpressProvider = false;
		for (uint i = 0; i < withdrawRequest.parts.length; i++) {
			WithdrawReceiverPart memory part = withdrawRequest.parts[i];
			if (part.expressProvider == address(this)) {
				if(part.virtualProvider == address(0))
					IERC20(collateral).transfer(_bytesToAddress(part.receiver), part.amount);
				isExpressProvider = true;
			}
		}
		require(isExpressProvider, "No parts for this express provider");
	}
	function onWithdrawComplete(WithdrawRequest memory withdrawRequest) external {
		require(withdrawRequest.status == WithdrawStatus.PROVIDER_ACCEPTED, "Withdraw not accepted");
	}

	function onWithdrawCancelRequest(WithdrawRequest memory withdrawRequest) external {
		require(withdrawRequest.status == WithdrawStatus.CANCEL_REQUESTED, "Withdraw not cancel requested");
	}

	function _bytesToAddress(bytes memory data) internal pure returns (address addr) {
		require(data.length == 20, "Invalid address bytes length");
		assembly {
			addr := shr(96, mload(add(data, 32)))
		}
	}
}
