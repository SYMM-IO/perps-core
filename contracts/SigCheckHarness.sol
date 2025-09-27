// SPDX-License-Identifier: GPL-3.0-or-later

pragma solidity >=0.8.18;

import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

contract SigCheckHarness {
	function check(address signer, bytes32 hash, bytes memory sig) external view returns (bool) {
		return SignatureChecker.isValidSignatureNow(signer, hash, sig);
	}
}
