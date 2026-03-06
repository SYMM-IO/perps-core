# Event Changelog: v0.8.4 to v0.8.5

This document details every event change between Symmio Core v0.8.4 and v0.8.5. It covers the core Symmio diamond (29 facets) and the new AccountLayer diamond (6 facets). Use it to update subgraphs, event indexers, frontend listeners, and hedger/PartyB integrations.

---

## Quick Reference

| Category | Count |
|---|---|
| Removed backward-compatible overloads | 21 |
| Fully removed events | 1 |
| Changed event signatures | 2 |
| New events on existing facets/libraries | 41 |
| New facets with events | 5 facets, 35 events |
| New AccountLayer diamond events | 6 facets, 30 events |

---

## 1. Removed Backward-Compatible Overloads

v0.8.4 shipped duplicate event overloads marked "For backward compatibility, will be removed in future." These have all been removed in v0.8.5. If your indexer was listening to the simplified overload, switch to the full-parameter version listed below.

### 1.1 Liquidation Events

**PartyA Liquidation** (was `ILiquidationEvents`, now `IPartyALiquidationEvents`)

| Removed Overload | Use Instead |
|---|---|
| `LiquidatePartyA(address liquidator, address partyA, uint256 allocatedBalance, int256 upnl, int256 totalUnrealizedLoss)` | `LiquidatePartyA(address liquidator, address partyA, uint256 allocatedBalance, int256 upnl, int256 totalUnrealizedLoss, bytes liquidationId)` |
| `LiquidatePositionsPartyA(address liquidator, address partyA, uint256[] quoteIds)` | `LiquidatePositionsPartyA(address liquidator, address partyA, uint256[] quoteIds, uint256[] liquidatedAmounts, uint256[] closeIds, bytes liquidationId)` |
| `LiquidatePendingPositionsPartyA(address liquidator, address partyA)` | `LiquidatePendingPositionsPartyA(address liquidator, address partyA, uint256[] quoteIds, uint256[] liquidatedAmounts, bytes liquidationId)` |
| `SettlePartyALiquidation(address partyA, address[] partyBs, int256[] amounts)` | `SettlePartyALiquidation(address partyA, address[] partyBs, int256[] amounts, bytes liquidationId)` |
| `LiquidationDisputed(address partyA)` | `LiquidationDisputed(address partyA, bytes liquidationId)` |
| `ResolveLiquidationDispute(address partyA, address[] partyBs, int256[] amounts, bool disputed)` | `ResolveLiquidationDispute(address partyA, address[] partyBs, int256[] amounts, bool disputed, bytes liquidationId)` |
| `FullyLiquidatedPartyA(address partyA)` | `FullyLiquidatedPartyA(address partyA, bytes liquidationId)` |
| `SetSymbolsPrices(address liquidator, address partyA, uint256[] symbolIds, uint256[] prices)` | `SetSymbolsPrices(address liquidator, address partyA, uint256[] symbolIds, uint256[] prices, bytes liquidationId)` |

**PartyB Liquidation** (was in `ILiquidationEvents`, now `IPartyBLiquidationEvents`)

| Removed Overload | Use Instead |
|---|---|
| `LiquidatePositionsPartyB(address liquidator, address partyB, address partyA, uint256[] quoteIds)` | `LiquidatePositionsPartyB(address liquidator, address partyB, address partyA, uint256[] quoteIds, uint256[] liquidatedAmounts, uint256[] closeIds)` |

**Migration note:** All liquidation events now always include `liquidationId`. Use this field to correlate multi-step liquidation flows. The topic hash changes when parameters change, so your ABI must be updated for decoding.

### 1.2 Account Events

| Removed Overload | Use Instead |
|---|---|
| `AllocatePartyA(address user, uint256 amount)` | `AllocatePartyA(address user, uint256 amount, uint256 newAllocatedBalance)` |
| `DeallocatePartyA(address user, uint256 amount)` | `DeallocatePartyA(address user, uint256 amount, uint256 newAllocatedBalance)` |
| `AllocateForPartyB(address partyB, address partyA, uint256 amount)` | `AllocateForPartyB(address partyB, address partyA, uint256 amount, uint256 newAllocatedBalance)` |
| `DeallocateForPartyB(address partyB, address partyA, uint256 amount)` | `DeallocateForPartyB(address partyB, address partyA, uint256 amount, uint256 newAllocatedBalance)` |
| `TransferAllocation(uint256 amount, address origin, address recipient)` | `TransferAllocation(uint256 amount, address origin, uint256 originNewAllocatedBalance, address recipient, uint256 recipientNewAllocatedBalance)` |

