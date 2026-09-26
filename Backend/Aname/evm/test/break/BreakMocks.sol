// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAmaneAdapter} from "../../src/AdapterRegistry.sol";
import {AmaneTestToken} from "../../src/AmaneTestToken.sol";

/// Honest REPAY stand-in: forwards the input to the pinned beneficiary.
contract MockRepayAdapter is IAmaneAdapter {
    function actionKind() external pure returns (uint8) { return 2; }
    function adapterName() external pure returns (string memory) { return "Mock Repay"; }
    function adapterVersion() external pure returns (uint32) { return 1; }

    function execute(address tokenIn, address, uint256 amountIn, uint256, address recipient) external {
        AmaneTestToken(tokenIn).transfer(recipient, amountIn);
    }
}

contract RepayImplHonest {
    function execute(address tokenIn, address, uint256 amountIn, uint256, address recipient) external {
        AmaneTestToken(tokenIn).transfer(recipient, amountIn);
    }
}

contract RepayImplSteal {
    address public immutable thief;

    constructor(address t) { thief = t; }

    function execute(address tokenIn, address, uint256 amountIn, uint256, address) external {
        AmaneTestToken(tokenIn).transfer(thief, amountIn);
    }
}

/// Adapter whose runtime code (and so codehash) never changes but whose behaviour does:
/// execute() delegatecalls an implementation the owner can swap at will.
contract UpgradeableRepayAdapter is IAmaneAdapter {
    address public impl;
    address public immutable owner;

    constructor(address i) {
        impl = i;
        owner = msg.sender;
    }

    function upgrade(address i) external {
        require(msg.sender == owner, "owner");
        impl = i;
    }

    function actionKind() external pure returns (uint8) { return 2; }
    function adapterName() external pure returns (string memory) { return "Proxy Repay"; }
    function adapterVersion() external pure returns (uint32) { return 1; }

    function execute(address, address, uint256, uint256, address) external {
        (bool ok, bytes memory ret) = impl.delegatecall(msg.data);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }
}

contract FalseReturnToken is AmaneTestToken {
    constructor() AmaneTestToken("False", "FLS", 6) {}

    function transfer(address, uint256) external pure override returns (bool) {
        return false;
    }
}

/// USDT-style token: transfer() returns nothing.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

/// Mutable routing table living outside the adapter.
contract RepayRouteConfig {
    address public overrideTo;

    function setOverride(address to) external {
        overrideTo = to;
    }
}

/// Adapter with no DELEGATECALL/CALLCODE/SELFDESTRUCT/SSTORE: its destination is read from an
/// external contract, so behaviour changes while code and codehash stay fixed.
contract RoutedRepayAdapter is IAmaneAdapter {
    RepayRouteConfig public immutable cfg;

    constructor(RepayRouteConfig c) { cfg = c; }

    function actionKind() external pure returns (uint8) { return 2; }
    function adapterName() external pure returns (string memory) { return "Routed Repay"; }
    function adapterVersion() external pure returns (uint32) { return 1; }

    function execute(address tokenIn, address, uint256 amountIn, uint256, address recipient) external {
        address to = cfg.overrideTo();
        AmaneTestToken(tokenIn).transfer(to == address(0) ? recipient : to, amountIn);
    }
}
