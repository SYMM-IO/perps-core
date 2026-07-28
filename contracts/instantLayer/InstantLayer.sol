// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @title  InstantLayer
/// @author Symmetry Labs
/// @notice Advanced operation orchestration layer for the Symmio protocol enabling batched,
///         templated, and delegated operations with comprehensive signature verification.
///
/// @dev    This contract serves as an intermediary layer between users and the Symmio protocol,
///         providing sophisticated operation management capabilities:
///
///         ┌─────────────────────────────────────────────────────────────┐
///         │                     CORE FEATURES                           │
///         ├─────────────────────────────────────────────────────────────┤
///         │ • Delegation System: Users can authorize delegates to       │
///         │   execute specific operations on their behalf               │
///         │ • Template Operations: Pre-defined operation sequences      │
///         │   with automatic result chaining between steps              │
///         │ • Flexible Nonce Management: Choose between salt-only       │
///         │   (nonce=0) or ordered execution (nonce>0)                  │
///         │ • Multi-Account Support: Works with both PartyB and         │
///         │   AccountLayer contracts                                      │
///         │ • EIP-712 Signatures: Type-safe signature verification      │
///         │ • Batch Processing: Execute multiple operations atomically  │
///         └─────────────────────────────────────────────────────────────┘
///
///         SECURITY CONSIDERATIONS:
///         - All contracts must be registered before interaction
///         - Comprehensive replay protection via salt and optional nonce
///         - Deadline enforcement for time-sensitive operations
///         - Role-based access control for administrative functions
///         - Reentrancy protection on all execution functions

import { AccessControlEnumerable } from "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { VirtualAccountDetail } from "../accountLayer/storages/AccountStorage.sol";
import { IViewFacet } from "../accountLayer/facets/View/IViewFacet.sol";
import { ICoreFacet } from "../accountLayer/facets/Core/ICoreFacet.sol";
import { IAccountLayerDiamond } from "../accountLayer/interfaces/IAccountLayerDiamond.sol";

/* ════════════════════════════ EXTERNAL INTERFACES ════════════════════════════ */

/// @notice Interface for SymmioPartyB contract that handles PartyB operations.
/// @dev    PartyB contracts execute trading operations on behalf of market makers.
interface ISymmioPartyB {
	/// @notice Execute multiple operations as PartyB
	/// @param _callDatas Array of encoded function calls to execute
	function _call(bytes[] calldata _callDatas) external;
}

/// @notice Interface for the core Symmio contract.
/// @dev    Used to toggle instant layer mode for optimized execution.
interface ISymmio {
	/// @notice Enable or disable instant layer mode
	/// @param _callFromInstantLayer True to enable instant layer mode
	function setCallFromInstantLayer(bool _callFromInstantLayer) external;

	/// @notice Enable or disable instant open mode (skips pending balance tracking)
	/// @param _instantOpenMode True to skip pending balances in send+lock+open flows
	function setInstantOpenMode(bool _instantOpenMode) external;

	/// @notice Begin transient InstantLayer execution.
	function beginInstantLayerExecution(bool _instantOpenMode) external;

	/// @notice End transient InstantLayer execution before returning.
	function endInstantLayerExecution() external;
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
	bytes32 public constant ACCOUNT_TYPEHASH = keccak256("Account(address addr,bool isPartyB)");

	/// @notice EIP-712 type hash for ReplayAttackHeader struct
	bytes32 public constant REPLAY_HEADER_TYPEHASH = keccak256("ReplayAttackHeader(uint256 nonce,uint256 deadline,bytes32 salt)");

	/// @notice EIP-712 type hash for FlexField struct
	bytes32 public constant FLEX_FIELD_TYPEHASH = keccak256("FlexField(uint256 offset,uint256 length,address authorizedFlexFiller)");

	/// @notice EIP-712 type hash for FlexFillAuth (flex filler signing fill values)
	bytes32 public constant FLEX_FILL_AUTH_TYPEHASH = keccak256("FlexFillAuth(bytes32 opHash,uint256 fieldIndex,bytes value)");

	/// @notice EIP-712 type hash for SignedOperation struct (includes nested type definitions)
	bytes32 internal constant SIGNED_OPERATION_TYPEHASH = keccak256(
		abi.encodePacked(
			"SignedOperation(",
			"address signer,",
			"address target,",
			"bytes callData,",
			"Account signerAccount,",
			"FlexField[] flexFields,",
			"uint256 maxUses,",
			"ReplayAttackHeader replayAttackHeader",
			")",
			"Account(address addr,bool isPartyB)",
			"FlexField(uint256 offset,uint256 length,address authorizedFlexFiller)",
			"ReplayAttackHeader(uint256 nonce,uint256 deadline,bytes32 salt)"
		)
	);

	/// @notice EIP-712 type hash for DelegationInfo struct
	bytes32 public constant DELEGATION_INFO_TYPEHASH = keccak256(
		"DelegationInfo(Account account,address delegatedSigner,bytes4[] selectors,uint256 expiryTimestamp)"
		"Account(address addr,bool isPartyB)"
	);

