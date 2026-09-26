// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAmaneAdapter} from "../AdapterRegistry.sol";

interface IWormholeTokenBridge {
    struct TransferWithPayload {
        uint8 payloadID;
        uint256 amount;
        bytes32 tokenAddress;
        uint16 tokenChain;
        bytes32 to;
        uint16 toChain;
        bytes32 fromAddress;
        bytes payload;
    }

    function transferTokensWithPayload(address token, uint256 amount, uint16 recipientChain, bytes32 recipient, uint32 nonce, bytes memory payload) external payable returns (uint64);
    function completeTransferWithPayload(bytes memory encodedVm) external returns (bytes memory);
    function parseTransferWithPayload(bytes memory encoded) external pure returns (TransferWithPayload memory);
    function wrappedAsset(uint16 tokenChainId, bytes32 tokenAddress) external view returns (address);
    function chainId() external view returns (uint16);
}

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/// Amane BRIDGE transport over Wormhole Wrapped Token Transfers, for one peer chain.
/// Outbound: sends the account's tokens with payload (intent, destination endpoint) to the peer
/// chain's pinned Amane bridge adapter. Inbound: redeems a transfer-with-payload addressed to this
/// adapter, accepts it only from the peer's pinned Amane bridge emitter, and forwards the tokens
/// only to the account named in the payload, which must be the caller. It holds nothing between
/// calls and never decides what the funds may be used for.
contract WormholeBridgeAdapter is IAmaneAdapter {
    error WrongPeer();
    error WrongDestination();
    error BadPayload();
    error TransferFailed();

    IWormholeTokenBridge public immutable tokenBridge;
    uint16 public immutable peerChain;
    /// Peer adapter's redeeming identity on the peer chain (on Sui: its EmitterCap id).
    bytes32 public immutable peerRecipient;
    /// Peer adapter's sending identity as it appears in `fromAddress` of its transfers.
    bytes32 public immutable peerEmitter;

    constructor(IWormholeTokenBridge tokenBridge_, uint16 peerChain_, bytes32 peerRecipient_, bytes32 peerEmitter_) {
        tokenBridge = tokenBridge_;
        peerChain = peerChain_;
        peerRecipient = peerRecipient_;
        peerEmitter = peerEmitter_;
    }

    function actionKind() external pure returns (uint8) {
        return 10;
    }

    function adapterName() external pure returns (string memory) {
        return "Wormhole Bridge";
    }

    function adapterVersion() external pure returns (uint32) {
        return 1;
    }

    function execute(address, address, uint256, uint256, address) external pure {
        revert("use bridge");
    }

    function bridge(address token, uint256 amount, bytes32 recipient, bytes32 intent) external {
        if (!IERC20Min(token).approve(address(tokenBridge), amount)) revert TransferFailed();
        tokenBridge.transferTokensWithPayload(token, amount, peerChain, peerRecipient, 0, abi.encodePacked(intent, recipient));
    }

    function redeem(bytes calldata vaa) external returns (bytes32 intent) {
        IWormholeTokenBridge.TransferWithPayload memory t = tokenBridge.parseTransferWithPayload(tokenBridge.completeTransferWithPayload(vaa));
        if (t.fromAddress != peerEmitter) revert WrongPeer();
        if (t.payload.length != 64) revert BadPayload();
        bytes memory p = t.payload;
        bytes32 dest;
        assembly {
            intent := mload(add(p, 32))
            dest := mload(add(p, 64))
        }
        if (dest != bytes32(uint256(uint160(msg.sender)))) revert WrongDestination();
        address token = t.tokenChain == tokenBridge.chainId() ? address(uint160(uint256(t.tokenAddress))) : tokenBridge.wrappedAsset(t.tokenChain, t.tokenAddress);
        uint256 bal = IERC20Min(token).balanceOf(address(this));
        if (!IERC20Min(token).transfer(msg.sender, bal)) revert TransferFailed();
    }
}
