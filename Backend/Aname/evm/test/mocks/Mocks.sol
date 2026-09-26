// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAmaneAdapter} from "../../src/AdapterRegistry.sol";
import {AmaneTestToken} from "../../src/AmaneTestToken.sol";

contract FixedRateSwapAdapter is IAmaneAdapter {
    uint256 public immutable rateNum;
    uint256 public immutable rateDen;

    constructor(uint256 num, uint256 den) {
        rateNum = num;
        rateDen = den;
    }

    function actionKind() external pure returns (uint8) { return 0; }
    function adapterName() external pure returns (string memory) { return "Fixture Swap"; }
    function adapterVersion() external pure returns (uint32) { return 1; }

    function execute(address, address tokenOut, uint256 amountIn, uint256, address) external {
        AmaneTestToken(tokenOut).mint(msg.sender, amountIn * rateNum / rateDen);
    }
}

/// Adapter that ignores its instructions: keeps the input and pays nothing, or pays the caller's
/// recipient to someone else. Used to prove the core measures delivery itself.
contract MaliciousAdapter is IAmaneAdapter {
    uint8 public immutable kind;
    address public immutable thief;
    string private name_;

    constructor(uint8 kind_, address thief_, string memory n) {
        kind = kind_;
        thief = thief_;
        name_ = n;
    }

    function actionKind() external view returns (uint8) { return kind; }
    function adapterName() external view returns (string memory) { return name_; }
    function adapterVersion() external pure returns (uint32) { return 1; }

    function execute(address tokenIn, address, uint256 amountIn, uint256, address) external {
        AmaneTestToken(tokenIn).transfer(thief, amountIn);
    }
}

interface IAccount {
    function executeAction(bytes calldata) external;
}

contract PayloadStore {
    bytes public payload;

    function set(bytes calldata p) external { payload = p; }
}

/// Adapter that tries to re-enter the account during execution. The payload lives in a separate
/// contract because adapters with SSTORE in their runtime code cannot be registered.
contract ReentrantAdapter is IAmaneAdapter {
    address public immutable account;
    PayloadStore public immutable store;

    constructor(address account_, PayloadStore store_) {
        account = account_;
        store = store_;
    }
    function actionKind() external pure returns (uint8) { return 9; }
    function adapterName() external pure returns (string memory) { return "Transfer Pay"; }
    function adapterVersion() external pure returns (uint32) { return 1; }

    function execute(address tokenIn, address, uint256 amountIn, uint256, address recipient) external {
        (bool ok, bytes memory ret) = account.call(store.payload());
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
        AmaneTestToken(tokenIn).transfer(recipient, amountIn);
    }
}

contract FeeOnTransferToken is AmaneTestToken {
    constructor() AmaneTestToken("Fee", "FEE", 6) {}

    function transfer(address to, uint256 amount) external override returns (bool) {
        uint256 fee = amount / 100;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount - fee;
        return true;
    }
}

/// Stateful delegatecall proxy adapter. Must be refused by the registry.
contract ProxyAdapter is IAmaneAdapter {
    address public impl;

    constructor(address impl_) { impl = impl_; }

    function upgrade(address impl_) external { impl = impl_; }
    function actionKind() external pure returns (uint8) { return 2; }
    function adapterName() external pure returns (string memory) { return "Proxy Repay"; }
    function adapterVersion() external pure returns (uint32) { return 1; }

    function execute(address, address, uint256, uint256, address) external {
        (bool ok,) = impl.delegatecall(msg.data);
        require(ok);
    }
}
