# **Oracle-Less Trading**

Whenever partyA is trading exclusively with a single partyB, there is no risk of one partyB doing something that could harm another. In this case, we can remove the Muon signature checks. If partyA trusts partyB, they can bind themselves to
that specific partyB, and from that moment onward, the signatures previously required for trading will no longer be checked. PartyB can then pass any value they choose to the contract method.

This change will increase the overall speed of the system as partyBs don't have to wait for muon signatures before every transaction.

## Binding Requirements

Before partyA can bind to a partyB, they must meet the following conditions:

1. **No pending quotes** - PartyA must have zero pending locked balance (no quotes in PENDING, LOCKED, or CANCEL_PENDING status)
2. **No open positions with other partyBs** - All existing open positions must be with the target partyB

This ensures a clean state before entering the bound relationship.

## Binding Flow

The `bindToPartyB` function lets a caller initiate a binding, ensuring the target address isn't zero, that they have no pending quotes, no open positions with other partyBs, and that they're not already bound. Once bound, the caller can

later request to unbind using `requestToUnbindFromPartyB`, which doesn't immediately break the link but instead moves the status into a `PENDING_UNBIND` state, recording the time of the request. If the caller changes their mind, they can

reverse this step with `cancelUnbindRequest`, restoring the state back to `BOUND`. Finally, `completeUnbindRequest` finalizes the unbinding process: either `partyB` can immediately complete it, or anyone else (including `partyA` themselves)
must wait until a cooldown period has passed. Once complete, the link is severed, the status is reset to `NOT_BOUND`, and timestamps are updated for traceability.

## Security Consideration: Fee Draining via Fabricated UPNL

Because Muon signature verification is bypassed for bound PartyAs, a malicious PartyA can pass fabricated positive UPNL values to `sendQuote`. This inflates their apparent available balance, allowing them to send more quotes than they could otherwise afford. Each quote deducts a real trading fee from `allocatedBalances`, so the PartyA effectively drains their balance into pending fees.

If the PartyA is then liquidated as `LATE` or `OVERDUE`, those pending quotes are cancelled and their fees would normally be refunded to the PartyA at settlement -- recovering the exact funds they drained. This is addressed by the [liquidation escrow](liquidation-escrow.md) mechanism, which redirects pending fee reimbursements to a ClearingHouse-controlled escrow in `LATE`/`OVERDUE` liquidations instead of returning them to the PartyA.

The vulnerability exists in non-bound mode as well, but the Muon oracle enforces accurate UPNL values during `sendQuote`, which limits the amount of excess fee draining that is practically possible.
