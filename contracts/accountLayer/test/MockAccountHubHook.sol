// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

interface ICoreFacetCallback {
	function executeForAccount(bytes calldata callData) external;
}

/**
 * @title MockAccountHubHook
 * @notice Mock implementation of IAccountHubHook for testing AccountHub hook functionality
 * @dev Implements all hook functions and provides testing utilities to verify hook calls
 */
contract MockAccountHubHook {
	// ==================== Structs ====================

	struct HookCall {
		bytes4 selector;
		bytes data;
		uint256 timestamp;
		uint256 callCount;
	}

	// ==================== State Variables ====================

	/// @notice Records all hook calls made
	HookCall[] public hookCalls;

	/// @notice Maps selector to total number of times it was called
	mapping(bytes4 => uint256) public selectorCallCount;

	/// @notice Maps selector to whether it should revert
	mapping(bytes4 => bool) public shouldRevert;

	/// @notice Maps selector to custom revert message
	mapping(bytes4 => string) public revertMessages;

	/// @notice Maps selector to return value
	mapping(bytes4 => bool) public returnValues;

	/// @notice Maps account address to whether hook was called for it
	mapping(address => bool) public accountHookCalled;

	/// @notice Tracks the last account that triggered each hook type
	mapping(bytes4 => address) public lastAccountForSelector;

	/// @notice Whether to record calls (can be disabled for gas testing)
	bool public recordCalls;

	/// @notice AccountHub address for executeForAccount callback
	address public accountHub;

	/// @notice Maps selector to calldata to execute via executeForAccount
	mapping(bytes4 => bytes) public executeForAccountCallData;

	/// @notice Maps selector to whether executeForAccount should be called
	mapping(bytes4 => bool) public shouldExecuteForAccount;

	/// @notice Tracks successful executeForAccount calls
	uint256 public executeForAccountCallCount;

	/// @notice Last executeForAccount result
	bool public lastExecuteForAccountSuccess;

	// ==================== Events ===================

	// ==================== Constructor ====================

	constructor() {
		recordCalls = true;
	}

	// ==================== Hook Functions ====================

	function onAccountCreation(address user, address account, bytes memory metadata) external returns (bool) {
		bytes4 selector = this.onAccountCreation.selector;
		if (shouldRevert[selector]) {
			revert(revertMessages[selector]);
		}

		accountHookCalled[account] = true;
		lastAccountForSelector[selector] = account;
		selectorCallCount[selector]++;

		if (recordCalls) {
			hookCalls.push(
				HookCall({
					selector: selector,
					data: abi.encode(user, account, metadata),
					timestamp: block.timestamp,
					callCount: selectorCallCount[selector]
				})
			);
		}

		// Execute callback if configured
		if (shouldExecuteForAccount[selector] && accountHub != address(0)) {
			bytes memory callData = executeForAccountCallData[selector];
			if (callData.length > 0) {
				ICoreFacetCallback(accountHub).executeForAccount(callData);
				executeForAccountCallCount++;
				lastExecuteForAccountSuccess = true;
			}
		}

		return returnValues[selector];
	}

	/**
	 * @notice Hook called when a virtual account is created
	 * @param virtualAccount The virtual account address
	 * @param parent The parent account address
	 * @return bool Success indicator
	 */
	function onVirtualAccountCreation(address virtualAccount, address parent, bytes memory metadata) external returns (bool) {
		bytes4 selector = this.onVirtualAccountCreation.selector;

		if (shouldRevert[selector]) {
			revert(revertMessages[selector]);
		}

		accountHookCalled[virtualAccount] = true;
		lastAccountForSelector[selector] = virtualAccount;
		selectorCallCount[selector]++;

		if (recordCalls) {
			hookCalls.push(
				HookCall({
					selector: selector,
					data: abi.encode(virtualAccount, parent, metadata),
					timestamp: block.timestamp,
					callCount: selectorCallCount[selector]
				})
			);
		}

		// Execute callback if configured
		if (shouldExecuteForAccount[selector] && accountHub != address(0)) {
			bytes memory callData = executeForAccountCallData[selector];
			if (callData.length > 0) {
				ICoreFacetCallback(accountHub).executeForAccount(callData);
				executeForAccountCallCount++;
				lastExecuteForAccountSuccess = true;
			}
		}

		return returnValues[selector];
	}

	/**
	 * @notice Hook called when a virtual account is deleted
	 * @param account The virtual account address being deleted
	 */
	function onVirtualAccountDeletion(address account) external {
		bytes4 selector = this.onVirtualAccountDeletion.selector;

		if (shouldRevert[selector]) {
			revert(revertMessages[selector]);
		}

		accountHookCalled[account] = true;
		lastAccountForSelector[selector] = account;
		selectorCallCount[selector]++;

		if (recordCalls) {
			hookCalls.push(
				HookCall({ selector: selector, data: abi.encode(account), timestamp: block.timestamp, callCount: selectorCallCount[selector] })
			);
		}
	}

	/**
	 * @notice Hook called when a sub-account is deleted
	 * @param subAccount The sub-account address being deleted
	 * @param owner The owner of the sub-account
	 */
	function onSubAccountDeletion(address subAccount, address owner) external {
		bytes4 selector = this.onSubAccountDeletion.selector;

		if (shouldRevert[selector]) {
			revert(revertMessages[selector]);
		}

		accountHookCalled[subAccount] = true;
		lastAccountForSelector[selector] = subAccount;
		selectorCallCount[selector]++;

		if (recordCalls) {
			hookCalls.push(
				HookCall({ selector: selector, data: abi.encode(subAccount, owner), timestamp: block.timestamp, callCount: selectorCallCount[selector] })
			);
		}
	}

	/**
	 * @notice Hook called when _call is executed on an account
	 * @param account The account address
	 * @param callDatas Array of call data
	 */
	function onCall(address account, bytes[] memory callDatas) external {
		bytes4 selector = this.onCall.selector;

		if (shouldRevert[selector]) {
			revert(revertMessages[selector]);
		}

		accountHookCalled[account] = true;
		lastAccountForSelector[selector] = account;
		selectorCallCount[selector]++;

		if (recordCalls) {
			hookCalls.push(
				HookCall({
					selector: selector,
					data: abi.encode(account, callDatas),
					timestamp: block.timestamp,
					callCount: selectorCallCount[selector]
				})
			);
		}
	}

	// ==================== Testing Configuration Functions ====================

	/**
	 * @notice Configures a hook to revert with a custom message
	 * @param selector The function selector to configure
	 * @param _shouldRevert Whether the hook should revert
	 * @param message The revert message (optional)
	 */
	function setRevertForSelector(bytes4 selector, bool _shouldRevert, string memory message) external {
		shouldRevert[selector] = _shouldRevert;
		if (_shouldRevert) {
			revertMessages[selector] = bytes(message).length > 0 ? message : "MockHook: Configured to revert";
		}
	}

	/**
	 * @notice Sets the return value for a specific hook
	 * @param selector The function selector
	 * @param value The return value
	 */
	function setReturnValue(bytes4 selector, bool value) external {
		returnValues[selector] = value;
	}

	/**
	 * @notice Enables or disables call recording
	 * @param _recordCalls Whether to record calls
	 * @dev Disable for gas optimization in certain tests
	 */
	function setRecordCalls(bool _recordCalls) external {
		recordCalls = _recordCalls;
	}

	/**
	 * @notice Sets the AccountHub address for executeForAccount callbacks
	 * @param _accountHub The AccountHub contract address
	 */
	function setAccountHub(address _accountHub) external {
		accountHub = _accountHub;
	}

	/**
	 * @notice Configures a hook to call executeForAccount with specific calldata
	 * @param selector The hook selector that should trigger the callback
	 * @param callData The calldata to pass to executeForAccount
	 * @param enabled Whether to enable the callback
	 */
	function setExecuteForAccountCallback(bytes4 selector, bytes memory callData, bool enabled) external {
		executeForAccountCallData[selector] = callData;
		shouldExecuteForAccount[selector] = enabled;
	}

	/**
	 * @notice Resets executeForAccount tracking
	 */
	function resetExecuteForAccountTracking() external {
		executeForAccountCallCount = 0;
		lastExecuteForAccountSuccess = false;
	}

	/**
	 * @notice Resets all hook call data
	 */
	function resetHookCalls() external {
		delete hookCalls;
	}

	/**
	 * @notice Resets call count for a specific selector
	 * @param selector The selector to reset
	 */
	function resetSelectorCallCount(bytes4 selector) external {
		selectorCallCount[selector] = 0;
	}

	/**
	 * @notice Resets all call counts
	 */
	function resetAllCallCounts() external {
		selectorCallCount[this.onAccountCreation.selector] = 0;
		selectorCallCount[this.onVirtualAccountCreation.selector] = 0;
		selectorCallCount[this.onVirtualAccountDeletion.selector] = 0;
		selectorCallCount[this.onSubAccountDeletion.selector] = 0;
		selectorCallCount[this.onCall.selector] = 0;
	}

	/**
	 * @notice Clears the account hook called flag
	 * @param account The account to clear
	 */
	function clearAccountHookCalled(address account) external {
		accountHookCalled[account] = false;
	}

	// ==================== View Functions for Testing ====================

	/**
	 * @notice Gets the total number of hook calls recorded
	 * @return The number of hook calls
	 */
	function getHookCallsCount() external view returns (uint256) {
		return hookCalls.length;
	}

	/**
	 * @notice Gets a specific hook call by index
	 * @param index The index of the hook call
	 * @return selector The function selector
	 * @return data The call data
	 * @return timestamp The timestamp of the call
	 * @return callCount The call count at that time
	 */
	function getHookCall(uint256 index) external view returns (bytes4 selector, bytes memory data, uint256 timestamp, uint256 callCount) {
		require(index < hookCalls.length, "MockHook: Index out of bounds");
		HookCall memory call = hookCalls[index];
		return (call.selector, call.data, call.timestamp, call.callCount);
	}

	/**
	 * @notice Gets all hook calls
	 * @return Array of all hook calls
	 */
	function getAllHookCalls() external view returns (HookCall[] memory) {
		return hookCalls;
	}

	/**
	 * @notice Gets the call count for a specific selector
	 * @param selector The function selector
	 * @return The number of times the selector was called
	 */
	function getCallCount(bytes4 selector) external view returns (uint256) {
		return selectorCallCount[selector];
	}

	/**
	 * @notice Checks if a hook was called for a specific account
	 * @param account The account address
	 * @return Whether the hook was called
	 */
	function wasHookCalledForAccount(address account) external view returns (bool) {
		return accountHookCalled[account];
	}

	/**
	 * @notice Gets the last account that triggered a specific hook
	 * @param selector The function selector
	 * @return The last account address
	 */
	function getLastAccountForSelector(bytes4 selector) external view returns (address) {
		return lastAccountForSelector[selector];
	}

	/**
	 * @notice Checks if a selector is configured to revert
	 * @param selector The function selector
	 * @return Whether it will revert
	 */
	function willRevert(bytes4 selector) external view returns (bool) {
		return shouldRevert[selector];
	}

	/**
	 * @notice Gets the revert message for a selector
	 * @param selector The function selector
	 * @return The revert message
	 */
	function getRevertMessage(bytes4 selector) external view returns (string memory) {
		return revertMessages[selector];
	}

	/**
	 * @notice Gets the return value for a selector
	 * @param selector The function selector
	 * @return The return value
	 */
	function getReturnValue(bytes4 selector) external view returns (bool) {
		return returnValues[selector];
	}

	/**
	 * @notice Gets call counts for all hook types
	 * @return onAccountCreationCount Number of account creation hooks
	 * @return onVirtualAccountCreationCount Number of virtual account creation hooks
	 * @return onVirtualAccountDeletionCount Number of virtual account deletion hooks
	 * @return onSubAccountDeletionCount Number of sub-account deletion hooks
	 * @return onCallCount Number of call hooks
	 */
	function getAllCallCounts()
		external
		view
		returns (
			uint256 onAccountCreationCount,
			uint256 onVirtualAccountCreationCount,
			uint256 onVirtualAccountDeletionCount,
			uint256 onSubAccountDeletionCount,
			uint256 onCallCount
		)
	{
		return (
			selectorCallCount[this.onAccountCreation.selector],
			selectorCallCount[this.onVirtualAccountCreation.selector],
			selectorCallCount[this.onVirtualAccountDeletion.selector],
			selectorCallCount[this.onSubAccountDeletion.selector],
			selectorCallCount[this.onCall.selector]
		);
	}

	// ==================== Helper Functions for Assertions ====================

	/**
	 * @notice Verifies that a hook was called exactly N times
	 * @param selector The function selector
	 * @param expectedCount The expected call count
	 * @return Whether the assertion passes
	 */
	function assertCallCount(bytes4 selector, uint256 expectedCount) external view returns (bool) {
		return selectorCallCount[selector] == expectedCount;
	}

	/**
	 * @notice Verifies that account creation hook was called for a specific account
	 * @param account The account address
	 * @return Whether the assertion passes
	 */
	function assertAccountCreationCalled(address account) external view returns (bool) {
		return accountHookCalled[account] && lastAccountForSelector[this.onAccountCreation.selector] == account;
	}

	/**
	 * @notice Verifies that virtual account creation hook was called
	 * @param virtualAccount The virtual account address
	 * @return Whether the assertion passes
	 */
	function assertVirtualAccountCreationCalled(address virtualAccount) external view returns (bool) {
		return accountHookCalled[virtualAccount] && lastAccountForSelector[this.onVirtualAccountCreation.selector] == virtualAccount;
	}
}
