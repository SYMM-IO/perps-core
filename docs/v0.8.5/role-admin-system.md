# Role Admin System

## Overview

v0.8.5 introduces **role admins** -- a delegation layer on top of SYMMIO's existing role-based access control. Previously, the `DEFAULT_ADMIN_ROLE` holder was the only address that could grant and revoke roles, making it a bottleneck for every role change. Now, default admins can delegate management of specific roles to dedicated addresses via per-role admins. This allows operational teams to manage their domain (e.g., liquidator rotation, pause controls) without requiring the default admin to sign every transaction.

## How It Worked Before

In v0.8.4, the Diamond owner called `setAdmin(address)` to grant `DEFAULT_ADMIN_ROLE` to a single wallet. That wallet could then grant and revoke any role via `grantRole` / `revokeRole`. There was no way to delegate management of a specific role to someone else -- every role change had to go through the one `DEFAULT_ADMIN_ROLE` holder.

## What Changed

A new mapping was added to `GlobalAppStorage`:

```solidity
// contracts/core/storages/GlobalAppStorage.sol

/// @notice Who can grant/revoke each role
mapping(bytes32 => mapping(address => bool)) roleAdmins;
```

This maps each role to a set of addresses that can manage it. Combined with the existing `hasRole` mapping, the system now supports a three-tier hierarchy:

```
Owner
  └─ setAdmin(user)  ──>  DEFAULT_ADMIN_ROLE holders
       ├─ addRoleAdmin(role, admin)  ──>  Per-role admins
       │    └─ grantRole / revokeRole (for that specific role only)
       └─ grantRole / revokeRole (for any role)
```

- **Owner** calls `setAdmin()` to grant `DEFAULT_ADMIN_ROLE`.
- **Default admins** can grant/revoke any role directly, and can appoint or remove per-role admins via `addRoleAdmin` / `removeRoleAdmin`.
- **Per-role admins** can grant/revoke only the role they were assigned to administer. They cannot delegate further.

## Example

```
1. Owner calls setAdmin(multisig)
   --> multisig now holds DEFAULT_ADMIN_ROLE

2. multisig calls addRoleAdmin(LIQUIDATOR_ROLE, liquidationOps)
   --> liquidationOps can now grant/revoke LIQUIDATOR_ROLE

3. liquidationOps calls grantRole(bot1, LIQUIDATOR_ROLE)
   --> bot1 can now perform liquidations

4. liquidationOps calls revokeRole(bot1, LIQUIDATOR_ROLE)
   --> bot1 can no longer liquidate

5. multisig calls removeRoleAdmin(LIQUIDATOR_ROLE, liquidationOps)
   --> liquidationOps loses management authority
```

## Security Notes

- **Delegation is one level deep.** Per-role admins cannot appoint other role admins -- only `DEFAULT_ADMIN_ROLE` holders can call `addRoleAdmin`.
- **No role enumeration on-chain.** Both `hasRole` and `roleAdmins` are nested mappings, so listing all holders or all admins must be done off-chain via events.
- **Proxy protection.** `onlyRoleAdmin` blocks calls when `GlobalAppStorage.signer` is set, preventing proxies from inheriting admin privileges.
