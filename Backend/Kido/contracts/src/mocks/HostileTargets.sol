// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Deliberately badly-behaved targets for P8.12.
/// @dev The point is not that these succeed or fail, but that whatever they do, the executor's own
///      state and the real treasury target are unaffected.
library HostileTargets {
// solhint-disable no-empty-blocks
}

/// Always reverts.
contract Reverter {
    error AlwaysFails();

    function poke(address, uint256) external pure {
        revert AlwaysFails();
    }
}

/// Burns all forwarded gas.
contract GasBurner {
    uint256 public sink;

    function poke(address, uint256) external {
        // Unbounded loop, bounded only by the gas the executor forwards. Proves the executor
        // cannot be made to do unbounded work on the CALLER's behalf — the target burns its own
        // forwarded gas and the call simply runs out.
        for (uint256 i = 0; i < type(uint256).max; i++) {
            sink = i;
        }
    }
}

/// Returns malformed/oversized return data.
contract BadReturn {
    function poke(address, uint256) external pure returns (bytes memory) {
        // 100 KB of return data. The executor must not choke interpreting it — it does not
        // interpret return data at all, which is the property under test.
        return new bytes(100_000);
    }
}

/// Re-enters via a callback rather than directly.
contract CallbackTarget {
    address public executor;
    bytes public payload;
    bool public attempted;
    bool public reentryReverted;

    function arm(address executor_, bytes calldata payload_) external {
        executor = executor_;
        payload = payload_;
        attempted = false;
        reentryReverted = false;
    }

    function poke(address, uint256) external {
        if (attempted || executor == address(0)) return;
        attempted = true;
        (bool ok,) = executor.call(payload);
        if (!ok) reentryReverted = true;
    }
}
