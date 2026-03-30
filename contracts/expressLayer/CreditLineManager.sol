// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccessControlEnumerableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlEnumerableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { IMuonSignatureVerifier } from "../core/interfaces/IMuonSignatureVerifier.sol";

import { CreditData } from "./types/CreditTypes.sol";
import { ICreditLineManager } from "./interfaces/ICreditLineManager.sol";

/// @title CreditLineManager
/// @notice Per-affiliate credit line for express withdrawals.
///         Stores risk policy and debt state. Holds no tokens — affiliate pool in ExpressProvider
///         serves as implicit backing for credit advances.
///
/// Controls (affiliate can set stricter than protocol, never looser):
///   - maxDebt:    absolute cap on total outstanding debt (0 = no limit)
///   - maxDebtBps: max debt as basis points of Muon-provided affiliate-level eligibleBase (0 = no limit)
///   - paused:     kills the credit line
///   - blacklist:  per-user block
///
/// Roles:
///   - EXPRESS_PROVIDER_ROLE: only ExpressProvider calls reserve/activate/settle/cancel
///   - PROTOCOL_ADMIN_ROLE:  sets protocol caps and Muon freshness window
///   - AFFILIATE_ADMIN_ROLE: sets affiliate caps, pause, blacklist
contract CreditLineManager is ICreditLineManager, Initializable, AccessControlEnumerableUpgradeable, UUPSUpgradeable {
	// ═══════════════════════════════════════════════════════════════════
	//                              ERRORS
	// ═══════════════════════════════════════════════════════════════════

	error CreditLinePaused();
	error UserBlacklisted();
	error MuonSignatureExpired();
	error DebtExceedsAbsoluteCap();
	error DebtExceedsPercentCap();
	error NoDebtForRequest();
	error DebtAlreadyActivated();
	error DebtNotActivated();
	error AffiliateLimitExceedsProtocol();

	// ═══════════════════════════════════════════════════════════════════
	//                              EVENTS
	// ═══════════════════════════════════════════════════════════════════

	event DebtReserved(address indexed user, uint256 indexed requestId, uint256 amount);
	event DebtActivated(address indexed user, uint256 indexed requestId, uint256 amount);
	event DebtSettled(address indexed user, uint256 indexed requestId, uint256 amount);
	event DebtCancelled(address indexed user, uint256 indexed requestId, uint256 amount);
	event ProtocolConfigUpdated(uint256 maxDebt, uint256 maxDebtBps, uint256 muonFreshnessWindow);
	event AffiliateConfigUpdated(uint256 maxDebt, uint256 maxDebtBps);
	event UserBlacklistUpdated(address indexed user, bool blacklisted);
	event PausedUpdated(bool paused);

	// ═══════════════════════════════════════════════════════════════════
	//                              ROLES
	// ═══════════════════════════════════════════════════════════════════

	bytes32 public constant EXPRESS_PROVIDER_ROLE = keccak256("EXPRESS_PROVIDER_ROLE");
	bytes32 public constant PROTOCOL_ADMIN_ROLE = keccak256("PROTOCOL_ADMIN_ROLE");
	bytes32 public constant AFFILIATE_ADMIN_ROLE = keccak256("AFFILIATE_ADMIN_ROLE");

	// ═══════════════════════════════════════════════════════════════════
	//                              STATE
	// ═══════════════════════════════════════════════════════════════════

	// ── Protocol-set hard caps ──
	uint256 public protocolMaxDebt;
	uint256 public protocolMaxDebtBps;
	uint256 public muonFreshnessWindow;

	// ── Affiliate-chosen stricter caps ──
	uint256 public affiliateMaxDebt;
	uint256 public affiliateMaxDebtBps;

	// ── Debt tracking ──
	uint256 public reservedDebt;
	uint256 public activeDebt;
	mapping(bytes32 => uint256) public requestDebt;
	mapping(bytes32 => bool) public requestActivated;

	// ── State ──
	bool public paused;
	mapping(address => bool) public blacklisted;

	// ── Core refs ──
	address public symmio;
	address public signatureVerifier;
	uint256 public muonAppId;

	// ═══════════════════════════════════════════════════════════════════
	//                           INITIALIZER
	// ═══════════════════════════════════════════════════════════════════

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	function initialize(address admin, address _symmio, address _expressProvider, address _signatureVerifier, uint256 _muonAppId) public initializer {
		__AccessControlEnumerable_init();

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(PROTOCOL_ADMIN_ROLE, admin);
		_grantRole(AFFILIATE_ADMIN_ROLE, admin);
		_grantRole(EXPRESS_PROVIDER_ROLE, _expressProvider);

		symmio = _symmio;
		signatureVerifier = _signatureVerifier;
		muonAppId = _muonAppId;
		muonFreshnessWindow = 60;
	}

	function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

	// ═══════════════════════════════════════════════════════════════════
	//                    EXPRESS PROVIDER FUNCTIONS
	// ═══════════════════════════════════════════════════════════════════

	/// @inheritdoc ICreditLineManager
	function reserveDebt(address user, uint256 requestId, uint256 creditAmount, CreditData calldata data) external onlyRole(EXPRESS_PROVIDER_ROLE) {
		if (paused) revert CreditLinePaused();
		if (blacklisted[user]) revert UserBlacklisted();

		// Verify Muon signature freshness
		if (block.timestamp > data.timestamp + muonFreshnessWindow) revert MuonSignatureExpired();

		// Verify Muon signature via the shared verifier
		// eligibleBase is per-affiliate (aggregate of all users), not per-user.
		// address(this) identifies the affiliate since there is one CLM per affiliate.
		bytes32 hash = keccak256(abi.encodePacked(muonAppId, data.reqId, address(this), data.eligibleBase, data.timestamp, block.chainid));
		IMuonSignatureVerifier(signatureVerifier).verify(hash, data.sigs, data.gatewaySignature);

		// Check caps
		uint256 newTotalDebt = reservedDebt + activeDebt + creditAmount;

		uint256 effectiveMaxDebt = _effectiveMax(protocolMaxDebt, affiliateMaxDebt);
		if (effectiveMaxDebt > 0 && newTotalDebt > effectiveMaxDebt) revert DebtExceedsAbsoluteCap();

		uint256 effectiveMaxBps = _effectiveMax(protocolMaxDebtBps, affiliateMaxDebtBps);
		if (effectiveMaxBps > 0 && newTotalDebt > (data.eligibleBase * effectiveMaxBps) / 10000) revert DebtExceedsPercentCap();

		// Record debt
		bytes32 key = _key(user, requestId);
		requestDebt[key] = creditAmount;
		reservedDebt += creditAmount;

		emit DebtReserved(user, requestId, creditAmount);
	}

	/// @inheritdoc ICreditLineManager
	function activateDebt(address user, uint256 requestId) external onlyRole(EXPRESS_PROVIDER_ROLE) {
		bytes32 key = _key(user, requestId);
		uint256 amount = requestDebt[key];
		if (amount == 0) revert NoDebtForRequest();
		if (requestActivated[key]) revert DebtAlreadyActivated();

		requestActivated[key] = true;
		reservedDebt -= amount;
		activeDebt += amount;

		emit DebtActivated(user, requestId, amount);
	}

	/// @inheritdoc ICreditLineManager
	function settleDebt(address user, uint256 requestId) external onlyRole(EXPRESS_PROVIDER_ROLE) {
		bytes32 key = _key(user, requestId);
		uint256 amount = requestDebt[key];
		if (amount == 0) revert NoDebtForRequest();

		if (requestActivated[key]) {
			activeDebt -= amount;
		} else {
			reservedDebt -= amount;
		}

		delete requestDebt[key];
		delete requestActivated[key];

		emit DebtSettled(user, requestId, amount);
	}

	/// @inheritdoc ICreditLineManager
	function cancelReservation(address user, uint256 requestId) external onlyRole(EXPRESS_PROVIDER_ROLE) {
		bytes32 key = _key(user, requestId);
		uint256 amount = requestDebt[key];
		if (amount == 0) revert NoDebtForRequest();

		reservedDebt -= amount;
		delete requestDebt[key];

		emit DebtCancelled(user, requestId, amount);
	}

	/// @inheritdoc ICreditLineManager
	function totalDebt() external view returns (uint256) {
		return reservedDebt + activeDebt;
	}

	// ═══════════════════════════════════════════════════════════════════
	//                     PROTOCOL ADMIN FUNCTIONS
	// ═══════════════════════════════════════════════════════════════════

	function setProtocolConfig(uint256 _maxDebt, uint256 _maxDebtBps, uint256 _muonFreshnessWindow) external onlyRole(PROTOCOL_ADMIN_ROLE) {
		protocolMaxDebt = _maxDebt;
		protocolMaxDebtBps = _maxDebtBps;
		muonFreshnessWindow = _muonFreshnessWindow;
		emit ProtocolConfigUpdated(_maxDebt, _maxDebtBps, _muonFreshnessWindow);
	}

	function setSignatureVerifier(address _signatureVerifier) external onlyRole(PROTOCOL_ADMIN_ROLE) {
		signatureVerifier = _signatureVerifier;
	}

	function setMuonAppId(uint256 _muonAppId) external onlyRole(PROTOCOL_ADMIN_ROLE) {
		muonAppId = _muonAppId;
	}

	// ═══════════════════════════════════════════════════════════════════
	//                    AFFILIATE ADMIN FUNCTIONS
	// ═══════════════════════════════════════════════════════════════════

	function setAffiliateConfig(uint256 _maxDebt, uint256 _maxDebtBps) external onlyRole(AFFILIATE_ADMIN_ROLE) {
		// Affiliate limits must be stricter (or equal) to protocol limits
		if (protocolMaxDebt > 0 && _maxDebt > protocolMaxDebt) revert AffiliateLimitExceedsProtocol();
		if (protocolMaxDebtBps > 0 && _maxDebtBps > protocolMaxDebtBps) revert AffiliateLimitExceedsProtocol();

		affiliateMaxDebt = _maxDebt;
		affiliateMaxDebtBps = _maxDebtBps;
		emit AffiliateConfigUpdated(_maxDebt, _maxDebtBps);
	}

	function setBlacklisted(address user, bool _blacklisted) external onlyRole(AFFILIATE_ADMIN_ROLE) {
		blacklisted[user] = _blacklisted;
		emit UserBlacklistUpdated(user, _blacklisted);
	}

	function setPaused(bool _paused) external onlyRole(AFFILIATE_ADMIN_ROLE) {
		paused = _paused;
		emit PausedUpdated(_paused);
	}

	// ═══════════════════════════════════════════════════════════════════
	//                           INTERNAL
	// ═══════════════════════════════════════════════════════════════════

	function _key(address user, uint256 requestId) internal pure returns (bytes32) {
		return keccak256(abi.encodePacked(user, requestId));
	}

	/// @dev Returns the effective (tighter) of two limits. 0 means "no limit".
	function _effectiveMax(uint256 protocolVal, uint256 affiliateVal) internal pure returns (uint256) {
		if (protocolVal == 0) return affiliateVal;
		if (affiliateVal == 0) return protocolVal;
		return protocolVal < affiliateVal ? protocolVal : affiliateVal;
	}
}
