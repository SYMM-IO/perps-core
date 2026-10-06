# Two-Step Ownership Transfer

## Overview

The Diamond proxy's ownership transfer has been changed from a single-step to a two-step process. Previously, calling `transferOwnership(newOwner)` would immediately assign ownership to the target address. If the address was incorrect or a contract unable to interact with the diamond, ownership would be irrecoverably lost.

## How It Works

Ownership transfer now requires two transactions:

1. **Current owner** calls `transferOwnership(newOwner)` -- this sets a *pending* owner but does not change the active owner.
2. **New owner** calls `acceptOwnership()` -- this confirms the transfer and assigns ownership to the caller.

Until `acceptOwnership()` is called, the original owner retains full control and can call `transferOwnership` again to change the pending owner or effectively cancel the transfer.

## Functions

### `transferOwnership(address newOwner)`

Sets the pending owner to `newOwner`. Only callable by the current owner. Does not transfer ownership immediately.

### `acceptOwnership()`

Accepts the pending ownership transfer. Only callable by the address set as the pending owner. On success, the caller becomes the new owner and the pending owner is cleared.

### `pendingOwner()` (view)

Returns the address of the pending owner, or `address(0)` if no transfer is pending.

## Migration Notes

No migration is required for this change. The upgrade simply replaces the ownership transfer logic in the Diamond's admin facet. Existing ownership is preserved.
