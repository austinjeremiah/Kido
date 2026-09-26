// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    ActionIntent,
    ActionKinds,
    AgentLease,
    AmaneHash,
    AmaneSig,
    AssetLimit,
    DestSpec,
    DestSpecHash,
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
import {Codes} from "./AmaneCodes.sol";

/// Non-upgradeable Amane endpoint for one logical account on one EVM chain.
/// Invariant: Action ⊆ Lease ⊆ RootPolicy. Every agent action is verified, budget-debited and
/// nonce-marked before any token leaves the account, and output is measured by the account itself.
import {AmaneStorage, IAmaneTransport, IERC20Minimal} from "./AmaneStorage.sol";

interface IAmaneSelf {
    function accountId() external view returns (bytes32);
    function chainRef() external view returns (bytes32);
    function registry() external view returns (AdapterRegistry);
    function threshold() external view returns (uint8);
}

/// Pinned extension of AmaneAccount: code executed only by delegatecall from an account, in that
/// account's storage. The account's immutables are read through its own getters. Deployed alone,
/// its functions only touch its own empty storage.
contract AmaneAccountExt is AmaneStorage {
    using AmaneHash for *;

    function installPolicy(RootPolicy calldata p, bytes[] calldata sigs) external nonReentrant {
        if (p.accountId != IAmaneSelf(address(this)).accountId()) revert AmaneRejected(Codes.POLICY_WRONG_ACCOUNT);
        if (p.policyVersion != policyVersion + 1) revert AmaneRejected(Codes.POLICY_VERSION_MISMATCH);
        if (p.priceMode != PRICE_MODE_TESTNET_FIXED) revert AmaneRejected(Codes.POLICY_BAD_PRICE_MODE);
        if (p.parentPolicyHash != policyHash) revert AmaneRejected(Codes.POLICY_PARENT_MISMATCH);
        if (block.timestamp > p.activateBefore) revert AmaneRejected(Codes.POLICY_ACTIVATION_EXPIRED);
        bytes32 h = p.hash();
        _requireThreshold(AmaneHash.digest(h), sigs);

        PolicyEndpoint calldata e = p.endpoints[_ownPolicyEndpoint(p)];
        if (e.epochSeconds == 0) revert AmaneRejected(Codes.POLICY_BAD_EPOCH);
        uint64 v = p.policyVersion;

        for (uint256 i; i < e.adapters.length; ++i) {
            AdapterPolicy storage a = rootAdapters[v][e.adapters[i].adapterId];
            if (a.allowed) revert AmaneRejected(Codes.POLICY_DUPLICATE_ENTRY);
            a.allowed = true;
            a.nameHash = keccak256(bytes(e.adapters[i].adapterName));
            a.version = e.adapters[i].adapterVersion;
        }
        for (uint256 i; i < e.assets.length; ++i) {
            Limit storage l = rootAssets[v][e.assets[i].assetId];
            if (l.allowed) revert AmaneRejected(Codes.POLICY_DUPLICATE_ENTRY);
            _storeLimit(l, e.assets[i]);
        }
        for (uint256 i; i < e.recipients.length; ++i) {
            bytes32 id = e.recipients[i].recipientId;
            if (rootRecipientLabel[v][id] != 0) revert AmaneRejected(Codes.POLICY_DUPLICATE_ENTRY);
            rootRecipientLabel[v][id] = keccak256(bytes(e.recipients[i].label));
        }
        for (uint256 i; i < e.beneficiaries.length; ++i) {
            bytes32 id = e.beneficiaries[i].recipientId;
            if (rootBeneficiaryLabel[v][id] != 0) revert AmaneRejected(Codes.POLICY_DUPLICATE_ENTRY);
            rootBeneficiaryLabel[v][id] = keccak256(bytes(e.beneficiaries[i].label));
        }
        for (uint256 i; i < e.recoveryDestinations.length; ++i) {
            bytes32 id = e.recoveryDestinations[i].recipientId;
            if (recoveryDestination[v][id]) revert AmaneRejected(Codes.POLICY_DUPLICATE_ENTRY);
            recoveryDestination[v][id] = true;
        }
        for (uint256 i; i < e.swapFloors.length; ++i) {
            if (e.swapFloors[i].minOutDenominator == 0 || e.swapFloors[i].minOutNumerator == 0) {
                revert AmaneRejected(Codes.POLICY_BAD_FLOOR);
            }
            Floor storage f = swapFloor[v][keccak256(abi.encode(e.swapFloors[i].assetIn, e.swapFloors[i].assetOut))];
            if (f.den != 0) revert AmaneRejected(Codes.POLICY_DUPLICATE_ENTRY);
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

    /// Redeems a cross-chain transfer through a pinned BRIDGE transport adapter and reserves what
    /// arrived for the intent the agent signed on the source endpoint. The account checks the signed
    /// source action, its commitment to `dest`, the destination spec against its own lease, the
    /// measured arrival and replay; the transport only proves delivery.
    function receiveCrossChain(ActionIntent calldata src, bytes calldata srcSig, DestSpec calldata dest, bytes32 transportId, bytes calldata transportData)
        external
        nonReentrant
    {
        if (paused) revert AmaneRejected(Codes.ACTION_ACCOUNT_PAUSED);
        if (src.accountId != IAmaneSelf(address(this)).accountId()) revert AmaneRejected(Codes.POLICY_WRONG_ACCOUNT);
        if (src.actionKind != ActionKinds.BRIDGE) revert AmaneRejected(Codes.XCHAIN_NOT_A_BRIDGE_ACTION);
        if (src.recipient != self32()) revert AmaneRejected(Codes.XCHAIN_WRONG_DESTINATION);
        Lease memory l = leases[src.leaseId];
        if (l.status != LEASE_ACTIVE) revert AmaneRejected(Codes.LEASE_NOT_ACTIVE);
        if (block.timestamp > l.expiresAt || block.timestamp > dest.deadline) revert AmaneRejected(Codes.XCHAIN_EXPIRED);
        bytes32 intent = AmaneHash.digest(src.hash());
        if (AmaneSig.recover(intent, srcSig) != l.agent) revert AmaneRejected(Codes.ACTION_WRONG_AGENT);
        if (src.planHash != DestSpecHash.hash(dest)) revert AmaneRejected(Codes.XCHAIN_SPEC_MISMATCH);
        if (intentUsed[intent]) revert AmaneRejected(Codes.XCHAIN_INTENT_USED);
        intentUsed[intent] = true;
        // The destination use must already be allowed here: action kind, adapter, pinned recipient, asset.
        uint64 v = policyVersion;
        if ((l.allowedActions >> dest.actionKind) & 1 == 0 || (allowedActions >> dest.actionKind) & 1 == 0) revert AmaneRejected(Codes.ACTION_KIND_NOT_ALLOWED);
        if (!leaseAdapters[src.leaseId][dest.adapterId] || !leaseAdapters[src.leaseId][transportId]) revert AmaneRejected(Codes.ACTION_ADAPTER_NOT_ALLOWED);
        if (!leaseAssets[src.leaseId][dest.asset].allowed) revert AmaneRejected(Codes.XCHAIN_WRONG_ASSET);
        _checkRecipient(src.leaseId, v, dest.actionKind, dest.recipient, dest.recipientLabel);
        AdapterRegistry.Entry memory t = IAmaneSelf(address(this)).registry().get(transportId);
        if (t.adapter == address(0) || !rootAdapters[v][transportId].allowed) revert AmaneRejected(Codes.ADAPTER_UNKNOWN);
        if (t.actionKind != ActionKinds.BRIDGE) revert AmaneRejected(Codes.ADAPTER_KIND_MISMATCH);
        if (t.adapter.codehash != t.codeHash) revert AmaneRejected(Codes.ADAPTER_CODE_CHANGED);

        address token = _asAddress(dest.asset);
        uint256 before = IERC20Minimal(token).balanceOf(address(this));
        bytes32 payloadIntent = IAmaneTransport(t.adapter).redeem(transportData);
        if (payloadIntent != intent) revert AmaneRejected(Codes.XCHAIN_PAYLOAD_MISMATCH);
        uint256 arrived = IERC20Minimal(token).balanceOf(address(this)) - before;
        if (arrived == 0 || arrived < dest.minArrival) revert AmaneRejected(Codes.XCHAIN_BELOW_MINIMUM);
        reservations[intent] = Reservation(src.leaseId, dest.actionKind, dest.adapterId, dest.recipient, dest.asset, dest.deadline, arrived);
        reservedOf[token] += arrived;
        emit CrossChainReserved(intent, src.leaseId, token, arrived);
    }

    /// After its deadline an unspent reservation returns to the account's ordinary balance, which
    /// only the owner's controllers can withdraw. It never becomes spendable by the agent's intent.
    function releaseReservation(bytes32 intent) external {
        Reservation memory r = reservations[intent];
        if (r.remaining == 0 || block.timestamp <= r.deadline) revert AmaneRejected(Codes.XCHAIN_NO_RESERVATION);
        delete reservations[intent];
        reservedOf[_asAddress(r.asset)] -= r.remaining;
    }

    function _ownPolicyEndpoint(RootPolicy calldata p) private view returns (uint256 idx) {
        bytes32 me = self32();
        bool found;
        for (uint256 i; i < p.endpoints.length; ++i) {
            if (p.endpoints[i].chainRef == IAmaneSelf(address(this)).chainRef() && p.endpoints[i].account == me) {
                if (found) revert AmaneRejected(Codes.POLICY_DUPLICATE_ENTRY);
                idx = i;
                found = true;
            }
        }
        if (!found) revert AmaneRejected(Codes.POLICY_WRONG_ENDPOINT);
    }

    function _storeIssuer(uint64 v, LeaseIssuer calldata x) private {
        IssuerPolicy storage ip = issuers[v][x.issuer];
        if (ip.allowed) revert AmaneRejected(Codes.POLICY_DUPLICATE_ENTRY);
        if (isController[x.issuer]) revert AmaneRejected(Codes.POLICY_ISSUER_IS_CONTROLLER);
        ip.allowed = true;
        ip.maxLeaseLifetime = x.maxLeaseLifetime;
        for (uint256 i; i < x.allowedAgents.length; ++i) {
            issuerAgents[v][x.issuer][x.allowedAgents[i]] = true;
        }
        for (uint256 i; i < x.limits.length; ++i) {
            if (x.limits[i].chainRef != IAmaneSelf(address(this)).chainRef()) continue;
            Limit storage l = issuerLimits[v][x.issuer][x.limits[i].assetId];
            if (l.allowed) revert AmaneRejected(Codes.POLICY_DUPLICATE_ENTRY);
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

    /// REPAY: the adapter repays the beneficiary's debt and returns any unspent input. The core
    /// measures both sides itself: input spent from the account, and the fall of the beneficiary's
    /// balance of the pinned debt token, which must be at least spent × num / den.
    function _checkRecipient(bytes32 leaseId, uint64 v, uint8 kind, bytes32 recipient, string calldata label) private view {
        if (kind == ActionKinds.REPAY) {
            if (!leaseBeneficiaries[leaseId][recipient] || rootBeneficiaryLabel[v][recipient] != keccak256(bytes(label))) revert AmaneRejected(Codes.ACTION_RECIPIENT_NOT_ALLOWED);
        } else if (kind == ActionKinds.PAY) {
            if (!leaseRecipients[leaseId][recipient] || rootRecipientLabel[v][recipient] != keccak256(bytes(label))) revert AmaneRejected(Codes.ACTION_RECIPIENT_NOT_ALLOWED);
        } else if (recipient != bytes32(0)) {
            revert AmaneRejected(Codes.ACTION_RECIPIENT_NOT_ALLOWED);
        }
    }

    function _requireThreshold(bytes32 digest, bytes[] calldata sigs) private view {
        address last;
        uint256 count;
        for (uint256 i; i < sigs.length; ++i) {
            address s = AmaneSig.recover(digest, sigs[i]);
            if (s <= last) revert AmaneRejected(Codes.CONTROLLER_UNSORTED);
            if (!isController[s]) revert AmaneRejected(Codes.CONTROLLER_NOT_AUTHORIZED);
            last = s;
            ++count;
        }
        if (count < IAmaneSelf(address(this)).threshold()) revert AmaneRejected(Codes.CONTROLLER_THRESHOLD);
    }
}
