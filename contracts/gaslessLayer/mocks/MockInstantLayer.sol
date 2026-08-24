// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

import { IInstantLayer } from "../interfaces/IInstantLayer.sol";

interface IMockSignerContext {
	function setSignerOverride(address signer) external;
}

/// @notice Stand-in for the Symmio InstantLayer. `executeBatch`/`executeTemplate` enforce that the
///         caller is the registered executor (mirroring OPERATOR_ROLE on the real contract) and that
///         the signature/fill/flex arrays match the op count (mirroring the real ArrayLengthMismatch
///         guards), and can be made to fail to exercise the gateway's atomic fee rollback.
contract MockInstantLayer is IInstantLayer {
	address public executor;
	bool public forceExecutionFailure;
	bool public forceDelegationFailure;
	bool public executeTargets;
	address public signerContextTarget;
	uint256 public lastOperationCount;
	uint256 public lastFillsLength;
	uint256 public lastFlexFillerSignaturesLength;
	uint256 public lastTemplateId;
	address public lastDelegationAccount;
	bool public lastDelegationIsPartyB;
	address public lastDelegationDelegate;
	uint256 public lastDelegationSelectorCount;
	bytes4 public lastDelegationFirstSelector;
	uint256 public lastDelegationExpiry;
	uint256 public lastDelegationNonce;
	uint256 public lastDelegationDeadline;
	bytes32 public lastDelegationSalt;
	bytes public lastDelegationSignature;
	mapping(address => mapping(address => mapping(bytes4 => uint256))) public delegations;

	error NotExecutor();
	error ForcedExecutionFailure();
	error ForcedDelegationFailure();
	error ArrayLengthMismatch();
	error TargetCallFailed(bytes reason);

	event InstantOperationsExecuted(uint256 count);

	/// @notice Register the executor that is allowed to call InstantLayer entrypoints (set this to the gateway).
	function setExecutor(address executor_) external {
		executor = executor_;
	}

	function setForceExecutionFailure(bool value) external {
		forceExecutionFailure = value;
	}

	function setForceDelegationFailure(bool value) external {
		forceDelegationFailure = value;
	}

	function setTargetExecution(bool value, address signerContextTarget_) external {
		executeTargets = value;
		signerContextTarget = signerContextTarget_;
	}

	function setDelegation(address delegator, address delegate, bytes4 selector, uint256 expiryTimestamp) external {
		delegations[delegator][delegate][selector] = expiryTimestamp;
	}

	function isDelegationActive(address delegator, address delegate, bytes4 selector) external view returns (bool) {
		return delegations[delegator][delegate][selector] > block.timestamp;
	}

	function executeBatch(
		SignedOperation[] calldata signedOps,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexFillerSignatures
	) external returns (bytes[] memory results) {
		if (msg.sender != executor) revert NotExecutor();
		if (signedOps.length != signatures.length) revert ArrayLengthMismatch();
		if (signedOps.length != fills.length) revert ArrayLengthMismatch();
		if (signedOps.length != flexFillerSignatures.length) revert ArrayLengthMismatch();
		if (forceExecutionFailure) revert ForcedExecutionFailure();
		lastOperationCount = signedOps.length;
		lastFillsLength = fills.length;
		lastFlexFillerSignaturesLength = flexFillerSignatures.length;
		results = new bytes[](signedOps.length);
		if (executeTargets) {
			for (uint256 i = 0; i < signedOps.length; i++) {
				results[i] = _executeTarget(signedOps[i]);
			}
		}
		emit InstantOperationsExecuted(signedOps.length);
	}

	function executeTemplate(
		uint256 templateId,
		SignedOperation[] calldata signedOps,
		bytes[] calldata signatures,
		bytes[][] calldata fills,
		bytes[][] calldata flexFillerSignatures
	) external returns (bytes[] memory results) {
		if (msg.sender != executor) revert NotExecutor();
		if (signedOps.length != signatures.length) revert ArrayLengthMismatch();
		if (signedOps.length != fills.length) revert ArrayLengthMismatch();
		if (signedOps.length != flexFillerSignatures.length) revert ArrayLengthMismatch();
		if (forceExecutionFailure) revert ForcedExecutionFailure();
		lastTemplateId = templateId;
		lastOperationCount = signedOps.length;
		lastFillsLength = fills.length;
		lastFlexFillerSignaturesLength = flexFillerSignatures.length;
		results = new bytes[](signedOps.length);
		if (executeTargets) {
			for (uint256 i = 0; i < signedOps.length; i++) {
				results[i] = _executeTarget(signedOps[i]);
			}
		}
		emit InstantOperationsExecuted(signedOps.length);
	}

	function grantBatchDelegationBySig(SignedDelegation calldata signedDelegation, bytes calldata signature) external {
		if (forceDelegationFailure) revert ForcedDelegationFailure();
		DelegationInfo calldata info = signedDelegation.delegationInfo;
		lastDelegationAccount = info.account.addr;
		lastDelegationIsPartyB = info.account.isPartyB;
		lastDelegationDelegate = info.delegatedSigner;
		lastDelegationSelectorCount = info.selectors.length;
		lastDelegationFirstSelector = info.selectors.length == 0 ? bytes4(0) : info.selectors[0];
		lastDelegationExpiry = info.expiryTimestamp;
		lastDelegationNonce = signedDelegation.replayAttackHeader.nonce;
		lastDelegationDeadline = signedDelegation.replayAttackHeader.deadline;
		lastDelegationSalt = signedDelegation.replayAttackHeader.salt;
		lastDelegationSignature = signature;

		for (uint256 i = 0; i < info.selectors.length; i++) {
			delegations[info.account.addr][info.delegatedSigner][info.selectors[i]] = info.expiryTimestamp;
		}
	}

	function _executeTarget(SignedOperation calldata signedOp) internal returns (bytes memory result) {
		if (signedOp.target == signerContextTarget) {
			IMockSignerContext(signerContextTarget).setSignerOverride(signedOp.signerAccount.addr);
		}
		(bool ok, bytes memory returned) = signedOp.target.call(signedOp.callData);
		if (!ok) revert TargetCallFailed(returned);
		if (signedOp.target == signerContextTarget) {
			IMockSignerContext(signerContextTarget).setSignerOverride(address(0));
		}
		return returned;
	}
}
