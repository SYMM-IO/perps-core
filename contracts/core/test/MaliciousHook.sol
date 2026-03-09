// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { ISymmioHook } from "../interfaces/ISymmioHook.sol";

interface ISymmioCore {
	function deallocate(uint256 amount) external;
	function allocate(uint256 amount) external;
	function balanceOf(address user) external view returns (uint256);
	function allocatedBalanceOf(address user) external view returns (uint256);
}

/**
 * @title MaliciousHook
 * @notice A hook that attempts to exploit reentrancy by calling back into Symmio
 * @dev Used for testing that LibHook.safeCall properly clears the signer
 */
contract MaliciousHook is ISymmioHook {
	address public symmioCore;
	address public targetUser;
	uint256 public deallocateAmount;

	bool public attemptedReentry;
	bool public reentrySucceeded;
	bytes public reentryError;

	uint256 public openCallCount;
	uint256 public closeCallCount;

	event ReentryAttempted(bool success, bytes error);

	function setSymmioCore(address _symmioCore) external {
		symmioCore = _symmioCore;
	}

	function setTargetUser(address _targetUser) external {
		targetUser = _targetUser;
	}

	function setDeallocateAmount(uint256 _amount) external {
		deallocateAmount = _amount;
	}

	function onOpenPosition(
		uint256 /* quoteId */,
		uint256 /* filledAmount */,
		uint256 /* openedPrice */,
		address partyA,
		address /* partyB */
	) external override {
		openCallCount++;

		if (symmioCore != address(0) && deallocateAmount > 0) {
			attemptedReentry = true;
			targetUser = partyA;

			// Try to call deallocate as the user (this should fail because signer is cleared)
			try ISymmioCore(symmioCore).deallocate(deallocateAmount) {
				reentrySucceeded = true;
				emit ReentryAttempted(true, "");
			} catch (bytes memory error) {
				reentrySucceeded = false;
				reentryError = error;
				emit ReentryAttempted(false, error);
			}
		}
	}

	function onClosePosition(
		uint256 /* quoteId */,
		uint256 /* filledAmount */,
		uint256 /* closedPrice */,
		address partyA,
		address /* partyB */
	) external override {
		closeCallCount++;

		if (symmioCore != address(0) && deallocateAmount > 0) {
			attemptedReentry = true;
			targetUser = partyA;

			// Try to call deallocate as the user (this should fail because signer is cleared)
			try ISymmioCore(symmioCore).deallocate(deallocateAmount) {
				reentrySucceeded = true;
				emit ReentryAttempted(true, "");
			} catch (bytes memory error) {
				reentrySucceeded = false;
				reentryError = error;
				emit ReentryAttempted(false, error);
			}
		}
	}

	function onCancelQuote(uint256 /* quoteId */, address /* partyA */, address /* partyB */) external pure override {
		return;
	}

	function onCloseExpired(uint256 /* quoteId */, address /* partyA */, address /* partyB */) external pure override {
		return;
	}

	function onFeeCharged(
		uint256 /* quoteId */,
		uint256 /* amount */,
		address /* partyA */,
		address /* partyB */,
		uint256 /* symbolId */,
		address /* affiliate */,
		TradingFeeType /* feeType */
	) external pure override {
		return;
	}

	function resetState() external {
		attemptedReentry = false;
		reentrySucceeded = false;
		reentryError = "";
		openCallCount = 0;
		closeCallCount = 0;
	}
}
