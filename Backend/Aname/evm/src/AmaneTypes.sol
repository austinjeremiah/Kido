// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

struct AssetLimit {
    bytes32 assetId;
    uint256 maxPerAction;
    uint256 maxPerEpoch;
    uint256 maxTotal;
}

struct AdapterRef {
    bytes32 adapterId;
    string adapterName;
    uint32 adapterVersion;
}

struct Recipient {
    bytes32 recipientId;
    string label;
}

struct SwapFloor {
    bytes32 assetIn;
    bytes32 assetOut;
    uint256 minOutNumerator;
    uint256 minOutDenominator;
}

struct PolicyEndpoint {
    bytes32 chainRef;
    bytes32 account;
    uint64 epochSeconds;
    AdapterRef[] adapters;
    AssetLimit[] assets;
    Recipient[] recipients;
    Recipient[] beneficiaries;
    SwapFloor[] swapFloors;
    Recipient[] recoveryDestinations;
}

struct IssuerLimit {
    bytes32 chainRef;
    bytes32 assetId;
    uint256 maxPerAction;
    uint256 maxPerEpoch;
    uint256 maxTotal;
}

struct LeaseIssuer {
    address issuer;
    uint64 maxLeaseLifetime;
    address[] allowedAgents;
    IssuerLimit[] limits;
}

struct RootPolicy {
    bytes32 accountId;
    uint64 policyVersion;
    bytes32 parentPolicyHash;
    uint32 allowedActions;
    uint8 priceMode;
    uint64 maxLeaseLifetime;
    uint64 activateBefore;
    PolicyEndpoint[] endpoints;
    LeaseIssuer[] leaseIssuers;
}

struct LeaseEndpoint {
    bytes32 chainRef;
    bytes32 account;
    bytes32[] adapters;
    AssetLimit[] assets;
    bytes32[] recipients;
    bytes32[] beneficiaries;
}

struct AgentLease {
    bytes32 accountId;
    uint64 policyVersion;
    bytes32 leaseId;
    address agent;
    address issuer;
    uint64 validAfter;
    uint64 expiresAt;
    uint64 activateBefore;
    uint32 allowedActions;
    uint8 authMode;
    LeaseEndpoint[] endpoints;
}

struct ActionIntent {
    bytes32 accountId;
    bytes32 chainRef;
    bytes32 account;
    uint64 policyVersion;
    bytes32 leaseId;
    uint64 nonce;
    uint8 actionKind;
    bytes32 adapterId;
    string adapterName;
    uint32 adapterVersion;
    bytes32 assetIn;
    bytes32 assetOut;
    uint256 amountIn;
    uint256 minAmountOut;
    bytes32 recipient;
    string recipientLabel;
    uint64 deadline;
    bytes32 planHash;
    uint32 planStep;
}

struct PauseAccount {
    bytes32 accountId;
    uint64 pauseEpoch;
    bytes32 pauseId;
    uint64 deadline;
}

struct UnpauseAccount {
    bytes32 accountId;
    bytes32 chainRef;
    bytes32 account;
    uint64 pauseEpoch;
    bytes32 pauseId;
    uint64 deadline;
}

struct RevokeLease {
    bytes32 accountId;
    bytes32 leaseId;
}

struct Withdraw {
    bytes32 accountId;
    bytes32 chainRef;
    bytes32 account;
    bytes32 assetId;
    uint256 amount;
    bytes32 destination;
    uint64 opNonce;
    uint64 deadline;
}

library ActionKinds {
    uint8 internal constant SWAP = 0;
    uint8 internal constant REPAY = 2;
    uint8 internal constant PAY = 9;
    uint8 internal constant BRIDGE = 10;
}

/// What a cross-chain transfer may be used for at the destination. The source BRIDGE ActionIntent
/// commits to it through planHash = DestSpecHash.hash(spec); the agent signs that ActionIntent.
struct DestSpec {
    uint8 actionKind;
    bytes32 adapterId;
    bytes32 recipient;
    string recipientLabel;
    bytes32 asset;
    uint256 minArrival;
    uint64 deadline;
}

library DestSpecHash {
    bytes32 internal constant TAG = keccak256("AMANE_DEST_SPEC_V1");

    function hash(DestSpec calldata d) internal pure returns (bytes32) {
        return keccak256(abi.encode(TAG, d.actionKind, d.adapterId, d.recipient, keccak256(bytes(d.recipientLabel)), d.asset, d.minArrival, d.deadline));
    }
}

