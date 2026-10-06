# Virtual Fund System

## Overview

Symmio operates across many chains, and users' funds are often fragmented between them. Bridging funds manually is slow and creates friction for users working with Symmio frontends. The Virtual Fund System solves this by introducing **virtual deposits** and **virtual withdrawals** -- mechanisms that let trusted providers credit or debit a user's balance in a Symmio contract without requiring an immediate on-chain token transfer on that specific chain.

In concrete terms: a user deposits funds to a provider on Chain A, and that provider calls `virtualDepositFor` on the Symmio contract on Chain B to credit the user's balance there. When withdrawing, the provider pays the user on their preferred chain and absorbs the balance reduction on the source chain. The actual collateral reconciliation between the provider and the Symmio contract happens asynchronously.

The system touches three layers of the protocol:

| Layer | Responsibility |
|-------|---------------|
| **Core (AccountFacet)** | `virtualDepositFor`, `virtualDepositAndAllocateFor`, `depositVirtualFunds` |
| **Core (WithdrawFacet)** | Virtual withdrawal flow with provider callbacks |
| **Core (ExternalTransferFacet)** | Cross-diamond virtual transfers between Symmio deployments |
| **Account Layer (CoreFacet)** | Express deposit splitting with virtual providers |

## Virtual Provider Registration

Virtual providers are trusted contracts registered by an admin with `PROVIDER_ADMIN_ROLE`. Registration is stored in `WithdrawStorage` and a provider cannot be both a virtual provider and an express provider simultaneously.

```solidity
// ControlFacet.sol
function registerVirtualProvider(address provider) external onlyRole(LibAccessibility.PROVIDER_ADMIN_ROLE);
function unregisterVirtualProvider(address provider) external onlyRole(LibAccessibility.PROVIDER_ADMIN_ROLE);
```

Registration is checked via the `virtualProviders` mapping:

```solidity
// WithdrawStorage.sol
mapping(address => bool) virtualProviders;
```

A view function is available to query registration status:

```solidity
function isVirtualProviderRegistered(address provider) external view returns (bool);
```

## Virtual Deposit

### `virtualDepositFor`

The core primitive. A registered virtual provider calls this to credit a user's balance **without transferring any ERC-20 tokens** in the same transaction. The provider is trusted to hold (or have already received) the corresponding collateral off-chain or on another chain.

```solidity
function virtualDepositFor(address user, uint256 amount) external whenNotAccountingPaused;
```

Internally, the implementation checks that `msg.sender` is a registered virtual provider, then directly increments the user's balance:

```solidity
// AccountFacetImpl.sol
function virtualDepositFor(address user, uint256 amount) internal {
    require(
        WithdrawStorage.layout().virtualProviders[msg.sender],
        "AccountFacet : msg.sender not registered as virtual provider"
    );
    AccountStorage.layout().balances[user] += amount;
}
```

The `amount` parameter is in **18-decimal precision** (not collateral decimals). The emitted `Deposit` event converts back to collateral decimals for backward compatibility and includes an `isVirtual = true` flag:

```solidity
event Deposit(address sender, address user, uint256 amount, bool isVirtual);
```

### `virtualDepositAndAllocateFor`

A convenience function that performs a virtual deposit and immediately allocates the funds, making them available for trading in a single transaction:

```solidity
function virtualDepositAndAllocateFor(address user, uint256 amount) external whenNotAccountingPaused;
```

This calls `_virtualDepositFor` followed by `AccountFacetImpl.allocate`, emitting both `Deposit` and `AllocatePartyA` events.

### `depositVirtualFunds`

When a virtual provider wants to reconcile -- transferring actual collateral tokens to the Symmio contract to back previously virtual-deposited balances -- it calls this function:

```solidity
function depositVirtualFunds(uint256 amount) external whenNotAccountingPaused;
```

This transfers ERC-20 tokens from the virtual provider to the Symmio contract via `safeTransferFrom`. It does **not** credit any user's balance; it simply moves real collateral into the contract to ensure solvency. Only registered virtual providers can call it.

## The IVirtualProvider Interface

Virtual providers must implement `IVirtualProvider`. Symmio calls these callbacks during withdraw, external transfer, and express deposit flows:

