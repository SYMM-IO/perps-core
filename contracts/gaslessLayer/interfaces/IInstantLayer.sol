// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

/// @title IInstantLayer
/// @notice Execution surface of the Symmio InstantLayer. The gateway calls `executeBatch` as a
///         registered executor — i.e. the InstantLayer admin must grant the gateway OPERATOR_ROLE,
///         since `executeBatch` is `onlyRole(OPERATOR_ROLE)` on the InstantLayer.
/// @dev Structs copied verbatim from perps-core
///      contracts/instantLayer/InstantLayer.sol so calldata encoding matches exactly.
interface IInstantLayer {
	struct Account {
		address addr;
		bool isPartyB;
	}

	struct ReplayAttackHeader {
		uint256 nonce;
		uint256 deadline;
		bytes32 salt;
	}

	struct FlexField {
		uint256 offset;
		uint256 length;
		address authorizedFlexFiller;
	}

	struct SignedOperation {
		address signer;
		address target;
		bytes callData;
		Account signerAccount;
		FlexField[] flexFields;
		uint256 maxUses;
		ReplayAttackHeader replayAttackHeader;
	}

	struct SignedDelegation {
		DelegationInfo delegationInfo;
		ReplayAttackHeader replayAttackHeader;
	}

	struct DelegationInfo {
		Account account;
		address delegatedSigner;
		bytes4[] selectors;
		uint256 expiryTimestamp;
	}

	/// @notice Execute a batch of independent signed operations. All must succeed.
	function executeBatch(
		SignedOperation[] calldata signedOps,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexFillerSignatures
	) external returns (bytes[] memory results);

	/// @notice Execute a registered Template (by id) with automatic result chaining between ops.
	/// @dev Mirrors perps-core InstantLayer.executeTemplate; onlyRole(OPERATOR_ROLE) on the real
	///      contract, so the gateway must be a registered executor. The template itself (op shape +
	///      result-injection recipe) lives on the InstantLayer and is referenced only by id.
	function executeTemplate(
		uint256 templateId,
		SignedOperation[] calldata signedOps,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexFillerSignatures
	) external returns (bytes[] memory results);

	/// @notice Grant batch delegation permissions through an owner signature.
	/// @dev Separate from executeBatch/executeTemplate: the InstantLayer validates the SignedDelegation
	///      EIP-712 payload and updates delegation nonce/storage directly.
	function grantBatchDelegationBySig(SignedDelegation calldata signedDelegation, bytes calldata signature) external;

	/// @notice Grant delegation permissions for `info.account` to `info.delegatedSigner`.
	/// @dev Never called by the gateway directly. Declared so integrators can encode this call as the
	///      callData of an owner-signed SignedOperation targeting the InstantLayer itself — the
	///      InstantLayer applies such grant operations inside executeBatch/executeTemplate, letting
	///      later operations in the same batch use the fresh delegation.
	function grantDelegation(DelegationInfo calldata info) external;

	/// @notice Return whether a delegate currently has permission for a delegator/selector pair.
	function isDelegationActive(address delegator, address delegate, bytes4 selector) external view returns (bool);
}
