// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.8.18;

/******************************************************************************\
* Author: Nick Mudge <nick@perfectabstractions.com> (https://twitter.com/mudgen)
* EIP-2535 Diamonds: https://eips.ethereum.org/EIPS/eip-2535
/******************************************************************************/

import { IDiamondCut } from "../facets/DiamondCut/IDiamondCut.sol";

library LibDiamond {
	bytes32 public constant DIAMOND_STORAGE_POSITION = keccak256("diamond.standard.diamond.storage");

	/// @notice Pairs a facet address with its selector position in the selectors array
	struct FacetAddressAndSelectorPosition {
		address facetAddress;
		uint16 selectorPosition;
	}

	/// @notice Central storage layout for the diamond proxy
	struct DiamondStorage {
		// function selector => facet address and selector position in selectors array
		mapping(bytes4 => FacetAddressAndSelectorPosition) facetAddressAndSelectorPosition;
		bytes4[] selectors;
		mapping(bytes4 => bool) supportedInterfaces;
		// owner of the contract
		address contractOwner;
		// address of new Owner
		address pendingOwner;
	}

	/// @notice Returns the diamond storage pointer at the predetermined slot
	function diamondStorage() internal pure returns (DiamondStorage storage ds) {
		bytes32 position = DIAMOND_STORAGE_POSITION;
		assembly {
			ds.slot := position
		}
	}

	/// @notice Emitted when ownership is transferred to a new owner
	event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
	/// @notice Emitted when a two-step ownership transfer is initiated
	event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
	/// @notice Emitted when a pending ownership transfer is canceled
	event OwnershipTransferCanceled(address indexed pendingOwner);

	/// @notice Sets the contract owner directly, bypassing the two-step process
	function setContractOwner(address _newOwner) internal {
		DiamondStorage storage ds = diamondStorage();
		address previousOwner = ds.contractOwner;
		ds.contractOwner = _newOwner;
		emit OwnershipTransferred(previousOwner, _newOwner);
	}

	/// @notice Initiates a two-step ownership transfer by setting a pending owner
	function transferOwnership(address _newOwner) internal {
		DiamondStorage storage ds = diamondStorage();
		ds.pendingOwner = _newOwner;
		emit OwnershipTransferStarted(ds.contractOwner, _newOwner);
	}

	/// @notice Cancels a pending ownership transfer
	function cancelOwnershipTransfer() internal {
		DiamondStorage storage ds = diamondStorage();
		require(ds.pendingOwner != address(0), "LibDiamond: Pending owner is zero");
		emit OwnershipTransferCanceled(ds.pendingOwner);
		ds.pendingOwner = address(0);
	}

	/// @notice Completes the two-step ownership transfer when called by the pending owner
	function acceptOwnership() internal {
		DiamondStorage storage ds = diamondStorage();
		require(msg.sender == ds.pendingOwner, "LibDiamond: Sender should be the pendingOwner");
		emit OwnershipTransferred(ds.contractOwner, ds.pendingOwner);
		ds.contractOwner = ds.pendingOwner;
		ds.pendingOwner = address(0);
	}

	/// @notice Returns the current contract owner address
	function contractOwner() internal view returns (address contractOwner_) {
		contractOwner_ = diamondStorage().contractOwner;
	}

	/// @notice Reverts if the caller is not the contract owner or the diamond itself
	function enforceIsOwnerOrContract() internal view {
		require(msg.sender == diamondStorage().contractOwner || msg.sender == address(this), "LibDiamond: Must be contract or owner");
	}

	/// @notice Reverts if the caller is not the contract owner
	function enforceIsContractOwner() internal view {
		require(msg.sender == diamondStorage().contractOwner, "LibDiamond: Must be contract owner");
	}

	/// @notice Emitted when a diamond cut is performed
	event DiamondCut(IDiamondCut.FacetCut[] _diamondCut, address _init, bytes _calldata);

	/// @notice Executes a diamond cut to add, replace, or remove facet functions
	function diamondCut(IDiamondCut.FacetCut[] memory _diamondCut, address _init, bytes memory _calldata) internal {
		for (uint256 facetIndex; facetIndex < _diamondCut.length; facetIndex++) {
			IDiamondCut.FacetCutAction action = _diamondCut[facetIndex].action;
			if (action == IDiamondCut.FacetCutAction.Add) {
				addFunctions(_diamondCut[facetIndex].facetAddress, _diamondCut[facetIndex].functionSelectors);
			} else if (action == IDiamondCut.FacetCutAction.Replace) {
				replaceFunctions(_diamondCut[facetIndex].facetAddress, _diamondCut[facetIndex].functionSelectors);
			} else if (action == IDiamondCut.FacetCutAction.Remove) {
				removeFunctions(_diamondCut[facetIndex].facetAddress, _diamondCut[facetIndex].functionSelectors);
			} else {
				revert("LibDiamondCut: Incorrect FacetCutAction");
			}
		}
		emit DiamondCut(_diamondCut, _init, _calldata);
		initializeDiamondCut(_init, _calldata);
	}

	/// @notice Registers new function selectors and maps them to a facet address
	function addFunctions(address _facetAddress, bytes4[] memory _functionSelectors) internal {
		require(_functionSelectors.length > 0, "LibDiamondCut: No selectors in facet to cut");
		DiamondStorage storage ds = diamondStorage();
		uint16 selectorCount = uint16(ds.selectors.length);
		require(_facetAddress != address(0), "LibDiamondCut: Add facet can't be address(0)");
		enforceHasContractCode(_facetAddress, "LibDiamondCut: Add facet has no code");
		for (uint256 selectorIndex; selectorIndex < _functionSelectors.length; selectorIndex++) {
			bytes4 selector = _functionSelectors[selectorIndex];
			address oldFacetAddress = ds.facetAddressAndSelectorPosition[selector].facetAddress;
			require(oldFacetAddress == address(0), "LibDiamondCut: Can't add function that already exists");
			ds.facetAddressAndSelectorPosition[selector] = FacetAddressAndSelectorPosition(_facetAddress, selectorCount);
			ds.selectors.push(selector);
			selectorCount++;
		}
	}

	/// @notice Replaces the facet address for existing function selectors
	function replaceFunctions(address _facetAddress, bytes4[] memory _functionSelectors) internal {
		require(_functionSelectors.length > 0, "LibDiamondCut: No selectors in facet to cut");
		DiamondStorage storage ds = diamondStorage();
		require(_facetAddress != address(0), "LibDiamondCut: Replace facet can't be address(0)");
		enforceHasContractCode(_facetAddress, "LibDiamondCut: Replace facet has no code");
		for (uint256 selectorIndex; selectorIndex < _functionSelectors.length; selectorIndex++) {
			bytes4 selector = _functionSelectors[selectorIndex];
			address oldFacetAddress = ds.facetAddressAndSelectorPosition[selector].facetAddress;
			// can't replace immutable functions -- functions defined directly in the diamond
			require(oldFacetAddress != address(this), "LibDiamondCut: Can't replace immutable function");
			require(oldFacetAddress != _facetAddress, "LibDiamondCut: Can't replace function with same function");
			require(oldFacetAddress != address(0), "LibDiamondCut: Can't replace function that doesn't exist");
			// replace old facet address
			ds.facetAddressAndSelectorPosition[selector].facetAddress = _facetAddress;
		}
	}

	/// @notice Removes function selectors from the diamond
	function removeFunctions(address _facetAddress, bytes4[] memory _functionSelectors) internal {
		require(_functionSelectors.length > 0, "LibDiamondCut: No selectors in facet to cut");
		DiamondStorage storage ds = diamondStorage();
		uint256 selectorCount = ds.selectors.length;
		require(_facetAddress == address(0), "LibDiamondCut: Remove facet address must be address(0)");
		for (uint256 selectorIndex; selectorIndex < _functionSelectors.length; selectorIndex++) {
			bytes4 selector = _functionSelectors[selectorIndex];
			FacetAddressAndSelectorPosition memory oldFacetAddressAndSelectorPosition = ds.facetAddressAndSelectorPosition[selector];
			require(oldFacetAddressAndSelectorPosition.facetAddress != address(0), "LibDiamondCut: Can't remove function that doesn't exist");
			// can't remove immutable functions -- functions defined directly in the diamond
			require(oldFacetAddressAndSelectorPosition.facetAddress != address(this), "LibDiamondCut: Can't remove immutable function.");
			// replace selector with last selector
			selectorCount--;
			if (oldFacetAddressAndSelectorPosition.selectorPosition != selectorCount) {
				bytes4 lastSelector = ds.selectors[selectorCount];
				ds.selectors[oldFacetAddressAndSelectorPosition.selectorPosition] = lastSelector;
				ds.facetAddressAndSelectorPosition[lastSelector].selectorPosition = oldFacetAddressAndSelectorPosition.selectorPosition;
			}
			// delete last selector
			ds.selectors.pop();
			delete ds.facetAddressAndSelectorPosition[selector];
		}
	}

	/// @notice Executes an initialization function via delegatecall after a diamond cut
	function initializeDiamondCut(address _init, bytes memory _calldata) internal {
		if (_init == address(0)) {
			require(_calldata.length == 0, "LibDiamondCut: _init is address(0) but_calldata is not empty");
		} else {
			require(_calldata.length > 0, "LibDiamondCut: _calldata is empty but _init is not address(0)");
			if (_init != address(this)) {
				enforceHasContractCode(_init, "LibDiamondCut: _init address has no code");
			}
			(bool success, bytes memory error) = _init.delegatecall(_calldata);
			if (!success) {
				if (error.length > 0) {
					// bubble up the error
					revert(string(error));
				} else {
					revert("LibDiamondCut: _init function reverted");
				}
			}
		}
	}

	/// @notice Reverts if the given address has no deployed contract code
	function enforceHasContractCode(address _contract, string memory _errorMessage) internal view {
		uint256 contractSize;
		assembly {
			contractSize := extcodesize(_contract)
		}
		require(contractSize > 0, _errorMessage);
	}
}