```solidity
interface IVirtualProvider {
    // Withdrawal lifecycle
    function onWithdrawRequest(WithdrawRequest memory withdrawRequest) external;
    function onWithdrawComplete(WithdrawRequest memory withdrawRequest) external;
    function onWithdrawCancelRequest(WithdrawRequest memory withdrawRequest) external;
    function onForceWithdrawCancel(WithdrawRequest memory withdrawRequest) external;
    function onSpeedUpWithdrawRequest(WithdrawRequest memory withdrawRequest, uint256 newCooldown) external;
    function onWithdrawSuspend(WithdrawRequest memory withdrawRequest) external;

    // Cross-diamond external transfers
    function onExternalTransfer(VirtualExternalTransferRequest memory externalTransfer) external;
    function onCancelExternalTransfer(uint256 id) external;

    // Express deposit (called from Account Layer)
    function onExpressDeposit(address user, uint256 amount, address symmioCore) external;
}
```

### Callback Security

All callbacks from the core layer are made through `LibSafeCall.safeExternalCall`, which clears the global `signer` before the external call and restores it afterward. This prevents a malicious provider from calling back into the Symmio contract and impersonating the user via `getSigner()`. The Account Layer uses an analogous `LibAccountLayerSafeCall` that clears `globalSigner` with the same pattern.

## Integration with the Withdraw System

Virtual providers participate in the multi-part withdrawal system. Each `WithdrawReceiverPart` can specify a `virtualProvider` address for cross-chain delivery:

```solidity
struct WithdrawReceiverPart {
    uint256 id;
    uint256 amount;
    int256 chainId;          // Destination chain (can differ from current chain)
    bytes receiver;          // Destination address
    address virtualProvider; // Non-zero for virtual parts
    address expressProvider; // Non-zero for express parts
}
```

### Pure Virtual Withdrawal

When all parts use a virtual provider (and no express provider), the withdrawal is classified as "pure virtual" (`isPureVirtual = true`). In this flow:

1. User calls `initiateWithdraw` with virtual provider parts
2. Symmio notifies the provider via `onWithdrawRequest`
3. Provider calls `acceptWithdrawRequest` to confirm
4. After cooldown, anyone calls `finalizeWithdrawRequest`
5. Symmio notifies the provider via `onWithdrawComplete`
6. Provider delivers funds to the user on the destination chain

Key detail: virtual parts do **not** lock real collateral in `withdrawLockedBalance`. The locked amount is `totalAmount - totalVirtualAmount`, since the virtual portion has no corresponding tokens in the contract.

### Cancel Blackout

Pure virtual withdrawals have a configurable `pureVirtualCancelBlackout` period. During this window before cooldown expiry, the user cannot cancel, giving the provider certainty that accepted requests will complete.

## Virtual External Transfers

Virtual providers also mediate cross-diamond fund transfers. When a user wants to move funds from one Symmio deployment to another without a real token transfer:

```solidity
function virtualExternalTransfer(
    address receiver,
    uint256 amount,
    address target,
    address virtualProvider
) external;
```

This flow:

1. Deducts the amount from the sender's balance on the source diamond
2. Creates a `VirtualExternalTransferRequest` with status `PENDING`
3. Notifies the virtual provider via `onExternalTransfer`
4. The provider calls `acceptVirtualExternalTransfer` on the source diamond (marking it `COMPLETED`)
5. The provider then calls `virtualDepositFor` on the target diamond to credit the receiver

If the provider fails to accept, the user can cancel via `cancelVirtualExternalTransfer`, which refunds the balance and notifies the provider via `onCancelExternalTransfer`.

```solidity
struct VirtualExternalTransferRequest {
    uint256 id;
    address sender;    // User on source diamond
    address receiver;  // User on target diamond
    address source;    // Source Symmio contract
    address target;    // Target Symmio contract
    uint256 amount;
    uint256 timestamp;
    address provider;
    VirtualExternalTransferStatus status;  // PENDING, COMPLETED, CANCELED
}
```

## Express Deposit (Account Layer)

At the Account Layer, affiliates can configure an `expressRate` and a `virtualProvider` to split deposits between real and virtual portions. This is designed for instant cross-chain deposits where part of the funds are sent to a virtual provider for immediate crediting.

### Configuration

Affiliate admins configure the split via the `AffiliateFacet`:

