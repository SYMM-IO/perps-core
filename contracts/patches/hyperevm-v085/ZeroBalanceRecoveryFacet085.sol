// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// Copyright (c) 2023 Symmetry Labs AG
pragma solidity >=0.8.18;

import { GlobalAppStorage085 } from "./GlobalAppStorage085.sol";

/// @dev Exact first member of v0.8.5 AccountStorage.Layout. No other account fields are accessed.
library AccountBalanceStorage085 {
	bytes32 internal constant SLOT = keccak256("diamond.standard.storage.account");

	struct Layout {
		mapping(address => uint256) balances;
	}

	function layout() internal pure returns (Layout storage l) {
		bytes32 slot = SLOT;
		assembly {
			l.slot := slot
		}
	}
}

/// @notice Add-only recovery facet for the HyperEVM v0.8.5 Core diamond.
/// @dev Existing recovery selectors, amount units, and suspension rules remain unchanged.
contract ZeroBalanceRecoveryFacet085 {
	/// @dev Every amount is in internal 18-decimal units; source balance before equals amount, after equals zero.
	event ZeroAddressBalanceRecovered(
		address indexed operator,
		address indexed recipient,
		uint256 amount,
		uint256 recipientBalanceBefore,
		uint256 recipientBalanceAfter
	);

	/// @notice Move the full available zero-address balance, including dust, to an internal account.
	/// @dev Retains v0.8.5 pause, role and persistent-signer proxy guards. No token transfer or conversion.
	function recoverZeroAddressBalance(address recipient) external returns (uint256 amount) {
		GlobalAppStorage085.Layout storage app = GlobalAppStorage085.layout();
		require(!app.globalPaused, "Pausable: Global paused");
		require(!app.accountingPaused, "Pausable: Accounting paused");
		require(app.signer == address(0), "Accessibility: Cannot call via proxy");
		require(app.hasRole[msg.sender][keccak256("SUSPENDED_FUNDS_WITHDRAWER_ROLE")], "Accessibility: Must have role");
		require(recipient != address(0), "Recovery: Zero recipient");

		AccountBalanceStorage085.Layout storage account = AccountBalanceStorage085.layout();
		amount = account.balances[address(0)];
		require(amount != 0, "Recovery: Empty balance");
		uint256 beforeBalance = account.balances[recipient];
		uint256 afterBalance = beforeBalance + amount;
		account.balances[address(0)] = 0;
		account.balances[recipient] = afterBalance;
		emit ZeroAddressBalanceRecovered(msg.sender, recipient, amount, beforeBalance, afterBalance);
	}
}
