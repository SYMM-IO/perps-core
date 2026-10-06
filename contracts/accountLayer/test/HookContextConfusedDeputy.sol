// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

interface IExecuteForAccount {
	function executeForAccount(bytes calldata callData) external;
}

contract DownstreamExecuteForAccountCaller {
	function callExecuteForAccount(address accountLayer, bytes calldata callData) external {
		IExecuteForAccount(accountLayer).executeForAccount(callData);
	}
}

contract ForwardingAccountLayerHook {
	address public accountLayer;
	address public downstreamCaller;
	bytes public executeForAccountCallData;

	function configure(address _accountLayer, address _downstreamCaller, bytes calldata _executeForAccountCallData) external {
		accountLayer = _accountLayer;
		downstreamCaller = _downstreamCaller;
		executeForAccountCallData = _executeForAccountCallData;
	}

	function onAccountCreation(address, address, bytes calldata) external returns (bool) {
		DownstreamExecuteForAccountCaller(downstreamCaller).callExecuteForAccount(accountLayer, executeForAccountCallData);
		return true;
	}
}
