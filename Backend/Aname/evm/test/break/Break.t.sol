// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import "../../src/AmaneTypes.sol";
import {AmaneAccount} from "../../src/AmaneAccount.sol";
import {AmaneAccountExt} from "../../src/AmaneAccountExt.sol";
import {AmaneStorage} from "../../src/AmaneStorage.sol";
import {Codes} from "../../src/AmaneCodes.sol";
import {AdapterRegistry} from "../../src/AdapterRegistry.sol";
import {AmaneTestToken} from "../../src/AmaneTestToken.sol";
import {TransferPayAdapter} from "../../src/adapters/TransferPayAdapter.sol";
import {FixedRateSwapAdapter, MaliciousAdapter, ReentrantAdapter, PayloadStore, FeeOnTransferToken} from "../mocks/Mocks.sol";
import {
    MockRepayAdapter,
    RepayImplHonest,
    RepayImplSteal,
    UpgradeableRepayAdapter,
    RepayRouteConfig,
    RoutedRepayAdapter,
    FalseReturnToken,
    NoReturnToken
} from "./BreakMocks.sol";

contract BreakHasher {
    using AmaneHash for *;

    function policy(RootPolicy calldata x) external pure returns (bytes32) { return AmaneHash.digest(x.hash()); }
    function lease(AgentLease calldata x) external pure returns (bytes32) { return AmaneHash.digest(x.hash()); }
    function action(ActionIntent calldata x) external pure returns (bytes32) { return AmaneHash.digest(x.hash()); }
    function pause(PauseAccount calldata x) external pure returns (bytes32) { return AmaneHash.digest(x.hash()); }
    function unpause(UnpauseAccount calldata x) external pure returns (bytes32) { return AmaneHash.digest(x.hash()); }
    function revoke(RevokeLease calldata x) external pure returns (bytes32) { return AmaneHash.digest(x.hash()); }
}

