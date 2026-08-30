// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

/// @title ISymmioCore
/// @notice Minimal surface of the Symmio core diamond used by the gateway.
interface ISymmioCore {
	/// @notice Deposit `amount` of collateral, crediting `account`'s core balance.
	/// @dev Pulls collateral from `msg.sender` (the gateway), so the gateway must approve first.
	function depositFor(address account, uint256 amount) external;

	/// @notice The collateral token this core settles in.
	function getCollateral() external view returns (address);

	/// @notice Charge a standing operational fee of `amount` from `payer`'s Symmio collateral balance.
	/// @dev The gateway must be a registered operational-fee charger on the core. The charge is bounded by the
	///      standing per-(payer, charger) allowance and draws `payer`'s free balance first, then allocated margin.
	function chargeOperationalFee(address payer, uint256 amount) external;

	/// @notice Set the signer's standing operational-fee allowance for each charger.
	function approveOperationalFee(address[] calldata chargers, uint256[] calldata amounts) external;

	/// @notice Set the signer's standing allowance and fee multiplier for each charger.
	function approveOperationalFeeWithMultiplier(address[] calldata chargers, uint256[] calldata amounts, uint256[] calldata feeMultipliers) external;

	/// @notice Free (deposited, unallocated) collateral balance of `user` in 18 decimals.
	function balanceOf(address user) external view returns (uint256);

	/// @notice Allocated (margin) balance of partyA `partyA` in 18 decimals. Non-partyA accounts return 0.
	function allocatedBalanceOfPartyA(address partyA) external view returns (uint256);

	/// @notice Remaining operational-fee budget and priority multiplier this charger can draw from `payer`.
	/// @dev Matches perps-core v0.8.6 ViewFacet.getOperationalFeeAllowance. `feeMultiplier` uses
	///      10000 as the normal 1x value; the core view returns that default when storage is unset.
	function getOperationalFeeAllowance(
		address payer,
		address charger
	) external view returns (uint256 allowance, uint256 pendingAllowance, uint256 reductionReadyAt, uint256 feeMultiplier);
}
