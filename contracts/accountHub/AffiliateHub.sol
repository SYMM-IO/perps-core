// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./interfaces/IAffiliateHub.sol";
import "./interfaces/IAccountHub.sol";
import "./interfaces/IAccountHubLens.sol";
import "./interfaces/ISymmio.sol";

/**
 * @title AffiliateHub
 * @notice Manages affiliate registrations, fee distribution, and hooks for the Symmio protocol
 * @dev Implements role-based access control, pausability, and reentrancy protection
 */
contract AffiliateHub is IAffiliateHub, Initializable, PausableUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
	using SafeERC20Upgradeable for IERC20Upgradeable;
	using EnumerableSet for EnumerableSet.AddressSet;

	// ==================== Constants ====================
	bytes32 public constant APPROVER_ROLE = keccak256("APPROVER_ROLE");
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");
	bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");

	uint256 private constant SHARE_PRECISION = 1e18;
	uint256 private constant MAX_NAME_LENGTH = 100;

	// ==================== State Variables ====================

	mapping(address => bool) private whitelistedSymmioCores;
	mapping(address => AffiliateData) private affiliates;
	mapping(address => PendingFeeUpdate) public pendingFeeUpdates;
	mapping(address => mapping(bytes4 => mapping(address => bool))) private operators;

	EnumerableSet.AddressSet private legacyMultiAccounts;

	address public symmioFeeReceiver;
	address public accountHub;
	uint256 public globalNonce;

	// ==================== Modifiers ====================

	/**
	 * @dev Ensures the caller is the affiliate admin
	 */
	modifier onlyAffiliateAdmin(address affiliate) {
		if (affiliates[affiliate].admin != msg.sender) revert NotAdmin();
		_;
	}

	/**
	 * @dev Ensures the affiliate is in active state
	 */
	modifier onlyIfAffiliateIsActive(address affiliate) {
		if (affiliates[affiliate].state != AffiliateState.ACTIVE) {
			revert AffiliateNotActive();
		}
		_;
	}

	// ==================== Constructor & Initializer ====================

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	/**
	 * @notice Initializes the AffiliateHub contract
	 * @param _admin The default admin address
	 * @param _symmioFeeReceiver The address to receive Symmio fees
	 */
	function initialize(address _admin, address _symmioFeeReceiver) public initializer {
		if (_admin == address(0)) revert ZeroAddress();
		if (_symmioFeeReceiver == address(0)) revert ZeroAddress();

		__Pausable_init();
		__AccessControl_init();
		__ReentrancyGuard_init();

		_grantRole(DEFAULT_ADMIN_ROLE, _admin);

		symmioFeeReceiver = _symmioFeeReceiver;
	}

	// ==================== Affiliate Management ====================

	/**
	 * @notice Requests to register a new affiliate
	 * @param reg The affiliate registration data
	 * @return affiliateAddress The generated affiliate address
	 */
	function requestToRegisterAffiliate(AffiliateRegistration memory reg) external whenNotPaused returns (address affiliateAddress) {
		if (accountHub == address(0)) revert AccountHubNotSet();
		address lens = IAccountHub(accountHub).accountHubLens();
		if (lens == address(0)) revert AccountHubLensNotSet();
		affiliateAddress = IAccountHubLens(lens).generateAccountManagerAddress(msg.sender, reg.name);

		if (affiliates[affiliateAddress].state != AffiliateState.NONE) revert AlreadyRegistered();
		if (reg.admin == address(0)) revert ZeroAddress();

		_validateName(reg.name);
		_validateFeeShares(reg.stakeholders, reg.symmioShare);

		AffiliateData storage affiliate = affiliates[affiliateAddress];
		affiliate.name = reg.name;
		affiliate.brandColor = reg.brandColor;
		affiliate.admin = reg.admin;
		affiliate.state = AffiliateState.PENDING;
		affiliate.metadata = reg.metadata;
		affiliate.feeDetails.symmioShare = reg.symmioShare;
		affiliate.feeDetails.stakeholders = reg.stakeholders;
		affiliate.legacyMultiAccounts = reg.legacyMultiAccounts;
		affiliate.registrant = msg.sender;

		for (uint256 i = 0; i < reg.symmioCores.length; i++) {
			if (!whitelistedSymmioCores[reg.symmioCores[i]]) revert NoWhitelistedSymmioCore();
			affiliate.symmioCores.add(reg.symmioCores[i]);
		}

		emit AffiliateRegistered(affiliateAddress, reg.name);
	}

	/**
	 * @notice Cancels a pending affiliate registration
	 * @param affiliate The affiliate address
	 */
	function cancelRegistration(address affiliate) external whenNotPaused onlyAffiliateAdmin(affiliate) {
		if (affiliates[affiliate].state != AffiliateState.PENDING) revert NotPending();

		delete affiliates[affiliate];
		emit RegistrationCancelled(affiliate);
	}

	/**
	 * @notice Rejects a pending affiliate registration
	 * @param affiliate The affiliate address to reject
	 */
	function rejectRegistration(address affiliate) external onlyRole(APPROVER_ROLE) {
		if (affiliates[affiliate].state != AffiliateState.PENDING) revert NotPending();

		delete affiliates[affiliate];
		emit RegistrationRejected(affiliate, msg.sender);
	}

	/**
	 * @notice Approves a pending affiliate registration
	 * @param affiliate The affiliate address to approve
	 */
	function approveAffiliate(address affiliate) external onlyRole(APPROVER_ROLE) whenNotPaused {
		if (affiliates[affiliate].state != AffiliateState.PENDING) revert NotPending();
		if (accountHub == address(0)) revert AccountHubNotSet();

		// Deploy AccountManager via AccountHub (which also grants SIGNER_SETTER_ROLE)
		address accountManager = IAccountHub(accountHub).deployAccountManager(
			affiliate,
			affiliates[affiliate].registrant,
			affiliates[affiliate].name
		);

		address feeDistributor = _generateFeeDistributorAddress(affiliate, ++globalNonce);

		affiliates[affiliate].state = AffiliateState.ACTIVE;
		affiliates[affiliate].accountManager = accountManager;
		affiliates[affiliate].feeDetails.feeDistributor = feeDistributor;

		_setupAffiliateOnSymmioCore(affiliate);

		address[] memory legacyAccounts = affiliates[affiliate].legacyMultiAccounts;
		for (uint256 i = 0; i < legacyAccounts.length; i++) {
			legacyMultiAccounts.add(legacyAccounts[i]);
		}

		emit AffiliateApproved(affiliate, feeDistributor);
	}

	/**
	 * @notice Proposes a transfer of affiliate admin role
	 * @param affiliate The affiliate address
	 * @param newAdmin The proposed new admin address
	 */
	function proposeAdminTransfer(
		address affiliate,
		address newAdmin
	) external whenNotPaused onlyIfAffiliateIsActive(affiliate) onlyAffiliateAdmin(affiliate) {
		if (newAdmin == address(0)) revert ZeroAddress();

		affiliates[affiliate].pendingAdmin = newAdmin;
		emit AdminTransferProposed(affiliate, newAdmin);
	}

	/**
	 * @notice Accepts the pending admin transfer
	 * @param affiliate The affiliate address
	 */
	function acceptAdminTransfer(address affiliate) external whenNotPaused {
		if (affiliates[affiliate].pendingAdmin != msg.sender) revert Unauthorized();

		address oldAdmin = affiliates[affiliate].admin;
		affiliates[affiliate].admin = msg.sender;
		affiliates[affiliate].pendingAdmin = address(0);

		emit AdminTransferCompleted(affiliate, oldAdmin, msg.sender);
	}

	/**
	 * @notice Cancels the pending admin transfer
	 * @param affiliate The affiliate address
	 */
	function cancelAdminTransfer(address affiliate) external whenNotPaused onlyAffiliateAdmin(affiliate) {
		affiliates[affiliate].pendingAdmin = address(0);
		emit AdminTransferCancelled(affiliate);
	}

	/**
	 * @notice Updates affiliate display details
	 * @param affiliate The affiliate address
	 * @param name The new name
	 * @param brandColor The new brand color
	 */
	function updateAffiliateDetails(
		address affiliate,
		string memory name,
		string memory brandColor
	) external whenNotPaused onlyAffiliateAdmin(affiliate) onlyIfAffiliateIsActive(affiliate) {
		_validateName(name);

		affiliates[affiliate].name = name;
		affiliates[affiliate].brandColor = brandColor;

		emit AffiliateUpdated(affiliate, name, brandColor);
	}

	/**
	 * @notice Pauses an active affiliate
	 * @param affiliate The affiliate address
	 */
	function pauseAffiliate(address affiliate) external whenNotPaused onlyIfAffiliateIsActive(affiliate) {
		if (!hasRole(PAUSER_ROLE, msg.sender) && affiliates[affiliate].admin != msg.sender) {
			revert Unauthorized();
		}

		affiliates[affiliate].state = AffiliateState.PAUSED;
		emit AffiliatePaused(affiliate);
	}

	/**
	 * @notice Unpauses a paused affiliate
	 * @param affiliate The affiliate address
	 */
	function unpauseAffiliate(address affiliate) external onlyRole(UNPAUSER_ROLE) {
		if (affiliates[affiliate].state != AffiliateState.PAUSED) revert InvalidState();

		affiliates[affiliate].state = AffiliateState.ACTIVE;
		emit AffiliateUnpaused(affiliate);
	}

	// ==================== Fee Management ====================

	/**
	 * @notice Requests an update to affiliate fee distribution
	 * @param affiliate The affiliate address
	 * @param newStakeholders The new stakeholder configuration
	 * @param newSymmioShare The new Symmio share
	 */
	function requestFeeUpdate(
		address affiliate,
		Stakeholder[] memory newStakeholders,
		uint256 newSymmioShare
	) external whenNotPaused onlyAffiliateAdmin(affiliate) onlyIfAffiliateIsActive(affiliate) {
		_validateFeeShares(newStakeholders, newSymmioShare);

		PendingFeeUpdate storage pending = pendingFeeUpdates[affiliate];
		pending.symmioShare = newSymmioShare;
		pending.timestamp = block.timestamp;
		pending.exists = true;
		pending.stakeholders = newStakeholders;

		emit StakeholdersUpdateRequested(affiliate);
	}

	/**
	 * @notice Cancels a pending fee update
	 * @param affiliate The affiliate address
	 */
	function cancelFeeUpdate(address affiliate) external whenNotPaused onlyAffiliateAdmin(affiliate) {
		if (!pendingFeeUpdates[affiliate].exists) revert NoPendingUpdate();

		delete pendingFeeUpdates[affiliate];
		emit FeeUpdateCancelled(affiliate);
	}

	/**
	 * @notice Approves a pending fee update
	 * @param affiliate The affiliate address
	 */
	function approveFeeUpdate(address affiliate) external onlyRole(APPROVER_ROLE) whenNotPaused {
		if (!pendingFeeUpdates[affiliate].exists) revert NoPendingUpdate();

		delete affiliates[affiliate].feeDetails.stakeholders;
		affiliates[affiliate].feeDetails.symmioShare = pendingFeeUpdates[affiliate].symmioShare;
		affiliates[affiliate].feeDetails.stakeholders = pendingFeeUpdates[affiliate].stakeholders;

		delete pendingFeeUpdates[affiliate];
		emit StakeholdersUpdated(affiliate);
	}

	/**
	 * @notice Claims all available fees for an affiliate
	 * @param affiliate The affiliate address
	 * @param symmio The Symmio core address
	 */
	function claimAllFees(address affiliate, address symmio) external whenNotPaused nonReentrant {
		_claimFees(affiliate, symmio, _getClaimableFee(affiliate, symmio), msg.sender);
	}

	/**
	 * @notice Claims a specific amount of fees for an affiliate
	 * @param affiliate The affiliate address
	 * @param symmio The Symmio core address
	 * @param amount The amount to claim
	 */
	function claimFees(address affiliate, address symmio, uint256 amount) public whenNotPaused nonReentrant {
		_claimFees(affiliate, symmio, amount, msg.sender);
	}

	/**
	 * @dev fee claim logic
	 */
	function _claimFees(address affiliate, address symmio, uint256 amount, address caller) private {
		address collateral = ISymmio(symmio).getCollateral();
		FeeDetails storage feeDetails = affiliates[affiliate].feeDetails;
		Stakeholder[] memory stakeholders = feeDetails.stakeholders;

		// authorize fee claim
		bool auth = false;

		for (uint256 i = 0; i < stakeholders.length; i++) {
			if (caller == stakeholders[i].receiver) {
				auth = true;
				break;
			}
		}

		if (!auth && !hasRole(DISTRIBUTOR_ROLE, caller)) revert Unauthorized();

		// withdraw fees from Symmio
		ISymmio(symmio).setSigner(feeDetails.feeDistributor);
		ISymmio(symmio).withdrawTo(address(this), amount);
		ISymmio(symmio).setSigner(address(0));

		// distribute fees to stakeholders
		for (uint256 i = 0; i < stakeholders.length; i++) {
			uint256 share = (stakeholders[i].share * amount) / SHARE_PRECISION;
			IERC20Upgradeable(collateral).safeTransfer(stakeholders[i].receiver, share);
			emit FeesDistributed(stakeholders[i].receiver, share);
		}

		// transfer Symmio share to the protocol receiver
		uint256 symmioAmount = (feeDetails.symmioShare * amount) / SHARE_PRECISION;
		if (symmioAmount > 0) {
			IERC20Upgradeable(collateral).safeTransfer(symmioFeeReceiver, symmioAmount);
			emit FeesDistributed(symmioFeeReceiver, symmioAmount);
		}

		emit FeesClaimed(affiliate, symmio, amount);
	}

	/**
	 * @notice Simulates fee claim to preview distribution
	 * @param affiliate The affiliate address
	 * @param symmio The Symmio core address
	 * @return holders Array of recipient addresses
	 * @return shares Array of corresponding share amounts
	 */
	function dryClaimAllFees(address affiliate, address symmio) public view returns (address[] memory holders, uint256[] memory shares) {
		uint256 totalClaimable = _getClaimableFee(affiliate, symmio);
		Stakeholder[] memory stakeholders = affiliates[affiliate].feeDetails.stakeholders;

		uint256 len = stakeholders.length;
		holders = new address[](len);
		shares = new uint256[](len);

		for (uint256 i = 0; i < len; i++) {
			holders[i] = stakeholders[i].receiver;
			shares[i] = (stakeholders[i].share * totalClaimable) / SHARE_PRECISION;
		}

		return (holders, shares);
	}

	// ==================== Hook Management ====================

	/**
	 * @notice Sets a hook for specific function calls
	 * @param affiliate The affiliate address
	 * @param selector The function selector to hook
	 * @param hook The hook contract address
	 */
	function setHook(
		address affiliate,
		bytes4 selector,
		address hook
	) external whenNotPaused onlyAffiliateAdmin(affiliate) onlyIfAffiliateIsActive(affiliate) {
		affiliates[affiliate].hooks[selector] = hook;
		emit HookSet(affiliate, selector, hook);
	}

	/**
	 * @notice Removes a hook
	 * @param affiliate The affiliate address
	 * @param selector The function selector to unhook
	 */
	function removeHook(address affiliate, bytes4 selector) external whenNotPaused onlyAffiliateAdmin(affiliate) {
		delete affiliates[affiliate].hooks[selector];
		emit HookRemoved(affiliate, selector);
	}

	/**
	 * @notice Gets the hook address for a selector
	 * @param affiliate The affiliate address
	 * @param selector The function selector
	 * @return The hook contract address
	 */
	function getHook(address affiliate, bytes4 selector) external view returns (address) {
		return affiliates[affiliate].hooks[selector];
	}

	// ==================== Operator Management ====================

	function setOperator(
		address affiliate,
		bytes4 selector,
		address operator,
		bool status
	) external whenNotPaused onlyAffiliateAdmin(affiliate) onlyIfAffiliateIsActive(affiliate) {
		if (operator == address(0)) revert ZeroAddress();
		operators[affiliate][selector][operator] = status;
		emit OperatorSet(affiliate, selector, operator, status);
	}

	function isOperator(address affiliate, bytes4 selector, address operator) external view returns (bool) {
		return operators[affiliate][selector][operator];
	}

	// ==================== Affiliate Delegated Calls ====================

	function callAsAffiliate(
		address affiliate,
		address symmio,
		bytes calldata callData
	) external whenNotPaused nonReentrant onlyIfAffiliateIsActive(affiliate) returns (bytes memory result) {
		if (callData.length < 4) revert InvalidCallData();

		bytes4 selector = bytes4(callData[:4]);
		if (affiliates[affiliate].admin != msg.sender && !operators[affiliate][selector][msg.sender]) revert Unauthorized();
		if (!affiliates[affiliate].symmioCores.contains(symmio)) revert SymmioCoreNotAllowed();

		ISymmio(symmio).setSigner(affiliate);
		(bool success, bytes memory returned) = symmio.call(callData);
		ISymmio(symmio).setSigner(address(0));

		if (!success) {
			assembly {
				revert(add(returned, 32), mload(returned))
			}
		}

		return returned;
	}

	// ==================== Admin Functions ====================

	/**
	 * @notice Sets the AccountHub contract address (must be called after deployment)
	 * @param _accountHub The AccountHub address
	 */
	function setAccountHub(address _accountHub) external onlyRole(SETTER_ROLE) {
		if (_accountHub == address(0)) revert ZeroAddress();
		accountHub = _accountHub;
	}

	/**
	 * @notice Sets the Symmio fee receiver address
	 * @param receiver The new receiver address
	 */
	function setSymmioFeeReceiver(address receiver) external onlyRole(SETTER_ROLE) {
		if (receiver == address(0)) revert ZeroAddress();

		address oldReceiver = symmioFeeReceiver;
		symmioFeeReceiver = receiver;

		emit SymmioFeeReceiverUpdated(oldReceiver, receiver);
	}

	/**
	 * @notice Sets or unsets a core as whitelisted
	 * @param core The core address
	 * @param status The availability status
	 */
	function setWhitelistedSymmioCore(address core, bool status) external onlyRole(SETTER_ROLE) {
		whitelistedSymmioCores[core] = status;
		emit WhitelistedSymmioCoreSet(core, status);
	}

	/**
	 * @notice Pauses the contract
	 */
	function pause() external onlyRole(PAUSER_ROLE) {
		_pause();
	}

	/**
	 * @notice Unpauses the contract
	 */
	function unpause() external onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}

	// ==================== View Functions ====================

	/**
	 * @notice Gets the affiliate state
	 * @param affiliate The affiliate address
	 * @return The affiliate state
	 */
	function getAffiliateState(address affiliate) external view returns (AffiliateState) {
		return affiliates[affiliate].state;
	}

	/**
	 * @notice Gets the affiliate admin
	 * @param affiliate The affiliate address
	 * @return The admin address
	 */
	function getAffiliateAdmin(address affiliate) external view returns (address) {
		return affiliates[affiliate].admin;
	}

	/**
	 * @notice Gets the affiliate fee distributor
	 * @param affiliate The affiliate address
	 * @return The fee distributor address
	 */
	function getAffiliateFeeDistributor(address affiliate) external view returns (address) {
		return affiliates[affiliate].feeDetails.feeDistributor;
	}

	function getAffiliateAccountManager(address affiliate) external view returns (address) {
		return affiliates[affiliate].accountManager;
	}

	/**
	 * @notice Gets all Symmio cores for an affiliate
	 * @param affiliate The affiliate address
	 * @return Array of core addresses
	 */
	function getAffiliateSymmioCores(address affiliate) external view returns (address[] memory) {
		EnumerableSet.AddressSet storage set = affiliates[affiliate].symmioCores;
		uint256 len = set.length();

		address[] memory cores = new address[](len);

		for (uint256 i = 0; i < len; i++) {
			cores[i] = set.at(i);
		}

		return cores;
	}

	/**
	 * @notice Checks if a Symmio core is whitelisted
	 * @param core The core address
	 * @return True if whitelisted
	 */
	function isWhitelistedSymmioCore(address core) external view returns (bool) {
		return whitelistedSymmioCores[core];
	}

	/**
	 * @notice Checks if an account is a legacy multi-account
	 * @param account The account address
	 * @return True if legacy multi-account
	 */
	function isLegacyMultiAccount(address account) external view returns (bool) {
		return legacyMultiAccounts.contains(account);
	}

	/**
	 * @notice Gets all legacy multi-accounts
	 * @return Array of legacy multi-account addresses
	 */
	function getLegacyMultiAccounts() external view returns (address[] memory) {
		return legacyMultiAccounts.values();
	}

	// ==================== Internal Functions ====================

	/**
	 * @dev Validates name length
	 */
	function _validateName(string memory name) private pure {
		if (bytes(name).length == 0 || bytes(name).length > MAX_NAME_LENGTH) {
			revert InvalidNameLength();
		}
	}

	/**
	 * @dev Validates fee shares sum to 100%
	 */
	function _validateFeeShares(Stakeholder[] memory stakeholders, uint256 symmioShare) private pure {
		if (symmioShare > SHARE_PRECISION) revert InvalidShare();

		uint256 totalShare = symmioShare;
		for (uint256 i = 0; i < stakeholders.length; i++) {
			if (stakeholders[i].receiver == address(0)) revert ZeroAddress();
			totalShare += stakeholders[i].share;
		}

		if (totalShare != SHARE_PRECISION) revert SharesMustSumTo100();
	}

	/**
	 * @dev Configures Symmio cores for an affiliate
	 */
	function _setupAffiliateOnSymmioCore(address affiliate) private {
		EnumerableSet.AddressSet storage cores = affiliates[affiliate].symmioCores;
		address feeDistributor = affiliates[affiliate].feeDetails.feeDistributor;

		for (uint256 i = 0; i < cores.length(); i++) {
			ISymmio(cores.at(i)).registerAffiliate(affiliate);
			ISymmio(cores.at(i)).setFeeCollector(affiliate, feeDistributor);
		}
	}

	/**
	 * @dev Gets claimable fees
	 */
	function _getClaimableFee(address affiliate, address symmio) private view returns (uint256) {
		uint8 decimals = IERC20Metadata(ISymmio(symmio).getCollateral()).decimals();
		uint256 balance = ISymmio(symmio).balanceOf(affiliates[affiliate].feeDetails.feeDistributor);
		return balance / (10 ** (18 - decimals));
	}

	/**
	 * @dev Generates deterministic fee distributor address
	 */
	function _generateFeeDistributorAddress(address affiliate, uint256 nonce) private pure returns (address) {
		bytes32 VIRTUAL_FEE_DISTRIBUTOR_CODE_HASH = keccak256("VFD_V1");
		return
			address(
				uint160(
					uint256(
						keccak256(abi.encodePacked(bytes1(0xff), affiliate, keccak256(abi.encodePacked(nonce)), VIRTUAL_FEE_DISTRIBUTOR_CODE_HASH))
					)
				)
			);
	}
}
