// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IGaslessLayer } from "./IGaslessLayer.sol";
import { IInstantLayer } from "./IInstantLayer.sol";
import { SubAccountCreationData } from "./ISymmioAccountLayer.sol";

/// @notice The fee-bearing calls accepted by the common quote interface.
interface IGaslessLayerActions {
	function relayInstantBatch(
		IInstantLayer.SignedOperation[] calldata ops,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexSignatures,
		uint256[] calldata walletIds
	) external returns (bytes[] memory);
	function relayInstantTemplate(
		uint256 templateId,
		IInstantLayer.SignedOperation[] calldata ops,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexSignatures
	) external returns (bytes[] memory);
	function relayGrantBatchDelegationBySig(IInstantLayer.SignedDelegation calldata delegation, bytes calldata signature) external;
	function relayNativeGasTopUp(IGaslessLayer.NativeGasTopUpRequest calldata request, bytes calldata signature) external payable;
	function settleDepositToNewAccount(
		address owner,
		uint256 walletId,
		address affiliate,
		SubAccountCreationData calldata data
	) external returns (address);
	function settleDepositToExistingAccount(address owner, uint256 walletId, address account) external;
	function recoverNonCollateralToken(address owner, uint256 walletId, address token, address recipient) external returns (uint256);
}
