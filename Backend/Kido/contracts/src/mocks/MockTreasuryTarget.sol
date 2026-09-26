// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Deterministic protected target used for security tests and the demo.
/// @dev Deliberately has no access control of its own. The whole point is that ContextLock is the
///      only thing standing between an agent and this contract's state.
contract MockTreasuryTarget {
    error Rejected();

    mapping(address => uint256) public balanceOf;
    uint256 public totalTransferred;
    uint256 public callCount;
    address public lastRecipient;
    uint256 public lastAmount;

    bool public shouldRevert;

    event Transferred(address indexed recipient, uint256 amount, uint256 callCount);

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    /// @notice The one protected action. Moves accounting units to `recipient`.
    function transferTo(address recipient, uint256 amount) external {
        if (shouldRevert) revert Rejected();
        balanceOf[recipient] += amount;
        totalTransferred += amount;
        callCount += 1;
        lastRecipient = recipient;
        lastAmount = amount;
        emit Transferred(recipient, amount, callCount);
    }

    receive() external payable {}
}