**Note:** `AllocateForPartyB`, `DeallocateForPartyB`, `TransferAllocation`, `DepositToReserveVault`, and `WithdrawFromReserveVault` have moved from `IAccountEvents` to the new `IPartyBAccountEvents` interface. The event signatures and topic hashes are identical -- only the source file changed.

### 1.3 Trading Events

| Removed Overload | Use Instead |
|---|---|
| `ExpireQuote(QuoteStatus quoteStatus, uint256 quoteId)` | `ExpireQuoteOpen(QuoteStatus, uint256 quoteId)` for pending quotes, `ExpireQuoteClose(QuoteStatus, uint256 quoteId, uint256 closeId)` for close requests |
| `FillCloseRequest(uint256 quoteId, address partyA, address partyB, uint256 filledAmount, uint256 closedPrice, QuoteStatus quoteStatus)` | `FillCloseRequest(uint256 quoteId, address partyA, address partyB, uint256 filledAmount, uint256 closedPrice, QuoteStatus quoteStatus, uint256 closeId)` |

### 1.4 PartyA Request Events

| Removed Overload | Use Instead |
|---|---|
| `RequestToClosePosition(address partyA, address partyB, uint256 quoteId, uint256 closePrice, uint256 quantityToClose, OrderType orderType, uint256 deadline, QuoteStatus quoteStatus)` | `RequestToClosePosition(..., uint256 closeId)` -- same params with `closeId` appended |
| `RequestToCancelCloseRequest(address partyA, address partyB, uint256 quoteId, QuoteStatus quoteStatus)` | `RequestToCancelCloseRequest(address partyA, address partyB, uint256 quoteId, QuoteStatus quoteStatus, uint256 closeId)` |

### 1.5 Force Action Events

| Removed Overload | Use Instead |
|---|---|
| `ForceCancelCloseRequest(uint256 quoteId, QuoteStatus quoteStatus)` | `ForceCancelCloseRequest(uint256 quoteId, QuoteStatus quoteStatus, uint256 closeId)` |
| `ForceClosePosition(uint256 quoteId, address partyA, address partyB, uint256 filledAmount, uint256 closedPrice, QuoteStatus quoteStatus)` | `ForceClosePosition(uint256 quoteId, address partyA, address partyB, uint256 filledAmount, uint256 closedPrice, QuoteStatus quoteStatus, uint256 closeId)` |

### 1.6 PartyB Position Action Events

| Removed Overload | Use Instead |
|---|---|
| `AcceptCancelCloseRequest(uint256 quoteId, QuoteStatus quoteStatus)` | `AcceptCancelCloseRequest(uint256 quoteId, QuoteStatus quoteStatus, uint256 closeId)` |
| `EmergencyClosePosition(uint256 quoteId, address partyA, address partyB, uint256 filledAmount, uint256 closedPrice, QuoteStatus quoteStatus)` | `EmergencyClosePosition(uint256 quoteId, address partyA, address partyB, uint256 filledAmount, uint256 closedPrice, QuoteStatus quoteStatus, uint256 closeId)` |

**Note:** `EmergencyClosePosition` has moved from `IPartyBPositionActionsEvents` to the new `IPartyBEmergencyActionsEvents` interface. The full-parameter event signature is identical.

---

## 2. Fully Removed Events

| Event | Reason |
|---|---|
| `SetSymbolMaxSlippage(uint256 symbolId, uint256 oldMaxSlippage, uint256 maxSlippage)` | Max slippage configuration removed. Force close gap management now uses `SetForceCloseGapRatio` exclusively. |

**Migration:** If you were indexing `SetSymbolMaxSlippage` for gap/slippage tracking, listen to `SetForceCloseGapRatio(uint256 symbolId, uint256 oldForceCloseGapRatio, uint256 newForceCloseGapRatio)` instead.

---

## 3. Changed Event Signatures

### 3.1 SetMuonIds

