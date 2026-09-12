// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title IInstantLayer
/// @notice Symmio InstantLayer methods used by the gateway.
/// @dev The InstantLayer admin must grant the gateway OPERATOR_ROLE to call `executeBatch`.
///      `executeBatch` requires `onlyRole(OPERATOR_ROLE)` on InstantLayer.
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

	/// @notice Execute a registered template by id, passing results between operations.
	/// @dev Matches perps-core InstantLayer.executeTemplate and requires onlyRole(OPERATOR_ROLE).
	///      InstantLayer stores the template's operation structure and result-injection rules.
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
	/// @dev The gateway does not call this directly. Integrators encode it in an owner-signed SignedOperation
	///      targeting InstantLayer. executeBatch/executeTemplate applies the grant, so later operations in the batch can use it.
	function grantDelegation(DelegationInfo calldata info) external;

	/// @notice Grant delegation to several delegates of one account in a single call.
	/// @dev The gateway does not call this directly. One owner-signed SignedOperation targeting InstantLayer
	///      can grant a session key and other delegates together inside a relayed batch.
	function grantDelegations(DelegationInfo[] calldata infos) external;

	/// @notice Return whether a delegate currently has permission for a delegator/selector pair.
	function isDelegationActive(address delegator, address delegate, bytes4 selector) external view returns (bool);
}
