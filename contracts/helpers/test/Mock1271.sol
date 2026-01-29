// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

contract Mock1271 {
    bytes4 constant internal MAGICVALUE = 0x1626ba7e;
    address public validSigner;

    constructor(address _validSigner) { validSigner = _validSigner; }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered,) = tryRecover(hash, signature);
        return recovered == validSigner ? MAGICVALUE : bytes4(0);
    }

    function tryRecover(bytes32 h, bytes memory sig) internal pure returns (address, bool) {
        if (sig.length != 65) return (address(0), false);
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := mload(add(sig, 32)) s := mload(add(sig, 64)) v := byte(0, mload(add(sig, 96))) }
        return (ecrecover(h, v, r, s), true);
    }
}

