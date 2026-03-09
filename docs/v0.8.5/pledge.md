# Pledge Collateral

Pledge collateral is a separate collateral pool that PartyBs deposit as a guarantee of good behavior. It is independent of the trading collateral used for positions and serves as a "skin in the game" mechanism -- if a PartyB acts maliciously (e.g., abuses ADL by closing positions at unfair prices), their pledge can be slashed by an admin.

## Depositing

Any PartyB can deposit pledge collateral in any ERC20 token. Amounts are in the token's native decimals.

```solidity
pledgeFacet.depositPledge(tokenAddress, amount);
```

## Withdrawing

Withdrawal follows a two-step request-approval flow to prevent rug-pulls:

```solidity
// 1. PartyB requests withdrawal
pledgeFacet.requestPledgeWithdraw(tokenAddress, amount, recipientAddress);

// 2. Admin approves withdrawal (requires PARTY_B_MANAGER_ROLE)
pledgeFacet.acceptPledgeWithdraw(partyBAddress, amount, tokenAddress);

// Or PartyB can cancel their own request
pledgeFacet.cancelPledgeWithdraw();
```

## Slashing

If a PartyB misbehaves, an admin with `PARTY_B_MANAGER_ROLE` can slash their pledge collateral and redirect it to any recipient:

```solidity
pledgeFacet.slashPledge(partyBAddress, tokenAddress, penaltyAmount, recipientAddress);
```

## Relation with ADL

Pledge collateral is primarily used as a penalty mechanism for [ADL (Auto-Deleveraging)](adl-close.md) usage. Before enabling ADL for a PartyB, they should have deposited sufficient pledge collateral. If ADL is misused -- e.g., closing positions at prices that unfairly harm PartyA -- the pledge can be slashed. This ensures PartyBs are incentivized to use ADL fairly.
