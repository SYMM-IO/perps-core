// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { SubAccountCreationData } from "../accountLayer/storages/AccountHubStorage.sol";

contract MockAffiliateHubForAccountManager {
	mapping(address => address[]) private affiliateCores;

	function setAffiliateCores(address affiliate, address[] memory cores) external {
		affiliateCores[affiliate] = cores;
	}

	function getAffiliateSymmioCores(address affiliate) external view returns (address[] memory) {
		address[] memory cores = affiliateCores[affiliate];
		require(cores.length > 0, "MockAffiliateHub: no cores configured");
		return cores;
	}
}

contract MockAccountHubForAccountManager {
	address public signer;
	address public lastCallAccount;
	address public lastCreateAffiliate;
	address public affiliateHub;

	mapping(address => address) public relatedCores;
	mapping(address => address[]) public affiliateCores;

	address[] private signerLog;
	address[] private pendingCreateResult;
	SubAccountCreationData[] private lastCreateData;
	bytes[] private lastCallData;
	uint256 private autoNonce;
	bool private revertOnCreate;
	bool private revertOnCall;
	bool private requireRelatedCore;

	function setSigner(address _signer) external {
		signer = _signer;
		signerLog.push(_signer);
	}

	function setAffiliateHub(address _affiliateHub) external {
		affiliateHub = _affiliateHub;
	}

	function configureRelatedCore(address account, address core) external {
		relatedCores[account] = core;
	}

	function configureNextCreateResult(address[] memory accounts) external {
		delete pendingCreateResult;
		for (uint256 i = 0; i < accounts.length; i++) {
			pendingCreateResult.push(accounts[i]);
		}
	}

	function setRevertOnCreate(bool status) external {
		revertOnCreate = status;
	}

	function setRevertOnCall(bool status) external {
		revertOnCall = status;
	}

	function setRequireRelatedCore(bool status) external {
		requireRelatedCore = status;
	}

	function setAffiliateCores(address affiliate, address[] memory cores) external {
		affiliateCores[affiliate] = cores;
	}

	function getAffiliateSymmioCores(address affiliate) external view returns (address[] memory) {
		address[] memory cores = affiliateCores[affiliate];
		require(cores.length > 0, "MockAffiliateHub: no cores configured");
		return cores;
	}

	function createSubAccounts(address affiliate, SubAccountCreationData[] memory data) external returns (address[] memory) {
		if (revertOnCreate) {
			revertOnCreate = false;
			revert("MockAccountHub: create reverted");
		}

		lastCreateAffiliate = affiliate;
		delete lastCreateData;
		for (uint256 i = 0; i < data.length; i++) {
			lastCreateData.push(data[i]);
		}

		address[] memory created = new address[](data.length);
		for (uint256 i = 0; i < data.length; i++) {
			if (i < pendingCreateResult.length) {
				created[i] = pendingCreateResult[i];
			} else {
				autoNonce++;
				created[i] = address(uint160(autoNonce));
			}
		}
		delete pendingCreateResult;
		return created;
	}

	function _call(address account, bytes[] memory callDatas) external returns (bytes[] memory) {
		if (revertOnCall) {
			revertOnCall = false;
			revert("MockAccountHub: call reverted");
		}

		lastCallAccount = account;
		delete lastCallData;
		for (uint256 i = 0; i < callDatas.length; i++) {
			lastCallData.push(callDatas[i]);
		}

		return callDatas;
	}

	function getRelatedCore(address account) external view returns (address) {
		if (requireRelatedCore && relatedCores[account] == address(0)) {
			revert("MockAccountHub: core not set");
		}
		return relatedCores[account];
	}

	function getLastCreateData() external view returns (SubAccountCreationData[] memory) {
		SubAccountCreationData[] memory copy = new SubAccountCreationData[](lastCreateData.length);
		for (uint256 i = 0; i < lastCreateData.length; i++) {
			copy[i] = lastCreateData[i];
		}
		return copy;
	}

	function getLastCallData() external view returns (bytes[] memory) {
		bytes[] memory copy = new bytes[](lastCallData.length);
		for (uint256 i = 0; i < lastCallData.length; i++) {
			copy[i] = lastCallData[i];
		}
		return copy;
	}

	function getSignerLog() external view returns (address[] memory) {
		address[] memory copy = new address[](signerLog.length);
		for (uint256 i = 0; i < signerLog.length; i++) {
			copy[i] = signerLog[i];
		}
		return copy;
	}

	function resetTracking() external {
		delete signerLog;
		delete lastCallData;
		delete lastCreateData;
		delete pendingCreateResult;
		revertOnCall = false;
		revertOnCreate = false;
		requireRelatedCore = false;
		signer = address(0);
		lastCallAccount = address(0);
		lastCreateAffiliate = address(0);
	}
}

contract MockSymmioCoreForAccountManager {
	address public collateral;

	function setCollateral(address _collateral) external {
		collateral = _collateral;
	}

	function getCollateral() external view returns (address) {
		return collateral;
	}
}
