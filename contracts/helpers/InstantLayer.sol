// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/**
 * @title  InstantLayer
 * @notice Advanced operation orchestration layer for the Symmio protocol with flexible
 *         nonce management, delegation capabilities, and secure execution capabilities.
 *         Enables templated operations and batch processing with salt-based uniqueness
 *         and optional nonce protection.
 *
 * @dev    Core features include:
 *         • Delegation system allowing users to authorize others to sign on their behalf
 *         • Operation structure with focused result injection capabilities
 *         • Flexible nonce system - use 0 for salt-only protection, non-zero for ordered execution
 *         • Salt-based operation uniqueness for replay protection without strict ordering
 *         • Registration system for both PartyB and MultiAccount contracts
 *         • EIP-712 signature verification with comprehensive security parameters
 *         • Template-based execution with automatic result chaining between operations
 *         • Batch operation processing with atomic success/failure guarantees
 *         • Comprehensive validation of registered contracts for enhanced security
 *
 *         The contract coordinates between PartyA and PartyB operations while maintaining
 *         protocol integrity through comprehensive signature verification and access controls.
 *         Both PartyB contracts and MultiAccount contracts must be registered before use.
 */

import { AccessControlEnumerable } from "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/* ────────────────────────── External Interfaces ────────────────────────── */

/**
 * @notice Interface for MultiAccount contract interactions.
 */
import "hardhat/console.sol";

interface IMultiAccount {
	function _call(address account, bytes[] calldata _callDatas) external;

	function isValidSignatureOfAccount(address account, bytes32 hash, bytes calldata signature) external view returns (bool);

	function owners(address account) external view returns (address);
}

/**
 * @notice Interface for SymmioPartyB contract interactions.
 */
interface ISymmioPartyB {
	function _call(bytes[] calldata _callDatas) external;
}

/**
 * @notice Interface for core Symmio contract interactions.
 */
interface ISymmio {
	function setCallFromInstantLayer(bool _callFromInstantLayer) external;
}