```solidity
// v0.8.4
event SetMuonIds(uint256 muonAppId, address gateway, uint256 x, uint8 parity);

// v0.8.5
event SetMuonIds(uint256 muonAppId);
```

**What changed:** Gateway address and public key parameters (`gateway`, `x`, `parity`) have been removed. Muon signature verification is now handled by an external `SymmioSignatureVerifier` contract, configured via the new `SetSignatureVerifierAddress` event.

**Migration:** Update your ABI. If you need public key/gateway info, listen to `PublicKeyAdded`, `PublicKeyRemoved`, `GatewaySignerAdded`, and `GatewaySignerRemoved` events on the `SymmioSignatureVerifier` contract instead.

### 3.2 RegisterAffiliate / DeregisterAffiliate (Typo Fix)

```solidity
// v0.8.4
event RegisterAffiliate(address affilate);   // typo
event DeregisterAffiliate(address affilate); // typo

// v0.8.5
event RegisterAffiliate(address affiliate);   // fixed
event DeregisterAffiliate(address affiliate); // fixed
```

**What changed:** The parameter name was corrected from `affilate` to `affiliate`. Since Solidity event topic hashes are computed from `event Name(type1,type2,...)` (types only, no param names), the topic hash is **unchanged**. Your ABI decoding will still work, but update your ABI JSON for correctness.

---

## 4. New Events on Existing Facets

### 4.1 Account Events (`IAccountEvents`)

```solidity
// New overload -- includes virtual deposit flag
event Deposit(address sender, address user, uint256 amount, bool isVirtual);

// Admin actions on suspended users
event WithdrawSuspendedUser(address admin, address user, address recipient, uint256 amount);
event DeallocateSuspendedUser(address admin, address user, uint256 amount, uint256 newAllocatedBalance);

// Transfer to balance (not allocation)
event InternalTransferToBalance(address sender, address user, uint256 userNewBalance, uint256 amount);

// Virtual funds system
event DepositVirtualFunds(address indexed provider, uint256 amount);
```

**Note:** The original `Deposit(address, address, uint256)` is kept as backward-compatible. The new overload adds `isVirtual` to distinguish real collateral deposits from virtual fund deposits.

### 4.2 Trading Events (`IPartiesEvents`)

```solidity
// New SendQuote format with encoded params and affiliate + arbitrary data
event SendQuote(address partyA, uint256 quoteId, address[] partyBsWhiteList, address affiliate, bytes paramsData, bytes data);

// New OpenPosition overload with locked values breakdown
event OpenPosition(uint256 quoteId, address partyA, address partyB, uint256 filledAmount, uint256 openedPrice, LockedValues lockedValues);

// New FillCloseRequest overload with locked values
event FillCloseRequest(uint256 quoteId, address partyA, address partyB, uint256 filledAmount, uint256 closedPrice, QuoteStatus quoteStatus, uint256 closeId, LockedValues lockedValues);
```

**Note:** The old `SendQuote` (with all individual params) and old `OpenPosition` (without `LockedValues`) are still emitted for backward compatibility alongside the new versions. Both events fire on each operation. The new `SendQuote` encodes params into `paramsData` bytes -- decode with `abi.decode(paramsData, (uint256, uint8, uint8, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256))` for `(symbolId, positionType, orderType, price, marketPrice, quantity, cva, lf, partyAmm, partyBmm, tradingFee, deadline)`.

### 4.3 Liquidation Events

**PartyA** (`IPartyALiquidationEvents`):
```solidity
// New overload with average closed prices for position liquidation
event LiquidatePositionsPartyA(
    address liquidator, address partyA, uint256[] quoteIds,
    uint256[] liquidatedAmounts, uint256[] closeIds, uint256[] averageClosedPrices, bytes liquidationId
);

// Emitted when LATE/OVERDUE settlement moves pending fees to escrow (see liquidation-escrow.md)
event LiquidationEscrowCreated(address indexed partyA, bytes liquidationId, uint256 amount);
```

**PartyB** (`IPartyBLiquidationEvents`):
```solidity
// New overload with average closed prices
event LiquidatePositionsPartyB(
    address liquidator, address partyB, address partyA, uint256[] quoteIds,
    uint256[] liquidatedAmounts, uint256[] closeIds, uint256[] averageClosedPrices
);
```

