# **External Transfer**

Previously, we had **internal transfers**, which allowed users to move funds between their accounts within the same diamond. By providing this feature, we enabled users to bypass the withdrawal cooldown.

But what if users want to transfer funds between accounts in **different Symmio diamonds**? (For example, when there are two Symmio perpetuals diamonds on a chain, or in the future, an options diamond alongside a perpetuals one.) This is where **external transfers** come in.

External transfers let users move funds across different diamonds with the help of a predefined relayer contract. Essentially, the external transfer process sends the funds to the relayer contract and then calls its callback. The relayer contract uses those funds to make a deposit for the user on the target Symmio diamond. Alternatively, the relayer can choose to revert the transaction for any reason.

### **`externalTransfer`**

```solidity
function externalTransfer(address receiver, uint256 amount, address target);
```

And the relayer contract callback function is:

```solidity
function onTransfer(address collateral, address sender, address receiver, uint256 amount, address target);
```

### Virtual External Transfer

As mentioned before, we have virtual funds which is just charged in balances in storage and the collateral token would not be transferred to our contract. So we can not transfer these funds from source diamond to relayer contract to make a deposit for user in target diamond. Instead of relayer contract, we use the virtual providers as intermediary. So we just notify the virtual contract to virtualDepositFor user in the target diamond contract.

```solidity
function virtualExternalTransfer(address receiver, uint256 amount,address target, address virtualProvider);
```

After calling this function, the virtual provider should accept it and if the virtual provider did not accept it, the user could cancel the external transfer request.

```solidity
function cancelVirtualExternalTransfer(uint256 id);
```

To find the status of the virtual external transfer, we develop this view call function

```solidity
function getVirtualExternalTransfer(uint256 id) external view returns (ExternalTransferReq memory)

// External Transfer : Symmio1(user1) balance -> Symmio2(user2) balance
struct ExternalTransferReq {
	uint256 id;
	address sender; // user1 in source contract
	address receiver; // user2 in target contract
	address source; // Symmio contract 1
	address target; // Symmio contract 2
	uint256 amount;
	uint256 timestamp;
	address provider; // virtual provider who handles the transfer
	ExternalTransferStatus status;
}

enum ExternalTransferStatus {
	PENDING, // 0
	COMPLETED, // 1
	CANCELED // 2
}
```
