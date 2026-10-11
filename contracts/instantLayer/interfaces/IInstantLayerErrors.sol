// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Custom errors used across the InstantLayer diamond
interface IInstantLayerErrors {
	/// @notice Caller does not hold the required role
	error MustHaveRole();

	/// @notice Caller is not a role admin for the requested role
	error MustBeRoleAdmin();

	/// @notice A role can only be renounced by its own holder
	error CanOnlyRenounceForSelf();

	/// @notice A required address argument was the zero address
	error ZeroAddress();

	/// @notice The diamond has already been initialized
	error AlreadyInitialized();

	/// @notice CallData format or content is invalid
	error InvalidCallData();

	/// @notice Provided array must not be empty
	error EmptyArray();

	/// @notice PartyB contract is already registered
	error PartyBAlreadyRegistered(address partyB);

	/// @notice PartyB contract is not in the registry
	error PartyBNotRegistered(address partyB);

	/// @notice AccountLayer address is invalid
	/// @param accountLayer Provided AccountLayer address
	error UnregisteredAccountLayer(address accountLayer);

	/// @notice Template has no operations
	error EmptyTemplate();

	/// @notice Template does not exist
	/// @param templateId The invalid template ID
	error InvalidTemplate(uint256 templateId);

	/// @notice Input arrays have mismatched lengths
	error ArrayLengthMismatch();

	/// @notice AccountLayer contract address has not been configured
	error AccountLayerNotSet();

	/// @notice Signature verification failed
	error InvalidSignature();

	/// @notice Operation or signature deadline has passed
	/// @param deadline The deadline that was exceeded
	error DeadlineExpired(uint256 deadline);

	/// @notice Nonce mismatch for ordered execution
	/// @param user The user whose nonce was checked
	/// @param expected The expected nonce value
	/// @param provided The nonce that was provided
	error InvalidNonce(address user, uint256 expected, uint256 provided);

	/// @notice Delegation hash has already been executed
	/// @param hash The delegation hash that was already used
	error DelegationAlreadyExecuted(bytes32 hash);

	/// @notice Delegation is invalid (PartyB account, wrong account, unauthorized signer, or no selectors)
	error InvalidDelegation();

	/// @notice A signed operation targeting the layer itself is not a valid delegation grant
	error InvalidGrantOperation();

	/// @notice Delegation has expired
	/// @param expiryTimestamp The expiry time that has passed
	error DelegationExpired(uint256 expiryTimestamp);

	/// @notice Cannot delegate to oneself
	error SelfDelegation();

	/// @notice Caller is not the owner of the specified account
	/// @param sender The address that attempted the operation
	/// @param account The actual account address
	error NotOwnerOfAccount(address sender, address account);

	/// @notice Cooldown not over
	/// @param eta The eta that has not passed
	error RevocationCooldownNotOver(uint256 eta);

	/// @notice Reentrant call into a nonReentrant-guarded function
	error ReentrancyGuardReentrantCall();

	/// @notice Template is disabled and cannot be executed
	/// @param templateId The template that is not active
	error TemplateNotActive(uint256 templateId);

	/// @notice Operation execution failed
	/// @param operationIndex Index of the failed operation
	/// @param revertData Error data from the failed operation
	error OperationFailed(uint256 operationIndex, bytes revertData);

	/// @notice CallData is too short (minimum 4 bytes for selector)
	error CallDataLengthMismatch();

	/// @notice Target contract is not whitelisted
	/// @param target The target address
	error TargetNotWhitelisted(address target);

	/// @notice Batch operation array is empty
	error EmptyBatch();

	/// @notice Source index for result injection is out of bounds
	/// @param sourceIndex The invalid source index
	error InvalidSourceIndex(uint256 sourceIndex);

	/// @notice Number of operations doesn't match template requirements
	error TemplateOperationLengthMismatch();

	/// @notice Signer and account mismatch
	/// @param signer The signer address
	/// @param account The account address
	error MismatchSignerAndAccount(address signer, address account);

	/// @notice Insertion point is out of bounds
	/// @param offset The offset that is out of bounds
	/// @param length The length of the calldata
	error InsertionPointOutOfBounds(uint256 offset, uint256 length);

	/// @notice Source result is empty when a non-empty result was expected
	error MissingSourceResult();

	/// @notice Source result length is shorter than required for extraction
	error BadSourceResultLength(bytes res, uint256 length);

	/// @notice Operation has exceeded its maximum allowed executions
	/// @param hash The operation hash
	/// @param maxUses The maximum allowed executions
	error MaxUsesExceeded(bytes32 hash, uint256 maxUses);

	/// @notice Flex fill values array length does not match flex fields count
	/// @param expected Expected number of fill values
	/// @param provided Provided number of fill values
	error InvalidFlexFillLength(uint256 expected, uint256 provided);

	/// @notice Flex fill value length does not match the field length
	/// @param fieldIndex Index of the flex field
	/// @param expected Expected value byte length
	/// @param provided Provided value byte length
	error InvalidFlexFillValueLength(uint256 fieldIndex, uint256 expected, uint256 provided);

	/// @notice Flex field offset+length exceeds calldata bounds
	/// @param offset Field byte offset
	/// @param length Field byte length
	/// @param callDataLength Total calldata length
	error FlexFieldOutOfBounds(uint256 offset, uint256 length, uint256 callDataLength);

	/// @notice Flex filler signature verification failed for a flex field fill
	/// @param fieldIndex Index of the flex field with bad flex filler signature
	error InvalidFlexFillerSignature(uint256 fieldIndex);

	/// @notice PartyB contract is not registered for operation execution
	/// @param partyB The unregistered PartyB address
	error UnregisteredPartyB(address partyB);
}
