// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import "../accountHub/AccountHub.sol";

contract AccountsHubHelper is AccountsHub {
	function exposedGenerateAccountManagerAddress(string memory name) external view returns (address) {
		return _generateAccountManagerAddress(name);
	}

	function exposedGenerateFeeDistributorAddress(address affiliate, uint256 nonce) external pure returns (address) {
		return _generateFeeDistributorAddress(affiliate, nonce);
	}

	function getAffiliateData(address affiliate)
		external
		view
		returns (
			string memory name,
			string memory brandColor,
			address admin,
			AffiliateState state,
			uint256 symmioShare,
			Stakeholder[] memory stakeholders,
			address accountManager,
			address feeDistributor
		)
	{
		AffiliateData storage data = affiliates[affiliate];
		uint256 stakeholdersLength = data.feeDetails.stakeholders.length;
		stakeholders = new Stakeholder[](stakeholdersLength);
		for (uint256 i = 0; i < stakeholdersLength; i++) {
			stakeholders[i] = data.feeDetails.stakeholders[i];
		}
		return (data.name, data.brandColor, data.admin, data.state, data.feeDetails.symmioShare, stakeholders, data.accountManager, data.feeDistributor);
	}
}
