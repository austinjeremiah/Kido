// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import "../src/AmaneTypes.sol";
import {AmaneAccount} from "../src/AmaneAccount.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {AmaneTestToken} from "../src/AmaneTestToken.sol";
import {TransferPayAdapter} from "../src/adapters/TransferPayAdapter.sol";
import {FixedRateSwapAdapter} from "./mocks/Mocks.sol";

abstract contract AmaneBase is Test {
    using AmaneHash for *;

    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

    uint256 internal pkA = uint256(keccak256("amane.test-only.controller.a"));
    uint256 internal pkB = uint256(keccak256("amane.test-only.controller.b"));
    uint256 internal pkIssuer = uint256(keccak256("amane.test-only.issuer"));
    uint256 internal pkAgent = uint256(keccak256("amane.test-only.agent"));
    uint256 internal pkAttacker = uint256(keccak256("amane.test-only.attacker"));

    address internal ctrlA = vm.addr(pkA);
    address internal ctrlB = vm.addr(pkB);
    address internal issuer = vm.addr(pkIssuer);
    address internal agent = vm.addr(pkAgent);
    address internal attacker = vm.addr(pkAttacker);
    address internal merchant = makeAddr("merchant");
    address internal recovery = makeAddr("recovery");
    address internal executor = makeAddr("executor");

    bytes32 internal constant ACCOUNT_ID = keccak256("amane.test.account");
    bytes32 internal constant SUI_CHAIN_REF = keccak256("sui:4c78adac");
    bytes32 internal constant SUI_ACCOUNT = bytes32(uint256(0x5a1));

    AdapterRegistry internal registry;
    AmaneAccount internal acct;
    AmaneTestToken internal usd;
    AmaneTestToken internal amsui;
    bytes32 internal payId;
    bytes32 internal swapId;
    bytes32 internal leaseId = keccak256("lease.1");

    function setUp() public virtual {
        vm.warp(T0);
        registry = new AdapterRegistry();
        usd = new AmaneTestToken("Amane Test USD", "AMUSD", 6);
        amsui = new AmaneTestToken("Amane Test SUI", "AMSUI", 9);
        payId = registry.register(address(new TransferPayAdapter()));
        swapId = registry.register(address(new FixedRateSwapAdapter(1000, 1)));
        acct = new AmaneAccount(ACCOUNT_ID, _sorted(ctrlA, ctrlB), 2, registry);
        usd.mint(address(acct), 1_000_000000);
    }

    // ---------------------------------------------------------------- builders

    function _sorted(address a, address b) internal pure returns (address[] memory xs) {
        xs = new address[](2);
        (xs[0], xs[1]) = a < b ? (a, b) : (b, a);
    }

    function a32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _endpoint(bytes32 chainRef, bytes32 account) internal view returns (PolicyEndpoint memory e) {
        e.chainRef = chainRef;
        e.account = account;
        e.epochSeconds = 3600;
        e.adapters = new AdapterRef[](2);
        e.adapters[0] = AdapterRef(payId, "Transfer Pay", 1);
        e.adapters[1] = AdapterRef(swapId, "Fixture Swap", 1);
        e.assets = new AssetLimit[](2);
        e.assets[0] = AssetLimit(a32(address(usd)), 100_000000, 200_000000, 500_000000);
        e.assets[1] = AssetLimit(a32(address(amsui)), 0, 0, 0);
        e.recipients = new Recipient[](1);
        e.recipients[0] = Recipient(a32(merchant), unicode"Merchant ✓ café");
        e.beneficiaries = new Recipient[](0);
        e.swapFloors = new SwapFloor[](1);
        e.swapFloors[0] = SwapFloor(a32(address(usd)), a32(address(amsui)), 950, 1);
        e.recoveryDestinations = new Recipient[](1);
        e.recoveryDestinations[0] = Recipient(a32(recovery), "Cold storage");
    }

    function _policy(uint64 version) internal view returns (RootPolicy memory p) {
        p.accountId = ACCOUNT_ID;
        p.policyVersion = version;
        p.parentPolicyHash = version == 1 ? bytes32(0) : acct.policyHash();
        p.activateBefore = uint64(block.timestamp + 600);
        p.allowedActions = uint32((1 << 0) | (1 << 9));
        p.priceMode = 1;
        p.maxLeaseLifetime = 86_400;
        p.endpoints = new PolicyEndpoint[](2);
        p.endpoints[0] = _endpoint(acct.chainRef(), a32(address(acct)));
        p.endpoints[1] = _endpoint(SUI_CHAIN_REF, SUI_ACCOUNT);
        p.leaseIssuers = new LeaseIssuer[](1);
        p.leaseIssuers[0].issuer = issuer;
        p.leaseIssuers[0].maxLeaseLifetime = 3600;
        p.leaseIssuers[0].allowedAgents = new address[](1);
        p.leaseIssuers[0].allowedAgents[0] = agent;
        p.leaseIssuers[0].limits = new IssuerLimit[](1);
        p.leaseIssuers[0].limits[0] = IssuerLimit(acct.chainRef(), a32(address(usd)), 50_000000, 100_000000, 100_000000);
    }

    function _leaseEndpoint(bytes32 chainRef, bytes32 account) internal view returns (LeaseEndpoint memory e) {
        e.chainRef = chainRef;
        e.account = account;
        e.adapters = new bytes32[](2);
        e.adapters[0] = payId;
        e.adapters[1] = swapId;
        e.assets = new AssetLimit[](2);
        e.assets[0] = AssetLimit(a32(address(usd)), 25_000000, 50_000000, 100_000000);
        e.assets[1] = AssetLimit(a32(address(amsui)), 0, 0, 0);
        e.recipients = new bytes32[](1);
        e.recipients[0] = a32(merchant);
        e.beneficiaries = new bytes32[](0);
    }

    function _lease(address signer) internal view returns (AgentLease memory l) {
        l.accountId = ACCOUNT_ID;
        l.policyVersion = 1;
        l.leaseId = leaseId;
        l.agent = agent;
        l.issuer = signer;
        l.validAfter = uint64(T0);
        l.expiresAt = uint64(T0 + 3600);
        l.activateBefore = uint64(T0 + 600);
        l.allowedActions = uint32((1 << 0) | (1 << 9));
        l.authMode = 1;
        l.endpoints = new LeaseEndpoint[](2);
        l.endpoints[0] = _leaseEndpoint(acct.chainRef(), a32(address(acct)));
        l.endpoints[1] = _leaseEndpoint(SUI_CHAIN_REF, SUI_ACCOUNT);
    }

    function _pay(uint64 nonce, uint256 amount) internal view returns (ActionIntent memory a) {
        a.accountId = ACCOUNT_ID;
        a.chainRef = acct.chainRef();
        a.account = a32(address(acct));
        a.policyVersion = 1;
        a.leaseId = leaseId;
        a.nonce = nonce;
        a.actionKind = 9;
        a.adapterId = payId;
        a.adapterName = "Transfer Pay";
        a.adapterVersion = 1;
        a.assetIn = a32(address(usd));
        a.assetOut = a32(address(usd));
        a.amountIn = amount;
        a.recipient = a32(merchant);
        a.recipientLabel = unicode"Merchant ✓ café";
        a.deadline = uint64(block.timestamp + 300);
        a.planHash = keccak256("plan");
    }

    function _swap(uint64 nonce, uint256 amount, uint256 minOut) internal view returns (ActionIntent memory a) {
        a = _pay(nonce, amount);
        a.actionKind = 0;
        a.adapterId = swapId;
        a.adapterName = "Fixture Swap";
        a.assetOut = a32(address(amsui));
        a.minAmountOut = minOut;
        a.recipient = bytes32(0);
        a.recipientLabel = "";
    }

    // ---------------------------------------------------------------- hashing via calldata

    function hPolicy(RootPolicy calldata p) external pure returns (bytes32) {
        return AmaneHash.digest(p.hash());
    }

    function hLease(AgentLease calldata l) external pure returns (bytes32) {
        return AmaneHash.digest(l.hash());
    }

    function hAction(ActionIntent calldata a) external pure returns (bytes32) {
        return AmaneHash.digest(a.hash());
    }

    function hPause(PauseAccount calldata x) external pure returns (bytes32) {
        return AmaneHash.digest(x.hash());
    }

    function hUnpause(UnpauseAccount calldata x) external pure returns (bytes32) {
        return AmaneHash.digest(x.hash());
    }

    function hRevoke(RevokeLease calldata x) external pure returns (bytes32) {
        return AmaneHash.digest(x.hash());
    }

    function hWithdraw(Withdraw calldata x) external pure returns (bytes32) {
        return AmaneHash.digest(x.hash());
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        if (uint256(s) > SECP_N / 2) {
            s = bytes32(SECP_N - uint256(s));
            v = v == 27 ? 28 : 27;
        }
        return abi.encodePacked(r, s, v);
    }

    function _both(bytes32 digest) internal view returns (bytes[] memory sigs) {
        sigs = new bytes[](2);
        (uint256 first, uint256 second) = ctrlA < ctrlB ? (pkA, pkB) : (pkB, pkA);
        sigs[0] = _sign(first, digest);
        sigs[1] = _sign(second, digest);
    }

    function _install(RootPolicy memory p) internal {
        acct.installPolicy(p, _both(this.hPolicy(p)));
    }

    function _activate(AgentLease memory l, uint256 pk) internal {
        acct.activateLease(l, _sign(pk, this.hLease(l)));
    }

    function _agentSig(ActionIntent memory a) internal view returns (bytes memory) {
        return _sign(pkAgent, this.hAction(a));
    }

    function _exec(ActionIntent memory a) internal returns (uint256) {
        bytes memory sig = _agentSig(a);
        vm.prank(executor);
        return acct.executeAction(a, sig);
    }

    function _execReject(ActionIntent memory a, string memory code) internal {
        bytes memory sig = _agentSig(a);
        _reject(code);
        vm.prank(executor);
        acct.executeAction(a, sig);
    }

    function _activateReject(AgentLease memory l, uint256 pk, string memory code) internal {
        bytes memory sig = _sign(pk, this.hLease(l));
        _reject(code);
        acct.activateLease(l, sig);
    }

    function _ready() internal {
        _install(_policy(1));
        _activate(_lease(ctrlA), pkA);
    }

    function _pauseMsg(bytes32 pauseId) internal view returns (PauseAccount memory) {
        return PauseAccount(ACCOUNT_ID, acct.pauseEpoch(), pauseId, uint64(block.timestamp + 60));
    }

    function _unpauseMsg(bytes32 pauseId) internal view returns (UnpauseAccount memory) {
        return UnpauseAccount(ACCOUNT_ID, acct.chainRef(), a32(address(acct)), acct.pauseEpoch(), pauseId, uint64(block.timestamp + 60));
    }

    function _reject(string memory code) internal {
        vm.expectRevert(abi.encodeWithSelector(AmaneAccount.AmaneRejected.selector, code));
    }
}
