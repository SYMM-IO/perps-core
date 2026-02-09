# ADL Close (Auto-Deleveraging)

ADL (Auto-Deleveraging) is a mechanism that allows PartyB (hedger) to forcibly close positions to reduce their risk exposure. Unlike emergency close, ADL does not require emergency mode activation, PartyB emergency status, or delisted symbols. It provides PartyB with a controlled way to reduce positions when needed.

## Key Characteristics

- **No solvency checks**: Unlike `fillCloseRequest`, ADL close does not verify that PartyB has sufficient available balance. This allows PartyB to close positions even when they might otherwise be blocked.
- **Preserves pending close requests**: If the position has a pending close request from PartyA (`CLOSE_PENDING` or `CANCEL_CLOSE_PENDING`), ADL will temporarily cancel it, execute the ADL close, and then restore the original close request with adjusted quantity if the position remains open.
- **PartyB-initiated**: Only the PartyB of the quote can call ADL close on their positions.

## Enabling ADL for a PartyB

ADL must be explicitly enabled for each PartyB by an admin with `PARTY_B_MANAGER_ROLE`:

```solidity
// Enable ADL for a PartyB
controlFacet.setADLEnabled(partyBAddress, true);

// Disable ADL for a PartyB
controlFacet.setADLEnabled(partyBAddress, false);

// Check if ADL is enabled
bool enabled = viewFacet.isADLEnabled(partyBAddress);
```

## Assurance Collateral

### What is Assurance Collateral?

Assurance collateral is a separate collateral pool that PartyB deposits as a guarantee of good behavior. It is independent of the trading collateral used for positions.

### Depositing Assurance Collateral

```solidity
// PartyB deposits assurance collateral
assuranceFacet.depositAssuranceCollateral(tokenAddress, amount);
```

### Withdrawing Assurance Collateral

Withdrawal follows a request-approval flow:

```solidity
// 1. PartyB requests withdrawal
assuranceFacet.requestAssuranceWithdraw(tokenAddress, amount, recipientAddress);

// 2. Admin approves withdrawal (requires PARTY_B_MANAGER_ROLE)
assuranceFacet.acceptAssuranceWithdraw(partyBAddress, amount, tokenAddress);

// Or PartyB can cancel their request
assuranceFacet.cancelAssuranceWithdraw();
```

### Relation with ADL

Assurance collateral serves as a penalty mechanism for ADL usage:

1. **Enabling ADL**: Before enabling ADL for a PartyB, they should have deposited sufficient assurance collateral.
2. **Slashing**: If PartyB misuses ADL (e.g., closes positions at unfair prices harming PartyA), their assurance collateral can be slashed:

```solidity
// Admin slashes PartyB's assurance collateral (requires PARTY_B_MANAGER_ROLE)
assuranceFacet.slashUser(partyBAddress, tokenAddress, penaltyAmount, recipientAddress);
```

This mechanism ensures PartyB has "skin in the game" and is incentivized to use ADL fairly.

## Event Emissions for Off-Chain Compatibility

ADL close emits events that mirror the normal close flow, ensuring off-chain applications (indexers, UIs, analytics) continue to work without modification.

### Event Sequence for ADL Close on OPENED Position

```
1. RequestToClosePosition (orderType: MARKET, closeId: adlCloseId)
2. FillCloseRequest (closeId: adlCloseId)
```

### Event Sequence for ADL Close on CLOSE_PENDING Position

When ADL interrupts an existing close request:

```
1. RequestToCancelCloseRequest (closeId: previousCloseId)  // Mock: PartyA requested cancel
2. AcceptCancelCloseRequest (closeId: previousCloseId)     // Mock: PartyB accepted cancel
3. RequestToClosePosition (orderType: MARKET, closeId: adlCloseId)  // ADL close request
4. FillCloseRequest (closeId: adlCloseId)                  // ADL fill

// If position still has remaining open amount:
5. RequestToClosePosition (closeId: newCloseId)            // Restore original close request
```

### Event Sequence for ADL Close on CANCEL_CLOSE_PENDING Position

```
1. AcceptCancelCloseRequest (closeId: previousCloseId)     // Mock: accept the pending cancel
2. RequestToClosePosition (orderType: MARKET, closeId: adlCloseId)
3. FillCloseRequest (closeId: adlCloseId)

// If position still has remaining open amount:
4. RequestToClosePosition (closeId: newCloseId)            // Restore original close request
5. RequestToCancelCloseRequest (closeId: newCloseId)       // Restore cancel-pending status
```

### Why Mock Events?

Off-chain applications track position state through events. By emitting the same event sequence as a normal close flow, ADL ensures:

- **Indexers** correctly update position state without special ADL handling
- **UIs** show consistent state transitions
- **Analytics** accurately track close volumes and prices
- **CloseId tracking** remains consistent (each close request gets a unique ID)

## Usage

### Single ADL Close (Direct Call)

```solidity
// PartyB calls ADL close directly on the diamond
partyBEmergencyActionsFacet.adlClose(
    quoteId,      // Quote ID to close
    amount,       // Amount to close (must be <= open amount)
    price         // Execution price
);
```

### Batched ADL Close (via SymmioPartyB Contract)

The `SymmioPartyB` helper contract provides a batched ADL close method that processes multiple quotes in a single transaction. Unlike the direct call, this method **does not revert** when individual ADL closes fail - it skips failed quotes and continues processing.

```solidity
// Batch ADL close multiple quotes
symmioPartyB.adlClose(
    quoteIds,     // Array of quote IDs to close
    amounts,      // Array of amounts to close (one per quote)
    prices        // Array of execution prices (one per quote)
);
```

### Key Features

- **Best-effort execution**: If one quote fails to ADL close (e.g., invalid amount, already liquidated), it emits an `ADLSkip` event and continues with the remaining quotes.
- **No transaction revert on individual failures**: Only reverts on precondition failures (access control, array mismatch, invalid Symmio address).
- **Detailed error reporting**: The `ADLSkip` event includes the raw revert data for debugging.

### ADLSkip Event

```solidity
event ADLSkip(
    uint256 quoteId,      // Quote that failed to ADL close
    uint256 amount,       // Requested close amount
    uint256 price,        // Requested execution price
    bytes revertData      // Raw revert data (ABI-encoded error)
);
```