### 4.4 PartyB Account Events (`IPartyBAccountEvents`) -- New File

Events moved from `IAccountEvents` to a dedicated `IPartyBAccountEvents` interface, plus one new event:

```solidity
// Moved (signatures unchanged):
event AllocateForPartyB(address partyB, address partyA, uint256 amount, uint256 newAllocatedBalance);
event DeallocateForPartyB(address partyB, address partyA, uint256 amount, uint256 newAllocatedBalance);
event TransferAllocation(uint256 amount, address origin, uint256 originNewAllocatedBalance, address recipient, uint256 recipientNewAllocatedBalance);
event DepositToReserveVault(address sender, address partyB, uint256 amount);
event WithdrawFromReserveVault(address partyB, uint256 amount);

// New:
event ActivateCrossPartyB(address user);
```

### 4.5 Force Action Events (`ForceActionsFacetEvents`)

```solidity
// Two-step force close initialization
event ForceCloseInitialized(
    address indexed initiator, address indexed partyB, uint256 quoteId,
    bytes highLowPriceSigId, uint256 closePrice, uint256 timestamp
);

// Emitted when cross-partyB force close completes with insolvent partyB
event ForceClosePartyBInsolvent(
    uint256 quoteId, address partyA, address partyB,
    uint256 closedPrice, uint256 currentPrice, int256 upnlPartyB, int256 partyBAvailableAfterClose
);

// Force fetch allocated balances from partyB
event ForceFetchAllocated(
    address partyB, address[] partyAs, uint256[] FetchedAmount, uint256[] newPartyBsAllocatedBalances
);
```

### 4.6 Funding Rate Events (`IFundingRateEvents`)

```solidity
// Accumulated funding system (replaces per-quote funding for supported modes)
event SetLongFundingFee(uint256[] symbolIds, int256[] fees, int256[] marketPrices, address partyB);
event SetShortFundingFee(uint256[] symbolIds, int256[] fees, int256[] marketPrices, address partyB);
event SetEpochDuration(uint256[] symbolIds, uint256[] durations, address partyB);
event UpdateAccumulatedFundingFee(uint256[] symbolIds, int256[] longRates, int256[] shortRates, int256[] marketPrices, address partyB);
event ChargeAccumulatedFundingFee(address partyA, address partyB, uint256[] quoteIds, address sender);
```

### 4.7 Settlement Events (`SettlementFacetEvents`)

```solidity
// Unified settlement -- settles across multiple partyAs for a single partyB
event SettleUpnlUnified(
    bytes settlementId, UnifiedQuoteSettlementData[] settlementData, uint256[] updatedPrices,
    address partyB, address[] partyAs, uint256[] newPartyAsAllocatedBalances, uint256 newPartyBAllocatedBalance
);
```

### 4.8 Shared Library Events (`SharedEvents`)

```solidity
// New enums added:
enum TradeVolumeType { OPEN, CLOSE, LIQUIDATE }
enum TradingFeeType { OPEN, CLOSE }

// New events:
event TradeVolumeRecorded(
    uint256 quoteId, uint256 amount, address partyA, address partyB,
    uint256 symbolId, address affiliate, TradeVolumeType _type
);
event TradingFeeCharged(
    uint256 quoteId, uint256 amount, address partyA, address partyB,
    uint256 symbolId, address affiliate, TradingFeeType _type
);
```

### 4.9 Library Events (`LibPartiesEvents`)

```solidity
// ADL (Auto-Deleveraging) close event
event ADLClose(uint256 quoteId, uint256 amount, uint256 price);
```

### 4.10 Control Events (`IControlEvents`)

New configuration and pause/unpause events:

