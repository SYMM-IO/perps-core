// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

contract RejectNativeReceiver {
	receive() external payable {
		revert("RejectNativeReceiver: rejected");
	}
}
