// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAmaneAdapter} from "../AdapterRegistry.sol";

interface IAaveV3Pool {
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256);
}

/// REPAY a beneficiary's variable-rate debt on an Aave v3 pool. The core has already checked the
/// beneficiary and the (asset, debt token) pair, and measures the debt reduction itself. Unspent
/// input (when the debt is smaller than the amount) goes back to the account. Holds nothing.
contract AaveV3RepayAdapter is IAmaneAdapter {
    error ApproveFailed();
    error RefundFailed();

    uint256 internal constant VARIABLE_RATE = 2;
    IAaveV3Pool public immutable pool;

    constructor(IAaveV3Pool pool_) {
        pool = pool_;
    }

    function actionKind() external pure returns (uint8) {
        return 2;
    }

    function adapterName() external pure returns (string memory) {
        return "Aave V3 Repay";
    }

    function adapterVersion() external pure returns (uint32) {
        return 1;
    }

    function execute(address tokenIn, address, uint256 amountIn, uint256, address recipient) external {
        _call(tokenIn, abi.encodeWithSelector(0x095ea7b3, address(pool), amountIn), ApproveFailed.selector);
        uint256 repaid = pool.repay(tokenIn, amountIn, VARIABLE_RATE, recipient);
        if (repaid < amountIn) {
            _call(tokenIn, abi.encodeWithSelector(0x095ea7b3, address(pool), 0), ApproveFailed.selector);
            _call(tokenIn, abi.encodeWithSelector(0xa9059cbb, msg.sender, amountIn - repaid), RefundFailed.selector);
        }
    }

    function _call(address token, bytes memory data, bytes4 err) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) {
            assembly {
                mstore(0, err)
                revert(0, 4)
            }
        }
    }
}
