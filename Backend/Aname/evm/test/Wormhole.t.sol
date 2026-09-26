// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./AmaneBase.sol";
import {WormholeBridgeAdapter, IWormholeTokenBridge} from "../src/adapters/WormholeBridgeAdapter.sol";
import {MockTokenBridge} from "./mocks/MockTokenBridge.sol";

/// Round trip through the Wormhole adapter: out to the Sui endpoint, back to this account.
contract WormholeTest is AmaneBase {
    MockTokenBridge tb;
    WormholeBridgeAdapter wh;
    bytes32 whId;
    bytes32 constant SUI_PEER = keccak256("sui amane bridge adapter emitter cap");
    bytes32 constant SUI_AMUSD = keccak256("sui amusd coin type");
    AmaneTestToken wAmusd; // Wormhole-wrapped Sui AMUSD on this chain
    string constant SUI_LABEL = "Amane Sui endpoint";

    function setUp() public override {
        super.setUp();
        tb = new MockTokenBridge();
        wh = new WormholeBridgeAdapter(IWormholeTokenBridge(address(tb)), 21, SUI_PEER, SUI_PEER);
        whId = registry.register(address(wh));
        wAmusd = new AmaneTestToken("AMUSD (Wormhole)", "wAMUSD", 6);
        tb.setWrapped(21, SUI_AMUSD, address(wAmusd));
        RootPolicy memory p = _policy(1);
        p.allowedActions = uint32((1 << 9) | (1 << 10));
        PolicyEndpoint memory e = p.endpoints[0];
        AdapterRef[] memory ads = new AdapterRef[](2);
        (ads[0], ads[1]) = (AdapterRef(payId, "Transfer Pay", 1), AdapterRef(whId, "Wormhole Bridge", 1));
        e.adapters = ads;
        AssetLimit[] memory assets = new AssetLimit[](2);
        (assets[0], assets[1]) = (e.assets[0], AssetLimit(a32(address(wAmusd)), 100_000000, 200_000000, 500_000000));
        e.assets = assets;
        Recipient[] memory rs = new Recipient[](2);
        (rs[0], rs[1]) = (e.recipients[0], Recipient(SUI_ACCOUNT, SUI_LABEL));
        e.recipients = rs;
        p.endpoints[0] = e;
        _install(p);
        AgentLease memory l = _lease(ctrlA);
        l.allowedActions = p.allowedActions;
        bytes32[] memory la = new bytes32[](2);
        (la[0], la[1]) = (payId, whId);
        l.endpoints[0].adapters = la;
        AssetLimit[] memory lassets = new AssetLimit[](2);
        (lassets[0], lassets[1]) = (l.endpoints[0].assets[0], AssetLimit(a32(address(wAmusd)), 25_000000, 50_000000, 100_000000));
        l.endpoints[0].assets = lassets;
        bytes32[] memory lr = new bytes32[](2);
        (lr[0], lr[1]) = (a32(merchant), SUI_ACCOUNT);
        l.endpoints[0].recipients = lr;
        _activate(l, pkA);
    }

    function hDest(DestSpec calldata d) external pure returns (bytes32) { return DestSpecHash.hash(d); }

    function _bridgeOut(uint64 nonce, uint256 amount) internal view returns (ActionIntent memory a) {
        a = _pay(nonce, amount);
        a.actionKind = 10;
        a.adapterId = whId;
        a.adapterName = "Wormhole Bridge";
        a.recipient = SUI_ACCOUNT;
        a.recipientLabel = SUI_LABEL;
        a.assetOut = SUI_AMUSD;
    }

    function test_WH_001_bridge_out_sends_exact_amount_with_intent_and_destination() public {
        ActionIntent memory a = _bridgeOut(1, 20_000000);
        _exec(a);
        (address token, uint256 amount, uint16 chain, bytes32 recipient,) = tb.sent(0);
        assertEq(token, address(usd));
        assertEq(amount, 20_000000);
        assertEq(chain, 21);
        assertEq(recipient, SUI_PEER);
        assertEq(tb.lastPayload(), abi.encodePacked(this.hAction(a), SUI_ACCOUNT));
    }

    function test_WH_002_bridge_out_to_unpinned_endpoint_rejected() public {
        ActionIntent memory a = _bridgeOut(1, 1_000000);
        a.recipient = keccak256("attacker sui account");
        _execReject(a, Codes.ACTION_RECIPIENT_NOT_ALLOWED);
    }

    function test_WH_003_bridge_out_budget_applies() public {
        _execReject(_bridgeOut(1, 25_000001), Codes.BUDGET_PER_ACTION);
    }

    /// The Sui endpoint bridged wAMUSD back, committing to a PAY to the merchant here.
    function _inbound(uint256 amount, bytes32 fromAddr, address to) internal returns (ActionIntent memory src, DestSpec memory d, bytes memory vaa) {
        d = DestSpec(9, payId, a32(merchant), unicode"Merchant ✓ café", a32(address(wAmusd)), amount, uint64(block.timestamp + 600));
        src = _pay(7, amount);
        src.chainRef = SUI_CHAIN_REF;
        src.account = SUI_ACCOUNT;
        src.actionKind = 10;
        src.adapterId = keccak256("sui wormhole adapter");
        src.adapterName = "Wormhole Bridge";
        src.assetIn = SUI_AMUSD;
        src.recipient = a32(address(acct));
        src.recipientLabel = "Amane Sepolia endpoint";
        src.planHash = this.hDest(d);
        IWormholeTokenBridge.TransferWithPayload memory t = IWormholeTokenBridge.TransferWithPayload(3, amount, SUI_AMUSD, 21, a32(to), 10002, fromAddr, abi.encodePacked(this.hAction(src), a32(address(acct))));
        vaa = abi.encode(t);
    }

    function test_WH_004_bridge_back_redeemed_reserved_and_paid_to_pinned_merchant() public {
        (ActionIntent memory src, DestSpec memory d, bytes memory vaa) = _inbound(10_000000, SUI_PEER, address(wh));
        bytes memory sig = _agentSig(src);
        acct.receiveCrossChain(src, sig, d, whId, vaa);
        bytes32 intent = this.hAction(src);
        assertEq(acct.reservedOf(address(wAmusd)), 10_000000);
        ActionIntent memory pay = _pay(8, 10_000000);
        pay.assetIn = a32(address(wAmusd));
        pay.assetOut = a32(address(wAmusd));
        pay.planHash = intent;
        bytes memory psig = _agentSig(pay);
        acct.executeReserved(intent, pay, psig);
        assertEq(wAmusd.balanceOf(merchant), 10_000000);
    }

    function test_WH_005_transfer_not_from_the_pinned_peer_rejected() public {
        (ActionIntent memory src, DestSpec memory d, bytes memory vaa) = _inbound(10_000000, keccak256("someone else"), address(wh));
        bytes memory sig = _agentSig(src);
        vm.expectRevert(WormholeBridgeAdapter.WrongPeer.selector);
        acct.receiveCrossChain(src, sig, d, whId, vaa);
    }

    function test_WH_006_same_vaa_cannot_be_redeemed_twice() public {
        (ActionIntent memory src, DestSpec memory d, bytes memory vaa) = _inbound(10_000000, SUI_PEER, address(wh));
        bytes memory sig = _agentSig(src);
        acct.receiveCrossChain(src, sig, d, whId, vaa);
        _reject(Codes.XCHAIN_INTENT_USED);
        acct.receiveCrossChain(src, sig, d, whId, vaa);
    }

    function test_WH_007_someone_else_cannot_redeem_the_payload_to_themselves() public {
        (, , bytes memory vaa) = _inbound(10_000000, SUI_PEER, address(wh));
        vm.prank(attacker);
        vm.expectRevert(WormholeBridgeAdapter.WrongDestination.selector);
        wh.redeem(vaa);
    }

    function test_WH_008_adapter_passes_registry_immutability_scan() public view {
        assertEq(registry.get(whId).actionKind, 10);
    }

    /// Arrival reserved for a BRIDGE back to the Sui endpoint: the round trip's return leg.
    function _inboundReturning(uint256 amount) internal returns (ActionIntent memory src, DestSpec memory d, bytes memory vaa) {
        d = DestSpec(10, whId, SUI_ACCOUNT, SUI_LABEL, a32(address(wAmusd)), amount, uint64(block.timestamp + 3600));
        src = _pay(7, amount);
        src.chainRef = SUI_CHAIN_REF;
        src.account = SUI_ACCOUNT;
        src.actionKind = 10;
        src.adapterId = keccak256("sui wormhole adapter");
        src.adapterName = "Wormhole Bridge";
        src.assetIn = SUI_AMUSD;
        src.recipient = a32(address(acct));
        src.recipientLabel = "Amane Sepolia endpoint";
        src.planHash = this.hDest(d);
        IWormholeTokenBridge.TransferWithPayload memory t = IWormholeTokenBridge.TransferWithPayload(3, amount, SUI_AMUSD, 21, a32(address(wh)), 10002, SUI_PEER, abi.encodePacked(this.hAction(src), a32(address(acct))));
        vaa = abi.encode(t);
    }

    function test_WH_009_round_trip_reserved_bridge_back_commits_to_next_destination() public {
        (ActionIntent memory src, DestSpec memory d, bytes memory vaa) = _inboundReturning(10_000000);
        acct.receiveCrossChain(src, _agentSig(src), d, whId, vaa);
        bytes32 intent = this.hAction(src);
        ActionIntent memory back = _bridgeOut(8, 10_000000);
        back.assetIn = a32(address(wAmusd));
        back.planHash = keccak256("sui destination spec");
        acct.executeReserved(intent, back, _agentSig(back));
        assertEq(acct.reservedOf(address(wAmusd)), 0);
        (address token, uint256 amount, uint16 chain, bytes32 recipient,) = tb.sent(0);
        assertEq(token, address(wAmusd));
        assertEq(amount, 10_000000);
        assertEq(chain, 21);
        assertEq(recipient, SUI_PEER);
        assertEq(tb.lastPayload(), abi.encodePacked(this.hAction(back), SUI_ACCOUNT));
    }

    function test_WH_010_reserved_bridge_back_to_another_endpoint_rejected() public {
        (ActionIntent memory src, DestSpec memory d, bytes memory vaa) = _inboundReturning(10_000000);
        acct.receiveCrossChain(src, _agentSig(src), d, whId, vaa);
        ActionIntent memory back = _bridgeOut(8, 10_000000);
        back.assetIn = a32(address(wAmusd));
        back.recipient = a32(merchant);
        bytes memory sig = _agentSig(back);
        bytes32 intent = this.hAction(src);
        _reject(Codes.XCHAIN_RESERVATION_MISMATCH);
        acct.executeReserved(intent, back, sig);
    }

    function test_WH_011_recovery_path_refused_while_the_destination_is_still_deliverable() public {
        (ActionIntent memory src, DestSpec memory d, bytes memory vaa) = _inbound(10_000000, SUI_PEER, address(wh));
        bytes memory sig = _agentSig(src);
        _reject(Codes.XCHAIN_NO_RESERVATION);
        acct.recoverArrival(src, sig, d, whId, vaa);
    }

    function test_WH_012_timed_out_arrival_quarantined_only_root_recovery_moves_it() public {
        (ActionIntent memory src, DestSpec memory d, bytes memory vaa) = _inbound(10_000000, SUI_PEER, address(wh));
        bytes memory sig = _agentSig(src);
        vm.warp(d.deadline + 1);
        _reject(Codes.XCHAIN_EXPIRED);
        acct.receiveCrossChain(src, sig, d, whId, vaa);
        acct.recoverArrival(src, sig, d, whId, vaa);
        assertEq(acct.quarantinedOf(address(wAmusd)), 10_000000);
        ActionIntent memory pay = _pay(8, 1_000000);
        pay.assetIn = a32(address(wAmusd));
        pay.assetOut = a32(address(wAmusd));
        pay.deadline = uint64(block.timestamp + 60);
        _execReject(pay, Codes.XCHAIN_RESERVED_FUNDS);
        Withdraw memory w = Withdraw(ACCOUNT_ID, acct.chainRef(), a32(address(acct)), a32(address(wAmusd)), 10_000000, a32(recovery), 0, uint64(block.timestamp + 60));
        acct.withdraw(w, _both(this.hWithdraw(w)));
        assertEq(wAmusd.balanceOf(recovery), 10_000000);
        assertEq(acct.reservedOf(address(wAmusd)), 0);
    }

    function test_WH_013_expired_reservation_released_into_quarantine_not_to_leases() public {
        (ActionIntent memory src, DestSpec memory d, bytes memory vaa) = _inbound(10_000000, SUI_PEER, address(wh));
        acct.receiveCrossChain(src, _agentSig(src), d, whId, vaa);
        vm.warp(d.deadline + 1);
        acct.releaseReservation(this.hAction(src));
        assertEq(acct.reservedOf(address(wAmusd)), 10_000000);
        assertEq(acct.quarantinedOf(address(wAmusd)), 10_000000);
    }

    function test_WH_014_root_recovery_cannot_take_a_live_reservation() public {
        (ActionIntent memory src, DestSpec memory d, bytes memory vaa) = _inbound(10_000000, SUI_PEER, address(wh));
        acct.receiveCrossChain(src, _agentSig(src), d, whId, vaa);
        Withdraw memory w = Withdraw(ACCOUNT_ID, acct.chainRef(), a32(address(acct)), a32(address(wAmusd)), 1, a32(recovery), 0, uint64(block.timestamp + 60));
        bytes[] memory sigs = _both(this.hWithdraw(w));
        _reject(Codes.XCHAIN_RESERVED_FUNDS);
        acct.withdraw(w, sigs);
    }

    function test_WH_015_recovery_with_a_forged_source_signature_rejected() public {
        (ActionIntent memory src, DestSpec memory d, bytes memory vaa) = _inbound(10_000000, SUI_PEER, address(wh));
        vm.warp(d.deadline + 1);
        bytes memory sig = _sign(0xbad, this.hAction(src));
        _reject(Codes.ACTION_WRONG_AGENT);
        acct.recoverArrival(src, sig, d, whId, vaa);
    }
}