	/// @notice EIP-712 type hash for SignedDelegation struct
	bytes32 public constant SIGNED_DELEGATION_TYPEHASH = keccak256(
		"SignedDelegation(DelegationInfo delegationInfo,ReplayAttackHeader replayAttackHeader)"
		"Account(address addr,bool isPartyB)"
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

	/// @notice Registry of whitelisted call targets
	mapping(address => bool) public whitelistedTargets;

	/// @notice Configured AccountLayer contract
	address public accountLayer;

	/// @notice Tracking of operation usage counts for replay protection
	/// @dev    Must be < maxUses to execute (or unlimited if maxUses=0).
	mapping(bytes32 => uint256) public operationUsageCount;

	/// @notice Templates that skip pending balance tracking (send+lock+open flows)
	mapping(uint256 => bool) public templateInstantOpenMode;

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

	/// @notice Whether execution uses EIP-1153 contexts instead of persistent mode/signer slots.
	/// @dev Defaults to true for Cancun-compatible deployments. It can be disabled without
	///      changing any signed-operation or template format.
	bool public transientContextEnabled;

	/* ═══════════════════════════════ STRUCTS ═══════════════════════════════ */

	/// @notice Represents an account context for operations.
	/// @dev    isPartyB decides between AccountLayer and PartyB.
	/// @param addr         The actual account address (PartyA account or PartyB address)
	/// @param isPartyB     Whether this operation targets a PartyB or not
	struct Account {
		address addr;
		bool isPartyB;
	}

	/// @notice Header containing anti-replay protection parameters.
	/// @dev    Provides flexible replay protection through salt and optional nonce.
	/// @param nonce    Sequential counter (0 = disabled/salt-only, >0 = enforced ordering)
	/// @param deadline UNIX timestamp after which the operation expires
	/// @param salt     Unique 32-byte value for operation uniqueness (always required)
	struct ReplayAttackHeader {
		uint256 nonce;
		uint256 deadline;
		bytes32 salt;
	}

	/// @notice Defines a modifiable region within operation calldata.
	/// @dev    Each flex field allows an authorized flex filler to replace bytes at a specific offset.
	/// @param offset   Byte offset in calldata (after 4-byte selector) where replacement starts
	/// @param length   Number of bytes to replace (typically 32)
	/// @param authorizedFlexFiller Address authorized to provide the replacement value for this field
	struct FlexField {
		uint256 offset;
		uint256 length;
		address authorizedFlexFiller;
	}

	/// @notice Represents a signed operation ready for execution.
	/// @dev    This structure is signed via EIP-712 for secure off-chain authorization.
	/// @param signer             Address that signed this operation (may be delegated)
	/// @param target             Contract to execute the call against
	/// @param callData           Encoded function call to execute
	/// @param signerAccount      Account context for the operation
	/// @param flexFields         Modifiable regions in calldata (empty for standard operations)
	/// @param maxUses            Maximum execution count (1=single-use, 0=unlimited)
	/// @param replayAttackHeader Anti-replay protection parameters
	struct SignedOperation {
		address signer;
		address target;
		bytes callData;
		Account signerAccount;
		FlexField[] flexFields;
		uint256 maxUses;
		ReplayAttackHeader replayAttackHeader;
	}

	/// @notice Container for delegation authorization with signature.
	/// @param delegationInfo     Delegation parameters and permissions
	/// @param replayAttackHeader Anti-replay protection for the delegation
	struct SignedDelegation {
		DelegationInfo delegationInfo;
		ReplayAttackHeader replayAttackHeader;
	}

	/// @notice Defines delegation permissions from one address to another.
	/// @param account           The account granting delegation
	/// @param delegatedSigner   Address authorized to act on behalf of the account
	/// @param selectors         Function selectors the delegate can execute
	/// @param expiryTimestamp   UNIX timestamp when delegation expires
	struct DelegationInfo {
		Account account;
		address delegatedSigner;
		bytes4[] selectors;
		uint256 expiryTimestamp;
	}

	/// @notice Configuration for result injection between operations.
	/// @dev    Enables chaining operation results within templates.
	///         IMPORTANT: Only 32-byte return values are supported (uint256, address, bytes32, bool, etc.).
	///         For functions returning tuples like (uint256, uint256), use sourceOffsets to specify
	///         which 32-byte slot to extract (e.g., offset 0 for first value, 32 for second).
	/// @param insertionPoints Array of byte offsets where results should be inserted in calldata
	/// @param sourceIndices   Array of operation indices whose results to inject
	/// @param sourceOffsets   Array of byte offsets within each source result to extract the 32-byte value
	struct Operation {
		uint256[] insertionPoints;
		uint256[] sourceIndices;
		uint256[] sourceOffsets;
	}

	/// @notice Template definition for complex multi-operation sequences.
	/// @param name       Human-readable identifier for the template
	/// @param operations Array of operations with their injection configurations
	/// @param active     Whether this template can currently be executed
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

	/// @notice Emitted when the configured AccountLayer is updated
	/// @param oldAccountLayer old AccountLayer
	/// @param newAccountLayer new AccountLayer
	event AccountLayerUpdated(address indexed oldAccountLayer, address indexed newAccountLayer);

	/// @notice Emitted when target whitelist status changes
	/// @param target Target contract address
	/// @param allowed Whether the target is whitelisted
	event TargetWhitelistUpdated(address indexed target, bool allowed);

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

	/// @notice Emitted when transient execution is enabled or disabled.
	event TransientContextEnabledUpdated(bool enabled);

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

	/// @notice AccountLayer address is invalid
	/// @param accountLayer Provided AccountLayer address
	error UnregisteredAccountLayer(address accountLayer);

	/// @notice AccountLayer contract address has not been configured
	error AccountLayerNotSet();

	/// @notice PartyB contract is not registered
	/// @param partyB The unregistered PartyB address
	error UnregisteredPartyB(address partyB);

	/// @notice Target contract is not whitelisted
	/// @param target The target address
	error TargetNotWhitelisted(address target);

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
	/// @param account The actual account address
	error NotOwnerOfAccount(address sender, address account);

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

	/// @notice Source result is empty when a non-empty result was expected
	error MissingSourceResult();

	/// @notice Source result length is shorter than required for extraction
	error BadSourceResultLength(bytes res, uint256 length);

	/// @notice PartyB contract is already registered
	error PartyBAlreadyRegistered(address partyB);

	/// @notice Provided array must not be empty
	error EmptyArray();

	/// @notice PartyB contract is not in the registry
	error PartyBNotRegistered(address partyB);

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

	/* ════════════════════════════ CONSTRUCTOR ════════════════════════════ */

	/// @notice Deploy InstantLayer with Symmio integration.
	/// @dev    Sets up EIP-712 domain and grants initial admin roles.
	/// @param _symmio Address of the core Symmio protocol contract
	/// @param _admin  Address to receive DEFAULT_ADMIN_ROLE, SETTER_ROLE, and OPERATOR_ROLE
	constructor(address _symmio, address _admin) EIP712("SymmioInstantLayer", "1") {
		symmio = ISymmio(_symmio);
		transientContextEnabled = true;
		emit TransientContextEnabledUpdated(true);

		// Grant initial roles to the admin (REVOKER_ROLE must be granted separately)
		_grantRole(DEFAULT_ADMIN_ROLE, _admin);
		_grantRole(SETTER_ROLE, _admin);
		_grantRole(OPERATOR_ROLE, _admin);

		revocationCooldown = 10 minutes;
		emit RevocationCooldownUpdated(0, revocationCooldown);

		whitelistedTargets[_symmio] = true;
		emit TargetWhitelistUpdated(_symmio, true);
	}

	/* ═════════════════════ DELEGATION MANAGEMENT ═════════════════════ */

	/// @notice Grant batch delegation permissions using a signature.
	/// @dev    Allows account owners to delegate multiple function selectors to another address
	///         via an off-chain signature. This enables gasless delegation setup.
	/// @param signedDelegation Delegation details including permissions and anti-replay parameters
	/// @param signature        EIP-712 signature from the account owner
	function grantBatchDelegationBySig(SignedDelegation calldata signedDelegation, bytes calldata signature) external {
		DelegationInfo calldata info = signedDelegation.delegationInfo;
		ReplayAttackHeader calldata rh = signedDelegation.replayAttackHeader;

		if (info.account.isPartyB) revert InvalidDelegation();

		address delegator = _canonicalDelegator(info.account.addr);
		address owner = _getAccountOwner(delegator);
		address delegate = info.delegatedSigner;
		uint256 expiry = info.expiryTimestamp;
		bytes4[] calldata selectors = info.selectors;

		// Validate delegation parameters
		if (delegate == owner) revert SelfDelegation();
		if (expiry <= block.timestamp) revert DelegationExpired(expiry);
		if (rh.deadline != 0 && block.timestamp > rh.deadline) revert DeadlineExpired(rh.deadline);
		if (info.selectors.length == 0) revert InvalidDelegation();

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

		for (uint256 i = 0; i < selectors.length;) {
			bytes4 selector = selectors[i];
			slot[selector] = expiry;
			delete pendingRevocationEta[delegator][delegate][selector];
			emit DelegationGranted(delegator, delegate, selector, expiry);

			unchecked {
				++i;
			}
		}
	}

	/// @notice Grant delegation permissions directly (no signature required).
	/// @dev    Account owners can directly grant delegation without signatures.
	/// @param info Delegation information including delegate address and permissions
	function grantDelegation(DelegationInfo calldata info) external onlyOwner(info.account) {
		if (info.account.isPartyB) revert InvalidDelegation();
		if (info.delegatedSigner == msg.sender) revert SelfDelegation();
		if (info.expiryTimestamp <= block.timestamp) revert DelegationExpired(info.expiryTimestamp);

		address delegator = _canonicalDelegator(info.account.addr);
		address delegate = info.delegatedSigner;

		// Grant each selector permission
		for (uint256 j = 0; j < info.selectors.length; j++) {
			delegations[delegator][delegate][info.selectors[j]] = info.expiryTimestamp;
			delete pendingRevocationEta[delegator][delegate][info.selectors[j]];
			emit DelegationGranted(delegator, delegate, info.selectors[j], info.expiryTimestamp);
		}
	}

	/* ═════════════════ REGISTRATION MANAGEMENT ═════════════════ */

	/// @notice Register multiple PartyB contracts.
	/// @dev    PartyB contracts must be registered before they can execute operations.
	///         Registration also grants OPERATOR_ROLE to the PartyB.
	function registerPartyBs(address[] calldata partyBs) external onlyRole(SETTER_ROLE) {
		if (partyBs.length == 0) revert EmptyArray();
		for (uint256 i = 0; i < partyBs.length; i++) {
			if (registeredPartyBs[partyBs[i]]) revert PartyBAlreadyRegistered(partyBs[i]);
			registeredPartyBs[partyBs[i]] = true;
			_grantRole(OPERATOR_ROLE, partyBs[i]);
			emit PartyBRegistered(partyBs[i]);
		}
	}

	/// @notice Remove a PartyB contract from the registry.
	/// @dev    Also revokes OPERATOR_ROLE from the PartyB.
	/// @param partyB Address of the PartyB contract to unregister
	///
	/// Requirements:
	/// - Caller must have SETTER_ROLE
	function unregisterPartyB(address partyB) external onlyRole(SETTER_ROLE) {
		if (!registeredPartyBs[partyB]) revert PartyBNotRegistered(partyB);
		registeredPartyBs[partyB] = false;
		_revokeRole(OPERATOR_ROLE, partyB);
		emit PartyBUnregistered(partyB);
	}

	/// @notice Set the AccountLayer contract address.
	/// @param _accountLayer Address of the AccountLayer contract.
	function setAccountLayer(address _accountLayer) external onlyRole(SETTER_ROLE) {
		if (_accountLayer == address(0)) revert UnregisteredAccountLayer(_accountLayer);
		emit AccountLayerUpdated(accountLayer, _accountLayer);
		whitelistedTargets[accountLayer] = false;
		accountLayer = _accountLayer;
		whitelistedTargets[_accountLayer] = true;
		emit TargetWhitelistUpdated(_accountLayer, true);
	}

	/// @notice Whitelist or remove whitelist for a target contract.
	/// @param target  Target contract address.
	/// @param allowed True to whitelist, false to remove.
	function setTargetWhitelist(address target, bool allowed) external onlyRole(SETTER_ROLE) {
		if (target == address(0)) revert InvalidCallData();
		whitelistedTargets[target] = allowed;
		emit TargetWhitelistUpdated(target, allowed);
	}

	/// @notice Enables the Cancun transient execution path.
	/// @dev Disabling restores the exact legacy setter sequence. If this InstantLayer address
	///      has legacy adapters enabled on core and AccountLayer, disable those adapters as well
	///      to return all the way to persistent storage.
	///      This switch does not alter signed data or templates.
	function setTransientContextEnabled(bool enabled) external onlyRole(SETTER_ROLE) {
		transientContextEnabled = enabled;
		emit TransientContextEnabledUpdated(enabled);
	}

	/* ══════════════════════ TEMPLATE MANAGEMENT ══════════════════════ */

	/// @notice Create a new operation template.
	/// @dev    Templates define sequences of operations with automatic result chaining.
	///         Each operation can reference results from previous operations.
	/// @param name       Human-readable name for the template
	/// @param operations Array of operation configurations with injection points
	///
	/// @custom:example
	/// For a swap-and-stake template:
	/// - Operation 0: Swap tokens (returns amount out)
	/// - Operation 1: Stake tokens (uses amount from operation 0)
	/// Operation 1 would have insertionPoint=[36], sourceIndex=[0], and sourceOffset=[0]
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

	/// @notice Mark a template as using instant-open mode (skips pending balance tracking).
	/// @param templateId ID of the template to configure
	/// @param mode       True to enable instant-open mode for this template
	function setTemplateInstantOpenMode(uint256 templateId, bool mode) external onlyRole(SETTER_ROLE) {
		if (templateId >= nextTemplateId) revert InvalidTemplate(templateId);
		templateInstantOpenMode[templateId] = mode;
	}

	/// @notice Enable or disable a template.
	/// @dev    Disabled templates cannot be executed.
	/// @param templateId ID of the template to update
	/// @param active     Whether the template should be active
	function setTemplateActive(uint256 templateId, bool active) external onlyRole(SETTER_ROLE) {
		if (templateId >= nextTemplateId) revert InvalidTemplate(templateId);
		templates[templateId].active = active;
		emit TemplateUpdated(templateId, active);
	}

	/* ═════════════════════ REVOKE DELEGATION FUNCTIONS ═════════════════════ */

	/// @notice Update the global cooldown for delegation revocations.
	/// @dev    Only SETTER_ROLE. Add guardrails to prevent absurd values.
	///         Example policy: 5 minutes ≤ cooldown ≤ 30 days.
	function setRevocationCooldown(uint256 newCooldown) external onlyRole(SETTER_ROLE) {
		// Adjust bounds to taste; 0 disallowed to keep the two-step invariant.
		if (newCooldown < 5 minutes || newCooldown > 30 days) revert InvalidCallData();
		uint256 old = revocationCooldown;
		revocationCooldown = newCooldown;
		emit RevocationCooldownUpdated(old, newCooldown);
	}

	/// @notice Schedule revocation of specific selectors; takes effect after cooldown.
	/// @dev    Who may schedule: account owner (delegator), the delegate themselves, or REVOKER_ROLE.
	///         No-ops for selectors not currently active.
	function initiateRevokeDelegation(Account calldata account, address delegate, bytes4[] calldata selectors) external {
		address delegator = _canonicalDelegator(account.addr);
		bool callerIsOwner = _getAccountOwner(delegator) == msg.sender;
		bool callerIsDelegate = (msg.sender == delegate);
		bool callerIsAdmin = hasRole(REVOKER_ROLE, msg.sender);
		if (!(callerIsOwner || callerIsDelegate || callerIsAdmin)) {
			revert NotOwnerOfAccount(msg.sender, account.addr);
		}

		for (uint256 i = 0; i < selectors.length; ++i) {
			bytes4 sel = selectors[i];

			// only schedule if currently active
			uint256 currentExpiry = delegations[delegator][delegate][sel];
			if (currentExpiry <= block.timestamp) continue;

			uint256 eta = block.timestamp + revocationCooldown;
			pendingRevocationEta[delegator][delegate][sel] = eta;
			emit RevocationScheduled(delegator, delegate, sel, eta);
		}
	}

	/// @notice Finalize after cooldown; actually deletes the delegation.
	/// @dev    Anyone may call once ETA has passed.
	function finalizeRevokeDelegation(Account calldata account, address delegate, bytes4[] calldata selectors) external {
		address delegator = _canonicalDelegator(account.addr);
		for (uint256 i = 0; i < selectors.length; ++i) {
			bytes4 sel = selectors[i];
			uint256 eta = pendingRevocationEta[delegator][delegate][sel];
			if (eta == 0) continue; // not scheduled
			if (block.timestamp < eta) revert RevocationCooldownNotOver(eta); // still cooling

			// delete pending & active delegation
			delete pendingRevocationEta[delegator][delegate][sel];
			delete delegations[delegator][delegate][sel];

			emit DelegationSelectorRevoked(delegator, delegate, sel);
		}
	}

	/* ═════════════════════ OPERATION EXECUTION ═════════════════════ */

	/// @notice Execute a sequence of operations using a predefined template.
	/// @dev    Operations are executed in order with automatic result injection.
	///         All operations must succeed for the transaction to complete.
	///
	/// @param templateId ID of the template defining the operation sequence
	/// @param signedOps  Array of signed operations matching template requirements
	/// @param signatures Array of signatures corresponding to each operation
	///
	/// Operation Flow:
	/// 1. Validate template exists and is active
	/// 2. Enable instant layer mode in Symmio
	/// 3. For each operation:
	///    - Verify signature and anti-replay parameters
	///    - Inject results from previous operations as configured
	///    - Execute the operation
	///    - Store result for potential use in later operations
	/// 4. Disable instant layer mode
	function executeTemplate(
		uint256 templateId,
		SignedOperation[] calldata signedOps,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexFillerSignatures
	) external nonReentrant onlyRole(OPERATOR_ROLE) returns (bytes[] memory results) {
		if (templateId >= nextTemplateId) revert InvalidTemplate(templateId);
		if (signedOps.length != signatures.length) revert ArrayLengthMismatch();
		if (signedOps.length != fills.length) revert ArrayLengthMismatch();
		if (signedOps.length != flexFillerSignatures.length) revert ArrayLengthMismatch();

		Template storage template = templates[templateId];
		if (!template.active) revert TemplateNotActive(templateId);
		if (signedOps.length != template.operations.length) revert TemplateOperationLengthMismatch();

		// One core authority scope wraps the entire template. Cancun deployments use
		// transient storage; disabling the feature replays the historical persistent
		// setter sequence without changing templates or signed operations.
		bool useInstantOpen = templateInstantOpenMode[templateId];
		bool usesTransientContext = transientContextEnabled;
		if (usesTransientContext) {
			symmio.beginInstantLayerExecution(useInstantOpen);
		} else {
			symmio.setCallFromInstantLayer(true);
			if (useInstantOpen) {
				symmio.setInstantOpenMode(true);
			}
		}

		results = new bytes[](signedOps.length);

		bool success = true;
		for (uint256 i = 0; i < signedOps.length && success; i++) {
			Operation memory op = template.operations[i];
			SignedOperation calldata signedOp = signedOps[i];

			// Verify operation signature and parameters
			bytes32 opHash = _verifyOperation(signedOp, signatures[i]);

			// Apply flex field fills first, then inject template results
			bytes memory finalCallData = _applyFlexFills(signedOp, fills[i], flexFillerSignatures[i], opHash);
			finalCallData = _insertResults(finalCallData, op.insertionPoints, op.sourceIndices, op.sourceOffsets, results);

			// Execute the operation and capture result
			(success, results[i]) = _executeOperationSafe(signedOp, finalCallData, usesTransientContext);

			if (!success) {
				revert OperationFailed(i, results[i]);
			}
		}

		// Close the same mechanism that opened the scope, so a later call in an outer
		// multicast cannot inherit this batch's authority.
		if (usesTransientContext) {
			symmio.endInstantLayerExecution();
		} else {
			if (useInstantOpen) {
				symmio.setInstantOpenMode(false);
			}
			symmio.setCallFromInstantLayer(false);
		}
	}

	/// @notice Execute a batch of independent operations.
	/// @dev    Operations are executed sequentially without result chaining.
	///         All operations must succeed for the transaction to complete.
	///
	/// @param signedOps  Array of signed operations to execute
	/// @param signatures Array of signatures for the operations
	///
	/// @custom:security Operations are independent - no data flows between them
	function executeBatch(
		SignedOperation[] calldata signedOps,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexFillerSignatures
	) external nonReentrant onlyRole(OPERATOR_ROLE) returns (bytes[] memory results) {
		if (signedOps.length == 0) revert EmptyBatch();
		if (signedOps.length != signatures.length) revert ArrayLengthMismatch();
		if (signedOps.length != fills.length) revert ArrayLengthMismatch();
		if (signedOps.length != flexFillerSignatures.length) revert ArrayLengthMismatch();

		// Independent batches still need one shared routing-authority scope, but never
		// enable the atomic-open accounting mode reserved for configured templates.
		bool usesTransientContext = transientContextEnabled;
		if (usesTransientContext) {
			symmio.beginInstantLayerExecution(false);
		} else {
			symmio.setCallFromInstantLayer(true);
		}

		results = new bytes[](signedOps.length);

		bool success = true;
		for (uint256 i = 0; i < signedOps.length && success; i++) {
			// Verify each operation independently
			bytes32 opHash = _verifyOperation(signedOps[i], signatures[i]);

			// Apply flex field fills
			bytes memory callData = _applyFlexFills(signedOps[i], fills[i], flexFillerSignatures[i], opHash);

			// Execute with (potentially modified) calldata
			(success, results[i]) = _executeOperationSafe(signedOps[i], callData, usesTransientContext);

			if (!success) {
				revert OperationFailed(i, results[i]);
			}
		}

		if (usesTransientContext) {
			symmio.endInstantLayerExecution();
		} else {
			symmio.setCallFromInstantLayer(false);
		}
	}

	/* ═════════════════════════ INTERNAL HELPERS ═════════════════════════ */

	/// @dev Comprehensive verification of operation signatures and parameters.
	///
	/// Verification Steps:
	/// 1. Check deadline hasn't expired
	/// 2. Validate calldata minimum length
	/// 3. Verify target is whitelisted
	/// 4. Verify account authorization (PartyB registration or PartyA ownership/delegation)
	/// 5. Verify EIP-712 signature
	/// 6. Prevent replay attacks
	/// 7. Update nonce if required
	///
	/// @param signedOp   Operation to verify
	/// @param sigCallData Signature data for verification
	function _verifyOperation(SignedOperation calldata signedOp, bytes calldata sigCallData) private returns (bytes32) {
		// Check expiry
		if (signedOp.replayAttackHeader.deadline != 0 && signedOp.replayAttackHeader.deadline < block.timestamp)
			revert DeadlineExpired(signedOp.replayAttackHeader.deadline);

		// Validate calldata has at least selector
		if (signedOp.callData.length < 4) revert CallDataLengthMismatch();

		if (!whitelistedTargets[signedOp.target]) revert TargetNotWhitelisted(signedOp.target);

		bytes32 hash = getOperationHash(signedOp);
		address signer = signedOp.signer;

		// Validate registration and delegation
		if (signedOp.signerAccount.isPartyB) {
			// PartyB operation
			if (signer != signedOp.signerAccount.addr) revert MismatchSignerAndAccount(signer, signedOp.signerAccount.addr);
			if (!isPartyBRegistered(signer)) revert UnregisteredPartyB(signer);
		} else {
			// PartyA operation through AccountLayer
			address accountOwner = _getAccountOwner(signedOp.signerAccount.addr);

			// Check delegation if signer is not the owner
			if (accountOwner != signer) {
				bytes calldata callData = signedOp.callData;
				bytes4 selector;
				assembly ("memory-safe") {
					selector := calldataload(callData.offset) // Extract first 4 bytes
				}
				address delegator = _canonicalDelegator(signedOp.signerAccount.addr);
				if (!isDelegationActive(delegator, signedOp.signer, selector)) {
					revert InvalidDelegation();
				}
			}
		}

		// Verify signature - skip if signer is the executor (msg.sender proves identity)
		// Authorization was already verified above (PartyB registration or PartyA owner/delegation)
		if (signer != msg.sender) {
			if (!SignatureChecker.isValidSignatureNow(signer, hash, sigCallData)) {
				revert InvalidSignature();
			}
		}

		// Replay protection: unified for all operations via maxUses
		uint256 currentUsage = operationUsageCount[hash];
		if (signedOp.maxUses > 0 && currentUsage >= signedOp.maxUses) {
			revert MaxUsesExceeded(hash, signedOp.maxUses);
		}
		operationUsageCount[hash] = currentUsage + 1;

		// Handle nonce if enabled (non-zero)
		if (signedOp.replayAttackHeader.nonce != 0) {
			uint256 expectedNonce = nonces[signedOp.signerAccount.addr] + 1;
			if (signedOp.replayAttackHeader.nonce != expectedNonce) {
				revert InvalidNonce(signedOp.signerAccount.addr, expectedNonce, signedOp.replayAttackHeader.nonce);
			}
			nonces[signedOp.signerAccount.addr]++;
			emit NonceIncremented(signedOp.signerAccount.addr, nonces[signedOp.signerAccount.addr]);
		}

		return hash;
	}

	/// @dev Execute an operation with proper routing and error handling.
	///
	/// @param signedOp Signed operation containing routing information
	/// @param callData Prepared calldata (may include injected results)
	/// @param usesTransientContext Whether this batch began with the transient EIP-1153 context path
	/// @return success True if operation succeeded
	/// @return result  Return data from the operation
	function _executeOperationSafe(
		SignedOperation calldata signedOp,
		bytes memory callData,
		bool usesTransientContext
	) private returns (bool success, bytes memory result) {
		bytes[] memory callDatas = new bytes[](1);
		callDatas[0] = callData;

		bool decodeNestedResult;

		if (signedOp.signerAccount.isPartyB) {
			// Route to PartyB
			(success, result) = signedOp.signer.call(abi.encodeWithSelector(ISymmioPartyB._call.selector, callDatas));
		} else if (signedOp.target == address(symmio) || signedOp.target == accountLayer) {
			// Route to AccountLayer (wrapping Symmio calls via _call, or direct AL calls)
			if (accountLayer == address(0)) revert AccountLayerNotSet();
			address owner = _getAccountOwner(signedOp.signerAccount.addr);
			// The AccountLayer signer is the owner, which by itself authorizes every account that owner
			// holds. When a delegate is driving the operation, hand the AccountLayer the account family
			// the delegation was granted over so it can reject anything outside it. Owners stay unscoped.
			// AccountLayer must use the same signer lifetime as the surrounding core scope. Mixing
			// transient and persistent setters would leave ambiguous authority.
			address scope = signedOp.signer == owner ? address(0) : _canonicalDelegator(signedOp.signerAccount.addr);
			if (usesTransientContext) {
				IAccountLayerDiamond(accountLayer).setTransientSignerScoped(owner, scope);
			} else {
				IAccountLayerDiamond(accountLayer).setSignerScoped(owner, scope);
			}
			if (signedOp.target == address(symmio)) {
				(success, result) = accountLayer.call(abi.encodeWithSelector(ICoreFacet._call.selector, signedOp.signerAccount.addr, callDatas));
				decodeNestedResult = true;
			} else {
				(success, result) = accountLayer.call(callData);
			}
			if (usesTransientContext) {
				IAccountLayerDiamond(accountLayer).setTransientSigner(address(0));
			} else {
				IAccountLayerDiamond(accountLayer).setSigner(address(0));
			}
		} else {
			// Route to a whitelisted target
			(success, result) = signedOp.target.call(callData);
		}

		// Decode nested result array
		if (decodeNestedResult && success && result.length > 0) {
			bytes[] memory arr = abi.decode(result, (bytes[]));
			result = arr[0];
		}
	}

	/// @dev Inject results from previous operations into calldata.
	///
	/// This function enables complex operation chaining by automatically
	/// inserting return values from earlier operations into the calldata
	/// of later operations at specified byte offsets.
	///
	/// @param callData        Original calldata with placeholder values
	/// @param insertionPoints Array of byte offsets for insertions
	/// @param sourceIndices   Array of result indices to use
	/// @param sourceOffsets   Array of byte offsets within each source result to extract from
	/// @param results         Array of all previous operation results
	/// @return Modified calldata with injected values
	///
	/// @custom:example
	/// If operation 0 returns (uint256, uint256) = (100, 200) which is 64 bytes
	/// And operation 1 has insertionPoint=[36], sourceIndex=[0], sourceOffset=[32]
	/// Then bytes 36-67 of operation 1's calldata will be replaced with 200 (the second uint256)
	function _insertResults(
		bytes memory callData,
		uint256[] memory insertionPoints,
		uint256[] memory sourceIndices,
		uint256[] memory sourceOffsets,
		bytes[] memory results
	) private pure returns (bytes memory) {
		if (insertionPoints.length == 0) return callData;

		// Work directly on the memory buffer (already mutable)
		bytes memory modifiedCallData = callData;

		// Insert each result at its designated position
		for (uint256 i = 0; i < insertionPoints.length; i++) {
			if (sourceIndices[i] < results.length) {
				bytes memory res = results[sourceIndices[i]];
				uint256 sourceOffset = sourceOffsets[i];

				if (res.length == 0) revert MissingSourceResult();
				if (res.length < sourceOffset + 32) revert BadSourceResultLength(res, res.length);

				// Extract 32 bytes from the result at the specified offset
				bytes32 value;
				assembly {
					value := mload(add(add(res, 32), sourceOffset))
				}

				uint256 offset = insertionPoints[i];
				if (offset + 36 > modifiedCallData.length) revert InsertionPointOutOfBounds(offset + 32, modifiedCallData.length);

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

	/// @notice Check if an address is a registered PartyB contract.
	/// @param addr Address to check
	/// @return True if registered, false otherwise
	function isPartyBRegistered(address addr) public view returns (bool) {
		return registeredPartyBs[addr];
	}

	/// @notice Check if a delegation is currently active.
	/// @param delegator Address that granted delegation
	/// @param delegate  Address that received delegation
	/// @param selector  Function selector to check
	/// @return True if delegation is active, false otherwise
	function isDelegationActive(address delegator, address delegate, bytes4 selector) public view returns (bool) {
		uint256 expiry = delegations[delegator][delegate][selector];
		uint256 eta = pendingRevocationEta[delegator][delegate][selector];
		return expiry > block.timestamp && (eta == 0 || eta > block.timestamp);
	}

	/// @notice Get all currently active delegations for a delegator.
	/// @param _delegator Account to check delegations for
	/// @param delegates Array of potential delegates to check
	/// @param selectors  Array of selector arrays to check for each delegate
	/// @return activeDelegates Array of active delegation information
	function getActiveDelegations(
		Account calldata _delegator,
		address[] calldata delegates,
		bytes4[][] calldata selectors
	) external view returns (DelegationInfo[] memory activeDelegates) {
		if (delegates.length != selectors.length) revert ArrayLengthMismatch();
		address delegator = _canonicalDelegator(_delegator.addr);
		uint256 activeCount = 0;

		// Count active delegations
		for (uint256 i = 0; i < delegates.length; i++) {
			bytes4[] calldata sels = selectors[i];
			bool anyActive = false;
			for (uint256 j = 0; j < sels.length; j++) {
				if (isDelegationActive(delegator, delegates[i], sels[j])) {
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
				if (isDelegationActive(delegator, delegates[i], sels[j])) {
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
				if (isDelegationActive(delegator, delegates[i], sel)) {
					activeSels[idx++] = sel;
					uint256 exp = delegations[delegator][delegates[i]][sel];
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

	/// @notice Get the EIP-712 domain separator.
	/// @return Domain separator for signature verification
	function domainSeparator() external view returns (bytes32) {
		return _domainSeparatorV4();
	}

	/// @notice Get complete template information.
	/// @param templateId Template ID to query
	/// @return Complete template structure
	function getTemplate(uint256 templateId) external view returns (Template memory) {
		return templates[templateId];
	}

	/// @notice Get the next assigned template ID.
	/// @return Current value of the template ID counter
	function getNextTemplateId() external view returns (uint256) {
		return nextTemplateId;
	}

	/// @notice Get all operations for a template.
	/// @param templateId Template ID to query
	/// @return Array of operation configurations
	function getTemplateOperations(uint256 templateId) external view returns (Operation[] memory) {
		return templates[templateId].operations;
	}

	/// @notice Get templates by ID range.
	/// @dev    Returns templates from startId to startId + limit. Caller can filter active ones off-chain.
	/// @param startId Starting template ID
	/// @param limit   Maximum number of templates to return
	/// @return Array of templates in the specified range
	function getTemplates(uint256 startId, uint256 limit) external view returns (Template[] memory) {
		if (startId >= nextTemplateId) return new Template[](0);

		uint256 end = startId + limit;
		if (end > nextTemplateId) end = nextTemplateId;

		Template[] memory result = new Template[](end - startId);
		for (uint256 i = startId; i < end; i++) {
			result[i - startId] = templates[i];
		}
		return result;
	}

	/* ═════════════════════ EIP-712 HASH FUNCTIONS ═════════════════════ */

	/// @notice Calculate the EIP-712 hash for a signed operation.
	/// @param signedOp           Operation to hash
	/// @return msgDigest EIP-712 compliant hash
	function getOperationHash(SignedOperation memory signedOp) public view returns (bytes32 msgDigest) {
		msgDigest = _hashTypedDataV4(
			keccak256(
				abi.encode(
					SIGNED_OPERATION_TYPEHASH,
					signedOp.signer,
					signedOp.target,
					keccak256(signedOp.callData),
					_hashAccount(signedOp.signerAccount),
					_hashFlexFields(signedOp.flexFields),
					signedOp.maxUses,
					_hashReplay(signedOp.replayAttackHeader)
				)
			)
		);
	}

	/// @notice Calculate the EIP-712 hash for a flex fill authorization.
	/// @param opHash     Hash of the flex operation being filled
	/// @param fieldIndex Index of the flex field being filled
	/// @param value      The fill value bytes
	/// @return msgDigest EIP-712 compliant hash
	function getFlexFillAuthHash(bytes32 opHash, uint256 fieldIndex, bytes memory value) public view returns (bytes32 msgDigest) {
		msgDigest = _hashTypedDataV4(keccak256(abi.encode(FLEX_FILL_AUTH_TYPEHASH, opHash, fieldIndex, keccak256(value))));
	}

	/// @notice Calculate the EIP-712 hash for a signed delegation.
	/// @param signedDelegation       Delegation to hash
	/// @return msgDigest EIP-712 compliant hash
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

	/// @dev Hash a bytes4 array according to EIP-712 array encoding rules.
	/// Each bytes4 is right-padded to 32 bytes, then all are concatenated and hashed.
	function _hashBytes4Array(bytes4[] memory arr) internal pure returns (bytes32) {
		if (arr.length == 0) return keccak256("");
		bytes32[] memory words = new bytes32[](arr.length);
		for (uint256 i = 0; i < arr.length; i++) {
			words[i] = bytes32(arr[i]); // Right-pad to 32 bytes
		}
		return keccak256(abi.encodePacked(words)); // Concatenate 32-byte encodings and hash once.
	}

	/// @dev Hash a DelegationInfo struct according to EIP-712.
	function _hashDelegationInfo(DelegationInfo memory d) internal pure returns (bytes32) {
		return
			keccak256(
				abi.encode(DELEGATION_INFO_TYPEHASH, _hashAccount(d.account), d.delegatedSigner, _hashBytes4Array(d.selectors), d.expiryTimestamp)
			);
	}

	/// @dev Hash an Account struct according to EIP-712.
	function _hashAccount(Account memory a) internal pure returns (bytes32) {
		return keccak256(abi.encode(ACCOUNT_TYPEHASH, a.addr, a.isPartyB));
	}

	/// @dev Hash a ReplayAttackHeader struct according to EIP-712.
	function _hashReplay(ReplayAttackHeader memory r) internal pure returns (bytes32) {
		return keccak256(abi.encode(REPLAY_HEADER_TYPEHASH, r.nonce, r.deadline, r.salt));
	}

	/// @dev Hash a FlexField array according to EIP-712 array encoding rules.
	function _hashFlexFields(FlexField[] memory fields) internal pure returns (bytes32) {
		bytes32[] memory fieldHashes = new bytes32[](fields.length);
		for (uint256 i = 0; i < fields.length; i++) {
			fieldHashes[i] = keccak256(abi.encode(FLEX_FIELD_TYPEHASH, fields[i].offset, fields[i].length, fields[i].authorizedFlexFiller));
		}
		return keccak256(abi.encodePacked(fieldHashes));
	}

	/// @dev Apply flex field fill values to operation calldata.
	/// @param signedOp       The signed operation with flex field definitions
	/// @param fill           Fill values from flex fillers (one per flex field; empty bytes to skip)
	/// @param flexFillerSigs Per-field flex filler signatures (empty if filler == msg.sender)
	/// @param opHash         The operation hash (for flex filler auth verification)
	/// @return callData      Modified calldata with fill values injected
	function _applyFlexFills(
		SignedOperation calldata signedOp,
		bytes[] calldata fill,
		bytes[] calldata flexFillerSigs,
		bytes32 opHash
	) private view returns (bytes memory callData) {
		callData = signedOp.callData; // copy to memory

		if (signedOp.flexFields.length == 0) return callData;

		if (fill.length != signedOp.flexFields.length) {
			revert InvalidFlexFillLength(signedOp.flexFields.length, fill.length);
		}
		if (flexFillerSigs.length != signedOp.flexFields.length) revert ArrayLengthMismatch();

		for (uint256 i = 0; i < signedOp.flexFields.length; i++) {
			FlexField calldata field = signedOp.flexFields[i];
			bytes calldata value = fill[i];

			// Validate field bounds within calldata (always, even for empty fills)
			if (field.offset + field.length + 4 > callData.length) {
				revert FlexFieldOutOfBounds(field.offset, field.length, callData.length);
			}

			// Empty fill value = keep original calldata bytes (filler accepts user's value)
			if (value.length == 0) continue;

			// Validate fill value length matches field length
			if (value.length != field.length) {
				revert InvalidFlexFillValueLength(i, field.length, value.length);
			}

			// Verify flex filler authorization
			if (field.authorizedFlexFiller != msg.sender) {
				bytes32 fillHash = getFlexFillAuthHash(opHash, i, value);
				if (!SignatureChecker.isValidSignatureNow(field.authorizedFlexFiller, fillHash, flexFillerSigs[i])) {
					revert InvalidFlexFillerSignature(i);
				}
			}

			// Inject fill value at the specified offset (after 4-byte selector)
			uint256 insertPos = 4 + field.offset;
			assembly ("memory-safe") {
				calldatacopy(add(add(callData, 32), insertPos), value.offset, value.length)
			}
		}
	}

	/// @notice Normalize a delegation key to the canonical delegator account
	/// @dev Active virtual accounts are normalized to their parent sub account
	function _canonicalDelegator(address account) private view returns (address) {
		if (accountLayer == address(0)) revert AccountLayerNotSet();
		VirtualAccountDetail memory virtualAccount = IViewFacet(accountLayer).getVirtualAccount(account);
		if (virtualAccount.isExists) return virtualAccount.parentAccount;
		return account;
	}

	/// @notice Retrieve the owner of an account via the AccountLayer.
	function _getAccountOwner(address account) private view returns (address) {
		if (accountLayer == address(0)) revert AccountLayerNotSet();
		return IViewFacet(accountLayer).ownerOf(account);
	}

	/// @notice Check whether the caller is the owner of the given account.
	function _isAccountOwner(Account memory account) internal view returns (bool) {
		return _getAccountOwner(account.addr) == msg.sender;
	}

	/* ═══════════════════════════ MODIFIERS ═══════════════════════════ */

	/// @notice Restrict function access to the owner of a specific account.
	/// @dev    Verifies caller owns the account through the AccountLayer contract.
	/// @param account Account information including AccountLayer and address
	modifier onlyOwner(Account memory account) {
		if (!_isAccountOwner(account)) revert NotOwnerOfAccount(msg.sender, account.addr);
		_;
	}
}
