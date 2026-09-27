# Pledge token whitelist

`depositPledge(token, amount)` accepts a token only when a manager has explicitly whitelisted its address. The check runs before the token transfer call. Every token starts disabled, including the protocol's trading collateral; setting the trading collateral does not approve it for pledge deposits.

## Manager operations

Call these functions on the **Core diamond**, using the `PledgeFacet` ABI or the combined `abis/symmio.json` ABI:

| Operation                        | Call                                    | Authority                   |
| -------------------------------- | --------------------------------------- | --------------------------- |
| Approve a token for new deposits | `setPledgeTokenWhitelist(token, true)`  | `PLEDGE_TOKEN_MANAGER_ROLE` |
| Stop new deposits of a token     | `setPledgeTokenWhitelist(token, false)` | `PLEDGE_TOKEN_MANAGER_ROLE` |
| Read the current setting         | `isPledgeTokenWhitelisted(token)`       | Public                      |

Each update emits `PledgeTokenWhitelistUpdated(token, whitelisted)`. The setter rejects the zero address, and enabling an address requires deployed code. Managers can remove a token while accounting is paused. The setter uses the existing `onlyRole` check, including its restriction on calls with a configured signer context.

`PLEDGE_TOKEN_MANAGER_ROLE` is dedicated to token approval and removal. `PARTY_B_MANAGER_ROLE` remains responsible for approving pledge withdrawals and slashing; it does not authorize whitelist updates. A whitelist operator does not gain withdrawal or slashing authority.

A default admin or an administrator of the new role can grant it through `ControlFacet.grantRole(operator, keccak256("PLEDGE_TOKEN_MANAGER_ROLE"))`. Existing deployments require an explicit grant; there is no automatic migration from `PARTY_B_MANAGER_ROLE`. Fresh deployments include the new role in the existing protocol-admin role manifest. Calling the whitelist setter never grants or changes roles.

## Token review and accounting

Managers are responsible for reviewing token behavior off-chain before approval and monitoring changes afterward, including upgrades and configurable transfer fees.

Deposits continue to credit the requested `amount` in the token's native units. There is no balance-delta check, transfer-fee adjustment, rebase adjustment, or share accounting. Approval is a manager decision that the token is compatible with this fixed-amount ledger; the existence of deployed code alone does not establish compatibility or safety.

Fee-on-transfer and rebasing tokens are not automatically handled by the whitelist. Managers must account for those behaviors in their approval policy.

## Depositors and existing balances

Depositor eligibility is unchanged. `LibSigner.getSigner()` still identifies both the address funding the deposit and the account receiving pledge credit. Registration as a PartyB is not an additional requirement.

Removing a token blocks only new deposits. It does not erase balances or withdrawal requests, and it does not add a whitelist condition to withdrawal requests, cancellations, approvals, or slashing. Existing pause, suspension, role, and balance checks still apply. Re-enabling the token permits new deposits again.

## Upgrade and initial configuration

The new `whitelistedTokens` mapping is appended after the existing pledge balance and withdrawal-request mappings in `PledgeStorage`. Their slots remain unchanged.

1. Review the deployment's token addresses and explicitly grant `PLEDGE_TOKEN_MANAGER_ROLE` to the intended whitelist operator through an authorized role administrator. Verify the grant before seeding the whitelist.
2. Deploy the updated `PledgeFacet`. Prepare the diamond cut to replace its existing selectors and add `setPledgeTokenWhitelist(address,bool)` and `isPledgeTokenWhitelisted(address)`.
3. Explicitly seed every approved token through the Core diamond. Existing tokens are not automatically approved. When the upgrade authority also holds the manager role, include the setter calls after the cut in the same authorized batch. Otherwise, coordinate the upgrade and manager calls while accounting is paused, and verify the whitelist before resuming deposits.
4. Verify selector routing, read each token's whitelist status, and confirm the executed update events. Rehearse the deposit and removal flows against the intended upgrade state before production execution.

For a token-specific issue, remove that token to stop further pledge deposits. Reverting to a facet without this check would restore arbitrary token calls and should not be used as the routine response to a listing problem.

## Verification

The whitelist regression suite tests rejection before any token interaction, dedicated-role authorization and revocation, separation from withdrawal/slashing authority, signer-context protection, invalid addresses, management during an accounting pause, unchanged depositor eligibility and raw amounts, signer attribution, and withdrawal/slashing after removal.

```bash
npx hardhat test mocha --network default -- test/parallel/PledgeTokenWhitelist.test.ts
npx hardhat test mocha --no-compile --network default -- test/parallel/AccountFacet.test.ts test/parallel/SymmioPartyB.test.ts test/parallel/PartyBEmergencyActionsFacet.test.ts test/parallel/SolverFee.test.ts
```
