// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import "../../src/AmaneTypes.sol";
import {AmaneAccount} from "../../src/AmaneAccount.sol";
import {AdapterRegistry} from "../../src/AdapterRegistry.sol";
import {AmaneTestToken} from "../../src/AmaneTestToken.sol";
import {TransferPayAdapter} from "../../src/adapters/TransferPayAdapter.sol";
import {FixedRateSwapAdapter, MaliciousAdapter, ReentrantAdapter, FeeOnTransferToken} from "../mocks/Mocks.sol";
import {
    MockRepayAdapter,
    RepayImplHonest,
    RepayImplSteal,
    UpgradeableRepayAdapter,
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

    function _rej(string memory code) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(AmaneAccount.AmaneRejected.selector, code);
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
        account = new AmaneAccount(ACCOUNT_ID, ctrls, 2, registry);

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
        reentrant = new ReentrantAdapter(address(account));
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

    function _pauseSig(uint256 pk, uint64 n) internal view returns (PauseAccount memory x, bytes memory sig) {
        x = PauseAccount(ACCOUNT_ID, n);
        sig = _sign(pk, h.pause(x));
    }

    function _unpauseSigs(uint64 op) internal view returns (UnpauseAccount memory x, bytes[] memory sigs) {
        x = UnpauseAccount(ACCOUNT_ID, chainRef, _b(address(account)), op);
        bytes32 d = h.unpause(x);
        sigs = new bytes[](2);
        sigs[0] = _sign(ctrlPk[0], d);
        sigs[1] = _sign(ctrlPk[1], d);
    }
}