/// Adversarial suite for the EVM core. test_BREAK_* assert the secure behaviour and fail while the
/// corresponding finding is open; test_HOLDS_* pin defences that currently hold.
contract BreakBase is Test {
    uint256 internal constant N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    uint256 internal constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint64 internal constant T0 = 1_800_000_000; // multiple of 3600
    uint64 internal constant EPOCH = 3600;
    uint32 internal constant MASK = (1 << 0) | (1 << 2) | (1 << 9);
    bytes32 internal constant ACCOUNT_ID = keccak256("amane.test-only.account");

    BreakHasher internal h;
    AdapterRegistry internal registry;
    AmaneAccount internal account;
    bytes32 internal chainRef;

    uint256[3] internal ctrlPk;
    address[3] internal ctrl;
    uint256 internal issuerPk;
    address internal issuer;
    uint256 internal agentPk;
    address internal agent;
    uint256 internal agent2Pk;
    address internal agent2;
    uint256 internal strangerPk;
    address internal stranger;

    AmaneTestToken internal tokA;
    AmaneTestToken internal tokB;
    FeeOnTransferToken internal tokFee;
    FalseReturnToken internal tokFalse;
    NoReturnToken internal tokNoRet;

    address internal merchant;
    address internal borrower;
    address internal coldStorage;
    address internal thief;

    bytes32 internal swapId;
    bytes32 internal badSwapId;
    bytes32 internal evilSwapId;
    bytes32 internal payId;
    bytes32 internal repayId;
    bytes32 internal reentrantId;
    ReentrantAdapter internal reentrant;
    PayloadStore internal payloadStore;

    function _pk(string memory label) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked("amane.test-only.", label)));
    }

    function _b(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        if (uint256(s) > HALF_N) {
            s = bytes32(N - uint256(s));
            v = v == 27 ? 28 : 27;
        }
        return abi.encodePacked(r, s, v);
    }

    function _rej(uint16 code) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(AmaneStorage.AmaneRejected.selector, code);
    }

    function setUp() public virtual {
        vm.warp(T0);
        h = new BreakHasher();

        // sort controllers by address
        uint256[3] memory pks = [_pk("ctrl0"), _pk("ctrl1"), _pk("ctrl2")];
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (vm.addr(pks[j]) < vm.addr(pks[i])) (pks[i], pks[j]) = (pks[j], pks[i]);
            }
        }
        address[] memory ctrls = new address[](3);
        for (uint256 i; i < 3; ++i) {
            ctrlPk[i] = pks[i];
            ctrl[i] = vm.addr(pks[i]);
            ctrls[i] = ctrl[i];
        }
        issuerPk = _pk("issuer");
        issuer = vm.addr(issuerPk);
        agentPk = _pk("agent");
        agent = vm.addr(agentPk);
        agent2Pk = _pk("agent2");
        agent2 = vm.addr(agent2Pk);
        strangerPk = _pk("stranger");
        stranger = vm.addr(strangerPk);

        merchant = makeAddr("merchant");
        borrower = makeAddr("borrower");
        coldStorage = makeAddr("coldStorage");
        thief = makeAddr("thief");

        registry = new AdapterRegistry();
        chainRef = registry.chainRef();
        account = new AmaneAccount(ACCOUNT_ID, ctrls, 2, registry, address(new AmaneAccountExt()));

        tokA = new AmaneTestToken("A", "A", 6);
        tokB = new AmaneTestToken("B", "B", 6);
        tokFee = new FeeOnTransferToken();
        tokFalse = new FalseReturnToken();
        tokNoRet = new NoReturnToken();
        tokA.mint(address(account), 10_000e6);
        tokFee.mint(address(account), 10_000e6);
        tokFalse.mint(address(account), 10_000e6);
        tokNoRet.mint(address(account), 10_000e6);

        swapId = registry.register(address(new FixedRateSwapAdapter(1, 1)));
        badSwapId = registry.register(address(new FixedRateSwapAdapter(90, 100)));
        evilSwapId = registry.register(address(new MaliciousAdapter(0, thief, "Evil Swap")));
        payId = registry.register(address(new TransferPayAdapter()));
        repayId = registry.register(address(new MockRepayAdapter()));
        payloadStore = new PayloadStore();
        reentrant = new ReentrantAdapter(address(account), payloadStore);
        reentrantId = registry.register(address(reentrant));

        _install(_policy(1, address(account)), account);
    }

    // ------------------------------------------------------------------ builders

    function _adapterRefs() internal view returns (AdapterRef[] memory r) {
        r = new AdapterRef[](6);
        r[0] = AdapterRef(swapId, "Fixture Swap", 1);
        r[1] = AdapterRef(badSwapId, "Fixture Swap", 1);
        r[2] = AdapterRef(evilSwapId, "Evil Swap", 1);
        r[3] = AdapterRef(payId, "Transfer Pay", 1);
        r[4] = AdapterRef(repayId, "Mock Repay", 1);
        r[5] = AdapterRef(reentrantId, "Transfer Pay", 1);
    }

    function _assetIds() internal view returns (bytes32[] memory ids) {
        ids = new bytes32[](5);
        ids[0] = _b(address(tokA));
        ids[1] = _b(address(tokB));
        ids[2] = _b(address(tokFee));
        ids[3] = _b(address(tokFalse));
        ids[4] = _b(address(tokNoRet));
    }

    function _policy(uint64 v, address acct) internal view returns (RootPolicy memory p) {
        p.accountId = ACCOUNT_ID;
        p.policyVersion = v;
        p.parentPolicyHash = v == 1 ? bytes32(0) : account.policyHash();
        p.activateBefore = uint64(block.timestamp) + 1 days;
        p.allowedActions = MASK;
        p.priceMode = 1;
        p.maxLeaseLifetime = 1 days;
        p.endpoints = new PolicyEndpoint[](1);
        PolicyEndpoint memory e = p.endpoints[0];
        e.chainRef = chainRef;
        e.account = _b(acct);
        e.epochSeconds = EPOCH;
        e.adapters = _adapterRefs();
        bytes32[] memory ids = _assetIds();
        e.assets = new AssetLimit[](ids.length);
        for (uint256 i; i < ids.length; ++i) e.assets[i] = AssetLimit(ids[i], 100e6, 200e6, 500e6);
        e.recipients = new Recipient[](1);
        e.recipients[0] = Recipient(_b(merchant), "Merchant");
        e.beneficiaries = new Recipient[](1);
        e.beneficiaries[0] = Recipient(_b(borrower), "Borrower");
        e.swapFloors = new SwapFloor[](2);
        e.swapFloors[0] = SwapFloor(_b(address(tokA)), _b(address(tokB)), 95, 100);
        e.swapFloors[1] = SwapFloor(_b(address(tokB)), _b(address(tokA)), 2 ** 255, 1);
        e.recoveryDestinations = new Recipient[](1);
        e.recoveryDestinations[0] = Recipient(_b(coldStorage), "Cold storage");

        p.leaseIssuers = new LeaseIssuer[](1);
        p.leaseIssuers[0].issuer = issuer;
        p.leaseIssuers[0].maxLeaseLifetime = 3600;
        p.leaseIssuers[0].allowedAgents = new address[](2);
        p.leaseIssuers[0].allowedAgents[0] = agent;
        p.leaseIssuers[0].allowedAgents[1] = agent2;
        p.leaseIssuers[0].limits = new IssuerLimit[](1);
        p.leaseIssuers[0].limits[0] = IssuerLimit(chainRef, _b(address(tokA)), 50e6, 100e6, 300e6);
    }

    function _policySigs(RootPolicy memory p) internal view returns (bytes[] memory sigs) {
        bytes32 d = h.policy(p);
        sigs = new bytes[](2);
        sigs[0] = _sign(ctrlPk[0], d);
        sigs[1] = _sign(ctrlPk[1], d);
    }

    function _install(RootPolicy memory p, AmaneAccount acct) internal {
        acct.installPolicy(p, _policySigs(p));
    }

    function _lease(bytes32 id, address agent_, address issuer_, bool issuerCaps) internal view returns (AgentLease memory l) {
        l.accountId = ACCOUNT_ID;
        l.policyVersion = account.policyVersion();
        l.leaseId = id;
        l.agent = agent_;
        l.issuer = issuer_;
        l.validAfter = uint64(block.timestamp);
        l.expiresAt = uint64(block.timestamp) + 3600;
        l.activateBefore = uint64(block.timestamp) + 600;
        l.allowedActions = MASK;
        l.authMode = 1;
        l.endpoints = new LeaseEndpoint[](1);
        LeaseEndpoint memory e = l.endpoints[0];
        e.chainRef = chainRef;
        e.account = _b(address(account));
        AdapterRef[] memory refs = _adapterRefs();
        e.adapters = new bytes32[](refs.length);
        for (uint256 i; i < refs.length; ++i) e.adapters[i] = refs[i].adapterId;
        if (issuerCaps) {
            e.assets = new AssetLimit[](2);
            e.assets[0] = AssetLimit(_b(address(tokA)), 50e6, 100e6, 300e6);
            e.assets[1] = AssetLimit(_b(address(tokB)), 0, 0, 0);
        } else {
            bytes32[] memory ids = _assetIds();
            e.assets = new AssetLimit[](ids.length);
            for (uint256 i; i < ids.length; ++i) e.assets[i] = AssetLimit(ids[i], 100e6, 200e6, 500e6);
        }
        e.recipients = new bytes32[](1);
        e.recipients[0] = _b(merchant);
        e.beneficiaries = new bytes32[](1);
        e.beneficiaries[0] = _b(borrower);
    }

    function _activate(AgentLease memory l, uint256 signerPk) internal {
        account.activateLease(l, _sign(signerPk, h.lease(l)));
    }

    function _ctrlLease(bytes32 id) internal returns (AgentLease memory l) {
        l = _lease(id, agent, ctrl[0], false);
        _activate(l, ctrlPk[0]);
    }

    function _issuerLease(bytes32 id, address agent_) internal returns (AgentLease memory l) {
        l = _lease(id, agent_, issuer, true);
        _activate(l, issuerPk);
    }

    function _pay(bytes32 leaseId, uint64 nonce, uint256 amount) internal view returns (ActionIntent memory a) {
        a = _base(leaseId, nonce, ActionKinds.PAY, payId, "Transfer Pay");
        a.assetIn = _b(address(tokA));
        a.assetOut = _b(address(tokA));
        a.amountIn = amount;
        a.minAmountOut = amount;
        a.recipient = _b(merchant);
        a.recipientLabel = "Merchant";
    }

    function _swap(bytes32 leaseId, uint64 nonce, bytes32 adapterId, string memory name, uint256 amount, uint256 minOut)
        internal
        view
        returns (ActionIntent memory a)
    {
        a = _base(leaseId, nonce, ActionKinds.SWAP, adapterId, name);
        a.assetIn = _b(address(tokA));
        a.assetOut = _b(address(tokB));
        a.amountIn = amount;
        a.minAmountOut = minOut;
    }

    function _repay(bytes32 leaseId, uint64 nonce, bytes32 adapterId, string memory name, uint256 amount)
        internal
        view
        returns (ActionIntent memory a)
    {
        a = _base(leaseId, nonce, ActionKinds.REPAY, adapterId, name);
        a.assetIn = _b(address(tokA));
        a.assetOut = _b(address(tokA));
        a.amountIn = amount;
        a.recipient = _b(borrower);
        a.recipientLabel = "Borrower";
    }

    function _base(bytes32 leaseId, uint64 nonce, uint8 kind, bytes32 adapterId, string memory name)
        internal
        view
        returns (ActionIntent memory a)
    {
        a.accountId = ACCOUNT_ID;
        a.chainRef = chainRef;
        a.account = _b(address(account));
        a.policyVersion = account.policyVersion();
        a.leaseId = leaseId;
        a.nonce = nonce;
        a.actionKind = kind;
        a.adapterId = adapterId;
        a.adapterName = name;
        a.adapterVersion = 1;
        a.deadline = uint64(block.timestamp) + 600;
        a.planHash = keccak256("plan");
        a.planStep = 1;
    }

    function _exec(ActionIntent memory a, uint256 pk) internal returns (uint256) {
        return account.executeAction(a, _sign(pk, h.action(a)));
    }

    function _pauseSig(uint256 pk, bytes32 id) internal view returns (PauseAccount memory x, bytes memory sig) {
        x = PauseAccount(ACCOUNT_ID, account.pauseEpoch(), id, uint64(block.timestamp) + 30 days);
        sig = _sign(pk, h.pause(x));
    }

    function _unpauseSigs(bytes32 id) internal view returns (UnpauseAccount memory x, bytes[] memory sigs) {
        x = UnpauseAccount(ACCOUNT_ID, chainRef, _b(address(account)), account.pauseEpoch(), id, uint64(block.timestamp) + 30 days);
        bytes32 d = h.unpause(x);
        sigs = new bytes[](2);
        sigs[0] = _sign(ctrlPk[0], d);
        sigs[1] = _sign(ctrlPk[1], d);
    }
}