```solidity
function setExpressRate(address affiliate, uint256 expressRate) external;
function setVirtualProvider(address affiliate, address virtualProvider) external;
```

The `expressRate` is a fraction in 1e18 precision (e.g., `0.5e18` = 50% virtual). The `virtualProvider` must be set if `expressRate > 0`.

### Deposit Flow

When a user calls `depositForAccountWithExpressRate` or `depositAndAllocateForAccountWithExpressRate`:

1. The Account Layer pulls the full `amount` from the user
2. Calculates `virtualAmount = amount * expressRate / 1e18`
3. Deposits `realAmount = amount - virtualAmount` directly to Symmio via the normal deposit path
4. Transfers `virtualAmount` to the virtual provider's address
5. Calls `onExpressDeposit(user, virtualAmount, symmioCore)` on the provider
6. The provider converts to 18-decimal precision and calls `virtualDepositFor` on the Symmio core
7. The Account Layer verifies the **balance invariant**: the user's total balance increase (balance + allocated) must exactly equal the expected 18-decimal amount

This invariant check prevents malicious providers from depositing incorrect amounts:

```solidity
uint256 balanceIncrease = balanceAfter - balanceBefore;
uint256 allocatedIncrease = usesAllocation ? allocatedAfter - allocatedBefore : 0;
uint256 expectedIncrease = (amount * 1e18) / (10 ** collateralDecimals);
if (balanceIncrease + allocatedIncrease != expectedIncrease) revert BalanceInvariantViolation();
```

## Trust Model

Virtual providers are highly trusted entities. The system relies on several safeguards:

1. **Registration gating**: Only `PROVIDER_ADMIN_ROLE` can register/unregister providers
2. **Signer isolation**: `LibSafeCall` clears the signer context during all provider callbacks, preventing reentrancy-based impersonation
3. **Balance invariant**: The Account Layer verifies that express deposits produce exactly the expected balance change
4. **Mutual exclusion**: A contract cannot be both a virtual and express provider simultaneously
5. **Cooldown blackout**: Pure virtual withdrawals have a cancellation blackout period to prevent last-moment cancellations that could disadvantage providers

The provider is trusted to eventually deliver funds to users (on other chains) and to reconcile collateral via `depositVirtualFunds`. Misbehavior by a provider would be detected off-chain and the provider can be unregistered by the admin.

## Technical Reference

### Core Functions

```solidity
// Virtual deposit (provider -> user balance)
function virtualDepositFor(address user, uint256 amount) external;
function virtualDepositAndAllocateFor(address user, uint256 amount) external;

// Provider collateral reconciliation
function depositVirtualFunds(uint256 amount) external;

// Virtual external transfer (cross-diamond)
function virtualExternalTransfer(address receiver, uint256 amount, address target, address virtualProvider) external;
function acceptVirtualExternalTransfer(uint256 id) external;
function cancelVirtualExternalTransfer(uint256 id) external;
```

### Admin Functions

```solidity
// Provider management (requires PROVIDER_ADMIN_ROLE)
function registerVirtualProvider(address provider) external;
function unregisterVirtualProvider(address provider) external;
```

### Account Layer Functions

```solidity
// Express deposit with virtual split
function depositForAccountWithExpressRate(address account, uint256 amount) external;
function depositAndAllocateForAccountWithExpressRate(address account, uint256 amount) external;

// Affiliate configuration
function setExpressRate(address affiliate, uint256 expressRate) external;
function setVirtualProvider(address affiliate, address virtualProvider) external;
```

### Events

```solidity
// Core
event Deposit(address sender, address user, uint256 amount, bool isVirtual);
event DepositVirtualFunds(address indexed provider, uint256 amount);

// Control
event RegisterVirtualProvider(address provider);
event UnregisterVirtualProvider(address provider);

// External Transfer
event InitiateVirtualExternalTransfer(uint256 id, address sender, address receiver, uint256 amount, address target, address virtualProvider);
event AcceptVirtualExternalTransfer(uint256 id);
event CancelVirtualExternalTransfer(uint256 id);

// Account Layer
event ExpressRateSet(address indexed affiliate, uint256 expressRate);
event VirtualProviderSet(address indexed affiliate, address virtualProvider);
```