contract BreakTest is BreakBase {
    bytes32 constant L1 = keccak256("lease-1");
    bytes32 constant L2 = keccak256("lease-2");

    // ================================================================== BREAK

    /// F-0200: an unpause signed before a newer pause still lifts it. An untrusted executor that
    /// withholds a signed unpause can release it after a later emergency pause.
    function test_BREAK_stale_unpause_lifts_newer_pause() public {
        _ctrlLease(L1);
        (PauseAccount memory p1, bytes memory s1) = _pauseSig(ctrlPk[0], 1);
        account.pause(p1, s1);

        // owners sign an unpause and hand it to a relayer, which withholds it
        (UnpauseAccount memory u, bytes[] memory us) = _unpauseSigs(0);

        // a new emergency: a guardian pauses again with a fresh pause nonce
        vm.warp(T0 + 7 days);
        (PauseAccount memory p2, bytes memory s2) = _pauseSig(ctrlPk[2], 2);
        account.pause(p2, s2);
        assertTrue(account.paused());

        // the stale unpause must not override the newer pause
        vm.expectRevert();
        account.unpause(u, us);
    }

    /// F-0201: fixed calendar epochs let one lease spend 2x maxPerEpoch within two seconds.
    function test_BREAK_epoch_boundary_double_window() public {
        vm.warp(T0 + EPOCH - 1 - 600);
        AgentLease memory l = _lease(L1, agent, ctrl[0], false);
        _activate(l, ctrlPk[0]);
        vm.warp(T0 + EPOCH - 1); // last second of epoch k
        _exec(_pay(L1, 1, 100e6), agentPk);
        _exec(_pay(L1, 2, 100e6), agentPk); // epoch cap (200e6) fully used
        vm.warp(T0 + EPOCH); // one second later, epoch k+1
        // any further spend within one epoch length of the 200e6 already spent exceeds the cap
        ActionIntent memory a = _pay(L1, 3, 100e6);
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert();
        account.executeAction(a, sig);
    }

    /// F-0202: one controller can burn the pause nonce space and permanently disable pause.
    function test_BREAK_pause_nonce_exhaustion_disables_pause() public {
        (PauseAccount memory rogue, bytes memory rs) = _pauseSig(ctrlPk[2], type(uint64).max);
        account.pause(rogue, rs);
        (UnpauseAccount memory u, bytes[] memory us) = _unpauseSigs(0);
        account.unpause(u, us);
        assertFalse(account.paused());

        // an honest controller must still be able to pull the emergency brake
        (PauseAccount memory p, bytes memory s) = _pauseSig(ctrlPk[0], 2);
        account.pause(p, s);
        assertTrue(account.paused(), "pause must remain available");
    }

    /// F-0203: a RootPolicy has no expiry or parent binding, so a stale signed policy for the
    /// next version stays installable forever and the relayer picks which of two signed
    /// policies for the same version wins.
    function test_BREAK_stale_root_policy_installable() public {
        RootPolicy memory lax = _policy(2, address(account));
        lax.endpoints[0].assets[0].maxTotal = 500_000e6;
        lax.endpoints[0].assets[0].maxPerEpoch = 500_000e6;
        bytes[] memory laxSigs = _policySigs(lax); // draft signed, then abandoned

        vm.warp(T0 + 30 days);
        RootPolicy memory strict = _policy(2, address(account));
        strict.endpoints[0].assets[0].maxTotal = 100e6;
        _policySigs(strict); // the policy the owners actually intend

        // relayer installs the month-old lax draft instead
        vm.expectRevert();
        account.installPolicy(lax, laxSigs);
    }

    /// F-0204: the registry accepts an adapter whose behaviour can change behind a stable
    /// codehash (delegatecall proxy). REPAY output is not measured, so an upgrade steals.
    function test_BREAK_upgradeable_adapter_changes_meaning() public {
        UpgradeableRepayAdapter proxy = new UpgradeableRepayAdapter(address(new RepayImplHonest()));
        bytes32 proxyId;
        try registry.register(address(proxy)) returns (bytes32 id) {
            proxyId = id;
        } catch {
            return; // registry refuses mutable adapters: defended
        }
        RootPolicy memory p = _policy(2, address(account));
        AdapterRef[] memory refs = new AdapterRef[](p.endpoints[0].adapters.length + 1);
        for (uint256 i; i < refs.length - 1; ++i) refs[i] = p.endpoints[0].adapters[i];
        refs[refs.length - 1] = AdapterRef(proxyId, "Proxy Repay", 1);
        p.endpoints[0].adapters = refs;
        _install(p, account);

        AgentLease memory l = _lease(L1, agent, ctrl[0], false);
        bytes32[] memory ads = new bytes32[](1);
        ads[0] = proxyId;
        l.endpoints[0].adapters = ads;
        _activate(l, ctrlPk[0]);

        _exec(_repay(L1, 1, proxyId, "Proxy Repay", 10e6), agentPk);
        assertEq(tokA.balanceOf(borrower), 10e6);

        // same adapter id, same codehash, new behaviour
        proxy.upgrade(address(new RepayImplSteal(thief)));
        ActionIntent memory a = _repay(L1, 2, proxyId, "Proxy Repay", 100e6);
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert();
        account.executeAction(a, sig);
    }

    /// F-0205: any listed Lease Issuer can pre-revoke lease ids it did not issue, including
    /// controller-signed leases seen in the mempool before activation.
    function test_BREAK_issuer_revokes_foreign_lease() public {
        AgentLease memory l = _lease(L1, agent, ctrl[0], false);
        RevokeLease memory r = RevokeLease(ACCOUNT_ID, L1);
        bytes memory rs = _sign(issuerPk, h.revoke(r));
        vm.expectRevert();
        account.revokeLease(r, rs);
        _activate(l, ctrlPk[0]);
    }

    /// F-0206: the issuer "max active leases" cap from bible 7.2/7.3.1 is not implemented.
    /// With the bible's example cap of 3, a fourth concurrent issuer lease must be rejected.
    function test_BREAK_issuer_max_active_leases_not_enforced() public {
        for (uint256 i; i < 3; ++i) _issuerLease(keccak256(abi.encode("issuer-lease", i)), i % 2 == 0 ? agent : agent2);
        AgentLease memory l = _lease(keccak256(abi.encode("issuer-lease", uint256(3))), agent, issuer, true);
        bytes memory sig = _sign(issuerPk, h.lease(l));
        vm.expectRevert();
        account.activateLease(l, sig);
    }

    /// F-0207: a chain-agnostic pause signed before an unpause can be replayed afterwards by
    /// any relayer (e.g. a pause that was only submitted to the Sui endpoint).
    function test_BREAK_stale_pause_replayed_after_unpause() public {
        (PauseAccount memory p1, bytes memory s1) = _pauseSig(ctrlPk[0], 1);
        account.pause(p1, s1);
        // guardian pauses the Sui endpoint with nonce 2; the relayer keeps a copy
        (PauseAccount memory p2, bytes memory s2) = _pauseSig(ctrlPk[2], 2);
        // owners review and unpause this endpoint
        vm.warp(T0 + 1 days);
        (UnpauseAccount memory u, bytes[] memory us) = _unpauseSigs(0);
        account.unpause(u, us);
        // relayer re-pauses with the older signature
        vm.expectRevert();
        account.pause(p2, s2);
    }

    /// F-0208: a zero-numerator swap floor is accepted, silently disabling the mandatory
    /// owner price floor; with agent minOut = 0 a swap may return nothing.
    function test_BREAK_zero_numerator_floor_accepted() public {
        RootPolicy memory p = _policy(2, address(account));
        p.endpoints[0].swapFloors[0].minOutNumerator = 0;
        bytes[] memory sigs = _policySigs(p);
        try account.installPolicy(p, sigs) {} catch {
            return; // rejected at install: defended
        }
        _ctrlLease(L1);
        uint256 before = tokA.balanceOf(address(account));
        uint256 out = _exec(_swap(L1, 1, evilSwapId, "Evil Swap", 100e6, 0), agentPk);
        assertEq(before - tokA.balanceOf(address(account)), 100e6);
        assertGt(out, 0, "swap returned nothing: owner floor bypassed");
    }

    // ================================================================== HOLDS

    function test_HOLDS_lease_cap_above_root_rejected() public {
        AgentLease memory l = _lease(L1, agent, ctrl[0], false);
        l.endpoints[0].assets[0].maxPerEpoch = 200e6 + 1;
        bytes memory sig = _sign(ctrlPk[0], h.lease(l));
        vm.expectRevert(_rej("AMANE_LEASE_CAP_EXCEEDS_ROOT"));
        account.activateLease(l, sig);
    }

    function test_HOLDS_lease_action_mask_above_root_rejected() public {
        AgentLease memory l = _lease(L1, agent, ctrl[0], false);
        l.allowedActions = MASK | (1 << 1);
        bytes memory sig = _sign(ctrlPk[0], h.lease(l));
        vm.expectRevert(_rej("AMANE_LEASE_ACTION_NOT_IN_ROOT"));
        account.activateLease(l, sig);
    }

    function test_HOLDS_issuer_cap_exceeded_rejected() public {
        AgentLease memory l = _lease(L1, agent, issuer, true);
        l.endpoints[0].assets[0].maxTotal = 300e6 + 1;
        bytes memory sig = _sign(issuerPk, h.lease(l));
        vm.expectRevert(_rej("AMANE_LEASE_CAP_EXCEEDS_ISSUER"));
        account.activateLease(l, sig);
    }

    function test_HOLDS_issuer_asset_without_issuer_limit_rejected() public {
        AgentLease memory l = _lease(L1, agent, issuer, true);
        l.endpoints[0].assets[1].maxPerAction = 1; // tokB has no issuer limit
        bytes memory sig = _sign(issuerPk, h.lease(l));
        vm.expectRevert(_rej("AMANE_LEASE_CAP_EXCEEDS_ISSUER"));
        account.activateLease(l, sig);
    }

    function test_HOLDS_issuer_lifetime_and_agent_list() public {
        AgentLease memory l = _lease(L1, agent, issuer, true);
        l.expiresAt = l.validAfter + 3601;
        bytes memory sig = _sign(issuerPk, h.lease(l));
        vm.expectRevert(_rej("AMANE_LEASE_LIFETIME_EXCEEDED"));
        account.activateLease(l, sig);

        l = _lease(L1, stranger, issuer, true);
        sig = _sign(issuerPk, h.lease(l));
        vm.expectRevert(_rej("AMANE_LEASE_AGENT_NOT_ALLOWED"));
        account.activateLease(l, sig);
    }

    function test_HOLDS_unlisted_issuer_rejected() public {
        AgentLease memory l = _lease(L1, agent, stranger, true);
        bytes memory sig = _sign(strangerPk, h.lease(l));
        vm.expectRevert(_rej("AMANE_LEASE_ISSUER_NOT_AUTHORIZED"));
        account.activateLease(l, sig);
        // claimed issuer but signed by someone else
        l = _lease(L1, agent, issuer, true);
        sig = _sign(strangerPk, h.lease(l));
        vm.expectRevert(_rej("AMANE_LEASE_ISSUER_NOT_AUTHORIZED"));
        account.activateLease(l, sig);
    }

    function test_HOLDS_agent_signs_own_lease_rejected() public {
        AgentLease memory l = _lease(L1, agent, agent, false);
        bytes memory sig = _sign(agentPk, h.lease(l));
        vm.expectRevert(_rej("AMANE_LEASE_AGENT_IS_ISSUER"));
        account.activateLease(l, sig);
        // agent signs a lease naming the real issuer
        l = _lease(L1, agent, issuer, true);
        sig = _sign(agentPk, h.lease(l));
        vm.expectRevert(_rej("AMANE_LEASE_ISSUER_NOT_AUTHORIZED"));
        account.activateLease(l, sig);
        // controller as agent
        l = _lease(L1, ctrl[1], ctrl[0], false);
        sig = _sign(ctrlPk[0], h.lease(l));
        vm.expectRevert(_rej("AMANE_LEASE_AGENT_IS_ISSUER"));
        account.activateLease(l, sig);
    }

    function test_HOLDS_duplicate_lease_entries_rejected() public {
        AgentLease memory l = _lease(L1, agent, ctrl[0], false);
        l.endpoints[0].recipients = new bytes32[](2);
        l.endpoints[0].recipients[0] = _b(merchant);
        l.endpoints[0].recipients[1] = _b(merchant);
        bytes memory sig = _sign(ctrlPk[0], h.lease(l));
        vm.expectRevert(_rej("AMANE_LEASE_DUPLICATE_ENTRY"));
        account.activateLease(l, sig);

        l = _lease(L1, agent, ctrl[0], false);
        LeaseEndpoint[] memory eps = new LeaseEndpoint[](2);
        eps[0] = l.endpoints[0];
        eps[1] = l.endpoints[0];
        l.endpoints = eps;
        sig = _sign(ctrlPk[0], h.lease(l));
        vm.expectRevert(_rej("AMANE_LEASE_DUPLICATE_ENTRY"));
        account.activateLease(l, sig);
    }

    function test_HOLDS_lease_replay_and_cross_account() public {
        AgentLease memory l = _ctrlLease(L1);
        bytes memory sig = _sign(ctrlPk[0], h.lease(l));
        vm.expectRevert(_rej("AMANE_REPLAY_LEASE_ID"));
        account.activateLease(l, sig);

        address[] memory ctrls = new address[](3);
        for (uint256 i; i < 3; ++i) ctrls[i] = ctrl[i];
        AmaneAccount other = new AmaneAccount(ACCOUNT_ID, ctrls, 2, registry);
        _install(_policy(1, address(other)), other);
        vm.expectRevert(_rej("AMANE_LEASE_WRONG_ENDPOINT"));
        other.activateLease(l, sig);

        ActionIntent memory a = _pay(L1, 1, 1e6);
        bytes memory asig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej("AMANE_ACTION_WRONG_ENDPOINT"));
        other.executeAction(a, asig);
    }

    function test_HOLDS_action_cross_chain_and_tamper_rejected() public {
        _ctrlLease(L1);
        ActionIntent memory a = _pay(L1, 1, 1e6);
        a.chainRef = keccak256("eip155:1");
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej("AMANE_ACTION_WRONG_ENDPOINT"));
        account.executeAction(a, sig);

        a = _pay(L1, 1, 1e6);
        sig = _sign(agentPk, h.action(a));
        a.amountIn = 2e6; // executor mutates the amount
        vm.expectRevert(_rej("AMANE_ACTION_WRONG_AGENT"));
        account.executeAction(a, sig);
    }

    function test_HOLDS_nonce_replay_rejected() public {
        _ctrlLease(L1);
        ActionIntent memory a = _pay(L1, 7, 1e6);
        bytes memory sig = _sign(agentPk, h.action(a));
        account.executeAction(a, sig);
        vm.expectRevert(_rej("AMANE_REPLAY_NONCE"));
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
        vm.expectRevert(_rej("AMANE_BUDGET_EPOCH"));
        account.executeAction(a, sig);
    }

    function test_HOLDS_issuer_budget_shared_across_leases() public {
        _issuerLease(L1, agent);
        _issuerLease(L2, agent2);
        _exec(_pay(L1, 1, 50e6), agentPk);
        _exec(_pay(L1, 2, 50e6), agentPk);
        ActionIntent memory a = _pay(L2, 1, 1);
        bytes memory sig = _sign(agent2Pk, h.action(a));
        vm.expectRevert(_rej("AMANE_BUDGET_EPOCH"));
        account.executeAction(a, sig);
    }

    function test_HOLDS_root_total_across_epochs() public {
        _ctrlLease(L1);
        _exec(_pay(L1, 1, 100e6), agentPk);
        _exec(_pay(L1, 2, 100e6), agentPk);
        vm.warp(T0 + EPOCH);
        _exec(_pay(L1, 3, 100e6), agentPk);
        _exec(_pay(L1, 4, 100e6), agentPk);
        vm.warp(T0 + 2 * EPOCH - 1);
        // lease expires at T0+3600; use a fresh lease for the remaining total
        AgentLease memory l2 = _lease(L2, agent2, ctrl[0], false);
        _activate(l2, ctrlPk[0]);
        ActionIntent memory a = _pay(L2, 1, 100e6);
        bytes memory sig = _sign(agent2Pk, h.action(a));
        vm.expectRevert(_rej("AMANE_BUDGET_EPOCH"));
        account.executeAction(a, sig);
        vm.warp(T0 + 2 * EPOCH);
        _exec(_pay(L2, 2, 100e6), agent2Pk);
        a = _pay(L2, 3, 1);
        sig = _sign(agent2Pk, h.action(a));
        vm.expectRevert(_rej("AMANE_BUDGET_TOTAL"));
        account.executeAction(a, sig);
    }

    function test_HOLDS_pause_blocks_action() public {
        _ctrlLease(L1);
        (PauseAccount memory p, bytes memory s) = _pauseSig(ctrlPk[1], 1);
        vm.prank(stranger);
        account.pause(p, s);
        ActionIntent memory a = _pay(L1, 1, 1e6);
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej("AMANE_ACTION_ACCOUNT_PAUSED"));
        account.executeAction(a, sig);
        (p, s) = _pauseSig(strangerPk, 2);
        vm.expectRevert(_rej("AMANE_CONTROLLER_NOT_AUTHORIZED"));
        account.pause(p, s);
    }

    function test_HOLDS_revoke_blocks_action_and_activation() public {
        _issuerLease(L1, agent);
        RevokeLease memory r = RevokeLease(ACCOUNT_ID, L1);
        account.revokeLease(r, _sign(issuerPk, h.revoke(r)));
        ActionIntent memory a = _pay(L1, 1, 1e6);
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej("AMANE_LEASE_NOT_ACTIVE"));
        account.executeAction(a, sig);

        AgentLease memory l2 = _lease(L2, agent, ctrl[0], false);
        RevokeLease memory r2 = RevokeLease(ACCOUNT_ID, L2);
        account.revokeLease(r2, _sign(ctrlPk[2], h.revoke(r2)));
        sig = _sign(ctrlPk[0], h.lease(l2));
        vm.expectRevert(_rej("AMANE_REPLAY_LEASE_ID"));
        account.activateLease(l2, sig);
    }

    function test_HOLDS_agent_cannot_revoke_or_issue() public {
        _ctrlLease(L1);
        RevokeLease memory r = RevokeLease(ACCOUNT_ID, keccak256("x"));
        bytes memory rs = _sign(agentPk, h.revoke(r));
        vm.expectRevert(_rej("AMANE_CONTROLLER_NOT_AUTHORIZED"));
        account.revokeLease(r, rs);
    }

    function test_HOLDS_policy_version_bump_kills_old_leases() public {
        _issuerLease(L1, agent);
        _install(_policy(2, address(account)), account);
        ActionIntent memory a = _pay(L1, 1, 1e6);
        a.policyVersion = 1;
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej("AMANE_POLICY_VERSION_MISMATCH"));
        account.executeAction(a, sig);
    }

    function test_HOLDS_policy_needs_threshold_and_no_duplicate_signer() public {
        RootPolicy memory p = _policy(2, address(account));
        bytes32 d = h.policy(p);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(ctrlPk[0], d);
        vm.expectRevert(_rej("AMANE_CONTROLLER_THRESHOLD"));
        account.installPolicy(p, sigs);
        sigs = new bytes[](2);
        sigs[0] = _sign(ctrlPk[0], d);
        sigs[1] = _sign(ctrlPk[0], d);
        vm.expectRevert(_rej("AMANE_CONTROLLER_UNSORTED"));
        account.installPolicy(p, sigs);
    }

    function test_HOLDS_pay_recipient_substitution_rejected() public {
        _ctrlLease(L1);
        ActionIntent memory a = _pay(L1, 1, 1e6);
        a.recipient = _b(thief);
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej("AMANE_ACTION_RECIPIENT_NOT_ALLOWED"));
        account.executeAction(a, sig);

        a = _pay(L1, 1, 1e6);
        a.recipientLabel = "Merchant ";
        sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej("AMANE_ACTION_RECIPIENT_NOT_ALLOWED"));
        account.executeAction(a, sig);
    }

    function test_HOLDS_pay_malicious_adapter_underdelivery_rejected() public {
        // evil adapter has kind SWAP; using it for PAY fails the kind check
        _ctrlLease(L1);
        ActionIntent memory a = _pay(L1, 1, 1e6);
        a.adapterId = evilSwapId;
        a.adapterName = "Evil Swap";
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej("AMANE_ADAPTER_KIND_MISMATCH"));
        account.executeAction(a, sig);
    }

    function test_HOLDS_repay_beneficiary_substitution_rejected() public {
        _ctrlLease(L1);
        _exec(_repay(L1, 1, repayId, "Mock Repay", 5e6), agentPk);
        assertEq(tokA.balanceOf(borrower), 5e6);
        ActionIntent memory a = _repay(L1, 2, repayId, "Mock Repay", 5e6);
        a.recipient = _b(thief);
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej("AMANE_ACTION_RECIPIENT_NOT_ALLOWED"));
        account.executeAction(a, sig);
    }

    function test_HOLDS_swap_output_redirect_and_floor() public {
        _ctrlLease(L1);
        // honest 1:1 swap succeeds
        assertEq(_exec(_swap(L1, 1, swapId, "Fixture Swap", 10e6, 0), agentPk), 10e6);
        // adapter steals output, agent minOut 0: owner floor still applies
        ActionIntent memory a = _swap(L1, 2, evilSwapId, "Evil Swap", 10e6, 0);
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej("AMANE_ACTION_BELOW_MIN_OUT"));
        account.executeAction(a, sig);
        // 90% rate below the 95% floor
        a = _swap(L1, 2, badSwapId, "Fixture Swap", 10e6, 0);
        sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej("AMANE_ACTION_BELOW_MIN_OUT"));
        account.executeAction(a, sig);
        // swap output to an explicit recipient is refused
        a = _swap(L1, 2, swapId, "Fixture Swap", 10e6, 0);
        a.recipient = _b(thief);
        sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej("AMANE_ACTION_RECIPIENT_NOT_ALLOWED"));
        account.executeAction(a, sig);
    }

    function test_HOLDS_swap_same_asset_rejected() public {
        _ctrlLease(L1);
        ActionIntent memory a = _swap(L1, 1, swapId, "Fixture Swap", 10e6, 0);
        a.assetOut = a.assetIn;
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej("AMANE_ACTION_ASSET_NOT_ALLOWED"));
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
        vm.expectRevert(_rej("AMANE_ACTION_ADAPTER_NAME_MISMATCH"));
        account.executeAction(a, sig);
        a = _pay(L1, 1, 1e6);
        a.adapterVersion = 2;
        sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej("AMANE_ACTION_ADAPTER_NAME_MISMATCH"));
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
        vm.expectRevert(_rej("AMANE_ACTION_ADAPTER_NOT_ALLOWED"));
        account.executeAction(a, sig);
    }

    function test_HOLDS_reentrancy_blocked() public {
        _ctrlLease(L1);
        ActionIntent memory inner = _pay(L1, 2, 1e6);
        inner.adapterId = payId;
        reentrant.setPayload(abi.encodeCall(AmaneAccount.executeAction, (inner, _sign(agentPk, h.action(inner)))));
        ActionIntent memory a = _pay(L1, 1, 1e6);
        a.adapterId = reentrantId;
        bytes memory sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej("AMANE_ACTION_REENTRANT"));
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
        vm.expectRevert(_rej("AMANE_ASSET_TRANSFER_FAILED"));
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
        vm.expectRevert(_rej("AMANE_LEASE_NOT_YET_VALID"));
        account.executeAction(a, sig);
        vm.warp(l.expiresAt + 1);
        a = _pay(L1, 1, 1e6);
        sig = _sign(agentPk, h.action(a));
        vm.expectRevert(_rej("AMANE_LEASE_EXPIRED"));
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
        vm.expectRevert(_rej("AMANE_CONTROLLER_NOT_AUTHORIZED"));
        account.withdraw(w, sigs);
    }
}
