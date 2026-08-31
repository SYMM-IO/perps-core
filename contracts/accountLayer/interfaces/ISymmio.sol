// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Minimal interface of the Symmio core diamond used by the AccountLayer
interface ISymmio {
	/// @notice Position direction
	enum PositionType {
		LONG,
		SHORT
	}

	/// @notice Order type
	enum OrderType {
		LIMIT,
		MARKET,
		MARKET_BEST_EFFORT
	}

	/// @notice Fee configuration for an affiliate and symbol pair
	struct Fee {
		uint256 openFee;
		uint256 closeFee;
		bool isSet;
	}

	/// @notice Schnorr signature components for Muon verification
	struct SchnorrSign {
		uint256 signature;
		address owner;
		address nonce;
	}

	/// @notice Muon signature proving a single account's unrealized PnL
	struct SingleUpnlSig {
		bytes reqId;
		uint256 timestamp;
		int256 upnl;
		bytes gatewaySignature;
		SchnorrSign sigs;
	}

	/// @notice Muon signature proving a single account's unrealized PnL, gross accrued funding liability,
	/// pending balance, and locked balance re-marked to live notional (scaledLockedBalance)
	struct SingleUpnlWithPendingBalanceSig {
		bytes reqId;
		uint256 timestamp;
		int256 upnl;
		uint256 fundingDebt;
		uint256 pendingBalance;
		uint256 scaledLockedBalance;
		bytes gatewaySignature;
		SchnorrSign sigs;
	}

	/// @notice Muon signature proving a single account's unrealized PnL and a price
	struct SingleUpnlAndPriceSig {
		bytes reqId;
		uint256 timestamp;
		int256 upnl;
		uint256 price;
		bytes gatewaySignature;
		SchnorrSign sigs;
	}

	/// @notice Quote lifecycle status
	enum QuoteStatus {
		PENDING,
		LOCKED,
		CANCEL_PENDING,
		CANCELED,
		OPENED,
		CLOSE_PENDING,
		CANCEL_CLOSE_PENDING,
		CLOSED,
		LIQUIDATED,
		EXPIRED,
		LIQUIDATED_PENDING
	}

	/// @notice Locked margin values for a quote
	struct LockedValues {
		uint256 cva;
		uint256 lf;
		uint256 partyAmm;
		uint256 partyBmm;
	}

	/// @notice Full quote data representing a trading position or pending order
	struct Quote {
		uint256 id;
		address[] partyBsWhiteList;
		uint256 symbolId;
		PositionType positionType;
		OrderType orderType;
		uint256 openedPrice;
		uint256 initialOpenedPrice;
		uint256 requestedOpenPrice;
		uint256 marketPrice;
		uint256 quantity;
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
		uint256 parentId;
		uint256 createTimestamp;
		uint256 statusModifyTimestamp;
		uint256 lastFundingPaymentTimestamp;
		uint256 deadline;
		uint256 tradingFee;
		address affiliate;
		int256 accumulatedPaidFunding;
		uint256 closeFee;
		bytes data;
	}

	/// @notice Binding state between a partyA and a partyB
	struct BindState {
		BindStatus status;
		address partyB;
		uint256 modifyTimestamp;
	}

	/// @notice Binding status between a partyA and a partyB
	enum BindStatus {
		NOT_BOUND,
		BOUND,
		PENDING_UNBIND
	}

	/// @notice Specifies a receiver and amount for a withdraw request
	struct WithdrawReceiverPart {
		uint256 id;
		uint256 amount;
		int256 chainId;
		bytes receiver;
		address virtualProvider;
		address expressProvider;
	}

	/// @notice Solver fee caps approved by PartyA when sending a quote.
	/// @dev Mirror of core's QuoteStorage.SolverFeeCaps -- keep the field types in sync. LibQuoteParams derives
	///      the sendQuote selector from this interface, and that selector depends on this struct's ABI tuple
	///      shape; changing its field types would make the selector diverge from the core diamond's.
	struct SolverFeeCaps {
		uint256 openRateCap;
		uint256 closeRateCap;
	}

	/// @notice Sends a quote with an affiliate. Declared only so LibQuoteParams can derive its selector.
	function sendQuoteWithAffiliate(
		address[] memory partyBsWhiteList,
		uint256 symbolId,
		PositionType positionType,
		OrderType orderType,
		uint256 price,
		uint256 quantity,
		uint256 cva,
		uint256 lf,
		uint256 partyAmm,
		uint256 partyBmm,
		uint256 maxFundingRate,
		uint256 deadline,
		address affiliate,
		SingleUpnlAndPriceSig memory upnlSig
	) external returns (uint256);