```solidity
// Role administration
event RoleAdminAdded(bytes32 role, address admin);
event RoleAdminRemoved(bytes32 role, address admin);

// Fee system
event SetAffiliateFeeForUser(address affiliate, address user, uint256 symbolId, uint256 oldOpenFee, uint256 newOpenFee, uint256 oldCloseFee, uint256 newCloseFee);
event SetAffiliateFee(address affiliate, uint256 symbolId, uint256 oldOpenFee, uint256 newOpenFee, uint256 oldCloseFee, uint256 newCloseFee);
event SetMinAffiliateFee(uint256 oldMinAffiliateFee, uint256 newMinAffiliateFee);

// Symbol configuration
event SetSymbolType(uint256 symbolIds, uint256 symbolTypes);

// Binding system
event SetUnbindCooldown(uint256 oldUnbindCooldown, uint256 newUnbindCooldown);
event SetPartyBBindable(address partyB, bool bindable);

// Cross PartyB
event SetCrossPartyBModeActivated(bool oldValue, bool newValue);
event SetCrossPartyB(address indexed partyB, bool enabled);
event SetLegacyDeallocateDeprecated(bool oldValue, bool newValue);

// PartyB symbol management
event WhitelistSymbolType(address partyB, uint256 symbolType);
event WhitelistSymbols(address partyB, uint256[] symbolIds);
event RemoveSymbolTypeFromWhitelist(address partyB, uint256 symbolType);
event RemoveSymbolsFromWhitelist(address partyB, uint256[] symbolIds);
event BlacklistSymbols(address indexed partyB, uint256[] symbolId);
event RemoveSymbolsFromBlacklist(address indexed partyB, uint256[] symbolId);

// Signature verification
event SetSignatureVerifierAddress(address SignatureVerifier);

// External transfer
event AddRelayerForExternalTransferTarget(address target, address relayer);
event RemoveRelayerForExternalTransferTarget(address target);

// Hooks
event RegisterHook(address affiliate, address hook);

// ADL
event SetADLEnabled(address partyB, bool enabled);

// Entity metadata
event SetEntityMetadata(address entity, EntityMetadata metadata);

// PartyA connection limits
event SetMaxPartyAConnectionLimit(uint256 maxLimit);

// Withdraw system configuration
event SetMaxWithdrawParts(uint256 maxWithdrawParts);
event SetWithdrawCooldownPeriod(uint256 oldWithdrawCooldownPeriod, uint256 newWithdrawCooldownPeriod);
event SetMinWithdrawCooldown(uint256 lastMinWithdrawCooldown, uint256 newMinWithdrawCooldown);
event LegacyWithdrawalDeprecated();
event SetSpeedUpUser(address user, bool speedUp);

// Virtual funds
event RegisterVirtualProvider(address provider);
event UnregisterVirtualProvider(address provider);
event SetPureVirtualCancelBlackout(uint256 oldBlackout, uint256 newBlackout);

// Express deposit
event RegisterExpressProvider(address provider);
event UnregisterExpressProvider(address provider);

// Liquidation insurance
event SetLiquidationInsuranceVaultParams(address insuranceVault, uint256 maxLiquidationProfit);
event SetSoftLiquidationPenaltyCollector(address softLiquidationPenaltyCollector);

// Signer
event SignerSet(address signer);

// New pause/unpause granularity
event PausePartyBOpenPositions();
event UnpausePartyBOpenPositions();
event PauseExternalTransfer();
event UnpauseExternalTransfer();
event PauseInstantLayer();
event UnpauseInstantLayer();

// Accumulated funding system
event LegacyFundingDeprecated();
event AccumulatedFundingActivated();
```

### 4.11 Migration Events (`IMigrationEvents`) -- New Facet

```solidity
event QuotesMigrated(uint256 quotesProvided, uint256 quotesMigrated);
event CrossLockedValuesMigrated(address indexed partyB, uint256 partyAsProcessed);
```

### 4.12 Diamond Ownership Events (`LibDiamond`)

```solidity
// Two-step ownership transfer (replaces single-step)
event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
event OwnershipTransferCanceled(address indexed pendingOwner);
```

---

## 5. New Facets with Events

### 5.1 ClearingHouse Facet (`IClearingHouseFacetEvents`)

The clearing house enables a trusted operator to perform structured liquidation and settlement flows for cross PartyB and PartyA takeover scenarios.

