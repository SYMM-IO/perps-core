# The Problem: `generateUpgradeTxs.ts` EXECUTE Mode on Fork

## Summary

When running `generateUpgradeTxs.ts` with `EXECUTE=true` on a forked network, the script failed at multiple points because it impersonated the diamond owner but that address lacked the roles required by the Symmio access control system.

## Root Cause: Two Separate Access Control Systems

The Symmio diamond has **two independent access control systems**:

1. **Diamond ownership** (`LibDiamond`)
   - Stored in the diamond's own storage at `keccak256("diamond.standard.diamond.storage") + 3`
   - Checked by `enforceIsContractOwner()` modifier (`onlyOwner`)
   - Controls: `diamondCut()`, `setAdmin()`, `transferOwnership()`

2. **Role-based access control** (`GlobalAppStorage` / `LibAccessibility`)
   - Stored in `GlobalAppStorage.layout().hasRole[user][role]`
   - Checked by `onlyRole(role)` and `onlyRoleAdmin(role)` modifiers
   - Controls: `grantRole()`, `pauseGlobal()`, `setMaxPartyAConnectionLimit()`, `setSettlementCooldown()`, etc.

These two systems are **completely independent**. Being the diamond owner does NOT grant any roles, and having `DEFAULT_ADMIN_ROLE` does NOT make you the diamond owner.

## The Three Failures

### Failure 1: `grantRole()` reverted

```
Admin resolved: 0xdf41... (override)
[1/16] grantRole(PAUSER_ROLE) -> 0xdf41...
ProviderError: Internal error
```

**What happened:** The script impersonated `ADMIN_ADDRESS` (`0xdf41...`) instead of the diamond owner. This address is an EOA signer on the Gnosis Safe -- it has no on-chain authority by itself.

**Why:** The original code passed `ADMIN_ADDRESS` as the override to `getImpersonatedAdmin()`, bypassing the diamond owner resolution.

**The access control check:**
```solidity
// ControlFacet.sol
function grantRole(address user, bytes32 role) external onlyRoleAdmin(role) { ... }

// Accessibility.sol
modifier onlyRoleAdmin(bytes32 role) {
    require(LibAccessibility.isRoleAdmin(msg.sender, role), "Must be role admin");
}

// LibAccessibility.sol
function isRoleAdmin(address user, bytes32 role) returns (bool) {
    return layout.roleAdmins[role][user] || layout.hasRole[user][DEFAULT_ADMIN_ROLE];
}
```

`0xdf41...` has neither `roleAdmins[role]` nor `DEFAULT_ADMIN_ROLE`, so it reverts.

**Fix:** Remove the override -- let `getImpersonatedAdmin()` resolve the actual diamond owner from storage.

### Failure 2: `grantRole()` still reverted (with correct diamond owner)

```
Admin resolved: 0x0CbF... (from LibDiamond storage)
[1/16] grantRole(PAUSER_ROLE) -> 0xdf41...
ProviderError: Internal error
```

**What happened:** Now impersonating the correct diamond owner (`0x0CbF...`), but `grantRole()` still reverted.

**Why:** `grantRole()` checks `onlyRoleAdmin`, which requires `DEFAULT_ADMIN_ROLE`. The diamond owner (`0x0CbF...`) owns the diamond (LibDiamond system) but does NOT have `DEFAULT_ADMIN_ROLE` (GlobalAppStorage system).

**Fix:** Call `setAdmin(ownerAddress)` first. This is the bridge between the two systems:
```solidity
// ControlFacet.sol -- onlyOwner = LibDiamond owner check
function setAdmin(address user) external onlyOwner {
    GlobalAppStorage.layout().hasRole[user][DEFAULT_ADMIN_ROLE] = true;
}
```

Only the diamond owner can call `setAdmin()`, and it grants `DEFAULT_ADMIN_ROLE` in the role-based system.

### Failure 3: `pauseGlobal()` reverted

```
[1/16] grantRole(PAUSER_ROLE) -> 0xdf41...   -- OK
[2/16] grantRole(UNPAUSER_ROLE) -> 0xdf41...  -- OK
[3/16] pauseGlobal()                           -- REVERTED
```

**What happened:** After `setAdmin()`, `grantRole()` works because the diamond owner now has `DEFAULT_ADMIN_ROLE`. But `pauseGlobal()` still reverts.

**Why:** The generated calldata grants `PAUSER_ROLE` to `ADMIN_ADDRESS` (`0xdf41...`), not to the diamond owner (`0x0CbF...`). When the diamond owner calls `pauseGlobal()`, it checks:
```solidity
function pauseGlobal() external onlyRole(LibAccessibility.PAUSER_ROLE) { ... }
```

The diamond owner doesn't have `PAUSER_ROLE` -- only `0xdf41...` does. Same problem applies to `PROTOCOL_CONFIG_ROLE`, `COOLDOWN_ADMIN_ROLE`, and `MIGRATION_ROLE` used by later transactions.

**Fix:** Bootstrap all necessary roles to the diamond owner before executing the generated transactions:
```typescript
const bootstrapRoles = ["PAUSER_ROLE", "UNPAUSER_ROLE", "PROTOCOL_CONFIG_ROLE", "COOLDOWN_ADMIN_ROLE", "MIGRATION_ROLE"]
for (const role of bootstrapRoles) {
    await controlFacet.grantRole(ownerAddress, ethers.id(role))
}
```

## Why This Only Affects Fork Testing

In **production**, the Gnosis Safe (`0x8A82...`) is both:
- The diamond owner (or controls it via a governance proxy)
- The holder of `DEFAULT_ADMIN_ROLE` (set during initial deployment)

When the Safe submits a batch of transactions via Transaction Builder, `msg.sender` is the Safe address for every transaction. Since the Safe already has `DEFAULT_ADMIN_ROLE`, `grantRole()` works. Since the Safe grants `PAUSER_ROLE` to `ADMIN_ADDRESS` in tx 1 and then calls `pauseGlobal()` in tx 3 -- and the Safe itself is the caller for both -- this only works because the Safe is also in the role admin set.

On a **fork**, we impersonate the diamond owner (`0x0CbF...`), which is a different address that was never given any roles in the GlobalAppStorage system. The `setAdmin()` + bootstrap roles step bridges this gap.

## Address Map (Arbitrum)

| Address | Identity | Diamond Owner? | DEFAULT_ADMIN_ROLE? |
|---------|----------|---------------|-------------------|
| `0x0CbF...` | Diamond owner (from LibDiamond storage) | Yes | No (until setAdmin) |
| `0x8A82...` | Gnosis Safe multisig | No (or via proxy) | Yes (from deployment) |
| `0xdf41...` | EOA signer on the Safe | No | No |
| `0x00c2...` | Migration runner | No | No |

## Final Solution

```typescript
// 1. Impersonate the actual diamond owner (read from storage)
const admin = await getImpersonatedAdmin(DIAMOND_ADDRESS)

// 2. Bridge to role-based system (only diamond owner can call this)
await controlFacet.setAdmin(ownerAddress)

// 3. Grant all roles the owner needs to execute the generated transactions
for (const role of ["PAUSER_ROLE", "UNPAUSER_ROLE", "PROTOCOL_CONFIG_ROLE", "COOLDOWN_ADMIN_ROLE", "MIGRATION_ROLE"]) {
    await controlFacet.grantRole(ownerAddress, ethers.id(role))
}

// 4. Now execute all generated transactions as the diamond owner
for (const tx of transactions) {
    await admin.sendTransaction({ to: tx.to, value: tx.value, data: tx.calldata })
}
```