	/// @notice Sends a quote with an affiliate and custom data. Declared only so LibQuoteParams can derive its selector.
	function sendQuoteWithAffiliateAndData(
		address[] memory partyBsWhiteList,
		uint256 symbolId,
		PositionType positionType,
		OrderType orderType,
		uint256 price,
		uint256 quantity,
		uint256 cva,
		uint256 lf,
		uint256 partyAmm,
		uint256 partyBmm,
		uint256 deadline,
		address affiliate,
		SingleUpnlAndPriceSig memory upnlSig,
		bytes memory data
	) external returns (uint256 quoteId);

	/// @notice Sends a quote with affiliate, custom data, and solver fee caps. Declared only so LibQuoteParams can derive its selector.
	function sendQuote(
		address[] memory partyBsWhiteList,
		uint256 symbolId,
		PositionType positionType,
		OrderType orderType,
		uint256 price,
		uint256 quantity,
		uint256 cva,
		uint256 lf,
		uint256 partyAmm,
		uint256 partyBmm,
		uint256 deadline,
		address affiliate,
		SingleUpnlAndPriceSig memory upnlSig,
		bytes memory data,
		SolverFeeCaps memory solverFeeCaps
	) external returns (uint256 quoteId);

	/// @notice Deposits collateral for a user
	/// @param user The user address
	/// @param amount The amount to deposit
	function depositFor(address user, uint256 amount) external;

	/// @notice Deposits and allocates collateral for a user
	/// @param user The user address
	/// @param amount The amount to deposit and allocate
	function depositAndAllocateFor(address user, uint256 amount) external;

	/// @notice Withdraws collateral to a user
	/// @param user The recipient address
	/// @param amount The amount to withdraw
	function withdrawTo(address user, uint256 amount) external;

	/// @notice Allocates deposited collateral for trading
	/// @param amount The amount to allocate
	function allocate(uint256 amount) external;

	/// @notice Deallocates collateral with a UPNL signature
	/// @param amount The amount to deallocate
	/// @param upnlSig The Muon signature proving UPNL
	function deallocate(uint256 amount, ISymmio.SingleUpnlSig memory upnlSig) external;

	/// @notice Deallocates collateral while reserving pending balance and enforcing the scaled retention floor
	/// @param amount The amount to deallocate
	/// @param upnlSig The Muon signature carrying UPNL, funding debt, pending balance, and scaledLockedBalance
	function safeDeallocate(uint256 amount, ISymmio.SingleUpnlWithPendingBalanceSig memory upnlSig) external;

	/// @notice Initiates a withdraw request with receiver parts
	/// @param parts The withdraw receiver specifications
	/// @param speedUp Whether to speed up the withdrawal
	/// @param data Additional data
	/// @return requestId The created request ID
	/// @return cooldownEndTime The cooldown end timestamp
	function initiateWithdraw(
		WithdrawReceiverPart[] memory parts,
		bool speedUp,
		bytes memory data
	) external returns (uint256 requestId, uint256 cooldownEndTime);

	/// @notice Finalizes a pending withdraw request
	/// @param user The user whose request to finalize
	/// @param requestId The request ID to finalize
	function finalizeWithdrawRequest(address user, uint256 requestId) external;

	/// @notice Returns the collateral token address
	/// @return The ERC20 collateral address
	function getCollateral() external view returns (address);

	/// @notice Returns the deposited balance of a user
	/// @param user The user address
	/// @return The balance amount
	function balanceOf(address user) external view returns (uint256);

	/// @notice Sets the signer for authorization
	/// @param signer The signer address
	function setSigner(address signer) external;

	/// @notice Installs the effective signer for this transaction, or clears it with zero
	/// @dev Transient counterpart of setSigner. Core rejects it while a persistent
	///      signer is set, so one transaction never mixes the two mechanisms
	/// @param signerOrZero The signer address, or address(0) to end the signer scope
	function setTransientSigner(address signerOrZero) external;

	/// @notice Returns the allocated balance of a partyA
	/// @param partyA The partyA address
	/// @return The allocated balance
	function allocatedBalanceOfPartyA(address partyA) external view returns (uint256);

	/// @notice Transfers from the signer's deposited balance to another account's allocated balance
	/// @param user The recipient account address
	/// @param amount The amount to transfer
	function internalTransfer(address user, uint256 amount) external;