```solidity
// Liquidation initiation
event LiquidateCrossPartyB(address indexed initiator, address indexed partyB, bytes liquidationId, int256 upnl, uint256 timestamp);
event TakeoverPartyALiquidation(address indexed partyA, bytes liquidationId, uint256 timestamp);

// Clearing house operations
event DeallocateForClearingHouse(address indexed subject, address[] parties, address[] allocationKeys, uint256[] amounts);
event DistributeForClearingHouse(address indexed subject, address[] receivers, address[] allocationKeys, uint256[] amounts);
event LiquidatePendingPositionsForClearingHouse(address indexed subject, address[] counterparties, uint256[] liquidatedAmounts);
event LiquidatePositionsForClearingHouse(address indexed subject, uint256[] quoteIds, uint256[] liquidatedAmounts, uint256[] closeIds, uint256[] prices);

// Auto-takeover
event AutoTakeoverPartyALiquidation(address indexed partyA, bytes liquidationId);

// Settlement
event SettlePartyATakeover(address indexed partyA, bytes liquidationId);
event SettleCrossPartyBLiquidation(address indexed partyB);

// Liquidation escrow (see liquidation-escrow.md)
event LiquidationEscrowCreated(address indexed partyA, bytes liquidationId, uint256 amount);
event DistributeFromLiquidationEscrow(address indexed partyA, address[] receivers, address[] allocationKeys, uint256[] amounts);

// Soft liquidation
event SoftPartyBLiquidation(address partyB, address partyA, uint256 penaltyFromAllocated, uint256 penaltyFromBalance);
```

### 5.2 Binding Facet (`IBindingEvents`)

Enables PartyA to bind to a specific PartyB for instant action mode and dedicated execution.

```solidity
event BindToPartyB(address partyA, address partyB);
event RequestToUnbindFromPartyB(address partyA);
event CancelUnbindRequest(address partyA);
event CompleteUnbindRequest(address partyA, address partyB);

// Instant action mode
event ActivateInstantActionMode(address partyA, uint256 time);
event ProposeToDeactivateInstantActionMode(address partyA, uint256 time);
event DeactivateInstantActionMode(address partyA, uint256 time);
```

### 5.3 Pledge Facet (`IPledgeEvents`)

Collateral pledging system for PartyB operators.

```solidity
event PledgeCollateralDeposited(address indexed user, address indexed token, uint256 amount);
event PledgeWithdrawRequested(address indexed user, address indexed token, uint256 amount, address recipient);
event PledgeWithdrawApproved(address indexed user, address indexed token, uint256 amount);
event PledgeWithdrawCancelled(address indexed user, address indexed token, uint256 amount);
event UserSlashed(address indexed user, address indexed token, uint256 amount, address recipient);
```

### 5.4 External Transfer Facet (`IExternalTransferEvents`)

Cross-contract fund transfers with virtual fund support.

```solidity
event ExternalTransfer(address indexed sender, address indexed receiver, uint256 amount, address target);
event InitiateVirtualExternalTransfer(uint256 id, address sender, address receiver, uint256 amount, address target, address provider);
event AcceptVirtualExternalTransfer(uint256 id);
event CancelVirtualExternalTransfer(uint256 id);
```

### 5.5 Withdraw Facet (`IWithdrawEvents`)

Multi-step withdrawal system replacing the single-step `Withdraw` event from `IAccountEvents`.

```solidity
event WithdrawInitiated(uint256 indexed requestId, address indexed user, WithdrawReceiverPart[] parts, bool speedUp, bytes providerData, uint256 cooldownEndTime);
event WithdrawAccepted(uint256 indexed requestId, address indexed user);
event WithdrawFinalized(uint256 indexed requestId, address indexed user);
event WithdrawCancelRequested(uint256 indexed requestId, address indexed user);
event WithdrawCancelled(uint256 indexed requestId, address indexed user);
event Withdraw(address sender, address user, uint256 amount);
event WithdrawSuspended(uint256 requestId, address user);
event WithdrawRejected(uint256 requestId, address user);
event WithdrawSpeedUpAccepted(uint256 requestId, address user, uint256 newCooldown);
```

**Migration:** The old single-step `Withdraw(address, address, uint256)` is still emitted (from `WithdrawFacetImpl`) for backward compatibility. However, the full withdrawal lifecycle now flows through `WithdrawInitiated` -> `WithdrawAccepted` -> `WithdrawFinalized`. Indexers tracking withdrawal status should listen to all lifecycle events.

---

## 6. New AccountLayer Diamond Events

The AccountLayer is an entirely new diamond introduced in v0.8.5. It manages sub-accounts, virtual accounts, affiliate registration, and margin operations. If you are integrating with the AccountLayer for the first time, index all events below.

### 6.1 Core Facet (`ICoreFacet`)

