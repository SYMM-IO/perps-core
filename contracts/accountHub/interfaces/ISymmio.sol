// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface ISymmio {
	enum PositionType {
		LONG,
		SHORT
	}

	enum OrderType {
		LIMIT,
		MARKET
	}

	struct SchnorrSign {
		uint256 signature;
		address owner;
		address nonce;
	}

	struct SingleUpnlSig {
		bytes reqId;
		uint256 timestamp;
		int256 upnl;
		bytes gatewaySignature;
		SchnorrSign sigs;
	}

	struct SingleUpnlAndPriceSig {
		bytes reqId;
		uint256 timestamp;
		int256 upnl;
		uint256 price;
		bytes gatewaySignature;
		SchnorrSign sigs;
	}

	enum QuoteStatus {
		PENDING, //0
		LOCKED, //1
		CANCEL_PENDING, //2
		CANCELED, //3
		OPENED, //4
		CLOSE_PENDING, //5
		CANCEL_CLOSE_PENDING, //6
		CLOSED, //7
		LIQUIDATED, //8
		EXPIRED, //9
		LIQUIDATED_PENDING //10
	}

	struct LockedValues {
		uint256 cva;
		uint256 lf;
		uint256 partyAmm;
		uint256 partyBmm;
	}

	struct Quote {
		uint256 id;
		address[] partyBsWhiteList;
		uint256 symbolId;
		PositionType positionType;
		OrderType orderType;
		// Price of quote which PartyB opened in 18 decimals
		uint256 openedPrice;
		uint256 initialOpenedPrice;
		// Price of quote which PartyA requested in 18 decimals
		uint256 requestedOpenPrice;
		uint256 marketPrice;
		// Quantity of quote which PartyA requested in 18 decimals
		uint256 quantity;
		// Quantity of quote which PartyB has closed until now in 18 decimals
		uint256 closedAmount;
		LockedValues initialLockedValues;
		LockedValues lockedValues;
		uint256 maxFundingRate;
		address partyA;
		address partyB;
		QuoteStatus quoteStatus;
		uint256 avgClosedPrice;
		uint256 requestedClosePrice;
		uint256 quantityToClose;
		// handle partially open position
		uint256 parentId;
		uint256 createTimestamp;
		uint256 statusModifyTimestamp;
		uint256 lastFundingPaymentTimestamp;
		uint256 deadline;
		uint256 tradingFee; // openFee
		address affiliate;
		int256 accumulatedPaidFunding;
		uint256 closeFee;
		bytes data;
	}

	function depositFor(address user, uint256 amount) external;
	function withdrawTo(address user, uint256 amount) external;
	function allocate(uint256 amount) external;
	function getCollateral() external view returns (address);
	function balanceOf(address user) external view returns (uint256);
	function setSigner(address signer) external;
	function allocatedBalanceOfPartyA(address partyA) external view returns (uint256);
	function internalTransfer(address user, uint256 amount) external;
	function deallocate(uint256 amount, SingleUpnlSig memory upnlSig) external;
	function getPartyAOpenPositions(address partyA, uint256 start, uint256 size) external view returns (Quote[] memory);
	function setFeeCollector(address affiliate, address feeCollector) external;
	function getNextQuoteId() external returns (uint256);
}
