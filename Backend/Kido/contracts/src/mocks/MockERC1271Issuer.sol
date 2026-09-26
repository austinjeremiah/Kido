// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Contract capability issuer for CAP-012.
/// @dev Two modes so both the accept and the wrong-magic-value paths are testable.
contract MockERC1271Issuer {
    bytes4 internal constant MAGIC = 0x1626ba7e; // isValidSignature(bytes32,bytes)
    bytes4 internal constant WRONG = 0xffffffff;

    address public signer;
    bool public returnWrongMagic;

    constructor(address signer_) {
        signer = signer_;
    }

    function setReturnWrongMagic(bool v) external {
        returnWrongMagic = v;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (returnWrongMagic) return WRONG;
        if (signature.length != 65) return WRONG;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        return ecrecover(hash, v, r, s) == signer ? MAGIC : WRONG;
    }
}
