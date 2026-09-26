// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    ActionIntent,
    ActionKinds,
    AgentLease,
    AmaneHash,
    AmaneSig,
    AssetLimit,
    LeaseEndpoint,
    LeaseIssuer,
    PauseAccount,
    PolicyEndpoint,
    RevokeLease,
    RootPolicy,
    UnpauseAccount,
    Withdraw
} from "./AmaneTypes.sol";
import {AdapterRegistry, IAmaneAdapter} from "./AdapterRegistry.sol";

interface IERC20Minimal {
    function balanceOf(address) external view returns (uint256);
}

/// Non-upgradeable Amane endpoint for one logical account on one EVM chain.
/// Invariant: Action ⊆ Lease ⊆ RootPolicy. Every agent action is verified, budget-debited and
/// nonce-marked before any token leaves the account, and output is measured by the account itself.
contract AmaneAccount {
    using AmaneHash for *;

    uint8 private constant PRICE_MODE_TESTNET_FIXED = 1;
    uint8 private constant AUTH_MODE_AGENT_SIGNED = 1;

    uint8 private constant LEASE_NONE = 0;
    uint8 private constant LEASE_ACTIVE = 1;
    uint8 private constant LEASE_REVOKED = 2;

    struct Limit {
        bool allowed;
        uint256 perAction;
        uint256 perEpoch;
        uint256 total;
    }

    struct Spend {
        uint64 epoch;
        uint256 epochSpent;
        uint256 totalSpent;
    }

    struct AdapterPolicy {
        bool allowed;
        bytes32 nameHash;
        uint32 version;
    }

    struct Floor {
        uint256 num;
        uint256 den;
    }

    struct IssuerPolicy {
        bool allowed;
        uint64 maxLeaseLifetime;
    }

    struct Lease {
        uint8 status;
        bool byController;
        uint64 policyVersion;
        address agent;
        address issuer;
        uint64 validAfter;
        uint64 expiresAt;
        uint32 allowedActions;
    }

    bytes32 public immutable accountId;
    bytes32 public immutable chainRef;
    AdapterRegistry public immutable registry;
    uint8 public immutable threshold;

    address[] private controllerList;
    mapping(address => bool) public isController;

    bool public paused;
    uint64 public pauseNonce;
    uint64 public opNonce;

    uint64 public policyVersion;
    bytes32 public policyHash;
    uint32 public allowedActions;
    uint64 public maxLeaseLifetime;
    uint64 public epochSeconds;

    mapping(uint64 => mapping(bytes32 => AdapterPolicy)) private rootAdapters;
    mapping(uint64 => mapping(bytes32 => Limit)) private rootAssets;
    mapping(uint64 => mapping(bytes32 => bytes32)) private rootRecipientLabel;
    mapping(uint64 => mapping(bytes32 => bytes32)) private rootBeneficiaryLabel;
    mapping(uint64 => mapping(bytes32 => bool)) private recoveryDestination;
    mapping(uint64 => mapping(bytes32 => Floor)) private swapFloor;
    mapping(uint64 => mapping(address => IssuerPolicy)) private issuers;
    mapping(uint64 => mapping(address => mapping(address => bool))) private issuerAgents;
    mapping(uint64 => mapping(address => mapping(bytes32 => Limit))) private issuerLimits;

    mapping(bytes32 => Lease) private leases;
    mapping(bytes32 => mapping(bytes32 => bool)) private leaseAdapters;
    mapping(bytes32 => mapping(bytes32 => Limit)) private leaseAssets;
    mapping(bytes32 => mapping(bytes32 => bool)) private leaseRecipients;
    mapping(bytes32 => mapping(bytes32 => bool)) private leaseBeneficiaries;

    mapping(bytes32 => mapping(bytes32 => Spend)) private leaseSpend;
    mapping(uint64 => mapping(bytes32 => Spend)) private rootSpend;
    mapping(uint64 => mapping(address => mapping(bytes32 => Spend))) private issuerSpend;
    mapping(bytes32 => mapping(uint64 => bool)) public nonceUsed;

    uint256 private locked = 1;

    event PolicyInstalled(uint64 indexed policyVersion, bytes32 policyHash);
    event LeaseActivated(bytes32 indexed leaseId, address indexed agent, address indexed issuer, uint64 expiresAt);
    event LeaseRevoked(bytes32 indexed leaseId, address by);
    event Paused(uint64 pauseNonce, address by);
    event Unpaused(uint64 opNonce);
    event ActionExecuted(
        bytes32 indexed leaseId,
        uint64 indexed nonce,
        bytes32 indexed adapterId,
        uint8 actionKind,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 planHash,
        uint32 planStep
    );
    event Withdrawn(bytes32 indexed assetId, uint256 amount, address destination, uint64 opNonce);

    error AmaneRejected(string code);

    modifier nonReentrant() {
        if (locked != 1) revert AmaneRejected("AMANE_ACTION_REENTRANT");
        locked = 2;
        _;
        locked = 1;
    }

    constructor(bytes32 accountId_, address[] memory controllers_, uint8 threshold_, AdapterRegistry registry_) {
        if (controllers_.length == 0 || threshold_ == 0 || threshold_ > controllers_.length) {
            revert AmaneRejected("AMANE_CONTROLLER_BAD_THRESHOLD");
        }
        for (uint256 i; i < controllers_.length; ++i) {
            if (i > 0 && controllers_[i] <= controllers_[i - 1]) revert AmaneRejected("AMANE_CONTROLLER_UNSORTED");
            if (controllers_[i] == address(0)) revert AmaneRejected("AMANE_CONTROLLER_ZERO");
            isController[controllers_[i]] = true;
        }
        controllerList = controllers_;
        accountId = accountId_;
        threshold = threshold_;
        registry = registry_;
        chainRef = registry_.chainRef();
    }

    function controllers() external view returns (address[] memory) {
        return controllerList;
    }

    function self32() public view returns (bytes32) {
        return bytes32(uint256(uint160(address(this))));
    }

    // ---------------------------------------------------------------- root controller paths

    function installPolicy(RootPolicy calldata p, bytes[] calldata sigs) external nonReentrant {
        if (p.accountId != accountId) revert AmaneRejected("AMANE_POLICY_WRONG_ACCOUNT");
        if (p.policyVersion != policyVersion + 1) revert AmaneRejected("AMANE_POLICY_VERSION_MISMATCH");
        if (p.priceMode != PRICE_MODE_TESTNET_FIXED) revert AmaneRejected("AMANE_POLICY_BAD_PRICE_MODE");
        bytes32 h = p.hash();
        _requireThreshold(AmaneHash.digest(h), sigs);

        PolicyEndpoint calldata e = p.endpoints[_ownPolicyEndpoint(p)];
        if (e.epochSeconds == 0) revert AmaneRejected("AMANE_POLICY_BAD_EPOCH");
        uint64 v = p.policyVersion;

        for (uint256 i; i < e.adapters.length; ++i) {
            AdapterPolicy storage a = rootAdapters[v][e.adapters[i].adapterId];
            if (a.allowed) revert AmaneRejected("AMANE_POLICY_DUPLICATE_ENTRY");
            a.allowed = true;
            a.nameHash = keccak256(bytes(e.adapters[i].adapterName));
            a.version = e.adapters[i].adapterVersion;
        }
        for (uint256 i; i < e.assets.length; ++i) {
            Limit storage l = rootAssets[v][e.assets[i].assetId];
            if (l.allowed) revert AmaneRejected("AMANE_POLICY_DUPLICATE_ENTRY");
            _storeLimit(l, e.assets[i]);
        }
        for (uint256 i; i < e.recipients.length; ++i) {
            bytes32 id = e.recipients[i].recipientId;
            if (rootRecipientLabel[v][id] != 0) revert AmaneRejected("AMANE_POLICY_DUPLICATE_ENTRY");
            rootRecipientLabel[v][id] = keccak256(bytes(e.recipients[i].label));
        }
        for (uint256 i; i < e.beneficiaries.length; ++i) {
            bytes32 id = e.beneficiaries[i].recipientId;
            if (rootBeneficiaryLabel[v][id] != 0) revert AmaneRejected("AMANE_POLICY_DUPLICATE_ENTRY");
            rootBeneficiaryLabel[v][id] = keccak256(bytes(e.beneficiaries[i].label));
        }
        for (uint256 i; i < e.recoveryDestinations.length; ++i) {
            bytes32 id = e.recoveryDestinations[i].recipientId;
            if (recoveryDestination[v][id]) revert AmaneRejected("AMANE_POLICY_DUPLICATE_ENTRY");
            recoveryDestination[v][id] = true;
        }
        for (uint256 i; i < e.swapFloors.length; ++i) {
            if (e.swapFloors[i].minOutDenominator == 0) revert AmaneRejected("AMANE_POLICY_BAD_FLOOR");
            Floor storage f = swapFloor[v][keccak256(abi.encode(e.swapFloors[i].assetIn, e.swapFloors[i].assetOut))];
            if (f.den != 0) revert AmaneRejected("AMANE_POLICY_DUPLICATE_ENTRY");
            f.num = e.swapFloors[i].minOutNumerator;
            f.den = e.swapFloors[i].minOutDenominator;
        }
        for (uint256 i; i < p.leaseIssuers.length; ++i) {
            _storeIssuer(v, p.leaseIssuers[i]);
        }

        policyVersion = v;
        policyHash = h;
        allowedActions = p.allowedActions;
        maxLeaseLifetime = p.maxLeaseLifetime;
        epochSeconds = e.epochSeconds;
        emit PolicyInstalled(v, h);
    }

    /// Reduction path: one controller signature suffices and anyone may relay it, so an executor
    /// cannot censor a pause by refusing to submit.
    function pause(PauseAccount calldata x, bytes calldata sig) external {
        if (x.accountId != accountId) revert AmaneRejected("AMANE_POLICY_WRONG_ACCOUNT");
        if (x.pauseNonce <= pauseNonce) revert AmaneRejected("AMANE_REPLAY_PAUSE_NONCE");
        address signer = AmaneSig.recover(AmaneHash.digest(x.hash()), sig);
        if (!isController[signer]) revert AmaneRejected("AMANE_CONTROLLER_NOT_AUTHORIZED");
        pauseNonce = x.pauseNonce;
        paused = true;
        emit Paused(x.pauseNonce, signer);
    }

    function unpause(UnpauseAccount calldata x, bytes[] calldata sigs) external nonReentrant {
        if (x.accountId != accountId) revert AmaneRejected("AMANE_POLICY_WRONG_ACCOUNT");
        if (x.chainRef != chainRef || x.account != self32()) revert AmaneRejected("AMANE_CHAIN_WRONG_ENDPOINT");
        if (x.opNonce != opNonce) revert AmaneRejected("AMANE_REPLAY_OP_NONCE");
        _requireThreshold(AmaneHash.digest(x.hash()), sigs);
        opNonce = x.opNonce + 1;
        paused = false;
        emit Unpaused(x.opNonce);
    }

    function revokeLease(RevokeLease calldata x, bytes calldata sig) external {
        if (x.accountId != accountId) revert AmaneRejected("AMANE_POLICY_WRONG_ACCOUNT");
        address signer = AmaneSig.recover(AmaneHash.digest(x.hash()), sig);
        Lease storage l = leases[x.leaseId];
        bool allowed = isController[signer] || (l.status == LEASE_ACTIVE && l.issuer == signer)
            || (l.status == LEASE_NONE && issuers[policyVersion][signer].allowed);
        if (!allowed) revert AmaneRejected("AMANE_CONTROLLER_NOT_AUTHORIZED");
        l.status = LEASE_REVOKED;
        emit LeaseRevoked(x.leaseId, signer);
    }

    function withdraw(Withdraw calldata x, bytes[] calldata sigs) external nonReentrant {
        if (x.accountId != accountId) revert AmaneRejected("AMANE_POLICY_WRONG_ACCOUNT");
        if (x.chainRef != chainRef || x.account != self32()) revert AmaneRejected("AMANE_CHAIN_WRONG_ENDPOINT");
        if (x.opNonce != opNonce) revert AmaneRejected("AMANE_REPLAY_OP_NONCE");
        if (block.timestamp > x.deadline) revert AmaneRejected("AMANE_ACTION_EXPIRED");
        if (!recoveryDestination[policyVersion][x.destination]) revert AmaneRejected("AMANE_OWNER_DESTINATION_NOT_ALLOWED");
        _requireThreshold(AmaneHash.digest(x.hash()), sigs);
        opNonce = x.opNonce + 1;
        address to = _asAddress(x.destination);
        _safeTransfer(_asAddress(x.assetId), to, x.amount);
        emit Withdrawn(x.assetId, x.amount, to, x.opNonce);
    }

    // ---------------------------------------------------------------- lease issuance

    function activateLease(AgentLease calldata l, bytes calldata sig) external nonReentrant {
        if (l.accountId != accountId) revert AmaneRejected("AMANE_POLICY_WRONG_ACCOUNT");
        uint64 v = policyVersion;
        if (v == 0 || l.policyVersion != v) revert AmaneRejected("AMANE_POLICY_VERSION_MISMATCH");
        if (l.authMode != AUTH_MODE_AGENT_SIGNED) revert AmaneRejected("AMANE_LEASE_BAD_AUTH_MODE");
        if (l.expiresAt <= l.validAfter) revert AmaneRejected("AMANE_LEASE_BAD_WINDOW");
        if (block.timestamp > l.activateBefore) revert AmaneRejected("AMANE_LEASE_ACTIVATION_EXPIRED");
        uint64 lifetime = l.expiresAt - l.validAfter;
        if (lifetime > maxLeaseLifetime) revert AmaneRejected("AMANE_LEASE_LIFETIME_EXCEEDED");
        if (l.allowedActions & ~allowedActions != 0) revert AmaneRejected("AMANE_LEASE_ACTION_NOT_IN_ROOT");
        if (leases[l.leaseId].status != LEASE_NONE) revert AmaneRejected("AMANE_REPLAY_LEASE_ID");

        address signer = AmaneSig.recover(AmaneHash.digest(l.hash()), sig);
        if (signer != l.issuer) revert AmaneRejected("AMANE_LEASE_ISSUER_NOT_AUTHORIZED");
        if (l.agent == l.issuer || isController[l.agent]) revert AmaneRejected("AMANE_LEASE_AGENT_IS_ISSUER");
        bool byController = isController[signer];
        IssuerPolicy memory ip = issuers[v][signer];
        if (!byController) {
            if (!ip.allowed) revert AmaneRejected("AMANE_LEASE_ISSUER_NOT_AUTHORIZED");
            if (lifetime > ip.maxLeaseLifetime) revert AmaneRejected("AMANE_LEASE_LIFETIME_EXCEEDED");
            if (!issuerAgents[v][signer][l.agent]) revert AmaneRejected("AMANE_LEASE_AGENT_NOT_ALLOWED");
        }

        LeaseEndpoint calldata e = l.endpoints[_ownLeaseEndpoint(l)];
        bytes32 id = l.leaseId;
        for (uint256 i; i < e.adapters.length; ++i) {
            if (!rootAdapters[v][e.adapters[i]].allowed) revert AmaneRejected("AMANE_LEASE_ADAPTER_NOT_IN_ROOT");
            if (leaseAdapters[id][e.adapters[i]]) revert AmaneRejected("AMANE_LEASE_DUPLICATE_ENTRY");
            leaseAdapters[id][e.adapters[i]] = true;
        }
        for (uint256 i; i < e.assets.length; ++i) {
            AssetLimit calldata a = e.assets[i];
            Limit storage r = rootAssets[v][a.assetId];
            if (!r.allowed) revert AmaneRejected("AMANE_LEASE_ASSET_NOT_IN_ROOT");
            if (a.maxPerAction > r.perAction || a.maxPerEpoch > r.perEpoch || a.maxTotal > r.total) {
                revert AmaneRejected("AMANE_LEASE_CAP_EXCEEDS_ROOT");
            }
            if (!byController) {
                Limit storage c = issuerLimits[v][signer][a.assetId];
                if (a.maxPerAction > c.perAction || a.maxPerEpoch > c.perEpoch || a.maxTotal > c.total) {
                    revert AmaneRejected("AMANE_LEASE_CAP_EXCEEDS_ISSUER");
                }
            }
            Limit storage dst = leaseAssets[id][a.assetId];
            if (dst.allowed) revert AmaneRejected("AMANE_LEASE_DUPLICATE_ENTRY");
            _storeLimit(dst, a);
        }
        for (uint256 i; i < e.recipients.length; ++i) {
            if (rootRecipientLabel[v][e.recipients[i]] == 0) revert AmaneRejected("AMANE_LEASE_RECIPIENT_NOT_IN_ROOT");
            if (leaseRecipients[id][e.recipients[i]]) revert AmaneRejected("AMANE_LEASE_DUPLICATE_ENTRY");
            leaseRecipients[id][e.recipients[i]] = true;
        }
        for (uint256 i; i < e.beneficiaries.length; ++i) {
            if (rootBeneficiaryLabel[v][e.beneficiaries[i]] == 0) revert AmaneRejected("AMANE_LEASE_BENEFICIARY_NOT_IN_ROOT");
            if (leaseBeneficiaries[id][e.beneficiaries[i]]) revert AmaneRejected("AMANE_LEASE_DUPLICATE_ENTRY");
            leaseBeneficiaries[id][e.beneficiaries[i]] = true;
        }

        leases[id] = Lease({
            status: LEASE_ACTIVE,
            byController: byController,
            policyVersion: v,
            agent: l.agent,
            issuer: signer,
            validAfter: l.validAfter,
            expiresAt: l.expiresAt,
            allowedActions: l.allowedActions
        });
        emit LeaseActivated(id, l.agent, signer, l.expiresAt);
    }

    // ---------------------------------------------------------------- agent action path

    function executeAction(ActionIntent calldata a, bytes calldata agentSig) external nonReentrant returns (uint256 amountOut) {
        if (paused) revert AmaneRejected("AMANE_ACTION_ACCOUNT_PAUSED");
        if (a.accountId != accountId) revert AmaneRejected("AMANE_POLICY_WRONG_ACCOUNT");
        if (a.chainRef != chainRef || a.account != self32()) revert AmaneRejected("AMANE_ACTION_WRONG_ENDPOINT");
        Lease memory l = leases[a.leaseId];
        if (l.status != LEASE_ACTIVE) revert AmaneRejected("AMANE_LEASE_NOT_ACTIVE");
        uint64 v = policyVersion;
        if (a.policyVersion != v || l.policyVersion != v) revert AmaneRejected("AMANE_POLICY_VERSION_MISMATCH");
        if (block.timestamp < l.validAfter) revert AmaneRejected("AMANE_LEASE_NOT_YET_VALID");
        if (block.timestamp > l.expiresAt) revert AmaneRejected("AMANE_LEASE_EXPIRED");
        if (block.timestamp > a.deadline) revert AmaneRejected("AMANE_ACTION_EXPIRED");

        if (AmaneSig.recover(AmaneHash.digest(a.hash()), agentSig) != l.agent) {
            revert AmaneRejected("AMANE_ACTION_WRONG_AGENT");
        }
        if (nonceUsed[a.leaseId][a.nonce]) revert AmaneRejected("AMANE_REPLAY_NONCE");
        nonceUsed[a.leaseId][a.nonce] = true;

        if (a.actionKind >= 32 || (l.allowedActions >> a.actionKind) & 1 == 0 || (allowedActions >> a.actionKind) & 1 == 0) {
            revert AmaneRejected("AMANE_ACTION_KIND_NOT_ALLOWED");
        }
        AdapterRegistry.Entry memory entry = _checkAdapter(a, v);

        if (a.amountIn == 0) revert AmaneRejected("AMANE_ACTION_ZERO_AMOUNT");
        _debitAll(a.leaseId, l, v, a.assetIn, a.amountIn);

        address tokenIn = _asAddress(a.assetIn);
        if (a.actionKind == ActionKinds.SWAP) {
            amountOut = _swap(a, v, entry.adapter, tokenIn);
        } else if (a.actionKind == ActionKinds.PAY) {
            if (a.assetOut != a.assetIn) revert AmaneRejected("AMANE_ACTION_ASSET_NOT_ALLOWED");
            if (!leaseRecipients[a.leaseId][a.recipient]) revert AmaneRejected("AMANE_ACTION_RECIPIENT_NOT_ALLOWED");
            if (rootRecipientLabel[v][a.recipient] != keccak256(bytes(a.recipientLabel))) {
                revert AmaneRejected("AMANE_ACTION_RECIPIENT_NOT_ALLOWED");
            }
            amountOut = _deliver(a, entry.adapter, tokenIn);
        } else if (a.actionKind == ActionKinds.REPAY) {
            if (!leaseBeneficiaries[a.leaseId][a.recipient]) revert AmaneRejected("AMANE_ACTION_RECIPIENT_NOT_ALLOWED");
            if (rootBeneficiaryLabel[v][a.recipient] != keccak256(bytes(a.recipientLabel))) {
                revert AmaneRejected("AMANE_ACTION_RECIPIENT_NOT_ALLOWED");
            }
            amountOut = _spendOnly(a, entry.adapter, tokenIn);
        } else {
            revert AmaneRejected("AMANE_ACTION_KIND_NOT_ALLOWED");
        }

        emit ActionExecuted(a.leaseId, a.nonce, a.adapterId, a.actionKind, a.amountIn, amountOut, a.planHash, a.planStep);
    }

    // ---------------------------------------------------------------- views

    function lease(bytes32 leaseId) external view returns (Lease memory) {
        return leases[leaseId];
    }

    function leaseBudget(bytes32 leaseId, bytes32 assetId) external view returns (Limit memory limit, Spend memory spent) {
        return (leaseAssets[leaseId][assetId], leaseSpend[leaseId][assetId]);
    }

    function rootBudget(bytes32 assetId) external view returns (Limit memory limit, Spend memory spent) {
        return (rootAssets[policyVersion][assetId], rootSpend[policyVersion][assetId]);
    }

    function currentEpoch() public view returns (uint64) {
        return uint64(block.timestamp / epochSeconds) + 1;
    }

    // ---------------------------------------------------------------- internals

    function _checkAdapter(ActionIntent calldata a, uint64 v) private view returns (AdapterRegistry.Entry memory entry) {
        if (!leaseAdapters[a.leaseId][a.adapterId]) revert AmaneRejected("AMANE_ACTION_ADAPTER_NOT_ALLOWED");
        AdapterPolicy memory ap = rootAdapters[v][a.adapterId];
        if (!ap.allowed) revert AmaneRejected("AMANE_ACTION_ADAPTER_NOT_ALLOWED");
        if (ap.nameHash != keccak256(bytes(a.adapterName)) || ap.version != a.adapterVersion) {
            revert AmaneRejected("AMANE_ACTION_ADAPTER_NAME_MISMATCH");
        }
        entry = registry.get(a.adapterId);
        if (entry.adapter == address(0)) revert AmaneRejected("AMANE_ADAPTER_UNKNOWN");
        if (entry.nameHash != ap.nameHash || entry.adapterVersion != ap.version) {
            revert AmaneRejected("AMANE_ACTION_ADAPTER_NAME_MISMATCH");
        }
        if (entry.actionKind != a.actionKind) revert AmaneRejected("AMANE_ADAPTER_KIND_MISMATCH");
        if (entry.adapter.codehash != entry.codeHash) revert AmaneRejected("AMANE_ADAPTER_CODE_CHANGED");
    }

    function _debitAll(bytes32 leaseId, Lease memory l, uint64 v, bytes32 assetId, uint256 amount) private {
        uint64 epoch = currentEpoch();
        Limit memory ll = leaseAssets[leaseId][assetId];
        if (!ll.allowed) revert AmaneRejected("AMANE_ACTION_ASSET_NOT_ALLOWED");
        _debit(leaseSpend[leaseId][assetId], ll, amount, epoch);
        _debit(rootSpend[v][assetId], rootAssets[v][assetId], amount, epoch);
        if (!l.byController) {
            _debit(issuerSpend[v][l.issuer][assetId], issuerLimits[v][l.issuer][assetId], amount, epoch);
        }
    }

    function _debit(Spend storage s, Limit memory lim, uint256 amount, uint64 epoch) private {
        if (amount > lim.perAction) revert AmaneRejected("AMANE_BUDGET_PER_ACTION");
        if (s.epoch != epoch) {
            s.epoch = epoch;
            s.epochSpent = 0;
        }
        uint256 e = s.epochSpent + amount;
        if (e > lim.perEpoch) revert AmaneRejected("AMANE_BUDGET_EPOCH");
        uint256 t = s.totalSpent + amount;
        if (t > lim.total) revert AmaneRejected("AMANE_BUDGET_TOTAL");
        s.epochSpent = e;
        s.totalSpent = t;
    }

    function _swap(ActionIntent calldata a, uint64 v, address adapter, address tokenIn) private returns (uint256 out) {
        if (a.assetOut == a.assetIn) revert AmaneRejected("AMANE_ACTION_ASSET_NOT_ALLOWED");
        if (!leaseAssets[a.leaseId][a.assetOut].allowed) revert AmaneRejected("AMANE_ACTION_ASSET_NOT_ALLOWED");
        if (a.recipient != bytes32(0)) revert AmaneRejected("AMANE_ACTION_RECIPIENT_NOT_ALLOWED");
        Floor memory f = swapFloor[v][keccak256(abi.encode(a.assetIn, a.assetOut))];
        if (f.den == 0) revert AmaneRejected("AMANE_ACTION_NO_PRICE_FLOOR");
        uint256 required = (a.amountIn * f.num + f.den - 1) / f.den;
        uint256 minOut = a.minAmountOut > required ? a.minAmountOut : required;

        address tokenOut = _asAddress(a.assetOut);
        uint256 inBefore = IERC20Minimal(tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20Minimal(tokenOut).balanceOf(address(this));
        _safeTransfer(tokenIn, adapter, a.amountIn);
        IAmaneAdapter(adapter).execute(tokenIn, tokenOut, a.amountIn, minOut, address(this));
        uint256 inAfter = IERC20Minimal(tokenIn).balanceOf(address(this));
        uint256 outAfter = IERC20Minimal(tokenOut).balanceOf(address(this));
        if (inBefore - inAfter > a.amountIn) revert AmaneRejected("AMANE_ACTION_OVERSPENT");
        out = outAfter - outBefore;
        if (out < minOut) revert AmaneRejected("AMANE_ACTION_BELOW_MIN_OUT");
    }

    function _deliver(ActionIntent calldata a, address adapter, address tokenIn) private returns (uint256 delivered) {
        address to = _asAddress(a.recipient);
        uint256 inBefore = IERC20Minimal(tokenIn).balanceOf(address(this));
        uint256 toBefore = IERC20Minimal(tokenIn).balanceOf(to);
        _safeTransfer(tokenIn, adapter, a.amountIn);
        IAmaneAdapter(adapter).execute(tokenIn, tokenIn, a.amountIn, a.amountIn, to);
        if (inBefore - IERC20Minimal(tokenIn).balanceOf(address(this)) > a.amountIn) {
            revert AmaneRejected("AMANE_ACTION_OVERSPENT");
        }
        delivered = IERC20Minimal(tokenIn).balanceOf(to) - toBefore;
        if (delivered < a.amountIn) revert AmaneRejected("AMANE_ACTION_UNDER_DELIVERED");
    }

    function _spendOnly(ActionIntent calldata a, address adapter, address tokenIn) private returns (uint256 spent) {
        uint256 inBefore = IERC20Minimal(tokenIn).balanceOf(address(this));
        _safeTransfer(tokenIn, adapter, a.amountIn);
        IAmaneAdapter(adapter).execute(tokenIn, tokenIn, a.amountIn, a.minAmountOut, _asAddress(a.recipient));
        spent = inBefore - IERC20Minimal(tokenIn).balanceOf(address(this));
        if (spent > a.amountIn) revert AmaneRejected("AMANE_ACTION_OVERSPENT");
    }

    function _ownPolicyEndpoint(RootPolicy calldata p) private view returns (uint256 idx) {
        bytes32 me = self32();
        bool found;
        for (uint256 i; i < p.endpoints.length; ++i) {
            if (p.endpoints[i].chainRef == chainRef && p.endpoints[i].account == me) {
                if (found) revert AmaneRejected("AMANE_POLICY_DUPLICATE_ENTRY");
                idx = i;
                found = true;
            }
        }
        if (!found) revert AmaneRejected("AMANE_POLICY_WRONG_ENDPOINT");
    }

    function _ownLeaseEndpoint(AgentLease calldata l) private view returns (uint256 idx) {
        bytes32 me = self32();
        bool found;
        for (uint256 i; i < l.endpoints.length; ++i) {
            if (l.endpoints[i].chainRef == chainRef && l.endpoints[i].account == me) {
                if (found) revert AmaneRejected("AMANE_LEASE_DUPLICATE_ENTRY");
                idx = i;
                found = true;
            }
        }
        if (!found) revert AmaneRejected("AMANE_LEASE_WRONG_ENDPOINT");
    }

    function _storeIssuer(uint64 v, LeaseIssuer calldata x) private {
        IssuerPolicy storage ip = issuers[v][x.issuer];
        if (ip.allowed) revert AmaneRejected("AMANE_POLICY_DUPLICATE_ENTRY");
        if (isController[x.issuer]) revert AmaneRejected("AMANE_POLICY_ISSUER_IS_CONTROLLER");
        ip.allowed = true;
        ip.maxLeaseLifetime = x.maxLeaseLifetime;
        for (uint256 i; i < x.allowedAgents.length; ++i) {
            issuerAgents[v][x.issuer][x.allowedAgents[i]] = true;
        }
        for (uint256 i; i < x.limits.length; ++i) {
            if (x.limits[i].chainRef != chainRef) continue;
            Limit storage l = issuerLimits[v][x.issuer][x.limits[i].assetId];
            if (l.allowed) revert AmaneRejected("AMANE_POLICY_DUPLICATE_ENTRY");
            l.allowed = true;
            l.perAction = x.limits[i].maxPerAction;
            l.perEpoch = x.limits[i].maxPerEpoch;
            l.total = x.limits[i].maxTotal;
        }
    }

    function _storeLimit(Limit storage l, AssetLimit calldata a) private {
        l.allowed = true;
        l.perAction = a.maxPerAction;
        l.perEpoch = a.maxPerEpoch;
        l.total = a.maxTotal;
    }

    function _requireThreshold(bytes32 digest, bytes[] calldata sigs) private view {
        address last;
        uint256 count;
        for (uint256 i; i < sigs.length; ++i) {
            address s = AmaneSig.recover(digest, sigs[i]);
            if (s <= last) revert AmaneRejected("AMANE_CONTROLLER_UNSORTED");
            if (!isController[s]) revert AmaneRejected("AMANE_CONTROLLER_NOT_AUTHORIZED");
            last = s;
            ++count;
        }
        if (count < threshold) revert AmaneRejected("AMANE_CONTROLLER_THRESHOLD");
    }

    function _asAddress(bytes32 word) private pure returns (address) {
        if (uint256(word) >> 160 != 0) revert AmaneRejected("AMANE_CHAIN_NOT_AN_ADDRESS");
        return address(uint160(uint256(word)));
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        if (token.code.length == 0) revert AmaneRejected("AMANE_ASSET_NOT_A_TOKEN");
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) {
            revert AmaneRejected("AMANE_ASSET_TRANSFER_FAILED");
        }
    }
}