/// EIP-712 hashing. Type strings must stay byte-identical with packages/core/src/eip712.ts and
/// sui/amane/sources/eip712.move; golden vectors enforce this.
library AmaneHash {
    uint256 internal constant SIGNING_CHAIN_ID = 11155111;

    bytes32 internal constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId)");

    string private constant ADAPTER_REF_T = "AdapterRef(bytes32 adapterId,string adapterName,uint32 adapterVersion)";
    string private constant ASSET_LIMIT_T = "AssetLimit(bytes32 assetId,uint256 maxPerAction,uint256 maxPerEpoch,uint256 maxTotal)";
    string private constant ISSUER_LIMIT_T =
        "IssuerLimit(bytes32 chainRef,bytes32 assetId,uint256 maxPerAction,uint256 maxPerEpoch,uint256 maxTotal)";
    string private constant LEASE_ISSUER_T =
        "LeaseIssuer(address issuer,uint64 maxLeaseLifetime,address[] allowedAgents,IssuerLimit[] limits)";
    string private constant POLICY_ENDPOINT_T =
        "PolicyEndpoint(bytes32 chainRef,bytes32 account,uint64 epochSeconds,AdapterRef[] adapters,AssetLimit[] assets,Recipient[] recipients,Recipient[] beneficiaries,SwapFloor[] swapFloors,Recipient[] recoveryDestinations)";
    string private constant RECIPIENT_T = "Recipient(bytes32 recipientId,string label)";
    string private constant SWAP_FLOOR_T =
        "SwapFloor(bytes32 assetIn,bytes32 assetOut,uint256 minOutNumerator,uint256 minOutDenominator)";
    string private constant LEASE_ENDPOINT_T =
        "LeaseEndpoint(bytes32 chainRef,bytes32 account,bytes32[] adapters,AssetLimit[] assets,bytes32[] recipients,bytes32[] beneficiaries)";

    bytes32 internal constant ASSET_LIMIT_TYPEHASH = keccak256(bytes(ASSET_LIMIT_T));
    bytes32 internal constant ADAPTER_REF_TYPEHASH = keccak256(bytes(ADAPTER_REF_T));
    bytes32 internal constant RECIPIENT_TYPEHASH = keccak256(bytes(RECIPIENT_T));
    bytes32 internal constant SWAP_FLOOR_TYPEHASH = keccak256(bytes(SWAP_FLOOR_T));
    bytes32 internal constant ISSUER_LIMIT_TYPEHASH = keccak256(bytes(ISSUER_LIMIT_T));
    bytes32 internal constant LEASE_ISSUER_TYPEHASH = keccak256(abi.encodePacked(LEASE_ISSUER_T, ISSUER_LIMIT_T));
    bytes32 internal constant POLICY_ENDPOINT_TYPEHASH =
        keccak256(abi.encodePacked(POLICY_ENDPOINT_T, ADAPTER_REF_T, ASSET_LIMIT_T, RECIPIENT_T, SWAP_FLOOR_T));
    bytes32 internal constant ROOT_POLICY_TYPEHASH = keccak256(
        abi.encodePacked(
            "RootPolicy(bytes32 accountId,uint64 policyVersion,bytes32 parentPolicyHash,uint32 allowedActions,uint8 priceMode,uint64 maxLeaseLifetime,uint64 activateBefore,PolicyEndpoint[] endpoints,LeaseIssuer[] leaseIssuers)",
            ADAPTER_REF_T,
            ASSET_LIMIT_T,
            ISSUER_LIMIT_T,
            LEASE_ISSUER_T,
            POLICY_ENDPOINT_T,
            RECIPIENT_T,
            SWAP_FLOOR_T
        )
    );
    bytes32 internal constant LEASE_ENDPOINT_TYPEHASH = keccak256(abi.encodePacked(LEASE_ENDPOINT_T, ASSET_LIMIT_T));
    bytes32 internal constant AGENT_LEASE_TYPEHASH = keccak256(
        abi.encodePacked(
            "AgentLease(bytes32 accountId,uint64 policyVersion,bytes32 leaseId,address agent,address issuer,uint64 validAfter,uint64 expiresAt,uint64 activateBefore,uint32 allowedActions,uint8 authMode,LeaseEndpoint[] endpoints)",
            ASSET_LIMIT_T,
            LEASE_ENDPOINT_T
        )
    );
    bytes32 internal constant ACTION_INTENT_TYPEHASH = keccak256(
        "ActionIntent(bytes32 accountId,bytes32 chainRef,bytes32 account,uint64 policyVersion,bytes32 leaseId,uint64 nonce,uint8 actionKind,bytes32 adapterId,string adapterName,uint32 adapterVersion,bytes32 assetIn,bytes32 assetOut,uint256 amountIn,uint256 minAmountOut,bytes32 recipient,string recipientLabel,uint64 deadline,bytes32 planHash,uint32 planStep)"
    );
    bytes32 internal constant PAUSE_ACCOUNT_TYPEHASH = keccak256("PauseAccount(bytes32 accountId,uint64 pauseEpoch,bytes32 pauseId,uint64 deadline)");
    bytes32 internal constant UNPAUSE_ACCOUNT_TYPEHASH =
        keccak256(
            "UnpauseAccount(bytes32 accountId,bytes32 chainRef,bytes32 account,uint64 pauseEpoch,bytes32 pauseId,uint64 deadline)"
        );
    bytes32 internal constant REVOKE_LEASE_TYPEHASH = keccak256("RevokeLease(bytes32 accountId,bytes32 leaseId)");
    bytes32 internal constant WITHDRAW_TYPEHASH = keccak256(
        "Withdraw(bytes32 accountId,bytes32 chainRef,bytes32 account,bytes32 assetId,uint256 amount,bytes32 destination,uint64 opNonce,uint64 deadline)"
    );

    function domainSeparator() internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Amane"), keccak256("1"), SIGNING_CHAIN_ID));
    }

    function digest(bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    function hashBytes32Array(bytes32[] calldata xs) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(xs));
    }

    function hashAddressArray(address[] calldata xs) internal pure returns (bytes32) {
        bytes32[] memory words = new bytes32[](xs.length);
        for (uint256 i; i < xs.length; ++i) words[i] = bytes32(uint256(uint160(xs[i])));
        return keccak256(abi.encodePacked(words));
    }

    function hash(AssetLimit calldata x) internal pure returns (bytes32) {
        return keccak256(abi.encode(ASSET_LIMIT_TYPEHASH, x.assetId, x.maxPerAction, x.maxPerEpoch, x.maxTotal));
    }

    function hash(AssetLimit[] calldata xs) internal pure returns (bytes32) {
        bytes32[] memory h = new bytes32[](xs.length);
        for (uint256 i; i < xs.length; ++i) h[i] = hash(xs[i]);
        return keccak256(abi.encodePacked(h));
    }

    function hash(AdapterRef[] calldata xs) internal pure returns (bytes32) {
        bytes32[] memory h = new bytes32[](xs.length);
        for (uint256 i; i < xs.length; ++i) {
            h[i] = keccak256(
                abi.encode(ADAPTER_REF_TYPEHASH, xs[i].adapterId, keccak256(bytes(xs[i].adapterName)), xs[i].adapterVersion)
            );
        }
        return keccak256(abi.encodePacked(h));
    }

    function hash(Recipient[] calldata xs) internal pure returns (bytes32) {
        bytes32[] memory h = new bytes32[](xs.length);
        for (uint256 i; i < xs.length; ++i) {
            h[i] = keccak256(abi.encode(RECIPIENT_TYPEHASH, xs[i].recipientId, keccak256(bytes(xs[i].label))));
        }
        return keccak256(abi.encodePacked(h));
    }

    function hash(SwapFloor[] calldata xs) internal pure returns (bytes32) {
        bytes32[] memory h = new bytes32[](xs.length);
        for (uint256 i; i < xs.length; ++i) {
            h[i] = keccak256(
                abi.encode(SWAP_FLOOR_TYPEHASH, xs[i].assetIn, xs[i].assetOut, xs[i].minOutNumerator, xs[i].minOutDenominator)
            );
        }
        return keccak256(abi.encodePacked(h));
    }

    function hash(IssuerLimit[] calldata xs) internal pure returns (bytes32) {
        bytes32[] memory h = new bytes32[](xs.length);
        for (uint256 i; i < xs.length; ++i) {
            h[i] = keccak256(
                abi.encode(
                    ISSUER_LIMIT_TYPEHASH, xs[i].chainRef, xs[i].assetId, xs[i].maxPerAction, xs[i].maxPerEpoch, xs[i].maxTotal
                )
            );
        }
        return keccak256(abi.encodePacked(h));
    }

    function hash(PolicyEndpoint calldata e) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                POLICY_ENDPOINT_TYPEHASH,
                e.chainRef,
                e.account,
                e.epochSeconds,
                hash(e.adapters),
                hash(e.assets),
                hash(e.recipients),
                hash(e.beneficiaries),
                hash(e.swapFloors),
                hash(e.recoveryDestinations)
            )
        );
    }

    function hash(LeaseIssuer calldata x) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(LEASE_ISSUER_TYPEHASH, x.issuer, x.maxLeaseLifetime, hashAddressArray(x.allowedAgents), hash(x.limits))
        );
    }

    function hash(RootPolicy calldata p) internal pure returns (bytes32) {
        bytes32[] memory eps = new bytes32[](p.endpoints.length);
        for (uint256 i; i < p.endpoints.length; ++i) eps[i] = hash(p.endpoints[i]);
        bytes32[] memory iss = new bytes32[](p.leaseIssuers.length);
        for (uint256 i; i < p.leaseIssuers.length; ++i) iss[i] = hash(p.leaseIssuers[i]);
        return keccak256(
            abi.encode(
                ROOT_POLICY_TYPEHASH,
                p.accountId,
                p.policyVersion,
                p.parentPolicyHash,
                p.allowedActions,
                p.priceMode,
                p.maxLeaseLifetime,
                p.activateBefore,
                keccak256(abi.encodePacked(eps)),
                keccak256(abi.encodePacked(iss))
            )
        );
    }

    function hash(LeaseEndpoint calldata e) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                LEASE_ENDPOINT_TYPEHASH,
                e.chainRef,
                e.account,
                hashBytes32Array(e.adapters),
                hash(e.assets),
                hashBytes32Array(e.recipients),
                hashBytes32Array(e.beneficiaries)
            )
        );
    }

    function hash(AgentLease calldata l) internal pure returns (bytes32) {
        bytes32[] memory eps = new bytes32[](l.endpoints.length);
        for (uint256 i; i < l.endpoints.length; ++i) eps[i] = hash(l.endpoints[i]);
        return keccak256(
            abi.encode(
                AGENT_LEASE_TYPEHASH,
                l.accountId,
                l.policyVersion,
                l.leaseId,
                l.agent,
                l.issuer,
                l.validAfter,
                l.expiresAt,
                l.activateBefore,
                l.allowedActions,
                l.authMode,
                keccak256(abi.encodePacked(eps))
            )
        );
    }

    function hash(ActionIntent calldata a) internal pure returns (bytes32) {
        bytes memory head = abi.encode(
            ACTION_INTENT_TYPEHASH,
            a.accountId,
            a.chainRef,
            a.account,
            a.policyVersion,
            a.leaseId,
            a.nonce,
            a.actionKind,
            a.adapterId,
            keccak256(bytes(a.adapterName)),
            a.adapterVersion
        );
        bytes memory tail = abi.encode(
            a.assetIn,
            a.assetOut,
            a.amountIn,
            a.minAmountOut,
            a.recipient,
            keccak256(bytes(a.recipientLabel)),
            a.deadline,
            a.planHash,
            a.planStep
        );
        return keccak256(abi.encodePacked(head, tail));
    }

    function hash(PauseAccount calldata x) internal pure returns (bytes32) {
        return keccak256(abi.encode(PAUSE_ACCOUNT_TYPEHASH, x.accountId, x.pauseEpoch, x.pauseId, x.deadline));
    }

    function hash(UnpauseAccount calldata x) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(UNPAUSE_ACCOUNT_TYPEHASH, x.accountId, x.chainRef, x.account, x.pauseEpoch, x.pauseId, x.deadline)
        );
    }

    function hash(RevokeLease calldata x) internal pure returns (bytes32) {
        return keccak256(abi.encode(REVOKE_LEASE_TYPEHASH, x.accountId, x.leaseId));
    }

    function hash(Withdraw calldata x) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                WITHDRAW_TYPEHASH, x.accountId, x.chainRef, x.account, x.assetId, x.amount, x.destination, x.opNonce, x.deadline
            )
        );
    }
}

library AmaneSig {
    uint256 internal constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    error BadSignatureLength();
    error BadV();
    error HighS();
    error ZeroRS();
    error RecoverFailed();

    function recover(bytes32 digest, bytes calldata sig) internal pure returns (address signer) {
        if (sig.length != 65) revert BadSignatureLength();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v != 27 && v != 28) revert BadV();
        if (r == 0 || s == 0) revert ZeroRS();
        if (uint256(s) > HALF_N) revert HighS();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert RecoverFailed();
    }
}
