// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
pragma solidity >=0.8.18;

import { IExpressProvider } from "../interfaces/IExpressProvider.sol";
import { WithdrawRequest, WithdrawReceiverPart } from "../storages/WithdrawStorage.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISymmioCore {
	function acceptWithdrawRequest(address user, uint256 requestId) external;
	function acceptWithdrawCancelRequest(address user, uint256 requestId) external;
	function finalizeWithdrawRequest(address user, uint256 requestId) external;
	function rejectWithdrawRequest(address user, uint256 requestId) external;
}

contract ExpressProvider is IExpressProvider {
	address public symmioAddress;

	event WithdrawSuspended(address indexed user, uint256 indexed requestId);

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

	function rejectWithdrawRequest(address user, uint256 requestId) external {
		ISymmioCore(symmioAddress).rejectWithdrawRequest(user, requestId);
	}

	function onWithdrawRequest(WithdrawRequest memory withdrawRequest, address collateral) external override {
		bool isExpressProvider = false;
		for (uint i = 0; i < withdrawRequest.parts.length; i++) {
			WithdrawReceiverPart memory part = withdrawRequest.parts[i];
			if (part.expressProvider == address(this)) {
				if (part.virtualProvider == address(0)) {
					IERC20(collateral).transfer(_bytesToAddress(part.receiver), part.amount);
				}
				isExpressProvider = true;
			}
		}
		require(isExpressProvider, "No parts for this express provider");
	}

	function onWithdrawComplete(WithdrawRequest memory _req) external override pure {
		_req;
		// no logic → pure
	}

	function onWithdrawCancelRequest(WithdrawRequest memory _req) external override pure {
		_req;
	}

	function onWithdrawSuspend(WithdrawRequest memory _req) external override {
		emit WithdrawSuspended(_req.user, _req.id);
	}

	function _bytesToAddress(bytes memory data) internal pure returns (address addr) {
		require(data.length == 20, "Invalid address bytes length");
		assembly {
			addr := shr(96, mload(add(data, 32)))
		}
	}
}
