// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Malicious target for ADV-008. On being called, it calls back into the executor with
///         the same capability, attempting a nested execution.
contract ReentrantTarget {
    address public executor;
    bytes public payload;
    bool public attempted;
    bool public reentryReverted;
    bytes public reentryError;

    function arm(address executor_, bytes calldata payload_) external {
        executor = executor_;
        payload = payload_;
        attempted = false;
        reentryReverted = false;
    }

    function poke(address, uint256) external {
        if (attempted || executor == address(0)) return;
        attempted = true;
        (bool ok, bytes memory err) = executor.call(payload);
        if (!ok) {
            reentryReverted = true;
            reentryError = err;
        }
    }

    receive() external payable {}
}
