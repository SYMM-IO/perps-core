// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { AccessControlEnumerableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlEnumerableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/interfaces/IERC20Upgradeable.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";

interface ISymmio {
	function isCallFromInstantLayer() external view returns (bool);
	function adlClose(uint256 quoteId, uint256 amount, uint256 price) external;
}

contract SymmioPartyB is Initializable, PausableUpgradeable, AccessControlEnumerableUpgradeable, IERC1271 {
	bytes32 public constant TRUSTED_ROLE = keccak256("TRUSTED_ROLE");
	bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

	/// @notice Role for updating contract configuration and signer settings.
	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");

	bytes16 private constant _HEX_SYMBOLS = "0123456789abcdef";

	mapping(bytes4 => bool) public restrictedSelectors; // selector -> isRestricted
	mapping(address => bool) public multicastWhitelist; // contractAddress -> isAllowedForMulticast
	uint256 private _guardCounter;

	address public symmioAddress;
	address public signer;

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	// Custom modifier for reentrancy protection
	modifier nonReentrant() {
		require(_guardCounter == 0, "SymmioPartyB: reentrant call");
		_guardCounter = 1;
		_;
		_guardCounter = 0;
	}

	/**
	 * @dev Initializes the contract with the provided admin and Symmio address.
	 * @param admin The address of the default admin role.
	 * @param symmioAddress_ The address of the Symmio contract.
	 */
	function initialize(address admin, address symmioAddress_) public initializer {
		__Pausable_init();
		__AccessControl_init();

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(TRUSTED_ROLE, admin);
		_grantRole(MANAGER_ROLE, admin);
		symmioAddress = symmioAddress_;
	}

	/**
	 * @notice Emitted when an `adlClose` attempt reverts for a quote.
	 * @dev `adlCall` is best-effort; it catches per-quote failures and continues the loop.
	 * @param quoteId The quote id that was attempted to be ADL-closed.
	 * @param amount The requested close amount.
	 * @param price The requested execution price.
	 * @param reason A human-readable reason derived from the revert (string reason, panic, or custom error selector).
	 */
	event ADLSkip(uint256 quoteId, uint256 amount, uint256 price, string reason);

	/**
	 * @dev Emitted when the Symmio address is updated.
	 * @param oldSymmioAddress The address of the old Symmio contract.
	 * @param newSymmioAddress The address of the new Symmio contract.
	 */
	event SetSymmioAddress(address oldSymmioAddress, address newSymmioAddress);

	/**
	 * @dev Emitted when a restricted selector is set.
	 * @param selector The function selector.
	 * @param state The state of the selector.
	 */
	event SetRestrictedSelector(bytes4 selector, bool state);

	/**
	 * @dev Emitted when a multicast whitelist address is set.
	 * @param addr The address added to the whitelist.
	 * @param state The state of the whitelist address.
	 */
	event SetMulticastWhitelist(address addr, bool state);

	/**
	 * @dev Updates the address of the Symmio contract.
	 * @param addr The new address of the Symmio contract.
	 */
	function setSymmioAddress(address addr) external onlyRole(DEFAULT_ADMIN_ROLE) {
		emit SetSymmioAddress(symmioAddress, addr);
		symmioAddress = addr;
	}

	/**
	 * @dev Restricts or lifts restrictions on a selector for Party B..
	 * @param selector The function selector to set the state for.
	 * @param state The state to set for the selector.
	 */
	function setRestrictedSelector(bytes4 selector, bool state) external onlyRole(DEFAULT_ADMIN_ROLE) {
		restrictedSelectors[selector] = state;
		emit SetRestrictedSelector(selector, state);
	}

	/**
	 * @dev Allows or disallows Party B to call a method from a specific contract.
	 * @param addr The address to set the state for.
	 * @param state The state to set for the address.
	 */
	function setMulticastWhitelist(address addr, bool state) external onlyRole(MANAGER_ROLE) {
		require(addr != address(this), "SymmioPartyB: Invalid address");
		multicastWhitelist[addr] = state;
		emit SetMulticastWhitelist(addr, state);
	}

	/**
	 * @dev Approves an ERC20 token for spending by Symmio.
	 * @param token The address of the ERC20 token.
	 * @param amount The amount of tokens to approve.
	 */
	function _approve(address token, uint256 amount) external onlyRole(TRUSTED_ROLE) whenNotPaused {
		require(IERC20Upgradeable(token).approve(symmioAddress, amount), "SymmioPartyB: Not approved");
	}

	function _toHexSelector(bytes4 selector) private pure returns (string memory) {
		bytes memory buffer = new bytes(10);
		buffer[0] = "0";
		buffer[1] = "x";
		for (uint256 i = 0; i < 4; i++) {
			uint8 b = uint8(selector[i]);
			buffer[2 + i * 2] = _HEX_SYMBOLS[b >> 4];
			buffer[3 + i * 2] = _HEX_SYMBOLS[b & 0x0f];
		}
		return string(buffer);
	}

	/**
	 * @dev Best-effort conversion of low-level revert data into a readable string.
	 *
	 * - For `Error(string)`, Solidity provides the string via `catch Error(string memory reason)`.
	 * - For panics and custom errors, we return either `"Panic"` or `"Custom error: 0x...."` (selector only).
	 */
	function _revertDataToReason(bytes memory revertData) private pure returns (string memory) {
		if (revertData.length >= 4) {
			bytes4 selector;
			assembly {
				selector := mload(add(revertData, 0x20))
			}

			// Panic(uint256)
			if (selector == 0x4e487b71) return "Panic";

			return string.concat("Custom error: ", _toHexSelector(selector));
		}
		return "Low-level revert";
	}

	/* ──────────────────────────────── ADL ──────────────────────────────── */

	/**
	 * @notice Best-effort ADL close for multiple quotes.
	 * @dev For each index `i`, this function attempts `Symmio.adlClose(quoteIds[i], amounts[i], prices[i])`.
	 *
	 * Execution model:
	 * - Reverts only on precondition failures (access control, array mismatch, invalid Symmio address).
	 * - Catches per-quote reverts, emits `ADLSkip`, and continues processing the remaining items.
	 *
	 * Access control:
	 * - Allowed for `MANAGER_ROLE` or `TRUSTED_ROLE`.
	 * - Also allowed during InstantLayer execution (`Symmio.isCallFromInstantLayer() == true`).
	 *
	 * @param quoteIds Quote ids to ADL-close.
	 * @param amounts Close amounts per quote (token decimals).
	 * @param prices Execution prices per quote.
	 */
	function adlCall(
		uint256[] calldata quoteIds,
		uint256[] calldata amounts,
		uint256[] calldata prices
	) external nonReentrant whenNotPaused {
		uint256 len = quoteIds.length;
		require(amounts.length == len && prices.length == len, "SymmioPartyB: Array length mismatch");
		require(symmioAddress != address(0), "SymmioPartyB: Invalid address");
		require(
			hasRole(MANAGER_ROLE, msg.sender) || hasRole(TRUSTED_ROLE, msg.sender) || ISymmio(symmioAddress).isCallFromInstantLayer(),
			"SymmioPartyB: Invalid access"
		);

		for (uint256 i = 0; i < len; i++) {
			try ISymmio(symmioAddress).adlClose(quoteIds[i], amounts[i], prices[i]) {} catch Error(string memory reason) {
				emit ADLSkip(quoteIds[i], amounts[i], prices[i], reason);
			} catch (bytes memory revertData) {
				emit ADLSkip(quoteIds[i], amounts[i], prices[i], _revertDataToReason(revertData));
			}
		}
	}

	/**
	 * @dev Executes a call to a destination address with the provided call data.
	 * @param destAddress The destination address to call.
	 * @param callData The call data to be used for the call.
	 */
	function _executeCall(address destAddress, bytes memory callData) internal nonReentrant {
		require(destAddress != address(0), "SymmioPartyB: Invalid address");
		require(callData.length >= 4, "SymmioPartyB: Invalid call data");

		if (destAddress == symmioAddress) {
			bytes4 functionSelector;
			assembly {
				functionSelector := mload(add(callData, 0x20))
			}
			if (restrictedSelectors[functionSelector]) {
				_checkRole(MANAGER_ROLE, msg.sender);
			} else {
				require(
					hasRole(MANAGER_ROLE, msg.sender) || hasRole(TRUSTED_ROLE, msg.sender) || ISymmio(symmioAddress).isCallFromInstantLayer(),
					"SymmioPartyB: Invalid access"
				);
			}
		} else {
			require(multicastWhitelist[destAddress], "SymmioPartyB: Destination address is not whitelisted");
			_checkRole(TRUSTED_ROLE, msg.sender);
		}

		(bool success, ) = destAddress.call{ value: 0 }(callData);
		require(success, "SymmioPartyB: Execution reverted");
	}

	/**
	 * @dev Executes multiple calls to the Symmio contract.
	 * @param _callDatas An array of call data to be used for the calls.
	 */
	function _call(bytes[] calldata _callDatas) external whenNotPaused {
		for (uint8 i; i < _callDatas.length; i++) _executeCall(symmioAddress, _callDatas[i]);
	}

	/**
	 * @dev Executes multiple calls to specified destination addresses.
	 * @param destAddresses An array of destination addresses to call.
	 * @param _callDatas An array of call data to be used for the calls.
	 */
	function _multicastCall(address[] calldata destAddresses, bytes[] calldata _callDatas) external whenNotPaused {
		require(destAddresses.length == _callDatas.length, "SymmioPartyB: Array length mismatch");

		for (uint8 i; i < _callDatas.length; i++) _executeCall(destAddresses[i], _callDatas[i]);
	}

	/**
	 * @dev Withdraws ERC20 tokens from the contract to the caller.
	 * @param token The address of the ERC20 token.
	 * @param amount The amount of tokens to withdraw.
	 */
	function withdrawERC20(address token, uint256 amount) external onlyRole(MANAGER_ROLE) {
		require(IERC20Upgradeable(token).transfer(msg.sender, amount), "SymmioPartyB: Not transferred");
	}

	/**
	 * @dev Pauses the contract.
	 */
	function pause() external onlyRole(PAUSER_ROLE) {
		_pause();
	}

	/**
	 * @dev Unpauses the contract.
	 */
	function unpause() external onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}

	/* ──────────────────── ERC-1271 Implementation ──────────────────── */

	/**
	 * @notice Set the authorized signer for EIP-1271 signature verification.
	 * @param _signer Address of the new authorized signer.
	 *
	 * @dev Only callable by accounts with SETTER_ROLE.
	 */
	function setSigner(address _signer) external onlyRole(SETTER_ROLE) {
		signer = _signer;
	}

	/**
	 * @notice Verify signature validity using ERC-1271 standard for contract-based authentication.
	 * @param hash      Hash of the data that was signed.
	 * @param signature Signature bytes to verify.
	 * @return magicValue Magic value (0x1626ba7e) if signature is valid, 0xffffffff otherwise.
	 *
	 * @dev Delegates signature verification to the SignatureVerifier base contract
	 *      using the configured signer address for validation.
	 */
	function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4 magicValue) {
		magicValue = SignatureChecker.isValidSignatureNow(signer, hash, signature) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
	}
}
