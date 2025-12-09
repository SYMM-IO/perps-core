// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/**
 * @title  InstantLayer
 * @author Symmetry Labs
 * @notice Advanced operation orchestration layer for the Symmio protocol enabling batched,
 *         templated, and delegated operations with comprehensive signature verification.
 *
 * @dev    This contract serves as an intermediary layer between users and the Symmio protocol,
 *         providing sophisticated operation management capabilities:
 *
 *         ┌─────────────────────────────────────────────────────────────┐
 *         │                     CORE FEATURES                           │
 *         ├─────────────────────────────────────────────────────────────┤
 *         │ • Delegation System: Users can authorize delegates to       │
 *         │   execute specific operations on their behalf               │
 *         │ • Template Operations: Pre-defined operation sequences      │
 *         │   with automatic result chaining between steps              │
 *         │ • Flexible Nonce Management: Choose between salt-only       │
 *         │   (nonce=0) or ordered execution (nonce>0)                  │
 *         │ • Multi-Account Support: Works with both PartyB and         │
 *         │   MultiAccount contracts                                    │
 *         │ • EIP-712 Signatures: Type-safe signature verification      │
 *         │ • Batch Processing: Execute multiple operations atomically  │
 *         └─────────────────────────────────────────────────────────────┘
 *
 *         SECURITY CONSIDERATIONS:
 *         - All contracts must be registered before interaction
 *         - Comprehensive replay protection via salt and optional nonce
 *         - Deadline enforcement for time-sensitive operations
 *         - Role-based access control for administrative functions
 *         - Reentrancy protection on all execution functions
 */

import { AccessControlEnumerable } from "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/* ════════════════════════════ EXTERNAL INTERFACES ════════════════════════════ */

/**
 * @notice Interface for AccountHub contract managing sub-accounts and virtual accounts.
 */
interface IAccountHub {
	/**
	 * @notice Execute multiple operations on behalf of an account
	 * @param account The account to execute operations for
	 * @param _callDatas Array of encoded function calls to execute
	 */
	function _call(address account, bytes[] calldata _callDatas) external;

	/**
	 * @notice Get the owner address of a specific account
	 * @param account The account to query
	 * @return The owner address of the account
	 */
	function ownerOf(address account) external view returns (address);
}

/**
 * @notice Interface for SymmioPartyB contract that handles PartyB operations.
 * @dev    PartyB contracts execute trading operations on behalf of market makers.
 */
interface ISymmioPartyB {
	/**
	 * @notice Execute multiple operations as PartyB
	 * @param _callDatas Array of encoded function calls to execute
	 */
	function _call(bytes[] calldata _callDatas) external;
}

/**
 * @notice Interface for the core Symmio contract.
 * @dev    Used to toggle instant layer mode for optimized execution.
 */
interface ISymmio {
	/**
	 * @notice Enable or disable instant layer mode
	 * @param _callFromInstantLayer True to enable instant layer mode
	 */
	function setCallFromInstantLayer(bool _callFromInstantLayer) external;
}

