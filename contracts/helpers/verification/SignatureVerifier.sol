// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

contract SignatureVerifier {
	function verifySignature(address signer, bytes32 hash, bytes memory signature) public view returns (bool) {
		return SignatureChecker.isValidSignatureNow(signer, hash, signature);
	}
}
