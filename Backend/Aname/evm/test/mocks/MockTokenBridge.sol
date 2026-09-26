// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AmaneTestToken} from "../../src/AmaneTestToken.sol";
import {IWormholeTokenBridge} from "../../src/adapters/WormholeBridgeAdapter.sol";

/// Token-bridge stand-in with the rules that matter here: outbound pulls exactly `amount`; a
/// transfer-with-payload can only be completed by its `to` address, once.
contract MockTokenBridge {
    struct Sent { address token; uint256 amount; uint16 chain; bytes32 recipient; bytes payload; }
    Sent[] public sent;
    mapping(bytes32 => bool) public completed;
    uint16 public constant chainId = 10002;
    mapping(bytes32 => address) public wrapped;

    function setWrapped(uint16 chain, bytes32 origin, address token) external { wrapped[keccak256(abi.encode(chain, origin))] = token; }
    function wrappedAsset(uint16 chain, bytes32 origin) external view returns (address) { return wrapped[keccak256(abi.encode(chain, origin))]; }

    function transferTokensWithPayload(address token, uint256 amount, uint16 chain, bytes32 recipient, uint32, bytes memory payload) external payable returns (uint64) {
        AmaneTestToken(token).transferFrom(msg.sender, address(this), amount);
        sent.push(Sent(token, amount, chain, recipient, payload));
        return uint64(sent.length);
    }

    function lastPayload() external view returns (bytes memory) { return sent[sent.length - 1].payload; }

    /// "VAA" here is the ABI-encoded transfer; completion mints the (wrapped) token to `to`.
    function completeTransferWithPayload(bytes memory vm) external returns (bytes memory) {
        IWormholeTokenBridge.TransferWithPayload memory t = abi.decode(vm, (IWormholeTokenBridge.TransferWithPayload));
        require(address(uint160(uint256(t.to))) == msg.sender, "invalid sender");
        bytes32 h = keccak256(vm);
        require(!completed[h], "transfer already completed");
        completed[h] = true;
        address token = t.tokenChain == chainId ? address(uint160(uint256(t.tokenAddress))) : wrapped[keccak256(abi.encode(t.tokenChain, t.tokenAddress))];
        AmaneTestToken(token).mint(msg.sender, t.amount);
        return vm;
    }

    function parseTransferWithPayload(bytes memory encoded) external pure returns (IWormholeTokenBridge.TransferWithPayload memory) {
        return abi.decode(encoded, (IWormholeTokenBridge.TransferWithPayload));
    }
}
