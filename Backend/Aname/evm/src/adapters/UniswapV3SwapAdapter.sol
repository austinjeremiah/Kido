// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAmaneAdapter} from "../AdapterRegistry.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// SWAP exactly `amountIn` through one Uniswap v3 pool (fixed fee tier) with the output sent to the
/// calling account. The core enforces the owner's price floor and measures the output itself; the
/// router is also told the minimum so a bad fill reverts upstream. Holds nothing.
contract UniswapV3SwapAdapter is IAmaneAdapter {
    error ApproveFailed();

    ISwapRouter02 public immutable router;
    uint24 public immutable fee;

    constructor(ISwapRouter02 router_, uint24 fee_) {
        router = router_;
        fee = fee_;
    }

    function actionKind() external pure returns (uint8) {
        return 0;
    }

    function adapterName() external pure returns (string memory) {
        return "Uniswap V3 Swap";
    }

    function adapterVersion() external pure returns (uint32) {
        return 1;
    }

    function execute(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address) external {
        (bool ok, bytes memory ret) = tokenIn.call(abi.encodeWithSelector(0x095ea7b3, address(router), amountIn));
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) revert ApproveFailed();
        router.exactInputSingle(ISwapRouter02.ExactInputSingleParams(tokenIn, tokenOut, fee, msg.sender, amountIn, minAmountOut, 0));
    }
}