contract InstantLayer is AccessControlEnumerable, ReentrancyGuard, EIP712 {
	/* ═══════════════════════════════ ROLES ═══════════════════════════════ */

	/// @notice Role identifier for managing contract configuration and templates
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");

	/// @notice Role identifier for executing operations and templates
	bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

	/// @notice Role identifier for revoking delegation permissions
	bytes32 public constant REVOKER_ROLE = keccak256("REVOKER_ROLE");

	/* ════════════════════════ EIP-712 TYPE HASHES ════════════════════════ */

	/// @notice EIP-712 type hash for Account struct
	bytes32 public constant ACCOUNT_TYPEHASH = keccak256("Account(address accountHub,address addr)");

	/// @notice EIP-712 type hash for ReplayAttackHeader struct
	bytes32 public constant REPLAY_HEADER_TYPEHASH = keccak256("ReplayAttackHeader(uint256 nonce,uint256 deadline,bytes32 salt)");

	/// @notice EIP-712 type hash for SignedOperation struct (includes nested type definitions)
	bytes32 internal constant SIGNED_OPERATION_TYPEHASH =
		keccak256(
			abi.encodePacked(
				"SignedOperation(",
				"address signer,",
				"bytes callData,",
				"Account signerAccount,",
				"ReplayAttackHeader replayAttackHeader",
				")",
				"Account(address accountHub,address addr)",
				"ReplayAttackHeader(uint256 nonce,uint256 deadline,bytes32 salt)"
			)
		);

	/// @notice EIP-712 type hash for DelegationInfo struct
	bytes32 public constant DELEGATION_INFO_TYPEHASH =
		keccak256(
			"DelegationInfo(Account account,address delegatedSigner,bytes4[] selectors,uint256 expiryTimestamp)"
			"Account(address accountHub,address addr)"
		);

	/// @notice EIP-712 type hash for SignedDelegation struct
	bytes32 public constant SIGNED_DELEGATION_TYPEHASH =
		keccak256(
			"SignedDelegation(DelegationInfo delegationInfo,ReplayAttackHeader replayAttackHeader)"
			"Account(address accountHub,address addr)"
			"DelegationInfo(Account account,address delegatedSigner,bytes4[] selectors,uint256 expiryTimestamp)"
			"ReplayAttackHeader(uint256 nonce,uint256 deadline,bytes32 salt)"
		);

	/* ══════════════════════════ STATE VARIABLES ══════════════════════════ */

	/// @notice Immutable reference to the core Symmio protocol contract
	ISymmio public immutable symmio;

	/// @notice Sequential nonce tracking per address for ordered execution
	/// @dev    Only enforced when nonce > 0 in operations
	mapping(address => uint256) public nonces;

	/// @notice Storage for all operation templates indexed by template ID
	mapping(uint256 => Template) public templates;

	/// @notice Registry of authorized PartyB contracts
	/// @dev    PartyB contracts must be registered before they can execute operations
	mapping(address => bool) public registeredPartyBs;

	/// @notice Registry of authorized AccountHub contracts
	/// @dev    AccountHub contracts must be registered before they can manage accounts
	mapping(address => bool) public registeredAccountHubs;

	/// @notice Tracking of executed operation hashes to prevent replay attacks
	/// @dev    Each operation can only be executed once
	mapping(bytes32 => bool) public usedOperationHashes;

	/// @notice Tracking of executed delegation hashes to prevent replay attacks
	/// @dev    Each delegation can only be executed once
	mapping(bytes32 => bool) public usedDelegationHashes;

	/// @notice Delegation permissions: delegator => delegate => selector => expiry timestamp
	/// @dev    Non-zero timestamp indicates active delegation until that time
	mapping(address => mapping(address => mapping(bytes4 => uint256))) public delegations;

	/// @notice Sequential nonce for delegation signatures to prevent replay
	mapping(address => uint256) public delegationNonces;

	/// delegator => delegate => selector => eta (0 = none scheduled)
	mapping(address => mapping(address => mapping(bytes4 => uint256))) public pendingRevocationEta;

	/// @notice Cooldown period for revoking delegation permissions
	uint256 public revocationCooldown; // in seconds

	/// @notice Counter for generating unique sequential template IDs
	uint256 public nextTemplateId;

	/* ═══════════════════════════════ STRUCTS ═══════════════════════════════ */

	/**
	 * @notice Represents an account context for operations.
	 * @dev    Used to identify which AccountHub manages a specific trading account.
	 * @param accountHub Address of the AccountHub contract (0x0 for PartyB operations)
	 * @param addr         The actual account address (PartyA account or PartyB address)
	 */
	struct Account {
		address accountHub;
		address addr;
	}

	/**
	 * @notice Header containing anti-replay protection parameters.
	 * @dev    Provides flexible replay protection through salt and optional nonce.
	 * @param nonce    Sequential counter (0 = disabled/salt-only, >0 = enforced ordering)
	 * @param deadline UNIX timestamp after which the operation expires
	 * @param salt     Unique 32-byte value for operation uniqueness (always required)
	 */
	struct ReplayAttackHeader {
		uint256 nonce;
		uint256 deadline;
		bytes32 salt;
	}

	/**
	 * @notice Represents a signed operation ready for execution.
	 * @dev    This structure is signed via EIP-712 for secure off-chain authorization.
	 * @param signer             Address that signed this operation (may be delegated)
	 * @param callData           Encoded function call to execute
	 * @param signerAccount      Account context for the operation
	 * @param replayAttackHeader Anti-replay protection parameters
	 */
	struct SignedOperation {
		address signer;
		bytes callData;
		Account signerAccount;
		ReplayAttackHeader replayAttackHeader;
	}

	/**
	 * @notice Container for delegation authorization with signature.
	 * @param delegationInfo     Delegation parameters and permissions
	 * @param replayAttackHeader Anti-replay protection for the delegation
	 */
	struct SignedDelegation {
		DelegationInfo delegationInfo;
		ReplayAttackHeader replayAttackHeader;
	}

	/**
	 * @notice Defines delegation permissions from one address to another.
	 * @param account           The account granting delegation
	 * @param delegatedSigner   Address authorized to act on behalf of the account
	 * @param selectors         Function selectors the delegate can execute
	 * @param expiryTimestamp   UNIX timestamp when delegation expires
	 */
	struct DelegationInfo {
		Account account;
		address delegatedSigner;
		bytes4[] selectors;
		uint256 expiryTimestamp;
	}

	/**
	 * @notice Configuration for result injection between operations.
	 * @dev    Enables chaining operation results within templates.
	 * @param insertionPoints Array of byte offsets where results should be inserted
	 * @param sourceIndices   Array of operation indices whose results to inject
	 */
	struct Operation {
		uint256[] insertionPoints;
		uint256[] sourceIndices;
	}

	/**
	 * @notice Template definition for complex multi-operation sequences.
	 * @param name       Human-readable identifier for the template
	 * @param operations Array of operations with their injection configurations
	 * @param active     Whether this template can currently be executed
	 */
	struct Template {
		string name;
		Operation[] operations;
		bool active;
	}

	/* ═══════════════════════════════ EVENTS ═══════════════════════════════ */

	/// @notice Emitted when a new template is created
	/// @param templateId Unique identifier assigned to the template
	/// @param name Human-readable name of the template
	event TemplateAdded(uint256 indexed templateId, string name);

	/// @notice Emitted when a template's active status changes
	/// @param templateId Template that was modified
	/// @param active New active status of the template
	event TemplateUpdated(uint256 indexed templateId, bool active);

	/// @notice Emitted when a template is successfully executed
	/// @param templateId Template that was executed
	/// @param executor Address that triggered the execution
	event OperationsExecuted(uint256 indexed templateId, address indexed executor);

	/// @notice Emitted when a batch of operations completes successfully
	/// @param executor Address that triggered the batch execution
	/// @param operationCount Number of operations in the batch
	event BatchExecuted(address indexed executor, uint256 operationCount);

	/// @notice Emitted when a user's nonce is incremented after operation execution
	/// @param user Address whose nonce was incremented
	/// @param newNonce The new nonce value
	event NonceIncremented(address indexed user, uint256 newNonce);

	/// @notice Emitted when a PartyB contract is registered
	/// @param partyB Address of the newly registered PartyB
	event PartyBRegistered(address indexed partyB);

	/// @notice Emitted when a PartyB contract is removed from registry
	/// @param partyB Address of the unregistered PartyB
	event PartyBUnregistered(address indexed partyB);

	/// @notice Emitted when an AccountHub contract is registered
	/// @param accountHub Address of the newly registered AccountHub
	event AccountHubRegistered(address indexed accountHub);

	/// @notice Emitted when a AccountHub contract is removed from registry
	/// @param accountHub Address of the unregistered AccountHub
	event AccountHubUnregistered(address indexed accountHub);

	/// @notice Emitted when delegation permission is granted
	/// @param delegator Address granting the delegation
	/// @param delegate Address receiving delegation permission
	/// @param selector Function selector being delegated
	/// @param expiryTimestamp When the delegation expires
	event DelegationGranted(address indexed delegator, address indexed delegate, bytes4 selector, uint256 expiryTimestamp);

	/// @notice Emitted when a delegation nonce is incremented
	/// @param delegator Address whose delegation nonce was incremented
	/// @param newNonce The new delegation nonce value
	event DelegationNonceIncremented(address indexed delegator, uint256 newNonce);

	/// @notice Emitted when the revocation cooldown is updated
	/// @param oldCooldown The old cooldown period
	/// @param newCooldown The new cooldown period
	event RevocationCooldownUpdated(uint256 oldCooldown, uint256 newCooldown);

	/// @notice Emitted when a delegation selector is scheduled for revocation
	/// @param delegator Address whose delegation is being revoked
	/// @param delegate Address whose delegation is being revoked
	/// @param selector Function selector being revoked
	/// @param eta The eta at which the revocation will take effect
	event RevocationScheduled(address indexed delegator, address indexed delegate, bytes4 selector, uint256 eta);

	/// @notice Emitted when a delegation selector is revoked
	/// @param delegator Address whose delegation is being revoked
	/// @param delegate Address whose delegation is being revoked
	/// @param selector Function selector being revoked
	event DelegationSelectorRevoked(address indexed delegator, address indexed delegate, bytes4 selector);

	/* ═══════════════════════════════ ERRORS ═══════════════════════════════ */

	/// @notice Signature verification failed
	error InvalidSignature();

	/// @notice CallData format or content is invalid
	error InvalidCallData();

	/// @notice Operation deadline has passed
	/// @param deadline The deadline that was exceeded
	error DeadlineExpired(uint256 deadline);

	/// @notice Nonce mismatch for ordered execution
	/// @param user The user whose nonce was checked
	/// @param expected The expected nonce value
	/// @param provided The nonce that was provided
	error InvalidNonce(address user, uint256 expected, uint256 provided);

	/// @notice Template is disabled and cannot be executed
	/// @param templateId The template that is not active
	error TemplateNotActive(uint256 templateId);

	/// @notice Template does not exist
	/// @param templateId The invalid template ID
	error InvalidTemplate(uint256 templateId);

	/// @notice Operation execution failed
	/// @param operationIndex Index of the failed operation
	/// @param revertData Error data from the failed operation
	error OperationFailed(uint256 operationIndex, bytes revertData);

	/// @notice Input arrays have mismatched lengths
	error ArrayLengthMismatch();

	/// @notice CallData is too short (minimum 4 bytes for selector)
	error CallDataLengthMismatch();

	/// @notice AccountHub contract is not registered
	/// @param accountHub The unregistered AccountHub address
	error UnregisteredAccountHub(address accountHub);

	/// @notice PartyB contract is not registered
	/// @param partyB The unregistered PartyB address
	error UnregisteredPartyB(address partyB);

	/// @notice Operation hash has already been executed
	/// @param hash The operation hash that was already used
	error OperationAlreadyExecuted(bytes32 hash);

	/// @notice Delegation hash has already been executed
	/// @param hash The delegation hash that was already used
	error DelegationAlreadyExecuted(bytes32 hash);

	/// @notice Batch operation array is empty
	error EmptyBatch();

	/// @notice Delegation is invalid or has expired
	error InvalidDelegation();

	/// @notice Delegation has expired
	/// @param expiryTimestamp The expiry time that has passed
	error DelegationExpired(uint256 expiryTimestamp);

	/// @notice Cannot delegate to oneself
	error SelfDelegation();

	/// @notice Source index for result injection is out of bounds
	/// @param sourceIndex The invalid source index
	error InvalidSourceIndex(uint256 sourceIndex);

	/// @notice Caller is not the owner of the specified account
	/// @param sender The address that attempted the operation
	/// @param accountHub The AccountHub contract address
	/// @param account The actual account address
	error NotOwnerOfAccount(address sender, address accountHub, address account);

	/// @notice Template has no operations
	error EmptyTemplate();

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

	/// @notice Cooldown not over
	/// @param eta The eta that has not passed
	error RevocationCooldownNotOver(uint256 eta);

	error MissingSourceResult();
	error BadSourceResultLength(bytes res, uint256 length);

	/* ════════════════════════════ CONSTRUCTOR ════════════════════════════ */

	/**
	 * @notice Deploy InstantLayer with Symmio integration.
	 * @dev    Sets up EIP-712 domain and grants initial admin roles.
	 * @param _symmio Address of the core Symmio protocol contract
	 * @param _admin  Address to receive all administrative roles
	 */
	constructor(address _symmio, address _admin) EIP712("SymmioInstantLayer", "1") {
		symmio = ISymmio(_symmio);

		// Grant all roles to the initial admin
		_grantRole(DEFAULT_ADMIN_ROLE, _admin);
		_grantRole(SETTER_ROLE, _admin);
		_grantRole(OPERATOR_ROLE, _admin);

		revocationCooldown = 10 minutes;
		emit RevocationCooldownUpdated(0, revocationCooldown);
	}

	/* ═════════════════════ DELEGATION MANAGEMENT ═════════════════════ */

	/**
	 * @notice Grant batch delegation permissions using a signature.
	 * @dev    Allows account owners to delegate multiple function selectors to another address
	 *         via an off-chain signature. This enables gasless delegation setup.
	 * @param signedDelegation Delegation details including permissions and anti-replay parameters
	 * @param signature        EIP-712 signature from the account owner
	 */
	function grantBatchDelegationBySig(SignedDelegation calldata signedDelegation, bytes calldata signature) external {
		DelegationInfo calldata info = signedDelegation.delegationInfo;
		ReplayAttackHeader calldata rh = signedDelegation.replayAttackHeader;

		address delegator = info.account.addr;
		address owner = _getAccountOwner(info.account.accountHub, delegator);
		address delegate = info.delegatedSigner;
		uint256 expiry = info.expiryTimestamp;
		bytes4[] calldata selectors = info.selectors;

		// Validate delegation parameters
		if (delegate == owner) revert SelfDelegation();
		if (expiry <= block.timestamp) revert DelegationExpired(expiry);
		if (rh.deadline != 0 && block.timestamp > rh.deadline) revert DeadlineExpired(rh.deadline);

		// Verify and update nonce
		uint256 expected = delegationNonces[delegator];
		if (rh.nonce != expected + 1) {
			revert InvalidNonce(delegator, expected, rh.nonce);
		}
		delegationNonces[delegator] = expected + 1;
		emit DelegationNonceIncremented(delegator, delegationNonces[delegator]);

		// Verify signature
		bytes32 hash = getDelegationHash(signedDelegation);
		if (!SignatureChecker.isValidSignatureNow(owner, hash, signature)) {
			revert InvalidSignature();
		}

		// Check for replay attacks
		if (usedDelegationHashes[hash]) revert DelegationAlreadyExecuted(hash);
		usedDelegationHashes[hash] = true;

		// Update delegation mappings
		mapping(bytes4 => uint256) storage slot = delegations[delegator][delegate];

		for (uint256 i = 0; i < selectors.length; ) {
			bytes4 selector = selectors[i];
			slot[selector] = expiry;
			delete pendingRevocationEta[delegator][delegate][selector];
			emit DelegationGranted(delegator, delegate, selector, expiry);

			unchecked {
				++i;
			}
		}
	}

	/**
	 * @notice Grant delegation permissions directly (no signature required).
	 * @dev    Account owners can directly grant delegation without signatures.
	 * @param info Delegation information including delegate address and permissions
	 */
	function grantDelegation(DelegationInfo calldata info) external onlyOwner(info.account) {
		if (info.delegatedSigner == msg.sender) revert SelfDelegation();
		if (info.expiryTimestamp <= block.timestamp) revert DelegationExpired(info.expiryTimestamp);

		address delegator = info.account.addr;
		address delegate = info.delegatedSigner;

		// Grant each selector permission
		for (uint256 j = 0; j < info.selectors.length; j++) {
			delegations[delegator][delegate][info.selectors[j]] = info.expiryTimestamp;
			delete pendingRevocationEta[delegator][delegate][info.selectors[j]];
			emit DelegationGranted(delegator, delegate, info.selectors[j], info.expiryTimestamp);
		}
	}

	/* ═════════════════ REGISTRATION MANAGEMENT ═════════════════ */

	/**
	 * @notice Register multiple PartyB contracts.
	 * @dev    PartyB contracts must be registered before they can execute operations.
	 *         Registration also grants OPERATOR_ROLE to the PartyB.
	 */
	function registerPartyBs(address[] calldata partyBs) external onlyRole(SETTER_ROLE) {
		for (uint256 i = 0; i < partyBs.length; i++) {
			registeredPartyBs[partyBs[i]] = true;
			_grantRole(OPERATOR_ROLE, partyBs[i]);
			emit PartyBRegistered(partyBs[i]);
		}
	}

	/**
	 * @notice Remove a PartyB contract from the registry.
	 * @dev    Also revokes OPERATOR_ROLE from the PartyB.
	 * @param partyB Address of the PartyB contract to unregister
	 *
	 * Requirements:
	 * - Caller must have SETTER_ROLE
	 */
	function unregisterPartyB(address partyB) external onlyRole(SETTER_ROLE) {
		registeredPartyBs[partyB] = false;
		_revokeRole(OPERATOR_ROLE, partyB);
		emit PartyBUnregistered(partyB);
	}

	/**
	 * @notice Register multiple AccountHub contracts.
	 * @dev    AccountHub contracts must be registered before they can manage accounts.
	 * @param accountHubs Array of AccountHub contract addresses to register
	 *
	 * Requirements:
	 * - Caller must have SETTER_ROLE
	 */
	function registerAccountHubs(address[] calldata accountHubs) external onlyRole(SETTER_ROLE) {
		for (uint256 i = 0; i < accountHubs.length; i++) {
			registeredAccountHubs[accountHubs[i]] = true;
			emit AccountHubRegistered(accountHubs[i]);
		}
	}

	/**
	 * @notice Remove a AccountHub contract from the registry.
	 * @param accountHub Address of the AccountHub contract to unregister
	 *
	 * Requirements:
	 * - Caller must have SETTER_ROLE
	 */
	function unregisterAccountHub(address accountHub) external onlyRole(SETTER_ROLE) {
		registeredAccountHubs[accountHub] = false;
		emit AccountHubUnregistered(accountHub);
	}

	/* ══════════════════════ TEMPLATE MANAGEMENT ══════════════════════ */

	/**
	 * @notice Create a new operation template.
	 * @dev    Templates define sequences of operations with automatic result chaining.
	 *         Each operation can reference results from previous operations.
	 * @param name       Human-readable name for the template
	 * @param operations Array of operation configurations with injection points
	 *
	 * @custom:example
	 * For a swap-and-stake template:
	 * - Operation 0: Swap tokens (returns amount out)
	 * - Operation 1: Stake tokens (uses amount from operation 0)
	 * Operation 1 would have insertionPoint=[36] and sourceIndex=[0]
	 */
	function addTemplate(string calldata name, Operation[] calldata operations) external onlyRole(SETTER_ROLE) {
		if (operations.length == 0) revert EmptyTemplate();

		uint256 templateId = nextTemplateId++;
		Template storage template = templates[templateId];
		template.name = name;
		template.active = true;

		// Copy operations to storage
		for (uint256 i = 0; i < operations.length; i++) {
			template.operations.push(operations[i]);
		}

		emit TemplateAdded(templateId, name);
	}

	/**
	 * @notice Enable or disable a template.
	 * @dev    Disabled templates cannot be executed.
	 * @param templateId ID of the template to update
	 * @param active     Whether the template should be active
	 */
	function setTemplateActive(uint256 templateId, bool active) external onlyRole(SETTER_ROLE) {
		if (templateId >= nextTemplateId) revert InvalidTemplate(templateId);
		templates[templateId].active = active;
		emit TemplateUpdated(templateId, active);
	}

	/* ═════════════════════ REVOKE DELEGATION FUNCTIONS ═════════════════════ */

	/**
	 * @notice Update the global cooldown for delegation revocations.
	 * @dev    Only SETTER_ROLE. Add guardrails to prevent absurd values.
	 *         Example policy: 1 minute ≤ cooldown ≤ 30 days.
	 */
	function setRevocationCooldown(uint256 newCooldown) external onlyRole(SETTER_ROLE) {
		// Adjust bounds to taste; 0 disallowed to keep the two-step invariant.
		if (newCooldown < 1 minutes || newCooldown > 30 days) revert InvalidCallData();
		uint256 old = revocationCooldown;
		revocationCooldown = newCooldown;
		emit RevocationCooldownUpdated(old, newCooldown);
	}

	/**
	 * @notice Schedule revocation of specific selectors; takes effect after cooldown.
	 * @dev    Who may schedule: account owner (delegator), the delegate themselves, or REVOKER_ROLE.
	 *         No-ops for selectors not currently active.
	 */
	function initiateRevokeDelegation(Account calldata account, address delegate, bytes4[] calldata selectors) external {
		bool callerIsOwner = _isAccountOwner(account);
		bool callerIsDelegate = (msg.sender == delegate);
		bool callerIsAdmin = hasRole(REVOKER_ROLE, msg.sender);
		if (!(callerIsOwner || callerIsDelegate || callerIsAdmin)) {
			revert NotOwnerOfAccount(msg.sender, account.accountHub, account.addr);
		}

		for (uint256 i = 0; i < selectors.length; ++i) {
			bytes4 sel = selectors[i];

			// only schedule if currently active
			uint256 currentExpiry = delegations[account.addr][delegate][sel];
			if (currentExpiry <= block.timestamp) continue;

			uint256 eta = block.timestamp + revocationCooldown;
			pendingRevocationEta[account.addr][delegate][sel] = eta;
			emit RevocationScheduled(account.addr, delegate, sel, eta);
		}
	}

	/**
	 * @notice Finalize after cooldown; actually deletes the delegation.
	 * @dev    Anyone may call once ETA has passed.
	 */
	function finalizeRevokeDelegation(Account calldata account, address delegate, bytes4[] calldata selectors) external {
		for (uint256 i = 0; i < selectors.length; ++i) {
			bytes4 sel = selectors[i];
			uint256 eta = pendingRevocationEta[account.addr][delegate][sel];
			if (eta == 0) continue; // not scheduled
			if (block.timestamp < eta) revert RevocationCooldownNotOver(eta); // still cooling

			// delete pending & active delegation
			delete pendingRevocationEta[account.addr][delegate][sel];
			delete delegations[account.addr][delegate][sel];

			emit DelegationSelectorRevoked(account.addr, delegate, sel);
		}
	}

	/* ═════════════════════ OPERATION EXECUTION ═════════════════════ */

	/**
	 * @notice Execute a sequence of operations using a predefined template.
	 * @dev    Operations are executed in order with automatic result injection.
	 *         All operations must succeed for the transaction to complete.
	 *
	 * @param templateId ID of the template defining the operation sequence
	 * @param signedOps  Array of signed operations matching template requirements
	 * @param signatures Array of signatures corresponding to each operation
	 *
	 * Operation Flow:
	 * 1. Validate template exists and is active
	 * 2. Enable instant layer mode in Symmio
	 * 3. For each operation:
	 *    - Verify signature and anti-replay parameters
	 *    - Inject results from previous operations as configured
	 *    - Execute the operation
	 *    - Store result for potential use in later operations
	 * 4. Disable instant layer mode
	 */
	function executeTemplate(
		uint256 templateId,
		SignedOperation[] calldata signedOps,
		bytes[] calldata signatures
	) external nonReentrant onlyRole(OPERATOR_ROLE) {
		if (templateId >= nextTemplateId) revert InvalidTemplate(templateId);
		if (signedOps.length != signatures.length) revert ArrayLengthMismatch();

		Template storage template = templates[templateId];
		if (!template.active) revert TemplateNotActive(templateId);
		if (signedOps.length != template.operations.length) revert TemplateOperationLengthMismatch();

		// Enable instant mode for optimized execution
		symmio.setCallFromInstantLayer(true);

		bytes[] memory results = new bytes[](signedOps.length);

		bool success = true;
		for (uint256 i = 0; i < signedOps.length && success; i++) {
			Operation memory op = template.operations[i];
			SignedOperation calldata signedOp = signedOps[i];

			// Verify operation signature and parameters
			_verifyOperation(signedOp, signatures[i]);

			// Inject results from previous operations into calldata
			bytes memory finalCallData = _insertResults(signedOp.callData, op.insertionPoints, op.sourceIndices, results);

			// Execute the operation and capture result
			(success, results[i]) = _executeOperationSafe(signedOp, finalCallData);

			if (!success) {
				revert OperationFailed(i, results[i]);
			}
		}

		// Disable instant mode
		symmio.setCallFromInstantLayer(false);
		emit OperationsExecuted(templateId, msg.sender);
	}

	/**
	 * @notice Execute a batch of independent operations.
	 * @dev    Operations are executed sequentially without result chaining.
	 *         All operations must succeed for the transaction to complete.
	 *
	 * @param signedOps  Array of signed operations to execute
	 * @param signatures Array of signatures for the operations
	 *
	 * @custom:security Operations are independent - no data flows between them
	 */
	function executeBatch(SignedOperation[] calldata signedOps, bytes[] calldata signatures) external nonReentrant onlyRole(OPERATOR_ROLE) {
		if (signedOps.length == 0) revert EmptyBatch();
		if (signedOps.length != signatures.length) revert ArrayLengthMismatch();

		symmio.setCallFromInstantLayer(true);

		bytes[] memory results = new bytes[](signedOps.length);

		bool success = true;
		for (uint256 i = 0; i < signedOps.length && success; i++) {
			// Verify each operation independently
			_verifyOperation(signedOps[i], signatures[i]);

			// Execute with original calldata (no injection)
			(success, results[i]) = _executeOperationSafe(signedOps[i], signedOps[i].callData);

			if (!success) {
				revert OperationFailed(i, results[i]);
			}
		}

		symmio.setCallFromInstantLayer(false);
		emit BatchExecuted(msg.sender, signedOps.length);
	}

	/* ═════════════════════════ INTERNAL HELPERS ═════════════════════════ */

	/**
	 * @dev Comprehensive verification of operation signatures and parameters.
	 *
	 * Verification Steps:
	 * 1. Check deadline hasn't expired
	 * 2. Validate calldata minimum length
	 * 3. Verify contract registration (PartyB or AccountHub)
	 * 4. Check delegation if signer != owner
	 * 5. Verify EIP-712 signature
	 * 6. Prevent replay attacks
	 * 7. Update nonce if required
	 *
	 * @param signedOp   Operation to verify
	 * @param sigCallData Signature data for verification
	 */
	function _verifyOperation(SignedOperation calldata signedOp, bytes calldata sigCallData) private {
		// Check expiry
		if (signedOp.replayAttackHeader.deadline != 0 && signedOp.replayAttackHeader.deadline < block.timestamp)
			revert DeadlineExpired(signedOp.replayAttackHeader.deadline);

		// Validate calldata has at least selector
		if (signedOp.callData.length < 4) revert CallDataLengthMismatch();

		bytes32 hash = getOperationHash(signedOp);
		address signer = signedOp.signer;

		// Validate registration and delegation
		if (signedOp.signerAccount.accountHub == address(0)) {
			// PartyB operation
			if (signer != signedOp.signerAccount.addr) revert MismatchSignerAndAccount(signer, signedOp.signerAccount.addr);
			if (!isPartyBRegistered(signer)) revert UnregisteredPartyB(signer);
		} else {
			// PartyA operation through AccountHub
			address accountOwner = _getAccountOwner(signedOp.signerAccount.accountHub, signedOp.signerAccount.addr);

			// Check delegation if signer is not the owner
			if (accountOwner != signer) {
				bytes calldata callData = signedOp.callData;
				bytes4 selector;
				assembly ("memory-safe") {
					selector := calldataload(callData.offset) // Extract first 4 bytes
				}
				if (!isDelegationActive(signedOp.signerAccount, signedOp.signer, selector)) {
					revert InvalidDelegation();
				}
			}
		}

		// Verify signature
		if (!SignatureChecker.isValidSignatureNow(signer, hash, sigCallData)) {
			revert InvalidSignature();
		}

		// Check for replay attacks
		if (usedOperationHashes[hash]) revert OperationAlreadyExecuted(hash);
		usedOperationHashes[hash] = true;

		// Handle nonce if enabled (non-zero)
		if (signedOp.replayAttackHeader.nonce != 0) {
			uint256 expectedNonce = nonces[signedOp.signerAccount.addr] + 1;
			if (signedOp.replayAttackHeader.nonce != expectedNonce) {
				revert InvalidNonce(signedOp.signerAccount.addr, expectedNonce, signedOp.replayAttackHeader.nonce);
			}
			nonces[signedOp.signerAccount.addr]++;
			emit NonceIncremented(signedOp.signerAccount.addr, nonces[signedOp.signerAccount.addr]);
		}
	}

	/**
	 * @dev Execute an operation with proper routing and error handling.
	 *
	 * @param signedOp Signed operation containing routing information
	 * @param callData Prepared calldata (may include injected results)
	 * @return success True if operation succeeded
	 * @return result  Return data from the operation
	 */
	function _executeOperationSafe(SignedOperation calldata signedOp, bytes memory callData) private returns (bool success, bytes memory result) {
		bytes[] memory callDatas = new bytes[](1);
		callDatas[0] = callData;

		if (signedOp.signerAccount.accountHub == address(0)) {
			// Route to PartyB
			(success, result) = signedOp.signer.call(abi.encodeWithSelector(ISymmioPartyB._call.selector, callDatas));
		} else {
			// Route to AccountHub
			(success, result) = signedOp.signerAccount.accountHub.call(
				abi.encodeWithSelector(IAccountHub._call.selector, signedOp.signerAccount.addr, callDatas)
			);
		}

		// Decode nested result array
		if (success && result.length > 0) {
			bytes[] memory arr = abi.decode(result, (bytes[]));
			result = arr[0];
		}
	}

	/**
	 * @dev Inject results from previous operations into calldata.
	 *
	 * This function enables complex operation chaining by automatically
	 * inserting return values from earlier operations into the calldata
	 * of later operations at specified byte offsets.
	 *
	 * @param callData        Original calldata with placeholder values
	 * @param insertionPoints Array of byte offsets for insertions
	 * @param sourceIndices   Array of result indices to use
	 * @param results         Array of all previous operation results
	 * @return Modified calldata with injected values
	 *
	 * @custom:example
	 * If operation 0 returns 0x0000...0123 (uint256(291))
	 * And operation 1 has insertionPoint=[36] and sourceIndex=[0]
	 * Then bytes 36-67 of operation 1's calldata will be replaced with 0x0000...0123
	 */
	function _insertResults(
		bytes calldata callData,
		uint256[] memory insertionPoints,
		uint256[] memory sourceIndices,
		bytes[] memory results
	) private pure returns (bytes memory) {
		if (insertionPoints.length == 0) return callData;

		// Create mutable copy
		bytes memory modifiedCallData = callData;

		// Insert each result at its designated position
		for (uint256 i = 0; i < insertionPoints.length; i++) {
			if (sourceIndices[i] < results.length) {
				bytes memory res = results[sourceIndices[i]];
				if (res.length == 0) revert MissingSourceResult(); // nothing was written
				if (res.length != 32) revert BadSourceResultLength(res, res.length); // if you expect bytes32

				// Decode result as 32-byte value
				bytes32 value = abi.decode(results[sourceIndices[i]], (bytes32));

				uint256 offset = insertionPoints[i];
				if (offset + 36 >= modifiedCallData.length) revert InsertionPointOutOfBounds(offset + 32, modifiedCallData.length);

				// Insert at calldata offset + 4 (selector) + 32 (length)
				assembly {
					mstore(add(modifiedCallData, add(36, offset)), value)
				}
			} else {
				revert InvalidSourceIndex(sourceIndices[i]);
			}
		}

		return modifiedCallData;
	}

	/* ══════════════════════════ VIEW FUNCTIONS ══════════════════════════ */

	/**
	 * @notice Check if an address is a registered PartyB contract.
	 * @param addr Address to check
	 * @return True if registered, false otherwise
	 */
	function isPartyBRegistered(address addr) public view returns (bool) {
		return registeredPartyBs[addr];
	}

	/**
	 * @notice Check if an address is a registered AccountHub contract.
	 * @param addr Address to check
	 * @return True if registered, false otherwise
	 */
	function isAccountHubRegistered(address addr) public view returns (bool) {
		return registeredAccountHubs[addr];
	}

	/**
	 * @notice Check if a delegation is currently active.
	 * @param delegator Account that granted delegation
	 * @param delegate  Address that received delegation
	 * @param selector  Function selector to check
	 * @return True if delegation is active, false otherwise
	 */
	function isDelegationActive(Account calldata delegator, address delegate, bytes4 selector) public view returns (bool) {
		uint256 expiry = delegations[delegator.addr][delegate][selector];
		uint256 eta = pendingRevocationEta[delegator.addr][delegate][selector];
		return expiry > block.timestamp && (eta == 0 || eta > block.timestamp);
	}

	/**
	 * @notice Get all currently active delegations for a delegator.
	 * @param _delegator Account to check delegations for
	 * @param delegates Array of potential delegates to check
	 * @param selectors  Array of selector arrays to check for each delegate
	 * @return activeDelegates Array of active delegation information
	 */
	function getActiveDelegations(
		Account calldata _delegator,
		address[] calldata delegates,
		bytes4[][] calldata selectors
	) external view returns (DelegationInfo[] memory activeDelegates) {
		if (delegates.length != selectors.length) revert ArrayLengthMismatch();
		uint256 activeCount = 0;

		// Count active delegations
		for (uint256 i = 0; i < delegates.length; i++) {
			bytes4[] calldata sels = selectors[i];
			bool anyActive = false;
			for (uint256 j = 0; j < sels.length; j++) {
				if (isDelegationActive(_delegator, delegates[i], sels[j])) {
					anyActive = true;
					break;
				}
			}
			if (anyActive) activeCount++;
		}

		// Build result array
		activeDelegates = new DelegationInfo[](activeCount);
		uint256 k = 0;

		for (uint256 i = 0; i < delegates.length; i++) {
			bytes4[] calldata sels = selectors[i];

			// Count active selectors for this delegate
			uint256 c = 0;
			for (uint256 j = 0; j < sels.length; j++) {
				if (isDelegationActive(_delegator, delegates[i], sels[j])) {
					c++;
				}
			}
			if (c == 0) continue;

			// Collect active selectors
			bytes4[] memory activeSels = new bytes4[](c);
			uint256 idx = 0;
			uint256 minExpiry = type(uint256).max;

			for (uint256 j = 0; j < sels.length; j++) {
				bytes4 sel = sels[j];
				if (isDelegationActive(_delegator, delegates[i], sel)) {
					activeSels[idx++] = sel;
					uint256 exp = delegations[_delegator.addr][delegates[i]][sel];
					if (exp < minExpiry) minExpiry = exp; // Track earliest expiry
				}
			}

			activeDelegates[k++] = DelegationInfo({
				account: _delegator,
				delegatedSigner: delegates[i],
				selectors: activeSels,
				expiryTimestamp: minExpiry
			});
		}
	}

	/**
	 * @notice Get the EIP-712 domain separator.
	 * @return Domain separator for signature verification
	 */
	function domainSeparator() external view returns (bytes32) {
		return _domainSeparatorV4();
	}

	/**
	 * @notice Get complete template information.
	 * @param templateId Template ID to query
	 * @return Complete template structure
	 */
	function getTemplate(uint256 templateId) external view returns (Template memory) {
		return templates[templateId];
	}

	/**
	 * @notice Get the next assigned template ID.
	 * @return Current value of the template ID counter
	 */
	function getNextTemplateId() external view returns (uint256) {
		return nextTemplateId;
	}

	/**
	 * @notice Get all operations for a template.
	 * @param templateId Template ID to query
	 * @return Array of operation configurations
	 */
	function getTemplateOperations(uint256 templateId) external view returns (Operation[] memory) {
		return templates[templateId].operations;
	}

	/* ═════════════════════ EIP-712 HASH FUNCTIONS ═════════════════════ */

	/**
	 * @notice Calculate the EIP-712 hash for a signed operation.
	 * @param signedOp           Operation to hash
	 * @return msgDigest EIP-712 compliant hash
	 */
	function getOperationHash(SignedOperation memory signedOp) public view returns (bytes32 msgDigest) {
		msgDigest = _hashTypedDataV4(
			keccak256(
				abi.encode(
					SIGNED_OPERATION_TYPEHASH,
					signedOp.signer,
					keccak256(signedOp.callData),
					_hashAccount(signedOp.signerAccount),
					_hashReplay(signedOp.replayAttackHeader)
				)
			)
		);
	}

	/**
	 * @notice Calculate the EIP-712 hash for a signed delegation.
	 * @param signedDelegation       Delegation to hash
	 * @return msgDigest EIP-712 compliant hash
	 */
	function getDelegationHash(SignedDelegation memory signedDelegation) public view returns (bytes32 msgDigest) {
		msgDigest = _hashTypedDataV4(
			keccak256(
				abi.encode(
					SIGNED_DELEGATION_TYPEHASH,
					_hashDelegationInfo(signedDelegation.delegationInfo),
					_hashReplay(signedDelegation.replayAttackHeader)
				)
			)
		);
	}

	/**
	 * @dev Hash a bytes4 array according to EIP-712 array encoding rules.
	 * Each bytes4 is right-padded to 32 bytes, then all are concatenated and hashed.
	 */
	function _hashBytes4Array(bytes4[] memory arr) internal pure returns (bytes32) {
		if (arr.length == 0) return keccak256("");
		bytes32[] memory words = new bytes32[](arr.length);
		for (uint256 i = 0; i < arr.length; i++) {
			words[i] = bytes32(arr[i]); // Right-pad to 32 bytes
		}
		return keccak256(abi.encodePacked(words)); // Concatenate 32-byte encodings and hash once.
	}

	/**
	 * @dev Hash a DelegationInfo struct according to EIP-712.
	 */
	function _hashDelegationInfo(DelegationInfo memory d) internal pure returns (bytes32) {
		return
			keccak256(
				abi.encode(DELEGATION_INFO_TYPEHASH, _hashAccount(d.account), d.delegatedSigner, _hashBytes4Array(d.selectors), d.expiryTimestamp)
			);
	}

	/**
	 * @dev Hash an Account struct according to EIP-712.
	 */
	function _hashAccount(Account memory a) internal pure returns (bytes32) {
		return keccak256(abi.encode(ACCOUNT_TYPEHASH, a.accountHub, a.addr));
	}

	/**
	 * @dev Hash a ReplayAttackHeader struct according to EIP-712.
	 */
	function _hashReplay(ReplayAttackHeader memory r) internal pure returns (bytes32) {
		return keccak256(abi.encode(REPLAY_HEADER_TYPEHASH, r.nonce, r.deadline, r.salt));
	}

	function _getAccountOwner(address controller, address account) private view returns (address) {
		if (registeredAccountHubs[controller]) {
			return IAccountHub(controller).ownerOf(account);
		}

		revert UnregisteredAccountHub(controller);
	}

	function _isAccountOwner(Account memory account) internal view returns (bool) {
		return _getAccountOwner(account.accountHub, account.addr) == msg.sender;
	}

	/* ═══════════════════════════ MODIFIERS ═══════════════════════════ */

	/**
	 * @notice Restrict function access to the owner of a specific account.
	 * @dev    Verifies caller owns the account through the AccountHub contract.
	 * @param account Account information including AccountHub and address
	 */
	modifier onlyOwner(Account memory account) {
		if (!_isAccountOwner(account)) revert NotOwnerOfAccount(msg.sender, account.accountHub, account.addr);
		_;
	}
}
