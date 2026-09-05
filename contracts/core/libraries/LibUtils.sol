// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

library LibUtils {
	/// @notice Gets the index of an item in an array.
	/// @param array_ The array in which to search for the item.
	/// @param item The item to find the index of.
	/// @return The index of the item in the array, or type(uint256).max if the item is not found.
	function getIndexOfItem(uint256[] storage array_, uint256 item) internal view returns (uint256) {
		for (uint256 index = 0; index < array_.length; index++) {
			if (array_[index] == item) return index;
		}
		return type(uint256).max;
	}

	/// @notice Removes an item from an array.
	/// @param array_ The array from which to remove the item.
	/// @param item The item to remove from the array.
	function removeFromArray(uint256[] storage array_, uint256 item) internal {
		uint256 index = getIndexOfItem(array_, item);
		require(index != type(uint256).max, "LibUtils: Item not Found");
		array_[index] = array_[array_.length - 1];
		array_.pop();
	}

	/// @notice Returns |a - b| for two signed values without intermediate overflow.
	/// @dev For a >= b the true difference lies in [0, 2^256), so the two's-complement subtraction is exact.
	function absDiff(int256 a, int256 b) internal pure returns (uint256) {
		unchecked {
			return a >= b ? uint256(a) - uint256(b) : uint256(b) - uint256(a);
		}
	}
}