```solidity
event SubAccountCreated(address indexed account, address indexed owner, address indexed affiliate, string name);
event SubAccountDeleted(address indexed account, address indexed owner, address indexed affiliate);
event VirtualAccountCreated(address indexed account, address indexed parent);
event VirtualAccountReused(address indexed account, address indexed parent);
event VirtualAccountDeleted(address indexed account, address indexed parent);
event SingleVAModeChanged(address indexed subAccount, bool enabled);
event EditAccountName(address indexed account, string name);
event Call(address indexed sender, address indexed account, bytes callData, bool success, bytes resultData);
event HookActionExecuted(address indexed account, address indexed affiliate, bytes4 selector);
event LegacyAccountImported(address indexed account, address indexed owner, address indexed legacyContract, address affiliate);
```

### 6.2 Margin Facet (`IMarginFacet`)

```solidity
event AddMargin(address indexed virtualAccount, address indexed subAccount, uint256 amount);
event RemoveMargin(address indexed virtualAccount, address indexed subAccount, uint256 amount);
event EmergencyMarginRecovered(address indexed virtualAccount, address indexed subAccount, uint256 amount);
```

### 6.3 Affiliate Facet (`IAffiliateFacet`)

```solidity
event AffiliateRegistered(address indexed affiliate, string name);
event AffiliateApproved(address indexed affiliate, address indexed feeDistributor);
event AffiliateUpdated(address indexed affiliate, string name, string brandColor);
event AffiliatePaused(address indexed affiliate);
event AffiliateUnpaused(address indexed affiliate);
event StakeholdersUpdateRequested(address indexed affiliate);
event StakeholdersUpdated(address indexed affiliate);
event RegistrationCancelled(address indexed affiliate);
event RegistrationRejected(address indexed affiliate, address indexed admin);
event AdminTransferProposed(address indexed affiliate, address indexed newAdmin);
event AdminTransferCompleted(address indexed affiliate, address indexed oldAdmin, address indexed newAdmin);
event AdminTransferCancelled(address indexed affiliate);
event FeesDistributed(address indexed recipient, uint256 amount);
event FeesClaimed(address indexed affiliate, address indexed symmio, uint256 amount);
event FeeUpdateCancelled(address indexed affiliate);
event HookSet(address indexed affiliate, bytes4 indexed selector, address hook);
event HookRemoved(address indexed affiliate, bytes4 indexed selector);
event OperatorSet(address indexed affiliate, bytes4 indexed selector, address indexed operator, bool status);
event ExpressRateSet(address indexed affiliate, uint256 expressRate);
event VirtualProviderSet(address indexed affiliate, address virtualProvider);
```

### 6.4 Control Facet (`IControlFacet`)

```solidity
event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
event RoleAdminSet(bytes32 indexed role, address indexed account, bool status, address indexed sender);
event AccountManagerImplementationUpdated(bytes oldImplementation, bytes newImplementation);
event SignerUpdated(address oldSigner, address newSigner);
event SymmioFeeReceiverUpdated(address indexed oldReceiver, address indexed newReceiver);
event WhitelistedSymmioCoreSet(address indexed core, bool status);
event AccountManagerDeployed(address indexed affiliate, address indexed accountManager);
event HookAllowedSelectorsSet(address indexed affiliate, bytes4[] selectors, bool allowed);
event CallAllowedSelectorsSet(address indexed affiliate, bytes4[] selectors, bool allowed);
event SymmioCoreAddedToAffiliate(address indexed affiliate, address indexed core);
```

### 6.5 SymmioHook Facet (`ISymmioHookFacet`)

```solidity
event VirtualAccountDeleted(address indexed account, address indexed parent);
```

---

## 7. Structural Changes Summary

### 7.1 File Reorganization

