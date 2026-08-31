// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { LockedValues, Quote } from "../storages/QuoteStorage.sol";

library LockedValuesOps {
	/// @notice Adds the values of two LockedValues structs.
	/// @param self The LockedValues struct to which values will be added.
	/// @param a The LockedValues struct containing values to be added.
	/// @return The updated LockedValues struct.
	function add(LockedValues storage self, LockedValues memory a) internal returns (LockedValues storage) {
		self.cva += a.cva;
		self.partyAmm += a.partyAmm;
		self.partyBmm += a.partyBmm;
		self.lf += a.lf;
		return self;
	}

	/// @notice Adds the locked values of a quote to a LockedValues struct.
	/// @param self The LockedValues struct to which values will be added.
	/// @param quote The Quote struct containing locked values to be added.
	/// @return The updated LockedValues struct.
	function addQuote(LockedValues storage self, Quote storage quote) internal returns (LockedValues storage) {
		return add(self, quote.lockedValues);
	}

	/// @notice Subtracts the values of two LockedValues structs.
	/// @param self The LockedValues struct from which values will be subtracted.
	/// @param a The LockedValues struct containing values to be subtracted.
	/// @return The updated LockedValues struct.
	function sub(LockedValues storage self, LockedValues memory a) internal returns (LockedValues storage) {
		self.cva -= a.cva;
		self.partyAmm -= a.partyAmm;
		self.partyBmm -= a.partyBmm;
		self.lf -= a.lf;
		return self;
	}

	/// @notice Subtracts the locked values of a quote from a LockedValues struct.
	/// @param self The LockedValues struct from which values will be subtracted.
	/// @param quote The Quote struct containing locked values to be subtracted.
	/// @return The updated LockedValues struct.
	function subQuote(LockedValues storage self, Quote storage quote) internal returns (LockedValues storage) {
		return sub(self, quote.lockedValues);
	}

	/// @notice Sets all values of a LockedValues struct to zero.
	/// @param self The LockedValues struct to be zeroed.
	/// @return The updated LockedValues struct.
	function makeZero(LockedValues storage self) internal returns (LockedValues storage) {
		self.cva = 0;
		self.partyAmm = 0;
		self.partyBmm = 0;
		self.lf = 0;
		return self;
	}

	/// @notice Calculates the total locked balance for Party A.
	/// @param self The LockedValues struct containing locked values.
	/// @return The total locked balance for Party A.
	function totalForPartyA(LockedValues memory self) internal pure returns (uint256) {
		return self.cva + self.partyAmm + self.lf;
	}

	/// @notice Calculates the total locked balance for Party B.
	/// @param self The LockedValues struct containing locked values.
	/// @return The total locked balance for Party B.
	function totalForPartyB(LockedValues memory self) internal pure returns (uint256) {
		return self.cva + self.partyBmm + self.lf;
	}

	/// @notice Multiplies all values of a LockedValues struct by a scalar value.
	/// @param self The LockedValues struct to be multiplied.
	/// @param a The scalar value to multiply by.
	/// @return The updated LockedValues struct.
	function mul(LockedValues storage self, uint256 a) internal returns (LockedValues storage) {
		self.cva *= a;
		self.partyAmm *= a;
		self.partyBmm *= a;
		self.lf *= a;
		return self;
	}

	/// @notice Multiplies all values of a LockedValues struct by a scalar value (memory version).
	/// @param self The LockedValues struct to be multiplied.
	/// @param a The scalar value to multiply by.
	/// @return The updated LockedValues struct.
	function mulMem(LockedValues memory self, uint256 a) internal pure returns (LockedValues memory) {
		LockedValues memory lockedValues = LockedValues(self.cva * a, self.lf * a, self.partyAmm * a, self.partyBmm * a);
		return lockedValues;
	}

	/// @notice Divides all values of a LockedValues struct by a scalar value.
	/// @param self The LockedValues struct to be divided.
	/// @param a The scalar value to divide by.
	/// @return The updated LockedValues struct.
	function div(LockedValues storage self, uint256 a) internal returns (LockedValues storage) {
		self.cva /= a;
		self.partyAmm /= a;
		self.partyBmm /= a;
		self.lf /= a;
		return self;
	}

	/// @notice Divides all values of a LockedValues struct by a scalar value (memory version).
	/// @param self The LockedValues struct to be divided.
	/// @param a The scalar value to divide by.
	/// @return The updated LockedValues struct.
	function divMem(LockedValues memory self, uint256 a) internal pure returns (LockedValues memory) {
		LockedValues memory lockedValues = LockedValues(self.cva / a, self.lf / a, self.partyAmm / a, self.partyBmm / a);
		return lockedValues;
	}
}
