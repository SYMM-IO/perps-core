// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { ISymmioHook } from "../interfaces/ISymmioHook.sol";

contract MockHook is ISymmioHook {
	struct CallData {
		uint256 quoteId;
		uint256 amount;
		uint256 price;
		address partyA;
		address partyB;
	}

	struct FeeCallData {
		uint256 quoteId;
		uint256 amount;
		address partyA;
		address partyB;
		uint256 symbolId;
		address affiliate;
		TradingFeeType feeType;
	}

	// Last captured inputs
	CallData private _lastOpenCall;
	CallData private _lastCloseCall;
	CallData private _lastCancelCall;
	CallData private _lastCloseExpiredCall;
	FeeCallData private _lastOpenFeeCall;
	FeeCallData private _lastCloseFeeCall;
	// Call counters
	uint256 public openCallCount;
	uint256 public closeCallCount;
	uint256 public cancelCallCount;
	uint256 public closeExpiredCallCount;
	uint256 public openFeeCallCount;
	uint256 public closeFeeCallCount;
	// Configurable behavior
	bool public shouldRevertOnOpen;
	bool public shouldRevertOnClose;
	bool public shouldRevertOnOpenFee;
	bool public shouldRevertOnCloseFee;
	string public revertMessageOnOpen;
	string public revertMessageOnClose;
	string public revertMessageOnOpenFee;
	string public revertMessageOnCloseFee;

	event OnOpenPosition(uint256 quoteId, uint256 amount, uint256 price, address partyA, address partyB);
	event OnClosePosition(uint256 quoteId, uint256 amount, uint256 price, address partyA, address partyB);
	event OnCancelQuote(uint256 quoteId, address partyA, address partyB);
	event OnCloseExpired(uint256 quoteId, address partyA, address partyB);
	event OnFeeCharged(uint256 quoteId, uint256 amount, address partyA, address partyB, uint256 symbolId, address affiliate, TradingFeeType feeType);
	function setRevertOnOpen(bool shouldRevert, string memory message) external {
		shouldRevertOnOpen = shouldRevert;
		revertMessageOnOpen = message;
	}

	function setRevertOnClose(bool shouldRevert, string memory message) external {
		shouldRevertOnClose = shouldRevert;
		revertMessageOnClose = message;
	}

	function setRevertOnOpenFee(bool shouldRevert, string memory message) external {
		shouldRevertOnOpenFee = shouldRevert;
		revertMessageOnOpenFee = message;
	}

	function setRevertOnCloseFee(bool shouldRevert, string memory message) external {
		shouldRevertOnCloseFee = shouldRevert;
		revertMessageOnCloseFee = message;
	}

	function onOpenPosition(uint256 quoteId, uint256 filledAmount, uint256 openedPrice, address partyA, address partyB) external override {
		if (shouldRevertOnOpen) {
			string memory msg_ = bytes(revertMessageOnOpen).length > 0 ? revertMessageOnOpen : "MockHook: revert on open";
			revert(msg_);
		}
		openCallCount += 1;
		_lastOpenCall = CallData({ quoteId: quoteId, amount: filledAmount, price: openedPrice, partyA: partyA, partyB: partyB });
		emit OnOpenPosition(quoteId, filledAmount, openedPrice, partyA, partyB);
	}

	function onClosePosition(uint256 quoteId, uint256 filledAmount, uint256 closedPrice, address partyA, address partyB) external override {
		if (shouldRevertOnClose) {
			string memory msg_ = bytes(revertMessageOnClose).length > 0 ? revertMessageOnClose : "MockHook: revert on close";
			revert(msg_);
		}
		closeCallCount += 1;
		_lastCloseCall = CallData({ quoteId: quoteId, amount: filledAmount, price: closedPrice, partyA: partyA, partyB: partyB });
		emit OnClosePosition(quoteId, filledAmount, closedPrice, partyA, partyB);
	}

	function onCancelQuote(uint256 quoteId, address partyA, address partyB) external override {
		cancelCallCount += 1;
		_lastCancelCall = CallData({ quoteId: quoteId, amount: 0, price: 0, partyA: partyA, partyB: partyB });
		emit OnCancelQuote(quoteId, partyA, partyB);
	}

	function onCloseExpired(uint256 quoteId, address partyA, address partyB) external override {
		closeExpiredCallCount += 1;
		_lastCloseExpiredCall = CallData({ quoteId: quoteId, amount: 0, price: 0, partyA: partyA, partyB: partyB });
		emit OnCloseExpired(quoteId, partyA, partyB);
	}

	function onFeeCharged(
		uint256 quoteId,
		uint256 amount,
		address partyA,
		address partyB,
		uint256 symbolId,
		address affiliate,
		TradingFeeType feeType
	) external override {
		if (feeType == TradingFeeType.OPEN) {
			if (shouldRevertOnOpenFee) {
				string memory msg_ = bytes(revertMessageOnOpenFee).length > 0 ? revertMessageOnOpenFee : "MockHook: revert on open fee";
				revert(msg_);
			}
			openFeeCallCount += 1;
			_lastOpenFeeCall = FeeCallData({
				quoteId: quoteId,
				amount: amount,
				partyA: partyA,
				partyB: partyB,
				symbolId: symbolId,
				affiliate: affiliate,
				feeType: feeType
			});
		} else {
			if (shouldRevertOnCloseFee) {
				string memory msg_ = bytes(revertMessageOnCloseFee).length > 0 ? revertMessageOnCloseFee : "MockHook: revert on close fee";
				revert(msg_);
			}
			closeFeeCallCount += 1;
			_lastCloseFeeCall = FeeCallData({
				quoteId: quoteId,
				amount: amount,
				partyA: partyA,
				partyB: partyB,
				symbolId: symbolId,
				affiliate: affiliate,
				feeType: feeType
			});
		}
		emit OnFeeCharged(quoteId, amount, partyA, partyB, symbolId, affiliate, feeType);
	}

	function onLiquidationSettled(address /* partyA */) external pure override {
		return;
	}

	// Getters for test assertions
	function getLastOpenCall()
		external
		view
		returns (uint256 quoteId, uint256 amount, uint256 price, address partyA, address partyB, uint256 callCount)
	{
		CallData memory c = _lastOpenCall;
		return (c.quoteId, c.amount, c.price, c.partyA, c.partyB, openCallCount);
	}

	function getLastCloseCall()
		external
		view
		returns (uint256 quoteId, uint256 amount, uint256 price, address partyA, address partyB, uint256 callCount)
	{
		CallData memory c = _lastCloseCall;
		return (c.quoteId, c.amount, c.price, c.partyA, c.partyB, closeCallCount);
	}

	function getLastCancelCall() external view returns (uint256 quoteId, address partyA, address partyB, uint256 callCount) {
		CallData memory c = _lastCancelCall;
		return (c.quoteId, c.partyA, c.partyB, cancelCallCount);
	}

	function getLastCloseExpiredCall() external view returns (uint256 quoteId, address partyA, address partyB, uint256 callCount) {
		CallData memory c = _lastCloseExpiredCall;
		return (c.quoteId, c.partyA, c.partyB, closeExpiredCallCount);
	}

	function getLastOpenFeeCall()
		external
		view
		returns (
			uint256 quoteId,
			uint256 amount,
			address partyA,
			address partyB,
			uint256 symbolId,
			address affiliate,
			TradingFeeType feeType,
			uint256 callCount
		)
	{
		FeeCallData memory c = _lastOpenFeeCall;
		return (c.quoteId, c.amount, c.partyA, c.partyB, c.symbolId, c.affiliate, c.feeType, openFeeCallCount);
	}

	function getLastCloseFeeCall()
		external
		view
		returns (
			uint256 quoteId,
			uint256 amount,
			address partyA,
			address partyB,
			uint256 symbolId,
			address affiliate,
			TradingFeeType feeType,
			uint256 callCount
		)
	{
		FeeCallData memory c = _lastCloseFeeCall;
		return (c.quoteId, c.amount, c.partyA, c.partyB, c.symbolId, c.affiliate, c.feeType, closeFeeCallCount);
	}
}
