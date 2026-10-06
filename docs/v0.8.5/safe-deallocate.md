# SafeDeallocate

The safeDeallocate function allows Party A to deallocate funds while accounting for off-chain pending operations (e.g., solver orders that haven't been written on-chain yet). This protects solvers from users front-running deallocations before the solver's batched transactions land on-chain.

When a user requests a solver to open a position:

1. User makes off-chain request to solver
2. Solver prepares to batch sendQuote + lockQuote + openPosition in one transaction
3. User calls deallocate before solver's transaction lands
4. Solver's transaction fails due to insufficient user funds

Muon now provides a pendingBalance value representing funds committed to off-chain operations. The new safeDeallocate function ensures:

```solidity
availableBalance >= pendingBalance + deallocateAmount
```

**New Signature Struct**

```solidity
struct SingleUpnlWithPendingBalanceSig {
	bytes reqId;
	uint256 timestamp;
	int256 upnl;
	uint256 pendingBalance;  // Funds reserved for pending off-chain operations
	bytes gatewaySignature;
	IMuonSignatureVerifier.SchnorrSign sigs;
}
```
