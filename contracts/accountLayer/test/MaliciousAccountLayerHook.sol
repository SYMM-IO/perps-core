// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

/**
 * @title MaliciousAccountLayerHook
 * @notice A hook that attempts to exploit the signer mechanism by calling back into AccountLayer
 * @dev Used for testing that LibAccountLayerUtils.callHook properly clears the globalSigner
 */
contract MaliciousAccountLayerHook {
	address public accountLayer;
	address public targetAccount;

	bool public attemptedReentry;
	bool public reentrySucceeded;
	bytes public reentryError;

	uint256 public onAccountCreationCallCount;
	uint256 public onVirtualAccountCreationCallCount;
	uint256 public onVirtualAccountDeletionCallCount;

	// Store the calldata to attempt during reentry
	bytes public reentryCallData;
	bool public shouldAttemptReentry;

	event ReentryAttempted(bool success, bytes error);

	function setAccountLayer(address _accountLayer) external {
		accountLayer = _accountLayer;
	}

	function setTargetAccount(address _targetAccount) external {
		targetAccount = _targetAccount;
	}

	function setReentryCallData(bytes memory _callData) external {
		reentryCallData = _callData;
	}

	function setShouldAttemptReentry(bool _shouldAttempt) external {
		shouldAttemptReentry = _shouldAttempt;
	}

	function onAccountCreation(address /* user */, address account, bytes memory /* metadata */) external returns (bool) {
		onAccountCreationCallCount++;

		if (shouldAttemptReentry && accountLayer != address(0) && reentryCallData.length > 0) {
			_attemptReentry(account);
		}

		return true;
	}

	function onVirtualAccountCreation(address virtualAccount, address /* parent */, bytes memory /* metadata */) external returns (bool) {
		onVirtualAccountCreationCallCount++;

		if (shouldAttemptReentry && accountLayer != address(0) && reentryCallData.length > 0) {
			_attemptReentry(virtualAccount);
		}

		return true;
	}

	function onVirtualAccountDeletion(address account) external {
		onVirtualAccountDeletionCallCount++;

		if (shouldAttemptReentry && accountLayer != address(0) && reentryCallData.length > 0) {
			_attemptReentry(account);
		}
	}

	function onCall(address account, bytes[] memory /* callDatas */) external {
		if (shouldAttemptReentry && accountLayer != address(0) && reentryCallData.length > 0) {
			_attemptReentry(account);
		}
	}

	function _attemptReentry(address account) internal {
		attemptedReentry = true;
		if (targetAccount == address(0)) {
			targetAccount = account;
		}

		// Try to call the AccountLayer with the configured calldata
		// This should fail because globalSigner is cleared during hook execution
		(bool success, bytes memory result) = accountLayer.call(reentryCallData);

		if (success) {
			reentrySucceeded = true;
			emit ReentryAttempted(true, "");
		} else {
			reentrySucceeded = false;
			reentryError = result;
			emit ReentryAttempted(false, result);
		}
	}

	function resetState() external {
		attemptedReentry = false;
		reentrySucceeded = false;
		reentryError = "";
		onAccountCreationCallCount = 0;
		onVirtualAccountCreationCallCount = 0;
		onVirtualAccountDeletionCallCount = 0;
		targetAccount = address(0);
	}
}
