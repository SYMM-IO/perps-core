// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

contract RejectNativeReceiver {
	receive() external payable {
		revert("RejectNativeReceiver: rejected");
	}
}