	/// @notice Transfers funds to another account's deposited balance
	/// @param user The recipient account address
	/// @param amount The amount to transfer
	function internalTransferToBalance(address user, uint256 amount) external;

	/// @notice Deallocates collateral without requiring a UPNL signature (zero UPNL assumed)
	/// @param amount The amount to deallocate
	function zeroUpnlDeallocate(uint256 amount) external;

	/// @notice Returns paginated open positions for a partyA
	/// @param partyA The partyA address
	/// @param start The starting index
	/// @param size The page size
	/// @return The array of quote structs
	function getPartyAOpenPositions(address partyA, uint256 start, uint256 size) external view returns (Quote[] memory);

	/// @notice Returns the number of open positions for a partyA
	/// @param partyA The partyA address
	/// @return The position count
	function partyAPositionsCount(address partyA) external view returns (uint256);

	/// @notice Returns pending quote IDs for a partyA
	/// @param partyA The partyA address
	/// @return The array of pending quote IDs
	function getPartyAPendingQuotes(address partyA) external view returns (uint256[] memory);

	/// @notice Returns the number of pending quotes for a partyA (cheaper than getPartyAPendingQuotes)
	/// @param partyA The partyA address
	/// @return The number of pending quotes
	function partyAPendingQuotesCount(address partyA) external view returns (uint256);

	/// @notice Checks if the current call originates from the InstantLayer
	/// @return Whether the call is from InstantLayer
	function isCallFromInstantLayer() external view returns (bool);

	/// @notice Temporarily strips core's InstantLayer privileges before AccountLayer calls out
	///         to an affiliate hook
	/// @dev Without this, a hook reached during an InstantLayer batch could call core directly
	///      and inherit the batch's transaction-wide routing authority. Core binds the saved
	///      context to msg.sender, so AccountLayer cannot choose or alter what it later restores
	/// @return suspended True if a context existed and was suspended -- only then may
	///         restoreExecutionContextAfterExternalCall be called
	function suspendExecutionContextForExternalCall() external returns (bool suspended);

	/// @notice Restores the execution context this same caller suspended
	/// @dev Reverts if nothing is suspended for this caller, or if the hook installed its own
	///      execution context while the original one was suspended
	function restoreExecutionContextAfterExternalCall() external;

	/// @notice Sets the fee collector address for an affiliate
	/// @param affiliate The affiliate address
	/// @param feeCollector The fee collector address
	function setFeeCollector(address affiliate, address feeCollector) external;

	/// @notice Returns the last assigned quote ID
	/// @return The last assigned quote ID
	function getNextQuoteId() external view returns (uint256);

	/// @notice Returns a quote by ID
	function getQuote(uint256 quoteId) external view returns (Quote memory);

	/// @notice Requests to cancel a quote; cancels immediately when the quote is still PENDING
	/// @param quoteId The quote ID to cancel
	function requestToCancelQuote(uint256 quoteId) external;

	/// @notice Registers an affiliate on the Symmio core
	/// @param affiliate The affiliate address to register
	function registerAffiliate(address affiliate) external;

	/// @notice Returns the fee configuration for an affiliate and symbol
	/// @notice Binds the caller (partyA) to a specific partyB
	/// @param partyB The partyB address to bind to
	function bindToPartyB(address partyB) external;

	/// @notice Requests to unbind the caller from their current partyB
	function requestToUnbindFromPartyB() external;

	/// @notice Completes an unbind request for a partyA
	/// @param partyA The partyA address to unbind
	function completeUnbindRequest(address partyA) external;

	/// @notice Returns the binding state of a user
	/// @param user The user address
	/// @return The bind state struct
	function getBindState(address user) external view returns (BindState memory);

	/// @notice Checks if a party A is in liquidation
	/// @param partyA The partyA address
	/// @return True if party A is liquidated, false otherwise
	function isPartyALiquidated(address partyA) external view returns (bool);

	/// @notice Checks if a PartyA takeover liquidation is in progress
	/// @param partyA The partyA address
	/// @return True if a takeover is in progress, false otherwise
	function isPartyATakeoverInProgress(address partyA) external view returns (bool);

	/// @notice Checks if a party B is in cross liquidation
	/// @param partyB The partyB address
	/// @return True if cross liquidation is in progress, false otherwise
	function getPartyBCrossLiquidationStatus(address partyB) external view returns (bool);
}
