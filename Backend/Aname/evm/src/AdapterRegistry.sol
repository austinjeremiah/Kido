// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IAmaneAdapter {
    function actionKind() external view returns (uint8);
    function adapterName() external view returns (string memory);
    function adapterVersion() external view returns (uint32);

    /// Called by an Amane account after it has transferred exactly `amountIn` of `tokenIn` to the
    /// adapter. Output must be sent to msg.sender (SWAP) or to `recipient` (PAY/REPAY beneficiary).
    function execute(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient) external;
}

/// Append-only registry. An adapter id commits to the chain, action kind, name, version, address
/// and runtime code hash (immutables included). Registration also rejects runtime code that can
/// change behaviour without changing its code hash (DELEGATECALL, CALLCODE, SELFDESTRUCT, SSTORE),
/// so an id can never change meaning through its own code. Behaviour of the upstream protocol an
/// adapter calls is outside this guarantee and is pinned per adapter manifest instead.
contract AdapterRegistry {
    bytes32 public constant ADAPTER_TAG = keccak256("AMANE_ADAPTER_V1");

    struct Entry {
        address adapter;
        uint8 actionKind;
        uint32 adapterVersion;
        bytes32 nameHash;
        bytes32 codeHash;
    }

    bytes32 public immutable chainRef;
    mapping(bytes32 => Entry) private entries;

    event AdapterRegistered(bytes32 indexed adapterId, address indexed adapter, uint8 actionKind, string adapterName, uint32 adapterVersion);

    error AlreadyRegistered(bytes32 adapterId);
    error NotAContract();
    error MutableAdapterCode(uint256 offset, uint8 opcode);

    constructor() {
        chainRef = keccak256(abi.encodePacked("eip155:", _toString(block.chainid)));
    }

    function computeId(uint8 kind, uint32 version, string memory name, address adapter, bytes32 codeHash)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(ADAPTER_TAG, chainRef, kind, version, keccak256(bytes(name)), adapter, codeHash));
    }

    function register(address adapter) external returns (bytes32 id) {
        if (adapter.code.length == 0) revert NotAContract();
        _assertImmutableCode(adapter.code);
        IAmaneAdapter a = IAmaneAdapter(adapter);
        uint8 kind = a.actionKind();
        uint32 version = a.adapterVersion();
        string memory name = a.adapterName();
        bytes32 codeHash = adapter.codehash;
        id = computeId(kind, version, name, adapter, codeHash);
        if (entries[id].adapter != address(0)) revert AlreadyRegistered(id);
        entries[id] = Entry(adapter, kind, version, keccak256(bytes(name)), codeHash);
        emit AdapterRegistered(id, adapter, kind, name, version);
    }

    function get(bytes32 id) external view returns (Entry memory) {
        return entries[id];
    }

    function _assertImmutableCode(bytes memory code) private pure {
        uint256 i;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            if (op == 0xf4 || op == 0xf2 || op == 0xff || op == 0x55) revert MutableAdapterCode(i, op);
            // Code after an INVALID byte is still reachable through a JUMPDEST, so the whole runtime
            // is scanned; constant data that happens to contain a forbidden byte is rejected too.
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
            ++i;
        }
    }

    function _toString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) ++len;
        bytes memory b = new bytes(len);
        for (; v != 0; v /= 10) b[--len] = bytes1(uint8(48 + v % 10));
        return string(b);
    }
}
