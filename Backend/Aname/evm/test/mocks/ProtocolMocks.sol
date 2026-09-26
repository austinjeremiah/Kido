// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AmaneTestToken} from "../../src/AmaneTestToken.sol";
import {ISwapRouter02} from "../../src/adapters/UniswapV3SwapAdapter.sol";

/// Variable-debt token stand-in: balanceOf is the borrower's debt, changed only by the pool.
contract MockDebtToken {
    mapping(address => uint256) public balanceOf;
    address public immutable pool;

    constructor(address pool_) {
        pool = pool_;
    }

    function set(address who, uint256 v) external {
        require(msg.sender == pool);
        balanceOf[who] = v;
    }
}

/// Aave v3 Pool stand-in with the real repay semantics: pulls min(amount, debt) and reduces debt.
contract MockAavePool {
    MockDebtToken public debt;

    function setDebtToken(MockDebtToken d) external {
        debt = d;
    }

    function borrowFor(address who, uint256 v) external {
        debt.set(who, v);
    }

    function repay(address asset, uint256 amount, uint256 mode, address onBehalfOf) external returns (uint256 paid) {
        require(mode == 2, "mode");
        uint256 owed = debt.balanceOf(onBehalfOf);
        paid = amount < owed ? amount : owed;
        AmaneTestToken(asset).transferFrom(msg.sender, address(this), paid);
        debt.set(onBehalfOf, owed - paid);
    }
}

/// SwapRouter02 stand-in: pulls the input, pays `rate` of it to the recipient, honours the minimum
/// unless told to ignore it (to prove the account measures output itself).
contract MockSwapRouter {
    uint256 public rateNum;
    uint256 public rateDen;
    bool public ignoreMin;
    uint24 public lastFee;

    function configure(uint256 num, uint256 den, bool ignoreMin_) external {
        (rateNum, rateDen, ignoreMin) = (num, den, ignoreMin_);
    }

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p) external payable returns (uint256 out) {
        AmaneTestToken(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        out = p.amountIn * rateNum / rateDen;
        require(ignoreMin || out >= p.amountOutMinimum, "Too little received");
        lastFee = p.fee;
        AmaneTestToken(p.tokenOut).mint(p.recipient, out);
    }
}