contract BreakTest is BreakBase {
    bytes32 constant L1 = keccak256("lease-1");
    bytes32 constant L2 = keccak256("lease-2");

    // ================================================================== FIXED (regressions)

    /// F-0200: an unpause signed before a newer pause must not lift it.
    function test_FIXED_F0200_stale_unpause_lifts_newer_pause() public {
        _ctrlLease(L1);
        (PauseAccount memory p1, bytes memory s1) = _pauseSig(ctrlPk[0], keccak256("incident-1"));
        account.pause(p1, s1);
        (UnpauseAccount memory u, bytes[] memory us) = _unpauseSigs(p1.pauseId); // withheld
        vm.warp(T0 + 7 days);
        (PauseAccount memory p2, bytes memory s2) = _pauseSig(ctrlPk[2], keccak256("incident-2"));
        account.pause(p2, s2);
        vm.expectRevert();
        account.unpause(u, us);
        assertTrue(account.paused());
    }

    /// F-0201: no 2x burst across an epoch boundary.
    function test_FIXED_F0201_epoch_boundary_double_window() public {
        vm.warp(T0 + EPOCH - 1 - 600);
        AgentLease memory l = _lease(L1, agent, ctrl[0], false);
        _activate(l, ctrlPk[0]);
        vm.warp(T0 + EPOCH - 1);
        _exec(_pay(L1, 1, 100e6), agentPk);
        _exec(_pay(L1, 2, 100e6), agentPk);
        vm.warp(T0 + EPOCH);
        ActionIntent memory a = _pay(L1, 3, 100e6);
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert();
        account.executeAction(a, sig);
    }

    /// F-0202: no controller-chosen nonce to exhaust; pause stays available after unpause.
    function test_FIXED_F0202_pause_nonce_exhaustion_disables_pause() public {
        (PauseAccount memory rogue, bytes memory rs) = _pauseSig(ctrlPk[2], bytes32(type(uint256).max));
        account.pause(rogue, rs);
        (UnpauseAccount memory u, bytes[] memory us) = _unpauseSigs(rogue.pauseId);
        account.unpause(u, us);
        assertFalse(account.paused());
        (PauseAccount memory p, bytes memory s) = _pauseSig(ctrlPk[0], keccak256("incident-2"));
        account.pause(p, s);
        assertTrue(account.paused(), "pause must remain available");
    }

    /// F-0203: a stale signed policy dies at activateBefore.
    function test_FIXED_F0203_stale_root_policy_installable() public {
        RootPolicy memory lax = _policy(2, address(account));
        lax.endpoints[0].assets[0].maxTotal = 500_000e6;
        bytes[] memory laxSigs = _policySigs(lax);
        vm.warp(T0 + 30 days);
        vm.expectRevert(_rej(Codes.POLICY_ACTIVATION_EXPIRED));
        account.installPolicy(lax, laxSigs);
    }

    /// F-0203: a policy whose parent is not the installed policy is refused.
    function test_FIXED_F0203_policy_parent_mismatch() public {
        RootPolicy memory p = _policy(2, address(account));
        p.parentPolicyHash = keccak256("some other lineage");
        bytes[] memory sigs = _policySigs(p);
        vm.expectRevert(_rej(Codes.POLICY_PARENT_MISMATCH));
        account.installPolicy(p, sigs);
    }

    /// F-0204 (proxy variant): delegatecall/SSTORE adapters are refused at registration.
    function test_FIXED_F0204_proxy_adapter_refused() public {
        UpgradeableRepayAdapter proxy = new UpgradeableRepayAdapter(address(new RepayImplHonest()));
        vm.expectRevert();
        registry.register(address(proxy));
    }

    /// F-0205: issuers may not pre-revoke lease ids.
    function test_FIXED_F0205_issuer_revokes_foreign_lease() public {
        AgentLease memory l = _lease(L1, agent, ctrl[0], false);
        RevokeLease memory r = RevokeLease(ACCOUNT_ID, L1);
        bytes memory rs = _sign(issuerPk, h.revoke(r));
        vm.expectRevert(_rej(Codes.CONTROLLER_NOT_AUTHORIZED));
        account.revokeLease(r, rs);
        _activate(l, ctrlPk[0]);
    }

    /// F-0207: a pause signed in an earlier pause epoch is dead after the unpause.
    function test_FIXED_F0207_stale_pause_replayed_after_unpause() public {
        (PauseAccount memory p1, bytes memory s1) = _pauseSig(ctrlPk[0], keccak256("incident-1"));
        account.pause(p1, s1);
        (PauseAccount memory p2, bytes memory s2) = _pauseSig(ctrlPk[2], keccak256("sui-only"));
        vm.warp(T0 + 1 days);
        (UnpauseAccount memory u, bytes[] memory us) = _unpauseSigs(p1.pauseId);
        account.unpause(u, us);
        vm.expectRevert(_rej(Codes.REPLAY_PAUSE_EPOCH));
        account.pause(p2, s2);
    }

    /// F-0208: zero-numerator floors are refused at install.
    function test_FIXED_F0208_zero_numerator_floor_accepted() public {
        RootPolicy memory p = _policy(2, address(account));
        p.endpoints[0].swapFloors[0].minOutNumerator = 0;
        bytes[] memory sigs = _policySigs(p);
        vm.expectRevert(_rej(Codes.POLICY_BAD_FLOOR));
        account.installPolicy(p, sigs);
    }

    // ================================================================== FIXED / ACCEPTED (cont.)

    /// F-0200: pause ids are single-use, so replaying the incident-1 pause after incident-2
    /// cannot restore lastPauseId for a withheld incident-1 unpause.
    function test_FIXED_F0200_pause_replay_restores_last_pause_id() public {
        _ctrlLease(L1);
        (PauseAccount memory p1, bytes memory s1) = _pauseSig(ctrlPk[0], keccak256("incident-1"));
        account.pause(p1, s1);
        (UnpauseAccount memory u, bytes[] memory us) = _unpauseSigs(p1.pauseId); // withheld
        vm.warp(T0 + 1 days);
        (PauseAccount memory p2, bytes memory s2) = _pauseSig(ctrlPk[2], keccak256("incident-2"));
        account.pause(p2, s2);
        vm.expectRevert(_rej(Codes.REPLAY_PAUSE_EPOCH));
        account.pause(p1, s1);
        vm.expectRevert(_rej(Codes.REPLAY_PAUSE_EPOCH));
        account.unpause(u, us);
        assertTrue(account.paused());
    }

    /// F-0204: an externally routed REPAY adapter registers (no banned opcode), but the core no
    /// longer executes REPAY at all until a measured adapter exists.
    function test_FIXED_F0204_externally_routed_repay_adapter() public {
        RepayRouteConfig cfg = new RepayRouteConfig();
        bytes32 routedId = registry.register(address(new RoutedRepayAdapter(cfg)));
        RootPolicy memory p = _policy(2, address(account));
        AdapterRef[] memory refs = new AdapterRef[](p.endpoints[0].adapters.length + 1);
        for (uint256 i; i < refs.length - 1; ++i) refs[i] = p.endpoints[0].adapters[i];
        refs[refs.length - 1] = AdapterRef(routedId, "Routed Repay", 1);
        p.endpoints[0].adapters = refs;
        _install(p, account);

        AgentLease memory l = _lease(L1, agent, ctrl[0], false);
        bytes32[] memory ads = new bytes32[](1);
        ads[0] = routedId;
        l.endpoints[0].adapters = ads;
        _activate(l, ctrlPk[0]);

        cfg.setOverride(thief);
        ActionIntent memory a = _repay(L1, 1, routedId, "Routed Repay", 100e6);
        bytes memory sig = _sign(agentPk, h.action(a));
        // v2 REPAY measures the beneficiary's balance of a pinned debt token. This intent names the
        // spend asset as the debt token, which is refused; a routed adapter against a real debt
        // token is caught by the measurement (ProtocolAdapters.t.sol test_REPAY_006).
        vm.expectRevert(_rej(Codes.ACTION_ASSET_NOT_ALLOWED));
        account.executeAction(a, sig);
        assertEq(tokA.balanceOf(thief), 0);
    }

    /// F-0210 (ACCEPTED): documented worst case is 2x maxPerEpoch in any epoch-length window.
    /// Pins that bound: ~2x is reachable, nothing beyond it is.
    function test_ACCEPTED_F0210_bucket_bound_is_2x_per_epoch_window() public {
        _ctrlLease(L1);
        _exec(_pay(L1, 1, 100e6), agentPk);
        _exec(_pay(L1, 2, 100e6), agentPk);
        vm.warp(T0 + EPOCH - 1);
        _exec(_pay(L1, 3, 100e6), agentPk);
        _exec(_pay(L1, 4, 99e6), agentPk); // 399e6 inside 3599s, below the 400e6 bound
        ActionIntent memory a = _pay(L1, 5, 1e6);
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.BUDGET_EPOCH));
        account.executeAction(a, sig);
    }

    /// F-0211: refill no longer overflows for very large maxPerEpoch.
    function test_FIXED_F0211_bucket_refill_overflow_bricks_large_cap() public {
        RootPolicy memory p = _policy(2, address(account));
        p.endpoints[0].assets[0] = AssetLimit(_b(address(tokA)), 100e6, type(uint256).max, type(uint256).max);
        _install(p, account);
        AgentLease memory l = _lease(L1, agent, ctrl[0], false);
        l.endpoints[0].assets[0] = AssetLimit(_b(address(tokA)), 100e6, 1_000e6, 5_000e6);
        _activate(l, ctrlPk[0]);
        _exec(_pay(L1, 1, 1e6), agentPk);
        vm.warp(block.timestamp + 2);
        // well within every cap; must not revert
        _exec(_pay(L1, 2, 1e6), agentPk);
    }

    // ================================================================== HOLDS

    function test_HOLDS_lease_cap_above_root_rejected() public {
        AgentLease memory l = _lease(L1, agent, ctrl[0], false);
        l.endpoints[0].assets[0].maxPerEpoch = 200e6 + 1;
        bytes memory sig = _sign(ctrlPk[0], h.lease(l));
        vm.expectRevert(_rej(Codes.LEASE_CAP_EXCEEDS_ROOT));
        account.activateLease(l, sig);
    }

    function test_HOLDS_lease_action_mask_above_root_rejected() public {
        AgentLease memory l = _lease(L1, agent, ctrl[0], false);
        l.allowedActions = MASK | (1 << 1);
        bytes memory sig = _sign(ctrlPk[0], h.lease(l));
        vm.expectRevert(_rej(Codes.LEASE_ACTION_NOT_IN_ROOT));
        account.activateLease(l, sig);
    }

    function test_HOLDS_issuer_cap_exceeded_rejected() public {
        AgentLease memory l = _lease(L1, agent, issuer, true);
        l.endpoints[0].assets[0].maxTotal = 300e6 + 1;
        bytes memory sig = _sign(issuerPk, h.lease(l));
        vm.expectRevert(_rej(Codes.LEASE_CAP_EXCEEDS_ISSUER));
        account.activateLease(l, sig);
    }

    function test_HOLDS_issuer_asset_without_issuer_limit_rejected() public {
        AgentLease memory l = _lease(L1, agent, issuer, true);
        l.endpoints[0].assets[1].maxPerAction = 1; // tokB has no issuer limit
        bytes memory sig = _sign(issuerPk, h.lease(l));
        vm.expectRevert(_rej(Codes.LEASE_CAP_EXCEEDS_ISSUER));
        account.activateLease(l, sig);
    }

    function test_HOLDS_issuer_lifetime_and_agent_list() public {
        AgentLease memory l = _lease(L1, agent, issuer, true);
        l.expiresAt = l.validAfter + 3601;
        bytes memory sig = _sign(issuerPk, h.lease(l));
        vm.expectRevert(_rej(Codes.LEASE_LIFETIME_EXCEEDED));
        account.activateLease(l, sig);

        l = _lease(L1, stranger, issuer, true);
        sig = _sign(issuerPk, h.lease(l));
        vm.expectRevert(_rej(Codes.LEASE_AGENT_NOT_ALLOWED));
        account.activateLease(l, sig);
    }

    function test_HOLDS_unlisted_issuer_rejected() public {
        AgentLease memory l = _lease(L1, agent, stranger, true);
        bytes memory sig = _sign(strangerPk, h.lease(l));
        vm.expectRevert(_rej(Codes.LEASE_ISSUER_NOT_AUTHORIZED));
        account.activateLease(l, sig);
        // claimed issuer but signed by someone else
        l = _lease(L1, agent, issuer, true);
        sig = _sign(strangerPk, h.lease(l));
        vm.expectRevert(_rej(Codes.LEASE_ISSUER_NOT_AUTHORIZED));
        account.activateLease(l, sig);
    }

    function test_HOLDS_agent_signs_own_lease_rejected() public {
        AgentLease memory l = _lease(L1, agent, agent, false);
        bytes memory sig = _sign(agentPk, h.lease(l));
        vm.expectRevert(_rej(Codes.LEASE_AGENT_IS_ISSUER));
        account.activateLease(l, sig);
        // agent signs a lease naming the real issuer
        l = _lease(L1, agent, issuer, true);
        sig = _sign(agentPk, h.lease(l));
        vm.expectRevert(_rej(Codes.LEASE_ISSUER_NOT_AUTHORIZED));
        account.activateLease(l, sig);
        // controller as agent
        l = _lease(L1, ctrl[1], ctrl[0], false);
        sig = _sign(ctrlPk[0], h.lease(l));
        vm.expectRevert(_rej(Codes.LEASE_AGENT_IS_ISSUER));
        account.activateLease(l, sig);
    }

    function test_HOLDS_duplicate_lease_entries_rejected() public {
        AgentLease memory l = _lease(L1, agent, ctrl[0], false);
        l.endpoints[0].recipients = new bytes32[](2);
        l.endpoints[0].recipients[0] = _b(merchant);
        l.endpoints[0].recipients[1] = _b(merchant);
        bytes memory sig = _sign(ctrlPk[0], h.lease(l));
        vm.expectRevert(_rej(Codes.LEASE_DUPLICATE_ENTRY));
        account.activateLease(l, sig);

        l = _lease(L1, agent, ctrl[0], false);
        LeaseEndpoint[] memory eps = new LeaseEndpoint[](2);
        eps[0] = l.endpoints[0];
        eps[1] = l.endpoints[0];
        l.endpoints = eps;
        sig = _sign(ctrlPk[0], h.lease(l));
        vm.expectRevert(_rej(Codes.LEASE_DUPLICATE_ENTRY));
        account.activateLease(l, sig);
    }

    function test_HOLDS_lease_replay_and_cross_account() public {
        AgentLease memory l = _ctrlLease(L1);
        bytes memory sig = _sign(ctrlPk[0], h.lease(l));
        vm.expectRevert(_rej(Codes.REPLAY_LEASE_ID));
        account.activateLease(l, sig);

        address[] memory ctrls = new address[](3);
        for (uint256 i; i < 3; ++i) ctrls[i] = ctrl[i];
        AmaneAccount other = new AmaneAccount(ACCOUNT_ID, ctrls, 2, registry, address(new AmaneAccountExt()));
        _install(_policy(1, address(other)), other);
        vm.expectRevert(_rej(Codes.LEASE_WRONG_ENDPOINT));
        other.activateLease(l, sig);

        ActionIntent memory a = _pay(L1, 1, 1e6);
        bytes memory asig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.ACTION_WRONG_ENDPOINT));
        other.executeAction(a, asig);
    }

    function test_HOLDS_action_cross_chain_and_tamper_rejected() public {
        _ctrlLease(L1);
        ActionIntent memory a = _pay(L1, 1, 1e6);
        a.chainRef = keccak256("eip155:1");
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.ACTION_WRONG_ENDPOINT));
        account.executeAction(a, sig);

        a = _pay(L1, 1, 1e6);
        sig = _sign(agentPk, h.action(a));
        a.amountIn = 2e6; // executor mutates the amount
        vm.expectRevert(_rej(Codes.ACTION_WRONG_AGENT));
        account.executeAction(a, sig);
    }

    function test_HOLDS_nonce_replay_rejected() public {
        _ctrlLease(L1);
        ActionIntent memory a = _pay(L1, 7, 1e6);
        bytes memory sig = _sign(agentPk, h.action(a));
        account.executeAction(a, sig);
        vm.expectRevert(_rej(Codes.REPLAY_NONCE));
        account.executeAction(a, sig);
    }

    function test_HOLDS_high_s_twin_rejected_on_action() public {
        _ctrlLease(L1);
        ActionIntent memory a = _pay(L1, 1, 1e6);
        bytes memory sig = _sign(agentPk, h.action(a));
        bytes32 r;
        bytes32 s;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
        }
        uint8 v = uint8(sig[64]);
        bytes memory twin = abi.encodePacked(r, bytes32(N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(AmaneSig.HighS.selector);
        account.executeAction(a, twin);
    }

    function test_HOLDS_multiple_leases_share_root_budget() public {
        _ctrlLease(L1);
        AgentLease memory l2 = _lease(L2, agent2, ctrl[0], false);
        _activate(l2, ctrlPk[0]);
        _exec(_pay(L1, 1, 100e6), agentPk);
        _exec(_pay(L1, 2, 100e6), agentPk);
        ActionIntent memory a = _pay(L2, 1, 1);
        bytes memory sig = _sign(agent2Pk, h.action(a));
        vm.expectRevert(_rej(Codes.BUDGET_EPOCH));
        account.executeAction(a, sig);
    }

    function test_HOLDS_issuer_budget_shared_across_leases() public {
        _issuerLease(L1, agent);
        _issuerLease(L2, agent2);
        _exec(_pay(L1, 1, 50e6), agentPk);
        _exec(_pay(L1, 2, 50e6), agentPk);
        ActionIntent memory a = _pay(L2, 1, 1);
        bytes memory sig = _sign(agent2Pk, h.action(a));
        vm.expectRevert(_rej(Codes.BUDGET_EPOCH));
        account.executeAction(a, sig);
    }

    function test_HOLDS_root_total_across_epochs() public {
        _ctrlLease(L1);
        _exec(_pay(L1, 1, 100e6), agentPk);
        _exec(_pay(L1, 2, 100e6), agentPk);
        vm.warp(T0 + EPOCH); // bucket fully refilled
        _exec(_pay(L1, 3, 100e6), agentPk);
        _exec(_pay(L1, 4, 100e6), agentPk);
        ActionIntent memory a = _pay(L1, 5, 1e6);
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.BUDGET_EPOCH));
        account.executeAction(a, sig);
        // lease expired at T0+3600; a fresh lease draws on the same root total (500e6)
        vm.warp(T0 + 2 * EPOCH);
        AgentLease memory l2 = _lease(L2, agent2, ctrl[0], false);
        _activate(l2, ctrlPk[0]);
        _exec(_pay(L2, 1, 100e6), agent2Pk);
        a = _pay(L2, 2, 1);
        sig = _sign(agent2Pk, h.action(a));
        vm.expectRevert(_rej(Codes.BUDGET_TOTAL));
        account.executeAction(a, sig);
    }

    function test_HOLDS_pause_blocks_action() public {
        _ctrlLease(L1);
        (PauseAccount memory p, bytes memory s) = _pauseSig(ctrlPk[1], keccak256("incident-1"));
        vm.prank(stranger);
        account.pause(p, s);
        ActionIntent memory a = _pay(L1, 1, 1e6);
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.ACTION_ACCOUNT_PAUSED));
        account.executeAction(a, sig);
        (p, s) = _pauseSig(strangerPk, keccak256("incident-2"));
        vm.expectRevert(_rej(Codes.CONTROLLER_NOT_AUTHORIZED));
        account.pause(p, s);
    }

    function test_HOLDS_revoke_blocks_action_and_activation() public {
        _issuerLease(L1, agent);
        RevokeLease memory r = RevokeLease(ACCOUNT_ID, L1);
        account.revokeLease(r, _sign(issuerPk, h.revoke(r)));
        ActionIntent memory a = _pay(L1, 1, 1e6);
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.LEASE_NOT_ACTIVE));
        account.executeAction(a, sig);

        AgentLease memory l2 = _lease(L2, agent, ctrl[0], false);
        RevokeLease memory r2 = RevokeLease(ACCOUNT_ID, L2);
        account.revokeLease(r2, _sign(ctrlPk[2], h.revoke(r2)));
        sig = _sign(ctrlPk[0], h.lease(l2));
        vm.expectRevert(_rej(Codes.REPLAY_LEASE_ID));
        account.activateLease(l2, sig);
    }

    function test_HOLDS_agent_cannot_revoke_or_issue() public {
        _ctrlLease(L1);
        RevokeLease memory r = RevokeLease(ACCOUNT_ID, keccak256("x"));
        bytes memory rs = _sign(agentPk, h.revoke(r));
        vm.expectRevert(_rej(Codes.CONTROLLER_NOT_AUTHORIZED));
        account.revokeLease(r, rs);
    }

    function test_HOLDS_policy_version_bump_kills_old_leases() public {
        _issuerLease(L1, agent);
        _install(_policy(2, address(account)), account);
        ActionIntent memory a = _pay(L1, 1, 1e6);
        a.policyVersion = 1;
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.POLICY_VERSION_MISMATCH));
        account.executeAction(a, sig);
    }

    function test_HOLDS_policy_needs_threshold_and_no_duplicate_signer() public {
        RootPolicy memory p = _policy(2, address(account));
        bytes32 d = h.policy(p);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(ctrlPk[0], d);
        vm.expectRevert(_rej(Codes.CONTROLLER_THRESHOLD));
        account.installPolicy(p, sigs);
        sigs = new bytes[](2);
        sigs[0] = _sign(ctrlPk[0], d);
        sigs[1] = _sign(ctrlPk[0], d);
        vm.expectRevert(_rej(Codes.CONTROLLER_UNSORTED));
        account.installPolicy(p, sigs);
    }

    function test_HOLDS_pay_recipient_substitution_rejected() public {
        _ctrlLease(L1);
        ActionIntent memory a = _pay(L1, 1, 1e6);
        a.recipient = _b(thief);
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.ACTION_RECIPIENT_NOT_ALLOWED));
        account.executeAction(a, sig);

        a = _pay(L1, 1, 1e6);
        a.recipientLabel = "Merchant ";
        sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.ACTION_RECIPIENT_NOT_ALLOWED));
        account.executeAction(a, sig);
    }

    function test_HOLDS_pay_malicious_adapter_underdelivery_rejected() public {
        // evil adapter has kind SWAP; using it for PAY fails the kind check
        _ctrlLease(L1);
        ActionIntent memory a = _pay(L1, 1, 1e6);
        a.adapterId = evilSwapId;
        a.adapterName = "Evil Swap";
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.ADAPTER_KIND_MISMATCH));
        account.executeAction(a, sig);
    }

    /// F-0204: REPAY is not executed by the EVM core until a measured adapter exists.
    function test_FIXED_F0204_repay_without_a_debt_token_pair() public {
        _ctrlLease(L1);
        ActionIntent memory a = _repay(L1, 1, repayId, "Mock Repay", 5e6);
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.ACTION_ASSET_NOT_ALLOWED));
        account.executeAction(a, sig);
    }

    function test_HOLDS_swap_output_redirect_and_floor() public {
        _ctrlLease(L1);
        // honest 1:1 swap succeeds
        assertEq(_exec(_swap(L1, 1, swapId, "Fixture Swap", 10e6, 0), agentPk), 10e6);
        // adapter steals output, agent minOut 0: owner floor still applies
        ActionIntent memory a = _swap(L1, 2, evilSwapId, "Evil Swap", 10e6, 0);
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.ACTION_BELOW_MIN_OUT));
        account.executeAction(a, sig);
        // 90% rate below the 95% floor
        a = _swap(L1, 2, badSwapId, "Fixture Swap", 10e6, 0);
        sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.ACTION_BELOW_MIN_OUT));
        account.executeAction(a, sig);
        // swap output to an explicit recipient is refused
        a = _swap(L1, 2, swapId, "Fixture Swap", 10e6, 0);
        a.recipient = _b(thief);
        sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.ACTION_RECIPIENT_NOT_ALLOWED));
        account.executeAction(a, sig);
    }

    function test_HOLDS_swap_same_asset_rejected() public {
        _ctrlLease(L1);
        ActionIntent memory a = _swap(L1, 1, swapId, "Fixture Swap", 10e6, 0);
        a.assetOut = a.assetIn;
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.ACTION_ASSET_NOT_ALLOWED));
        account.executeAction(a, sig);
    }

    function test_HOLDS_floor_overflow_fails_closed() public {
        tokB.mint(address(account), 1_000e6);
        _ctrlLease(L1);
        ActionIntent memory a = _swap(L1, 1, swapId, "Fixture Swap", 10e6, 0);
        (a.assetIn, a.assetOut) = (a.assetOut, a.assetIn); // B -> A, num = 2^255
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(); // checked-arithmetic panic
        account.executeAction(a, sig);
    }

    function test_HOLDS_adapter_name_version_mismatch_rejected() public {
        _ctrlLease(L1);
        ActionIntent memory a = _pay(L1, 1, 1e6);
        a.adapterName = "Fixture Swap";
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.ACTION_ADAPTER_NAME_MISMATCH));
        account.executeAction(a, sig);
        a = _pay(L1, 1, 1e6);
        a.adapterVersion = 2;
        sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.ACTION_ADAPTER_NAME_MISMATCH));
        account.executeAction(a, sig);
    }

    function test_HOLDS_adapter_not_in_lease_rejected() public {
        AgentLease memory l = _lease(L1, agent, ctrl[0], false);
        bytes32[] memory ads = new bytes32[](1);
        ads[0] = swapId;
        l.endpoints[0].adapters = ads;
        _activate(l, ctrlPk[0]);
        ActionIntent memory a = _pay(L1, 1, 1e6);
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.ACTION_ADAPTER_NOT_ALLOWED));
        account.executeAction(a, sig);
    }

    function test_HOLDS_reentrancy_blocked() public {
        _ctrlLease(L1);
        ActionIntent memory inner = _pay(L1, 2, 1e6);
        inner.adapterId = payId;
        payloadStore.set(abi.encodeCall(AmaneAccount.executeAction, (inner, _sign(agentPk, h.action(inner)))));
        ActionIntent memory a = _pay(L1, 1, 1e6);
        a.adapterId = reentrantId;
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.ACTION_REENTRANT));
        account.executeAction(a, sig);
    }

    function test_HOLDS_token_quirks() public {
        _ctrlLease(L1);
        ActionIntent memory a = _pay(L1, 1, 1e6);
        a.assetIn = a.assetOut = _b(address(tokFee));
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(); // fee-on-transfer: adapter cannot forward full amount / under-delivery
        account.executeAction(a, sig);

        a = _pay(L1, 2, 1e6);
        a.assetIn = a.assetOut = _b(address(tokFalse));
        sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.ASSET_TRANSFER_FAILED));
        account.executeAction(a, sig);

        a = _pay(L1, 3, 1e6);
        a.assetIn = a.assetOut = _b(address(tokNoRet));
        _exec(a, agentPk);
        assertEq(tokNoRet.balanceOf(merchant), 1e6);
    }

    function test_HOLDS_lease_window_and_deadline() public {
        AgentLease memory l = _lease(L1, agent, ctrl[0], false);
        l.validAfter = uint64(block.timestamp) + 100;
        l.expiresAt = l.validAfter + 3600;
        _activate(l, ctrlPk[0]);
        ActionIntent memory a = _pay(L1, 1, 1e6);
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.LEASE_NOT_YET_VALID));
        account.executeAction(a, sig);
        vm.warp(l.expiresAt + 1);
        a = _pay(L1, 1, 1e6);
        sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej(Codes.LEASE_EXPIRED));
        account.executeAction(a, sig);
    }

    function test_HOLDS_withdraw_not_reachable_by_agent() public {
        _ctrlLease(L1);
        Withdraw memory w = Withdraw(ACCOUNT_ID, chainRef, _b(address(account)), _b(address(tokA)), 1e6, _b(coldStorage), 0, uint64(block.timestamp) + 60);
        bytes[] memory sigs = new bytes[](2);
        // agent + one controller cannot reach threshold
        bytes32 structHash = keccak256(
            abi.encode(AmaneHash.WITHDRAW_TYPEHASH, w.accountId, w.chainRef, w.account, w.assetId, w.amount, w.destination, w.opNonce, w.deadline)
        );
        bytes32 d = keccak256(abi.encodePacked(hex"1901", AmaneHash.domainSeparator(), structHash));
        (sigs[0], sigs[1]) = agent < ctrl[0] ? (_sign(agentPk, d), _sign(ctrlPk[0], d)) : (_sign(ctrlPk[0], d), _sign(agentPk, d));
        vm.expectRevert(_rej(Codes.CONTROLLER_NOT_AUTHORIZED));
        account.withdraw(w, sigs);
    }
}
