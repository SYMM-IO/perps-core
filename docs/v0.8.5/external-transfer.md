# External Transfer

Previously, we had **internal transfers**, which allowed users to move funds between their accounts within the same diamond. By providing this feature, we enabled users to bypass the withdrawal cooldown.

But what if users want to transfer funds out to a **different contract**? This is where **external transfers** come in.

External transfers let users move funds to any trusted target contract with the help of a predefined relayer. The target can be another Symmio diamond (e.g., a perps diamond and a future options diamond on the same chain), but it can also be any external contract that Symmio has whitelisted. Symmio doesn't care what the target is -- it only requires that an admin has registered an authorized relayer for that target via `addRelayerForExternalTransferTarget`. The relayer receives the funds and a callback, and it's responsible for depositing or handling them at the target.

Because the relayer has full control over the funds once transferred, Symmio must trust both the target and its relayer. Admins with the `INTEGRATION_ADMIN_ROLE` can add or remove relayer authorizations, and the protocol should have roles and processes in place to confiscate funds or revoke relayer access if fraud or anomalies are detected.

### `externalTransfer`

```solidity
function externalTransfer(address receiver, uint256 amount, address target);
```

The relayer contract callback function is:

```solidity
function onTransfer(address collateral, address sender, address receiver, uint256 amount, address target);
```

The relayer can choose to revert the transaction for any reason (e.g., the target doesn't support that receiver, or a risk check fails).

### Virtual External Transfer

Virtual funds exist only as balance entries in storage -- no actual collateral token was transferred to the contract. So we can't send tokens from the source diamond to a relayer. Instead, we use a virtual provider as intermediary. The source diamond deducts the user's virtual balance and notifies the virtual provider, which is expected to credit the receiver on the target contract via `virtualDepositFor` or equivalent.

```solidity
function virtualExternalTransfer(address receiver, uint256 amount, address target, address virtualProvider);
```

After calling this function, the virtual provider should accept it. If the virtual provider does not accept, the user can cancel the external transfer request:

```solidity
function cancelVirtualExternalTransfer(uint256 id);
```

To find the status of the virtual external transfer:

```solidity
function getVirtualExternalTransfer(uint256 id) external view returns (VirtualExternalTransferRequest memory)

struct VirtualExternalTransferRequest {
	uint256 id;
	address sender;    // user in source contract
	address receiver;  // recipient in target contract
	address source;    // source Symmio contract
	address target;    // target contract (Symmio diamond or any trusted contract)
	uint256 amount;
	uint256 timestamp;
	address provider;  // virtual provider who handles the transfer
	VirtualExternalTransferStatus status;
}

enum VirtualExternalTransferStatus {
	PENDING,   // 0
	COMPLETED, // 1
	CANCELED   // 2
}
```
