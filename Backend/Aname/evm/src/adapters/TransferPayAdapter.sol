// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAmaneAdapter} from "../AdapterRegistry.sol";

/// PAY to a recipient the core has already checked against the pinned recipient set.
/// Holds no funds between calls; the core measures the recipient's balance delta.
contract TransferPayAdapter is IAmaneAdapter {
    error TransferFailed();

    function actionKind() external pure returns (uint8) {
        return 9;
    }

    function adapterName() external pure returns (string memory) {
        return "Transfer Pay";
    }

    function adapterVersion() external pure returns (uint32) {
        return 1;
    }

    function execute(address tokenIn, address, uint256 amountIn, uint256, address recipient) external {
        (bool ok, bytes memory ret) = tokenIn.call(abi.encodeWithSelector(0xa9059cbb, recipient, amountIn));
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) revert TransferFailed();
    }
}
