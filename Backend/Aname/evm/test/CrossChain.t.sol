// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./AmaneBase.sol";
import {IAmaneAdapter} from "../src/AdapterRegistry.sol";
import {AaveV3RepayAdapter, IAaveV3Pool} from "../src/adapters/AaveV3RepayAdapter.sol";
import {MockAavePool, MockDebtToken} from "./mocks/ProtocolMocks.sol";

/// Stand-in transport: "redeems" by minting the carried amount to the caller and returns the
/// intent the delivery carries. Registered like any adapter (immutable code, kind BRIDGE).
contract MockTransportAdapter is IAmaneAdapter {
    function actionKind() external pure returns (uint8) { return 10; }
    function adapterName() external pure returns (string memory) { return "Mock Transport"; }
    function adapterVersion() external pure virtual returns (uint32) { return 1; }
    function execute(address, address, uint256, uint256, address) external pure { revert("transport only redeems"); }

    function redeem(bytes calldata data) external returns (bytes32 intent) {
        (address token, uint256 amount, bytes32 carried) = abi.decode(data, (address, uint256, bytes32));
        AmaneTestToken(token).mint(msg.sender, amount);
        return carried;
    }
}

contract CrossChainTest is AmaneBase {
    MockAavePool pool;
    MockDebtToken vDebt;
    bytes32 repayId;
    bytes32 transportId;
    address borrower = makeAddr("borrower");
    string constant LABEL = "owner position";

    function setUp() public override {
        super.setUp();
        pool = new MockAavePool();
        vDebt = new MockDebtToken(address(pool));
        pool.setDebtToken(vDebt);
        repayId = registry.register(address(new AaveV3RepayAdapter(IAaveV3Pool(address(pool)))));
        transportId = registry.register(address(new MockTransportAdapter()));
        // start with an empty vault so every token here arrived cross-chain
        uint256 bal = usd.balanceOf(address(acct));
        vm.prank(address(acct));
        usd.transfer(address(0xdead), bal);
        pool.borrowFor(borrower, 500_000000);
        RootPolicy memory p = _policy(1);
        p.allowedActions = uint32((1 << 2) | (1 << 9) | (1 << 10));
        PolicyEndpoint memory e = p.endpoints[0];
        AdapterRef[] memory ads = new AdapterRef[](3);
        (ads[0], ads[1], ads[2]) = (AdapterRef(payId, "Transfer Pay", 1), AdapterRef(repayId, "Aave V3 Repay", 1), AdapterRef(transportId, "Mock Transport", 1));
        e.adapters = ads;
        e.beneficiaries = new Recipient[](1);
        e.beneficiaries[0] = Recipient(a32(borrower), LABEL);
        SwapFloor[] memory fl = new SwapFloor[](1);
        fl[0] = SwapFloor(a32(address(usd)), a32(address(vDebt)), 1, 1);
        e.swapFloors = fl;
        p.endpoints[0] = e;
        _install(p);
        AgentLease memory l = _lease(ctrlA);
        l.allowedActions = p.allowedActions;
        bytes32[] memory la = new bytes32[](3);
        (la[0], la[1], la[2]) = (payId, repayId, transportId);
        l.endpoints[0].adapters = la;
        l.endpoints[0].beneficiaries = new bytes32[](1);
        l.endpoints[0].beneficiaries[0] = a32(borrower);
        _activate(l, pkA);
    }

    function hDest(DestSpec calldata d) external pure returns (bytes32) {
        return DestSpecHash.hash(d);
    }

    function _dest() internal view returns (DestSpec memory d) {
        d = DestSpec(2, repayId, a32(borrower), LABEL, a32(address(usd)), 99_000000, uint64(block.timestamp + 3600));
    }

    /// The BRIDGE action the agent signed on the Sui endpoint, committing to `d`.
    function _src(DestSpec memory d, uint64 nonce) internal view returns (ActionIntent memory a) {
        a = _pay(nonce, 100_000000);
        a.chainRef = SUI_CHAIN_REF;
        a.account = SUI_ACCOUNT;
        a.actionKind = 10;
        a.adapterId = keccak256("sui wormhole bridge adapter");
        a.adapterName = "Wormhole Bridge";
        a.assetIn = keccak256("sui usdc");
        a.assetOut = a32(address(usd));
        a.recipient = a32(address(acct));
        a.recipientLabel = "";
        a.planHash = this.hDest(d);
    }

    function _receive(ActionIntent memory src, DestSpec memory d, uint256 amount, bytes32 carried) internal {
        acct.receiveCrossChain(src, _agentSig(src), d, transportId, abi.encode(address(usd), amount, carried));
    }

    /// Everything that makes external calls (signing, hashing) happens before the revert is armed.
    function _receiveReject(ActionIntent memory src, bytes memory sig, DestSpec memory d, uint256 amount, bytes32 carried, uint16 code) internal {
        bytes memory data = abi.encode(address(usd), amount, carried);
        _reject(code);
        acct.receiveCrossChain(src, sig, d, transportId, data);
    }

    function _digest(ActionIntent memory a) internal view returns (bytes32) {
        return this.hAction(a);
    }

    function test_XC_001_arrival_reserved_and_spent_only_by_the_pinned_repay() public {
        DestSpec memory d = _dest();
        ActionIntent memory src = _src(d, 1);
        bytes32 intent = _digest(src);
        _receive(src, d, 100_000000, intent);
        (,,,,,, uint256 remaining) = acct.reservations(intent);
        assertEq(remaining, 100_000000);
        assertEq(acct.reservedOf(address(usd)), 100_000000);

        // an ordinary action cannot spend reserved funds
        ActionIntent memory pay = _pay(50, 1_000000);
        _execReject(pay, Codes.XCHAIN_RESERVED_FUNDS);

        ActionIntent memory r = _pay(2, 100_000000);
        r.actionKind = 2; r.adapterId = repayId; r.adapterName = "Aave V3 Repay";
        r.assetOut = a32(address(vDebt)); r.recipient = a32(borrower); r.recipientLabel = LABEL; r.planHash = intent;
        bytes memory sig = _agentSig(r);
        vm.prank(executor);
        acct.executeReserved(intent, r, sig);
        assertEq(vDebt.balanceOf(borrower), 400_000000);
        assertEq(acct.reservedOf(address(usd)), 0);
    }

    function test_XC_002_forged_source_signature() public {
        DestSpec memory d = _dest();
        ActionIntent memory src = _src(d, 1);
        bytes memory sig = _sign(pkAttacker, this.hAction(src));
        _receiveReject(src, sig, d, 100_000000, _digest(src), Codes.ACTION_WRONG_AGENT);
    }

    function test_XC_003_destination_spec_changed_after_signing() public {
        DestSpec memory d = _dest();
        ActionIntent memory src = _src(d, 1);
        d.recipient = a32(attacker);
        bytes32 c_ = _digest(src);
        bytes memory s_ = _agentSig(src);
        _receiveReject(src, s_, d, 100_000000, c_, Codes.XCHAIN_SPEC_MISMATCH);
    }

    function test_XC_004_signed_but_unpinned_beneficiary() public {
        DestSpec memory d = _dest();
        d.recipient = a32(attacker);
        ActionIntent memory src = _src(d, 1);
        bytes32 c_ = _digest(src);
        bytes memory s_ = _agentSig(src);
        _receiveReject(src, s_, d, 100_000000, c_, Codes.ACTION_RECIPIENT_NOT_ALLOWED);
    }

    function test_XC_005_delivery_for_another_intent() public {
        DestSpec memory d = _dest();
        ActionIntent memory src = _src(d, 1);
        bytes32 c_ = keccak256("another intent");
        bytes memory s_ = _agentSig(src);
        _receiveReject(src, s_, d, 100_000000, c_, Codes.XCHAIN_PAYLOAD_MISMATCH);
    }

    function test_XC_006_arrival_below_minimum() public {
        DestSpec memory d = _dest();
        ActionIntent memory src = _src(d, 1);
        bytes32 c_ = _digest(src);
        bytes memory s_ = _agentSig(src);
        _receiveReject(src, s_, d, 98_000000, c_, Codes.XCHAIN_BELOW_MINIMUM);
    }

    function test_XC_007_replayed_intent() public {
        DestSpec memory d = _dest();
        ActionIntent memory src = _src(d, 1);
        _receive(src, d, 100_000000, _digest(src));
        bytes32 c_ = _digest(src);
        bytes memory s_ = _agentSig(src);
        _receiveReject(src, s_, d, 100_000000, c_, Codes.XCHAIN_INTENT_USED);
    }

    function test_XC_008_reservation_serves_only_its_pinned_action() public {
        DestSpec memory d = _dest();
        ActionIntent memory src = _src(d, 1);
        bytes32 intent = _digest(src);
        _receive(src, d, 100_000000, intent);
        ActionIntent memory p = _pay(3, 10_000000);
        p.planHash = intent;
        bytes memory sig = _agentSig(p);
        _reject(Codes.XCHAIN_RESERVATION_MISMATCH);
        acct.executeReserved(intent, p, sig);
        ActionIntent memory r = _pay(4, 100_000001);
        r.actionKind = 2; r.adapterId = repayId; r.adapterName = "Aave V3 Repay";
        r.assetOut = a32(address(vDebt)); r.recipient = a32(borrower); r.recipientLabel = LABEL; r.planHash = intent;
        sig = _agentSig(r);
        _reject(Codes.XCHAIN_RESERVATION_MISMATCH);
        acct.executeReserved(intent, r, sig);
    }

    function test_XC_009_not_a_bridge_action_or_wrong_destination() public {
        DestSpec memory d = _dest();
        ActionIntent memory src = _src(d, 1);
        src.actionKind = 9;
        bytes32 c_ = _digest(src);
        bytes memory s_ = _agentSig(src);
        _receiveReject(src, s_, d, 100_000000, c_, Codes.XCHAIN_NOT_A_BRIDGE_ACTION);
        src = _src(d, 2);
        src.recipient = a32(address(0xBEEF));
        c_ = _digest(src);
        s_ = _agentSig(src);
        _receiveReject(src, s_, d, 100_000000, c_, Codes.XCHAIN_WRONG_DESTINATION);
    }

    function test_XC_010_expired_reservation_released_into_quarantine() public {
        DestSpec memory d = _dest();
        ActionIntent memory src = _src(d, 1);
        bytes32 intent = _digest(src);
        _receive(src, d, 100_000000, intent);
        _reject(Codes.XCHAIN_NO_RESERVATION);
        acct.releaseReservation(intent);
        vm.warp(block.timestamp + 3601);
        acct.releaseReservation(intent);
        assertEq(acct.reservedOf(address(usd)), 100_000000);
        assertEq(acct.quarantinedOf(address(usd)), 100_000000);
        ActionIntent memory r = _pay(5, 1_000000);
        r.actionKind = 2; r.adapterId = repayId; r.adapterName = "Aave V3 Repay";
        r.assetOut = a32(address(vDebt)); r.recipient = a32(borrower); r.recipientLabel = LABEL; r.planHash = intent;
        bytes memory sig = _agentSig(r);
        _reject(Codes.XCHAIN_NO_RESERVATION);
        acct.executeReserved(intent, r, sig);
    }

    function test_XC_012_dest_spec_hash_matches_typescript_vector() public view {
        DestSpec memory d = DestSpec(2, bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111)), bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222)), "owner position", bytes32(uint256(0x3333333333333333333333333333333333333333333333333333333333333333)), 99_000000, 1_800_003_600);
        assertEq(this.hDest(d), 0xb00f7df4a08766849859c3597c0968709501383280002db39d66ad734075e5af);
    }

    function test_XC_011_transport_not_in_lease() public {
        bytes32 other = registry.register(address(new MockTransportAdapterB()));
        DestSpec memory d = _dest();
        ActionIntent memory src = _src(d, 1);
        bytes memory sig = _agentSig(src);
        bytes memory data = abi.encode(address(usd), 100_000000, _digest(src));
        _reject(Codes.ACTION_ADAPTER_NOT_ALLOWED);
        acct.receiveCrossChain(src, sig, d, other, data);
    }
}

contract MockTransportAdapterB is MockTransportAdapter {
    function adapterVersion() external pure override returns (uint32) { return 2; }
}