contract InstantLayer is AccessControlEnumerable, ReentrancyGuard, EIP712 {
	/* ─────────────────────────────── Roles ─────────────────────────────── */

	/// @notice Role for managing contract configuration and templates.
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");

	/// @notice Role for executing operations and templates.
	bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

	/// @notice Role for trusted operations, token approvals, and external contract calls.
	bytes32 public constant TRUSTED_ROLE = keccak256("TRUSTED_ROLE");

	/// @notice Role for managing restricted functions, multicast whitelist, and token withdrawals.
	bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

	/* ────────────────────── EIP-712 Configuration ────────────────────── */

	/// @notice EIP-712 type hash for signed operations with salt-based uniqueness.
	bytes32 public constant OPERATION_TYPEHASH =
		keccak256("SignedOperation(address accountSource,address signer,bytes callData,uint256 nonce,bytes32 salt,uint256 deadline)");

	/// @notice EIP-712 type hash for delegation authorization.
	bytes32 public constant DELEGATION_TYPEHASH =
		keccak256("DelegationAuthorization(address delegator,address delegate,uint256 expiryTimestamp,uint256 nonce,uint256 chainId)");

	/* ──────────────────────── Storage Variables ──────────────────────── */

	/// @notice Immutable reference to the core Symmio contract.
	ISymmio public immutable symmio;

	/// @notice Optional sequential nonce tracking per signer address.
	mapping(address => uint256) public nonces;

	/// @notice Mapping from template ID to template configuration.
	mapping(uint256 => Template) public templates;

	/// @notice Mapping of registered PartyB contracts.
	mapping(address => bool) public registeredPartyBs;

	/// @notice Mapping of registered MultiAccount contracts.
	mapping(address => bool) public registeredMultiAccounts;

	/// @notice Counter for generating unique template IDs.
	uint256 public nextTemplateId;

	/// @notice Mapping to track used operation hashes for replay protection
	mapping(bytes32 => bool) public usedOperationHashes;

	/// @notice Mapping of delegations: delegator => delegate => expiry timestamp
	/// @dev A non-zero timestamp indicates active delegation until that time
	mapping(address => mapping(address => uint256)) public delegations;

	/// @notice Nonce for delegation signatures to prevent replay
	mapping(address => uint256) public delegationNonces;

	/* ─────────────────────────────── Structs ─────────────────────────────── */

	/**
	 * @notice Delegation information structure.
	 * @param delegate        Address authorized to sign on behalf of delegator.
	 * @param expiryTimestamp Unix timestamp when delegation expires.
	 */
	struct DelegationInfo {
		address delegate;
		uint256 expiryTimestamp;
	}

	/**
	 * @notice Simplified operation configuration focusing on result injection.
	 * @param insertionPoints Byte offsets where return values should be inserted.
	 * @param sourceIndices   Indices of operations whose return values to use.
	 */
	struct Operation {
		uint256[] insertionPoints;
		uint256[] sourceIndices;
	}

	/**
	 * @notice Template containing multiple coordinated operations.
	 * @param name       Human-readable template name.
	 * @param operations Array of operations to execute in sequence.
	 * @param active     Whether the template is currently enabled.
	 */
	struct Template {
		string name;
		Operation[] operations;
		bool active;
	}

	/**
	 * @notice Signed operation with flexible authentication and execution details.
	 * @param accountSource MultiAccount contract address (for PartyA operations).
	 * @param signer        Original signer address (account owner for PartyA, PartyB address for PartyB).
	 * @param callData      Encoded function call data for Symmio core.
	 * @param nonce         Optional nonce (0 = no nonce protection, non-zero = ordered execution).
	 * @param salt          Salt for uniqueness (always required for replay protection).
	 * @param deadline      Operation expiration timestamp.
	 * @param signature     EIP-712 signature authorizing the operation (can be from signer or their delegate).
	 * @param actualSigner  Address that actually signed (either signer or their delegate).
	 */
	struct SignedOperation {
		address accountSource;
		address signer;
		bytes callData;
		uint256 nonce;
		bytes32 salt;
		uint256 deadline;
		bytes signature;
		address actualSigner;
	}

	/* ─────────────────────────────── Events ─────────────────────────────── */

	/// @notice Emitted when a new template is added to the system.
	event TemplateAdded(uint256 indexed templateId, string name);

	/// @notice Emitted when a template's active status is changed.
	event TemplateUpdated(uint256 indexed templateId, bool active);

	/// @notice Emitted when a template is successfully executed.
	event OperationsExecuted(uint256 indexed templateId, address indexed executor);

	/// @notice Emitted when a batch of operations is successfully executed.
	event BatchExecuted(address indexed executor, uint256 operationCount);

	/// @notice Emitted when a user's nonce is incremented.
	event NonceIncremented(address indexed user, uint256 newNonce);

	/// @notice Emitted when a PartyB contract is registered.
	event PartyBRegistered(address indexed partyB);

	/// @notice Emitted when a PartyB contract is unregistered.
	event PartyBUnregistered(address indexed partyB);

	/// @notice Emitted when a MultiAccount contract is registered.
	event MultiAccountRegistered(address indexed multiAccount);

	/// @notice Emitted when a MultiAccount contract is unregistered.
	event MultiAccountUnregistered(address indexed multiAccount);

	/// @notice Emitted when a delegation is granted.
	event DelegationGranted(address indexed delegator, address indexed delegate, uint256 expiryTimestamp);

	/// @notice Emitted when a delegation is revoked.
	event DelegationRevoked(address indexed delegator, address indexed delegate);

	/// @notice Emitted when a delegation nonce is incremented.
	event DelegationNonceIncremented(address indexed delegator, uint256 newNonce);

	/* ─────────────────────────────── Errors ─────────────────────────────── */

	error InvalidSignature(); // signature verification failed
	error DeadlineExpired(uint256 deadline); // signed operation expired
	error InvalidNonce(address user, uint256 expected, uint256 provided); // nonce mismatch for ordered execution
	error TemplateNotActive(uint256 templateId); // template is disabled
	error InvalidTemplate(uint256 templateId); // template does not exist
	error OperationFailed(uint256 operationIndex, bytes revertData); // operation execution failed
	error ArrayLengthMismatch(); // input arrays have different lengths
	error UnregisteredMultiAccount(address multiAccount); // MultiAccount not registered
	error UnregisteredPartyB(address partyB); // PartyB not registered
	error OperationAlreadyExecuted(bytes32 hash); // operation already executed
	error EmptyBatch(); // batch is empty
	error InvalidDelegation(); // delegation is invalid or expired
	error DelegationExpired(uint256 expiryTimestamp); // delegation has expired
	error InvalidDelegationExpiry(); // expiry timestamp is in the past
	error SelfDelegation(); // cannot delegate to self
	error InvalidSourceIndex(uint256 sourceIndex); // source index is invalid

	/* ─────────────────────────── Initialization ─────────────────────────── */

	/**
	 * @notice Initialize the InstantLayer with Symmio integration and EIP-712 configuration.
	 * @param _symmio Address of the core Symmio contract.
	 * @param _admin  Address receiving all admin roles.
	 */
	constructor(address _symmio, address _admin) EIP712("SymmioInstantLayer", "1") {
		symmio = ISymmio(_symmio);

		_grantRole(DEFAULT_ADMIN_ROLE, _admin);
		_grantRole(SETTER_ROLE, _admin);
		_grantRole(OPERATOR_ROLE, _admin);
		_grantRole(MANAGER_ROLE, _admin);
		_grantRole(TRUSTED_ROLE, _admin);
	}

	/* ───────────────────── Delegation Management ───────────────────── */

	/**
	 * @notice Grant delegation authority to another address.
	 * @param delegate        Address to authorize as delegate.
	 * @param expiryTimestamp Unix timestamp when delegation expires.
	 *
	 * @dev Delegator can be either a regular EOA or a smart contract that supports EIP-1271.
	 *      The delegation allows the delegate to sign operations on behalf of the delegator
	 *      until the expiry timestamp is reached.
	 */
	function grantDelegation(address delegate, uint256 expiryTimestamp) external {
		if (delegate == msg.sender) revert SelfDelegation();
		if (expiryTimestamp <= block.timestamp) revert InvalidDelegationExpiry();

		delegations[msg.sender][delegate] = expiryTimestamp;
		emit DelegationGranted(msg.sender, delegate, expiryTimestamp);
	}

	/**
	 * @notice Grant delegation with signature (allows gasless delegation setup).
	 * @param delegator       Address granting the delegation.
	 * @param delegate        Address to authorize as delegate.
	 * @param expiryTimestamp Unix timestamp when delegation expires.
	 * @param nonce           Nonce for replay protection.
	 * @param signature       EIP-712 signature from delegator.
	 *
	 * @dev This allows a delegate to submit the delegation transaction on behalf of the delegator.
	 */
	function grantDelegationBySig(address delegator, address delegate, uint256 expiryTimestamp, uint256 nonce, bytes calldata signature) external {
		if (delegate == delegator) revert SelfDelegation();
		if (expiryTimestamp <= block.timestamp) revert InvalidDelegationExpiry();
		if (nonce != delegationNonces[delegator]) revert InvalidNonce(delegator, delegationNonces[delegator], nonce);

		// Verify EIP-712 signature
		bytes32 structHash = keccak256(abi.encode(DELEGATION_TYPEHASH, delegator, delegate, expiryTimestamp, nonce, block.chainid));
		bytes32 hash = _hashTypedDataV4(structHash);

		if (!SignatureChecker.isValidSignatureNow(delegator, hash, signature)) {
			revert InvalidSignature();
		}

		delegationNonces[delegator]++;
		delegations[delegator][delegate] = expiryTimestamp;
		emit DelegationGranted(delegator, delegate, expiryTimestamp);
		emit DelegationNonceIncremented(delegator, delegationNonces[delegator]);
	}

	/**
	 * @notice Revoke a previously granted delegation.
	 * @param delegate Address to revoke delegation from.
	 */
	function revokeDelegation(address delegate) external {
		delegations[msg.sender][delegate] = 0;
		emit DelegationRevoked(msg.sender, delegate);
	}

	/**
	 * @notice Grant multiple delegations in a single transaction.
	 * @param delegates Array of delegation information.
	 */
	function grantDelegationBatch(DelegationInfo[] calldata delegates) external {
		for (uint256 i = 0; i < delegates.length; i++) {
			if (delegates[i].delegate == msg.sender) revert SelfDelegation();
			if (delegates[i].expiryTimestamp <= block.timestamp) revert InvalidDelegationExpiry();

			delegations[msg.sender][delegates[i].delegate] = delegates[i].expiryTimestamp;
			emit DelegationGranted(msg.sender, delegates[i].delegate, delegates[i].expiryTimestamp);
		}
	}

	/**
	 * @notice Check if a delegation is currently active.
	 * @param delegator The address that granted delegation.
	 * @param delegate  The address that received delegation.
	 * @return Whether the delegation is currently active.
	 */
	function isDelegationActive(address delegator, address delegate) public view returns (bool) {
		uint256 expiry = delegations[delegator][delegate];
		return expiry > block.timestamp;
	}

	/* ───────────────────── Registration Management ───────────────────── */

	/**
	 * @notice Register a PartyB contract for instant layer operations.
	 * @param partyB Address to register as PartyB.
	 */
	function registerPartyB(address partyB) external onlyRole(SETTER_ROLE) {
		registeredPartyBs[partyB] = true;
		_grantRole(OPERATOR_ROLE, partyB);
		emit PartyBRegistered(partyB);
	}

	/**
	 * @notice Unregister a PartyB contract.
	 * @param partyB Address to unregister.
	 */
	function unregisterPartyB(address partyB) external onlyRole(SETTER_ROLE) {
		registeredPartyBs[partyB] = false;
		_revokeRole(OPERATOR_ROLE, partyB);
		emit PartyBUnregistered(partyB);
	}

	/**
	 * @notice Register multiple PartyB contracts in a single transaction.
	 * @param partyBs Array of addresses to register.
	 */
	function registerPartyBBatch(address[] calldata partyBs) external onlyRole(SETTER_ROLE) {
		for (uint256 i = 0; i < partyBs.length; i++) {
			registeredPartyBs[partyBs[i]] = true;
			_grantRole(OPERATOR_ROLE, partyBs[i]);
			emit PartyBRegistered(partyBs[i]);
		}
	}

	/**
	 * @notice Register a MultiAccount contract for instant layer operations.
	 * @param multiAccount Address to register as MultiAccount.
	 */
	function registerMultiAccount(address multiAccount) external onlyRole(SETTER_ROLE) {
		registeredMultiAccounts[multiAccount] = true;
		emit MultiAccountRegistered(multiAccount);
	}

	/**
	 * @notice Unregister a MultiAccount contract.
	 * @param multiAccount Address to unregister.
	 */
	function unregisterMultiAccount(address multiAccount) external onlyRole(SETTER_ROLE) {
		registeredMultiAccounts[multiAccount] = false;
		emit MultiAccountUnregistered(multiAccount);
	}

	/**
	 * @notice Register multiple MultiAccount contracts in a single transaction.
	 * @param multiAccounts Array of addresses to register.
	 */
	function registerMultiAccountBatch(address[] calldata multiAccounts) external onlyRole(SETTER_ROLE) {
		for (uint256 i = 0; i < multiAccounts.length; i++) {
			registeredMultiAccounts[multiAccounts[i]] = true;
			emit MultiAccountRegistered(multiAccounts[i]);
		}
	}

	/* ────────────────────── Template Management ────────────────────── */

	/**
	 * @notice Add a new operation template to the system.
	 * @param name       Human-readable template name.
	 * @param operations Array of operations to include in the template.
	 */
	function addTemplate(string calldata name, Operation[] calldata operations) external onlyRole(SETTER_ROLE) {
		uint256 templateId = nextTemplateId++;
		Template storage template = templates[templateId];
		template.name = name;
		template.active = true;

		for (uint256 i = 0; i < operations.length; i++) {
			template.operations.push(operations[i]);
		}

		emit TemplateAdded(templateId, name);
	}

	/**
	 * @notice Toggle template active status.
	 * @param templateId Template ID to update.
	 * @param active     New active status.
	 */
	function setTemplateActive(uint256 templateId, bool active) external onlyRole(SETTER_ROLE) {
		if (templateId >= nextTemplateId) revert InvalidTemplate(templateId);
		templates[templateId].active = active;
		emit TemplateUpdated(templateId, active);
	}

	/* ───────────────────── Operation Execution ───────────────────── */

	/**
	 * @notice Execute operations based on a predefined template.
	 * @param templateId Template ID to execute.
	 * @param signedOps  Array of signed operations matching the template.
	 *
	 * @dev Operations are executed in sequence with return values from earlier
	 *      operations automatically injected into later operations as specified
	 *      by the template's insertion points and source indices.
	 *      Supports delegated signatures where actualSigner can be different from signer.
	 */
	function executeTemplate(uint256 templateId, SignedOperation[] calldata signedOps) external nonReentrant onlyRole(OPERATOR_ROLE) {
		if (templateId >= nextTemplateId) revert InvalidTemplate(templateId);

		Template storage template = templates[templateId];
		if (!template.active) revert TemplateNotActive(templateId);
		if (signedOps.length != template.operations.length) revert ArrayLengthMismatch();

		// Set instant mode active
		symmio.setCallFromInstantLayer(true);

		bytes[] memory results = new bytes[](signedOps.length);

		bool success = true;
		for (uint256 i = 0; i < signedOps.length && success; i++) {
			Operation memory op = template.operations[i];
			SignedOperation calldata signedOp = signedOps[i];

			// Verify signature and nonce (includes delegation check)
			_verifyOperation(signedOp);

			// Prepare calldata with insertions from previous results
			bytes memory finalCallData = _insertResults(signedOp.callData, op.insertionPoints, op.sourceIndices, results);

			// Execute operation
			(success, results[i]) = _executeOperationSafe(signedOp, finalCallData);
			if (!success) {
				symmio.setCallFromInstantLayer(false);
				revert OperationFailed(i, results[i]);
			}
		}

		// Reset instant mode
		symmio.setCallFromInstantLayer(false);
		emit OperationsExecuted(templateId, msg.sender);
	}

	/**
	 * @notice Execute a batch of operations without using a template.
	 * @param signedOps Array of signed operations to execute.
	 *
	 * @dev Each operation is executed independently without result injection.
	 *      All operations must succeed for the transaction to complete.
	 *      Supports delegated signatures where actualSigner can be different from signer.
	 */
	function executeBatch(SignedOperation[] calldata signedOps) external nonReentrant onlyRole(OPERATOR_ROLE) {
		if (signedOps.length == 0) revert EmptyBatch();

		symmio.setCallFromInstantLayer(true);

		bytes[] memory results = new bytes[](signedOps.length);

		bool success = true;
		for (uint256 i = 0; i < signedOps.length && success; i++) {
			// Verify signature and nonce (includes delegation check)
			_verifyOperation(signedOps[i]);

			console.log("Verified");

			(success, results[i]) = _executeOperationSafe(signedOps[i], signedOps[i].callData);
			console.log("Execution Finished", string(results[0]));
			if (!success) {
				symmio.setCallFromInstantLayer(false);
				revert OperationFailed(i, results[i]);
			}
		}

		symmio.setCallFromInstantLayer(false);
		emit BatchExecuted(msg.sender, signedOps.length);
	}

	/* ───────────────────────── Internal Helpers ───────────────────────── */

	/**
	 * @dev Verify signature and authentication for an operation with flexible nonce handling.
	 * @param signedOp Signed operation to verify.
	 *
	 * @dev Supports both salt-only protection (nonce = 0) and ordered execution (nonce > 0).
	 *      Validates that PartyB contracts and MultiAccount contracts are properly registered.
	 *      Now also supports delegated signatures where actualSigner != signer.
	 */
	function _verifyOperation(SignedOperation calldata signedOp) private {
		if (signedOp.deadline < block.timestamp) revert DeadlineExpired(signedOp.deadline);

		bytes32 hash = getOperationHash(signedOp, true);

		// Determine who should have signed
		address expectedSigner = signedOp.signer;
		bool isDelegated = false;

		// Validate registration status and signature
		if (signedOp.accountSource == address(0)) {
			// For PartyB operations
			if (!isPartyBRegistered(signedOp.signer)) revert UnregisteredPartyB(signedOp.signer);

			// Check signature from either signer or delegate
			if (!SignatureChecker.isValidSignatureNow(expectedSigner, hash, signedOp.signature)) {
				console.log("Party B signature Reverted!");
				revert InvalidSignature();
			}
		} else {
			// Check if actualSigner is provided and different from signer (delegation case)
			if (signedOp.actualSigner != address(0) && signedOp.actualSigner != signedOp.signer) {
				// Verify delegation is active
				if (!isDelegationActive(IMultiAccount(signedOp.accountSource).owners(signedOp.signer), signedOp.actualSigner)) {
					revert InvalidDelegation();
				}
				expectedSigner = signedOp.actualSigner;
				isDelegated = true;
			}
			// For PartyA operations through MultiAccount
			if (!isMultiAccountRegistered(signedOp.accountSource)) revert UnregisteredMultiAccount(signedOp.accountSource);

			if (isDelegated) {
				if (!SignatureChecker.isValidSignatureNow(expectedSigner, hash, signedOp.signature)) {
					console.log("Party A signature Reverted!");
					revert InvalidSignature();
				}
			} else {
				if (!IMultiAccount(signedOp.accountSource).isValidSignatureOfAccount(expectedSigner, hash, signedOp.signature)) {
					console.log("Party A2 signature Reverted!");
					revert InvalidSignature();
				}
			}
		}

		// Check for replay attacks
		if (usedOperationHashes[hash]) revert OperationAlreadyExecuted(hash);
		usedOperationHashes[hash] = true;

		// Check nonce only if it's not 0 (0 means no nonce protection, relies on salt)
		// For delegated operations, we still use the original signer's nonce
		if (signedOp.nonce != 0) {
			uint256 expectedNonce = nonces[signedOp.signer] + 1;
			if (signedOp.nonce != expectedNonce) {
				revert InvalidNonce(signedOp.signer, expectedNonce, signedOp.nonce);
			}
			nonces[signedOp.signer]++;
			emit NonceIncremented(signedOp.signer, nonces[signedOp.signer]);
		}
	}

	/**
	 * @dev Execute an operation safely with proper error handling.
	 * @param signedOp Signed operation details.
	 * @param callData Prepared call data for execution.
	 * @return success Whether the operation succeeded.
	 * @return result  Return data from the operation.
	 */
	function _executeOperationSafe(SignedOperation calldata signedOp, bytes memory callData) private returns (bool success, bytes memory result) {
		bytes[] memory callDatas = new bytes[](1);
		callDatas[0] = callData;

		if (signedOp.accountSource == address(0)) {
			// PartyB operation - always use the original signer (PartyB address)
			console.log("Symmio B Run!");
			(success, result) = signedOp.signer.call(abi.encodeWithSelector(ISymmioPartyB._call.selector, callDatas));
			console.log("Symmio B Result, result length:", result.length, string(result));
		} else {
			// PartyA operation through MultiAccount - use original signer account
			(success, result) = signedOp.accountSource.call(abi.encodeWithSelector(IMultiAccount._call.selector, signedOp.signer, callDatas));
			console.log("MultiAccount Result, result length:", result.length, string(result));
		}
		if (result.length > 0) {
			bytes[] memory arr = abi.decode(result, (bytes[]));
			result = arr[0];
		}
		console.log("Result:", success ? "Succeeded" : "Faulty", "result Count:", result.length);
	}

	/**
	 * @dev Insert results from previous operations into call data.
	 * @param callData        Original call data with placeholders.
	 * @param insertionPoints Byte offsets where results should be inserted.
	 * @param sourceIndices   Indices of operations whose results to use.
	 * @param results         Array of previous operation results.
	 * @return Modified call data with inserted results.
	 */
	function _insertResults(
		bytes calldata callData,
		uint256[] memory insertionPoints,
		uint256[] memory sourceIndices,
		bytes[] memory results
	) private pure returns (bytes memory) {
		if (insertionPoints.length == 0) return callData;

		// Copy callData to modify it
		bytes memory modifiedCallData = callData;

		// Replace each result at its insertion point
		for (uint256 i = 0; i < insertionPoints.length; i++) {
			if (sourceIndices[i] < results.length) {
				// Decode as bytes32 (works for address, uint256, etc.)
				bytes32 value = abi.decode(results[sourceIndices[i]], (bytes32));

				uint256 offset = insertionPoints[i];
				assembly {
					mstore(add(modifiedCallData, add(36, offset)), value)
				}
			} else {
				revert InvalidSourceIndex(sourceIndices[i]);
			}
		}

		return modifiedCallData;
	}

	/* ────────────────────────── View Functions ────────────────────────── */

	/**
	 * @notice Check if an address is a registered PartyB.
	 * @param addr Address to check.
	 * @return Whether the address is a registered PartyB.
	 */
	function isPartyBRegistered(address addr) public view returns (bool) {
		return registeredPartyBs[addr];
	}

	/**
	 * @notice Check if an address is a registered MultiAccount.
	 * @param addr Address to check.
	 * @return Whether the address is a registered MultiAccount.
	 */
	function isMultiAccountRegistered(address addr) public view returns (bool) {
		return registeredMultiAccounts[addr];
	}

	/**
	 * @notice Get the EIP-712 typed data hash for an operation.
	 * @param signedOp The signed operation.
	 * @return The EIP-712 hash that should be signed.
	 *
	 * @dev Includes salt for uniqueness protection in addition to standard parameters.
	 *      Note: The hash is always computed with the original signer, even if signed by a delegate.
	 */
	function getOperationHash(SignedOperation calldata signedOp, bool isEthSignedMessage) public view returns (bytes32) {
		bytes32 structHash = keccak256(
			abi.encode(
				OPERATION_TYPEHASH,
				signedOp.accountSource,
				signedOp.signer,
				keccak256(signedOp.callData),
				signedOp.nonce,
				signedOp.salt,
				signedOp.deadline
			)
		);

		return isEthSignedMessage ? ECDSA.toEthSignedMessageHash(_hashTypedDataV4(structHash)) : _hashTypedDataV4(structHash);
	}

	/**
	 * @notice Get the EIP-712 typed data hash for a delegation authorization.
	 * @param delegator       Address granting delegation.
	 * @param delegate        Address receiving delegation.
	 * @param expiryTimestamp Expiry timestamp for delegation.
	 * @param nonce           Nonce for replay protection.
	 * @return The EIP-712 hash that should be signed.
	 */
	function getDelegationHash(address delegator, address delegate, uint256 expiryTimestamp, uint256 nonce) public view returns (bytes32) {
		bytes32 structHash = keccak256(abi.encode(DELEGATION_TYPEHASH, delegator, delegate, expiryTimestamp, nonce));

		return _hashTypedDataV4(structHash);
	}

	/**
	 * @notice Get all active delegations for a delegator.
	 * @param delegator Address to check delegations for.
	 * @param delegates Array of potential delegates to check.
	 * @return activeDelegates Array of currently active delegates and their expiry times.
	 */
	function getActiveDelegations(address delegator, address[] calldata delegates) external view returns (DelegationInfo[] memory activeDelegates) {
		uint256 activeCount = 0;

		// Count active delegations
		for (uint256 i = 0; i < delegates.length; i++) {
			if (isDelegationActive(delegator, delegates[i])) {
				activeCount++;
			}
		}

		// Populate result array
		activeDelegates = new DelegationInfo[](activeCount);
		uint256 currentIndex = 0;

		for (uint256 i = 0; i < delegates.length; i++) {
			if (isDelegationActive(delegator, delegates[i])) {
				activeDelegates[currentIndex] = DelegationInfo({ delegate: delegates[i], expiryTimestamp: delegations[delegator][delegates[i]] });
				currentIndex++;
			}
		}

		return activeDelegates;
	}

	/**
	 * @notice Get the EIP-712 domain separator.
	 * @return The domain separator for this contract.
	 */
	function domainSeparator() external view returns (bytes32) {
		return _domainSeparatorV4();
	}

	/**
	 * @notice Get complete template information.
	 * @param templateId Template ID to query.
	 * @return Template structure with all details.
	 */
	function getTemplate(uint256 templateId) external view returns (Template memory) {
		return templates[templateId];
	}

	/**
	 * @notice Get complete template information.
	 * @return Last template ID.
	 */
	function getLastTemplateID() external view returns (uint256) {
		return nextTemplateId;
	}

	/**
	 * @notice Get operations array for a specific template.
	 * @param templateId Template ID to query.
	 * @return Array of operations in the template.
	 */
	function getTemplateOperations(uint256 templateId) external view returns (Operation[] memory) {
		return templates[templateId].operations;
	}
}
