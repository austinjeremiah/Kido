// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./AmaneBase.sol";

/// Drives random agent actions, time jumps, pauses and revokes against one account.
contract AgentHandler is AmaneBase {
    AmaneBase internal immutable suite;
    uint64 public nonce;
    uint256 public delivered;
    uint256 public executedWhilePaused;
    uint256 public executedAfterRevoke;
    bool public revoked;
    uint256 public maxWindowSpend;
    uint256[] internal spendTimes;
    uint256[] internal spendAmounts;

    constructor(AmaneAccount acct_, AmaneTestToken usd_, bytes32 payId_, bytes32 swapId_, address merchant_) {
        suite = AmaneBase(msg.sender);
        acct = acct_;
        usd = usd_;
        payId = payId_;
        swapId = swapId_;
        merchant = merchant_;
    }

    function pay(uint256 amount, bool reuseNonce) external {
        amount = bound(amount, 1, 30_000000);
        uint64 n = reuseNonce && nonce > 0 ? nonce : ++nonce;
        ActionIntent memory a = _pay(n, amount);
        bytes memory sig = _sign(pkAgent, suite.hAction(a));
        bool paused = acct.paused();
        try acct.executeAction(a, sig) {
            delivered += amount;
            if (paused) ++executedWhilePaused;
            if (revoked) ++executedAfterRevoke;
            spendTimes.push(block.timestamp);
            spendAmounts.push(amount);
            _trackWindow();
        } catch {}
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 2 hours));
    }

    function pauseAccount(bytes32 id) external {
        PauseAccount memory p = PauseAccount(ACCOUNT_ID, acct.pauseEpoch(), id, uint64(block.timestamp + 60));
        try acct.pause(p, _sign(pkB, suite.hPause(p))) {} catch {}
    }

    function unpauseAccount() external {
        if (!acct.paused()) return;
        UnpauseAccount memory u = UnpauseAccount(ACCOUNT_ID, acct.chainRef(), a32(address(acct)), acct.pauseEpoch(), acct.lastPauseId(), uint64(block.timestamp + 60));
        bytes32 d = suite.hUnpause(u);
        bytes[] memory sigs = new bytes[](2);
        (uint256 first, uint256 second) = ctrlA < ctrlB ? (pkA, pkB) : (pkB, pkA);
        sigs[0] = _sign(first, d);
        sigs[1] = _sign(second, d);
        acct.unpause(u, sigs);
    }

    function revoke() external {
        RevokeLease memory r = RevokeLease(ACCOUNT_ID, leaseId);
        acct.revokeLease(r, _sign(pkA, suite.hRevoke(r)));
        revoked = true;
    }

    function _trackWindow() internal {
        uint256 sum;
        for (uint256 i = spendTimes.length; i > 0; --i) {
            if (spendTimes[i - 1] + 3600 <= block.timestamp) break;
            sum += spendAmounts[i - 1];
        }
        if (sum > maxWindowSpend) maxWindowSpend = sum;
    }
}

contract AmaneInvariants is AmaneBase {
    AgentHandler internal handler;

    function setUp() public override {
        super.setUp();
        _install(_policy(1));
        AgentLease memory l = _lease(ctrlA);
        l.expiresAt = uint64(T0 + 86_400);
        _activate(l, pkA);
        handler = new AgentHandler(acct, usd, payId, swapId, merchant);
        targetContract(address(handler));
    }

    function invariant_lease_total_never_exceeded() public view {
        (, AmaneAccount.Spend memory spent) = acct.leaseBudget(leaseId, a32(address(usd)));
        assertLe(spent.totalSpent, 100_000000);
        assertEq(spent.totalSpent, handler.delivered());
    }

    function invariant_merchant_receives_exactly_what_was_spent() public view {
        assertEq(usd.balanceOf(merchant), handler.delivered());
        assertEq(usd.balanceOf(address(acct)) + handler.delivered(), 1_000_000000);
    }

    function invariant_bucket_level_never_exceeds_capacity() public view {
        (, AmaneAccount.Spend memory spent) = acct.leaseBudget(leaseId, a32(address(usd)));
        assertLe(spent.level, 50_000000);
    }

    function invariant_window_spend_bounded_by_documented_2x() public view {
        assertLe(handler.maxWindowSpend(), 2 * 50_000000);
    }

    function invariant_no_execution_while_paused_or_after_revoke() public view {
        assertEq(handler.executedWhilePaused(), 0);
        assertEq(handler.executedAfterRevoke(), 0);
    }
}
