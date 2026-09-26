// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title KidoLiveResolver
/// @notice Serves a Kido agent's live state (status, health factor, lease, holdings) under an ENS
///         name through CCIP-read (ERC-3668 / ENSIP-10). Every answer comes from Kido's gateway and
///         is accepted only when signed by the gateway key and not yet expired, so a client can
///         verify what it reads. Live state is information, never authority.
contract KidoLiveResolver {
    error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData);
    error SignatureExpired();
    error InvalidSigner();
    error NotOwner();

    event GatewayChanged(string url);

    address public immutable signer;
    address public immutable owner;
    string public url;

    constructor(string memory url_, address signer_) {
        url = url_;
        signer = signer_;
        owner = msg.sender;
    }

    /// @notice Moves the gateway (for example from a local Kido to a public host). The signer stays fixed.
    function setUrl(string calldata url_) external {
        if (msg.sender != owner) revert NotOwner();
        url = url_;
        emit GatewayChanged(url_);
    }

    /// @notice ENSIP-10 entry point: always defers to the gateway.
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory) {
        bytes memory callData = abi.encodeWithSelector(this.resolve.selector, name, data);
        string[] memory urls = new string[](1);
        urls[0] = url;
        revert OffchainLookup(address(this), urls, callData, this.resolveWithProof.selector, callData);
    }

    /// @notice CCIP-read callback: the gateway returns abi.encode(result, expires, signature).
    function resolveWithProof(bytes calldata response, bytes calldata extraData) external view returns (bytes memory) {
        (bytes memory result, uint64 expires, bytes memory sig) = abi.decode(response, (bytes, uint64, bytes));
        if (expires < block.timestamp) revert SignatureExpired();
        if (_recover(makeSignatureHash(address(this), expires, extraData, result), sig) != signer) revert InvalidSigner();
        return result;
    }

    /// @notice The digest the gateway signs (the ENS offchain-resolver scheme).
    function makeSignatureHash(address target, uint64 expires, bytes memory request, bytes memory result) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1900", target, expires, keccak256(request), keccak256(result)));
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x9061b923; // ERC-165, IExtendedResolver
    }

    function _recover(bytes32 h, bytes memory sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        // Reject malleable (high-s) signatures.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(h, v, r, s);
    }
}