| v0.8.4 Location | v0.8.5 Location | Notes |
|---|---|---|
| `contracts/facets/` | `contracts/core/facets/` | All core facets moved under `core/` |
| `contracts/interfaces/` | `contracts/core/interfaces/` | Core interfaces moved under `core/` |
| `contracts/libraries/` | `contracts/core/libraries/` | Core libraries moved under `core/` |
| `contracts/storages/` | `contracts/core/storages/` | Storage contracts moved under `core/` |
| `contracts/facets/liquidation/ILiquidationEvents.sol` | Split into `PartyALiquidation/IPartyALiquidationEvents.sol` + `PartyBLiquidation/IPartyBLiquidationEvents.sol` | Liquidation events split by party |
| `IAccountEvents.sol` (contained PartyB events) | `IAccountEvents.sol` + `IPartyBAccountEvents.sol` | PartyB account events extracted |
| `IPartyBPositionActionsEvents.sol` (contained emergency close) | `IPartyBPositionActionsEvents.sol` + `IPartyBEmergencyActionsEvents.sol` | Emergency close extracted |
| N/A | `contracts/accountLayer/` | Entirely new AccountLayer diamond |

### 7.2 New Enums in SharedEvents

The `BalanceChangeType` enum has two new values appended (14 total, up from 12):

- `DEFERRED_BALANCE_IN` (index 12): Emitted when deferred excess balance is returned to PartyA at settlement.
- `DEFERRED_BALANCE_OUT` (index 13): Emitted when excess balance is moved to `partyADeferredBalance` during deferred liquidation initiation.

See [Liquidation Escrow](liquidation-escrow.md) for context on how these relate to the escrow mechanism.

Two new enums have also been added:

- `TradeVolumeType`: `OPEN`, `CLOSE`, `LIQUIDATE`
- `TradingFeeType`: `OPEN`, `CLOSE`

These are used by the new `TradeVolumeRecorded` and `TradingFeeCharged` events.

---

## 8. Migration Checklist

### For Subgraph / Event Indexer Developers

- [ ] Update ABIs for all changed event signatures (especially `SetMuonIds`, `RegisterAffiliate`)
- [ ] Remove handlers for all 21 deleted backward-compatible overloads
- [ ] Add handlers for the replacement full-parameter events
- [ ] Add handlers for new `OpenPosition` and `FillCloseRequest` overloads with `LockedValues`
- [ ] Add handlers for new `SendQuote` format with `paramsData` + `data`
- [ ] Add `LiquidatePositionsPartyA` and `LiquidatePositionsPartyB` overloads with `averageClosedPrices`
- [ ] Index new withdraw lifecycle events (`WithdrawInitiated`, `WithdrawAccepted`, `WithdrawFinalized`, etc.)
- [ ] Index ClearingHouse events if tracking cross PartyB liquidation flows
- [ ] Index Binding events if tracking PartyA-PartyB binding state
- [ ] Index `TradeVolumeRecorded` and `TradingFeeCharged` for fee/volume analytics
- [ ] Index `LiquidationEscrowCreated` and `DistributeFromLiquidationEscrow` for escrow tracking
- [ ] Handle new `DEFERRED_BALANCE_IN` and `DEFERRED_BALANCE_OUT` values in `BalanceChangeType` enum
- [ ] Index `ADLClose` for auto-deleveraging tracking
- [ ] Add AccountLayer diamond address as a new data source if indexing sub-accounts/affiliates

### For Hedger / PartyB Integrators

- [ ] Update event listeners for removed backward-compatible overloads
- [ ] Handle new `ForceCloseInitialized` event for two-step force close flow
- [ ] Handle `ForceClosePartyBInsolvent` for cross-partyB insolvency scenarios
- [ ] Listen to `ForceFetchAllocated` for forced allocation fetches
- [ ] Handle accumulated funding events (`SetLongFundingFee`, `SetShortFundingFee`, `ChargeAccumulatedFundingFee`)
- [ ] Handle `SoftPartyBLiquidation` events from the ClearingHouse
- [ ] Listen to new pause events (`PausePartyBOpenPositions`, `PauseExternalTransfer`, `PauseInstantLayer`)
- [ ] Handle binding system events if supporting bound PartyA accounts

### For Frontend Developers

- [ ] Update deposit event parsing to handle both `Deposit(address,address,uint256)` and `Deposit(address,address,uint256,bool)`
- [ ] Update withdrawal UI to track multi-step flow via `WithdrawInitiated` -> `WithdrawAccepted` -> `WithdrawFinalized`
- [ ] Display `LockedValues` from new `OpenPosition` and `FillCloseRequest` events
- [ ] Parse new `SendQuote` format (decode `paramsData` bytes)
- [ ] Add UI for AccountLayer events if integrating sub-account management
