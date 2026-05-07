# AccountLayer Delegated Creation & Ownership Transfer

Version: v0.8.6 auditor note.

This document describes two AccountLayer changes that affect account ownership and affiliate observability:

1. Role-gated creation of SubAccounts for another owner.
2. Direct owner-initiated transfer of SubAccount ownership to another address.

The changes are intentionally narrow. They do not change the existing self-service SubAccount creation path, virtual account address derivation, Symmio core balance accounting, or virtual account lifecycle logic.

---

## Summary

The AccountLayer now supports a protocol-authorized account creator role. A caller with `ACCOUNT_CREATOR_ROLE` can create SubAccounts for a specified owner by calling `createSubAccountsFor(owner, affiliate, accountsData)`.

SubAccount owners can also transfer ownership directly with `transferSubAccountOwnership(subAccount, newOwner)`. This updates the stored owner and the owner-to-SubAccount indexes. Since Virtual Account ownership resolves through the parent SubAccount, all Virtual Accounts under the transferred SubAccount become controlled by the new owner automatically.

Affiliate hooks can observe ownership transfers through `onSubAccountOwnershipTransfer(subAccount, oldOwner, newOwner)`.

---

## Changed Interfaces

### `CoreFacet.createSubAccountsFor`

```solidity
function createSubAccountsFor(
    address owner,
    address affiliate,
    SubAccountCreationData[] memory accountsData
) external returns (address[] memory);
```

Access control:

- Caller must have `ACCOUNT_CREATOR_ROLE`.
- `owner` must not be `address(0)`.
- `accountsData` must not be empty.

Behavior:

- Uses the same internal `_createSubAccount` path as `createSubAccounts`.
- The SubAccount owner is set to the supplied `owner`, not the caller.
- The SubAccount is added to `userToSubAccounts[owner]`.
- The existing `SubAccountCreated(account, owner, affiliate, name)` event is emitted.
- The existing `onAccountCreation(owner, subAccount, metadata)` affiliate hook is called if registered.

### `CoreFacet.transferSubAccountOwnership`

```solidity
function transferSubAccountOwnership(address subAccount, address newOwner) external;
```

Access control:

- Caller must be the current owner of `subAccount`.
- Ownership is checked through the existing AccountLayer signer resolution path, so calls through AccountManager compatibility flows keep the same authentication model.

Validation:

- `newOwner` must not be `address(0)`.
- `subAccount` must exist and must be an active SubAccount.
- `newOwner` must differ from the current owner.

Behavior:

- Removes `subAccount` from `userToSubAccounts[oldOwner]`.
- Adds `subAccount` to `userToSubAccounts[newOwner]`.
- Updates `AccountStorage.subAccounts[subAccount].owner`.
- Calls the affiliate transfer hook after storage is updated.
- Emits `SubAccountOwnershipTransferred(subAccount, oldOwner, newOwner)`.

### `IAccountLayerHook.onSubAccountOwnershipTransfer`

```solidity
function onSubAccountOwnershipTransfer(
    address subAccount,
    address oldOwner,
    address newOwner
) external;
```

The hook is called after the owner field and enumerable indexes have been updated. If the hook queries `ownerOf(subAccount)`, it observes `newOwner`.

If the hook reverts, the entire transfer reverts, including the owner/index updates. This matches the existing AccountLayer lifecycle hook behavior for SubAccount creation and deletion.

---

## Storage Impact

No new storage variables are introduced.

The new account creator role uses the existing AccountLayer role storage:

```solidity
mapping(address => mapping(bytes32 => bool)) hasRole;
```

Ownership transfer mutates only existing account storage:

```solidity
mapping(address => SubAccountData) subAccounts;
mapping(address => EnumerableSet.AddressSet) userToSubAccounts;
```

The operation updates `subAccounts[subAccount].owner` and moves the SubAccount address between the two owner index sets.

---

## Ownership Resolution

SubAccounts store their owner directly:

```solidity
SubAccountData.owner
```

Virtual Accounts do not store their own owner. `LibAccountLayerUtils.resolveAccountOwner(account)` resolves a VA owner through its parent SubAccount. Therefore, transferring a SubAccount also transfers effective control of all currently active, inactive, and future Virtual Accounts under that SubAccount.

Implications:

- The new owner can execute all owner-gated operations for the SubAccount.
- The old owner loses all owner-gated access immediately.
- Owner-gated Virtual Account actions follow the parent SubAccount owner after transfer.
- Any balances, allocations, pending quotes, open positions, and reusable VA pools remain attached to the same SubAccount/VA addresses.

