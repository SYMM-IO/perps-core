// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
pragma solidity >=0.8.18;

/// @notice Pretends that a fee withdrawal succeeded without delivering any tokens.
contract AuditFakeFeeCore {
	address private immutable collateral;

	constructor(address token) {
		collateral = token;
	}

	function getCollateral() external view returns (address) {
		return collateral;
	}

	fallback() external {
		assembly {
			mstore(0, 1)
			mstore(32, 0)
			return(0, 64)
		}
	}
}

/// @notice Caller-controlled account manager used to exercise the relayer's source boundary.
contract AuditSourceMultiAccount {
	address private immutable owner;
	bool public called;

	constructor(address accountOwner) {
		owner = accountOwner;
	}

	function owners(address) external view returns (address) {
		return owner;
	}

	function _call(address, bytes[] calldata) external {
		called = true;
	}
}

/// @notice Attempts permissionless settlement from the last close hook, before haircut finalization.
contract AuditLiquidationSettlementHook {
	address private immutable core;
	address[] private partyBs;
	bool public settlementSucceeded;
	bytes public settlementFailure;

	constructor(address symmio, address[] memory solvers) {
		core = symmio;
		partyBs = solvers;
	}

	function onClosePosition(uint256, uint256, uint256, address partyA, address) external {
		(settlementSucceeded, settlementFailure) = core.call(abi.encodeWithSignature("settlePartyALiquidation(address,address[])", partyA, partyBs));
	}

	fallback() external {}
}
