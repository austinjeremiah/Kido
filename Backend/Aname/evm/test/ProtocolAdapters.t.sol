// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./AmaneBase.sol";
import {AaveV3RepayAdapter, IAaveV3Pool} from "../src/adapters/AaveV3RepayAdapter.sol";
import {UniswapV3SwapAdapter, ISwapRouter02} from "../src/adapters/UniswapV3SwapAdapter.sol";
import {MaliciousAdapter} from "./mocks/Mocks.sol";
import {MockAavePool, MockDebtToken, MockSwapRouter} from "./mocks/ProtocolMocks.sol";

contract ProtocolAdaptersTest is AmaneBase {
    MockAavePool pool;
    MockDebtToken vDebt;
    MockSwapRouter router;
    bytes32 repayId;
    bytes32 uniId;
    bytes32 thiefId;
    address borrower = makeAddr("borrower");
    string constant BORROWER = "owner position";

    function setUp() public override {
        super.setUp();
        pool = new MockAavePool();
        vDebt = new MockDebtToken(address(pool));
        pool.setDebtToken(vDebt);
        router = new MockSwapRouter();
        router.configure(1000, 1, false);
        repayId = registry.register(address(new AaveV3RepayAdapter(IAaveV3Pool(address(pool)))));
        uniId = registry.register(address(new UniswapV3SwapAdapter(ISwapRouter02(address(router)), 3000)));
        thiefId = registry.register(address(new MaliciousAdapter(2, attacker, "Thief Repay")));
    }

    function _withAdapters(PolicyEndpoint memory e) internal view returns (PolicyEndpoint memory) {
        AdapterRef[] memory ads = new AdapterRef[](e.adapters.length + 3);
        for (uint256 i; i < e.adapters.length; ++i) ads[i] = e.adapters[i];
        ads[e.adapters.length] = AdapterRef(repayId, "Aave V3 Repay", 1);
        ads[e.adapters.length + 1] = AdapterRef(uniId, "Uniswap V3 Swap", 1);
        ads[e.adapters.length + 2] = AdapterRef(thiefId, "Thief Repay", 1);
        e.adapters = ads;
        e.beneficiaries = new Recipient[](1);
        e.beneficiaries[0] = Recipient(a32(borrower), BORROWER);
        SwapFloor[] memory fl = new SwapFloor[](2);
        fl[0] = e.swapFloors[0];
        fl[1] = SwapFloor(a32(address(usd)), a32(address(vDebt)), 1, 1);
        e.swapFloors = fl;
        return e;
    }

    function _repayPolicy() internal view returns (RootPolicy memory p) {
        p = _policy(1);
        p.allowedActions = uint32((1 << 0) | (1 << 2) | (1 << 9));
        p.endpoints[0] = _withAdapters(p.endpoints[0]);
    }

    function _repayLease() internal view returns (AgentLease memory l) {
        l = _lease(ctrlA);
        l.allowedActions = uint32((1 << 0) | (1 << 2) | (1 << 9));
        LeaseEndpoint memory e = l.endpoints[0];
        bytes32[] memory ads = new bytes32[](5);
        (ads[0], ads[1], ads[2], ads[3], ads[4]) = (payId, swapId, repayId, uniId, thiefId);
        e.adapters = ads;
        e.beneficiaries = new bytes32[](1);
        e.beneficiaries[0] = a32(borrower);
        l.endpoints[0] = e;
    }

    function _readyRepay() internal {
        _install(_repayPolicy());
        _activate(_repayLease(), pkA);
    }

    function _repay(uint64 nonce, uint256 amount) internal view returns (ActionIntent memory a) {
        a = _pay(nonce, amount);
        a.actionKind = 2;
        a.adapterId = repayId;
        a.adapterName = "Aave V3 Repay";
        a.assetOut = a32(address(vDebt));
        a.recipient = a32(borrower);
        a.recipientLabel = BORROWER;
    }

    function test_REPAY_001_repays_pinned_beneficiary_and_measures_debt() public {
        _readyRepay();
        pool.borrowFor(borrower, 300_000000);
        uint256 before = usd.balanceOf(address(acct));
        assertEq(_exec(_repay(1, 20_000000)), 20_000000);
        assertEq(vDebt.balanceOf(borrower), 280_000000);
        assertEq(before - usd.balanceOf(address(acct)), 20_000000);
    }

    function test_REPAY_002_amount_above_debt_refunds_the_rest() public {
        _readyRepay();
        pool.borrowFor(borrower, 5_000000);
        uint256 before = usd.balanceOf(address(acct));
        assertEq(_exec(_repay(1, 20_000000)), 5_000000);
        assertEq(before - usd.balanceOf(address(acct)), 5_000000);
        assertEq(usd.balanceOf(address(pool)), 5_000000);
    }

    function test_REPAY_003_unpinned_beneficiary_rejected() public {
        _readyRepay();
        ActionIntent memory a = _repay(1, 1_000000);
        a.recipient = a32(attacker);
        _execReject(a, Codes.ACTION_RECIPIENT_NOT_ALLOWED);
    }

    function test_REPAY_004_label_mismatch_rejected() public {
        _readyRepay();
        ActionIntent memory a = _repay(1, 1_000000);
        a.recipientLabel = "someone else";
        _execReject(a, Codes.ACTION_RECIPIENT_NOT_ALLOWED);
    }

    function test_REPAY_005_unpinned_debt_token_rejected() public {
        _readyRepay();
        ActionIntent memory a = _repay(1, 1_000000);
        a.assetOut = a32(makeAddr("other debt token"));
        _execReject(a, Codes.ACTION_NO_PRICE_FLOOR);
    }

    function test_REPAY_010_swap_pair_cannot_serve_as_repay_pair() public {
        _readyRepay();
        ActionIntent memory a = _repay(1, 1_000000);
        a.assetOut = a32(address(amsui));
        _execReject(a, Codes.ACTION_ASSET_NOT_ALLOWED);
    }

    function test_REPAY_006_adapter_that_keeps_funds_is_caught() public {
        _readyRepay();
        pool.borrowFor(borrower, 300_000000);
        ActionIntent memory a = _repay(1, 1_000000);
        a.adapterId = thiefId;
        a.adapterName = "Thief Repay";
        _execReject(a, Codes.ACTION_UNDER_DELIVERED);
    }

    function test_REPAY_007_nothing_owed_is_under_delivery() public {
        _readyRepay();
        _execReject(_repay(1, 1_000000), Codes.ACTION_UNDER_DELIVERED);
    }

    function test_REPAY_008_not_in_lease_actions_rejected() public {
        _install(_repayPolicy());
        AgentLease memory l = _repayLease();
        l.allowedActions = uint32((1 << 0) | (1 << 9));
        _activate(l, pkA);
        pool.borrowFor(borrower, 300_000000);
        _execReject(_repay(1, 1_000000), Codes.ACTION_KIND_NOT_ALLOWED);
    }

    function test_REPAY_009_budget_still_applies() public {
        _readyRepay();
        pool.borrowFor(borrower, 300_000000);
        _execReject(_repay(1, 26_000000), Codes.BUDGET_PER_ACTION);
    }

    function _uni(uint64 nonce, uint256 amount, uint256 minOut) internal view returns (ActionIntent memory a) {
        a = _swap(nonce, amount, minOut);
        a.adapterId = uniId;
        a.adapterName = "Uniswap V3 Swap";
    }

    function test_UNI_001_swap_output_measured_and_floor_enforced() public {
        _readyRepay();
        uint256 out = _exec(_uni(1, 1_000000, 0));
        assertEq(out, 1_000000 * 1000);
        assertEq(amsui.balanceOf(address(acct)), out);
        assertEq(router.lastFee(), 3000);
    }

    function test_UNI_002_router_filling_below_owner_floor_reverts() public {
        _readyRepay();
        router.configure(900, 1, false);
        ActionIntent memory a = _uni(1, 1_000000, 0);
        bytes memory sig = _agentSig(a);
        vm.expectRevert(bytes("Too little received"));
        vm.prank(executor);
        acct.executeAction(a, sig);
    }

    function test_UNI_003_router_ignoring_minimum_is_caught_by_the_account() public {
        _readyRepay();
        router.configure(900, 1, true);
        _execReject(_uni(1, 1_000000, 0), Codes.ACTION_BELOW_MIN_OUT);
    }

    function test_UNI_004_swap_output_cannot_be_redirected() public {
        _readyRepay();
        ActionIntent memory a = _uni(1, 1_000000, 0);
        a.recipient = a32(attacker);
        _execReject(a, Codes.ACTION_RECIPIENT_NOT_ALLOWED);
    }

    function test_adapters_pass_registry_immutability_scan() public {
        assertEq(registry.get(repayId).actionKind, 2);
        assertEq(registry.get(uniId).actionKind, 0);
    }
}