The transfer is a true ownership transfer, not an empty-account-only migration.

---

## Hook Ordering & Revert Semantics

The transfer sequence is:

1. Validate caller and `newOwner`.
2. Read `oldOwner`, `affiliate`, and `symmioCore`.
3. Remove the SubAccount from `oldOwner`'s enumerable set.
4. Add the SubAccount to `newOwner`'s enumerable set.
5. Set `subAccounts[subAccount].owner = newOwner`.
6. Call `onSubAccountOwnershipTransfer(subAccount, oldOwner, newOwner)` if the affiliate registered a hook for that selector.
7. Emit `SubAccountOwnershipTransferred`.

The hook is deliberately called after storage mutation so downstream affiliate systems can read the final owner state. Solidity transaction atomicity means any hook revert rolls back the storage mutation and event emission.

The existing hook signer-clearing protection still applies. `LibAccountLayerUtils.callHook` clears `globalSigner` before external hook execution and restores it afterward, preventing the hook from re-entering AccountLayer while inheriting the transferring user's signer context.

---

## Security Considerations

### Role-granted account creation

`ACCOUNT_CREATOR_ROLE` can create SubAccounts for arbitrary non-zero owners under active affiliates. This role should be granted only to trusted automation, onboarding, migration, or protocol-operated services.

The role does not grant ownership over the created accounts. The created SubAccount is controlled by the supplied `owner`.

### Direct ownership transfer

Ownership transfer is immediate and does not require recipient acceptance. A typo in `newOwner` transfers control to that address atomically. This is a product decision that trades two-step safety for simple user-controlled transfer.

The function does not require the SubAccount to be empty. A user can transfer an account with balances, allocated margin, pending quotes, open positions, and active Virtual Accounts. Auditors should treat this as intentional behavior.

### Affiliate hook liveness

A registered transfer hook can revert and block ownership transfer for SubAccounts under that affiliate. This mirrors existing hook liveness risk for account creation and deletion. Affiliates should use simple, reliable hooks for lifecycle observability and keep heavier logic off-chain where possible.

### No Symmio core balance movement

Transfer only changes AccountLayer ownership metadata and indexes. It does not call into the Symmio core to move balances, deallocate collateral, settle positions, or alter quote ownership. The same virtual addresses continue to hold the same Symmio-side balances and positions.

---

## Events

### `SubAccountOwnershipTransferred`

```solidity
event SubAccountOwnershipTransferred(
    address indexed account,
    address indexed oldOwner,
    address indexed newOwner
);
```

Indexers should update the owner of `account` from `oldOwner` to `newOwner`. They should also treat all Virtual Accounts whose parent is `account` as effectively owned by `newOwner` from the same transaction onward.

Existing `SubAccountCreated` semantics remain unchanged for self-service creation. For role-gated delegated creation, the `owner` argument is the supplied target owner.

---

## Auditor Checklist

- Verify `createSubAccounts` remains self-service and still uses `LibAccountLayerUtils.getSigner()`.
- Verify `createSubAccountsFor` is gated by `ACCOUNT_CREATOR_ROLE`.
- Verify delegated creation stores the supplied `owner`, not `msg.sender`.
- Verify delegated creation still validates affiliate state, Symmio core whitelist, name length, isolation type, and single-VA-mode constraints through `_createSubAccount`.
- Verify `transferSubAccountOwnership` is gated by `onlyAccountOwner(subAccount)`.
- Verify zero-address and same-owner transfers revert.
- Verify owner indexes are updated consistently with `SubAccountData.owner`.
- Verify Virtual Account owner resolution changes through the parent SubAccount without mutating VA storage.
- Verify hook execution observes the final owner and reverts the whole transfer on failure.
- Verify signer clearing still applies during the new hook callback.

---

## Test Coverage

The AccountLayer behavior tests cover:

- Successful delegated creation by an `ACCOUNT_CREATOR_ROLE` holder.
- Rejection of delegated creation by a caller without the role.
- Rejection of delegated creation to `address(0)`.
- Owner/index correctness after delegated creation.
- Successful direct ownership transfer.
- Old owner access loss and new owner access gain.
- Virtual Account ownership resolution through transferred parent SubAccounts.
- Rejection of non-owner, zero-owner, and same-owner transfers.
- Affiliate hook invocation and encoded arguments.
- Hook visibility of final owner state.
- Hook revert rolling back the transfer.
