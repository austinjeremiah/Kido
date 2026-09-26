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

interface IERC20Minimal {
    function balanceOf(address) external view returns (uint256);
}

/// A BRIDGE transport adapter redeems a delivery proof, sends the tokens to the calling account and
/// returns the intent digest the delivery carries. It never decides what the funds may be used for.
/// Outbound half of a transport adapter: sends `amount` of `token` (already transferred to it) to
/// the destination endpoint `recipient`, carrying `intent` so the destination can verify it.
interface IAmaneBridge {
    function bridge(address token, uint256 amount, bytes32 recipient, bytes32 intent) external;
}

interface IAmaneTransport {
    function redeem(bytes calldata data) external returns (bytes32 intent);
}

/// Storage layout shared by the account and its pinned extension (which runs by delegatecall).
/// State lives only here; the order of declarations is the storage layout and must never change.
abstract contract AmaneStorage {
    uint8 internal constant PRICE_MODE_TESTNET_FIXED = 1;
    uint8 internal constant AUTH_MODE_AGENT_SIGNED = 1;

    uint8 internal constant LEASE_NONE = 0;
    uint8 internal constant LEASE_ACTIVE = 1;
    uint8 internal constant LEASE_REVOKED = 2;

    struct Limit {
        bool allowed;
        uint256 perAction;
        uint256 perEpoch;
        uint256 total;
    }

    /// Token bucket: `level` refills linearly to perEpoch over epochSeconds, so spend within
    /// any window of length W is at most perEpoch * (1 + W / epochSeconds).
    struct Spend {
        bool initialized;
        uint64 updatedAt;
        uint256 level;
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


    address[] internal controllerList;
    mapping(address => bool) public isController;

    bool public paused;
    uint64 public pauseEpoch;
    bytes32 public lastPauseId;
    mapping(bytes32 => bool) public pauseIdUsed;
    uint64 public opNonce;

    uint64 public policyVersion;
    bytes32 public policyHash;
    uint32 public allowedActions;
    uint64 public maxLeaseLifetime;
    uint64 public epochSeconds;

    mapping(uint64 => mapping(bytes32 => AdapterPolicy)) internal rootAdapters;
    mapping(uint64 => mapping(bytes32 => Limit)) internal rootAssets;
    mapping(uint64 => mapping(bytes32 => bytes32)) internal rootRecipientLabel;
    mapping(uint64 => mapping(bytes32 => bytes32)) internal rootBeneficiaryLabel;
    mapping(uint64 => mapping(bytes32 => bool)) internal recoveryDestination;
    mapping(uint64 => mapping(bytes32 => Floor)) internal swapFloor;
    mapping(uint64 => mapping(address => IssuerPolicy)) internal issuers;
    mapping(uint64 => mapping(address => mapping(address => bool))) internal issuerAgents;
    mapping(uint64 => mapping(address => mapping(bytes32 => Limit))) internal issuerLimits;

    mapping(bytes32 => Lease) internal leases;
    mapping(bytes32 => mapping(bytes32 => bool)) internal leaseAdapters;
    mapping(bytes32 => mapping(bytes32 => Limit)) internal leaseAssets;
    mapping(bytes32 => mapping(bytes32 => bool)) internal leaseRecipients;
    mapping(bytes32 => mapping(bytes32 => bool)) internal leaseBeneficiaries;

    mapping(bytes32 => mapping(bytes32 => Spend)) internal leaseSpend;
    mapping(uint64 => mapping(bytes32 => Spend)) internal rootSpend;
    mapping(uint64 => mapping(address => mapping(bytes32 => Spend))) internal issuerSpend;
    mapping(bytes32 => mapping(uint64 => bool)) public nonceUsed;

    /// Cross-chain arrivals, reserved for exactly one intent (the source BRIDGE action's digest).
    struct Reservation {
        bytes32 leaseId;
        uint8 actionKind;
        bytes32 adapterId;
        bytes32 recipient;
        bytes32 asset;
        uint64 deadline;
        uint256 remaining;
    }
    mapping(bytes32 => Reservation) public reservations;
    mapping(bytes32 => bool) public intentUsed;
    mapping(address => uint256) public reservedOf;

    uint256 internal locked = 1;

    event PolicyInstalled(uint64 indexed policyVersion, bytes32 policyHash);
    event LeaseActivated(bytes32 indexed leaseId, address indexed agent, address indexed issuer, uint64 expiresAt);
    event LeaseRevoked(bytes32 indexed leaseId, address by);
    event Paused(uint64 pauseEpoch, bytes32 pauseId, address by);
    event Unpaused(uint64 pauseEpoch, bytes32 pauseId);
    event CrossChainReserved(bytes32 indexed intent, bytes32 indexed leaseId, address token, uint256 amount);
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

    error AmaneRejected(uint16 code);

    modifier nonReentrant() {
        if (locked != 1) revert AmaneRejected(Codes.ACTION_REENTRANT);
        locked = 2;
        _;
        locked = 1;
    }

    function self32() public view returns (bytes32) {
        return bytes32(uint256(uint160(address(this))));
    }

    function _asAddress(bytes32 word) internal pure returns (address) {
        if (uint256(word) >> 160 != 0) revert AmaneRejected(Codes.CHAIN_NOT_AN_ADDRESS);
        return address(uint160(uint256(word)));
    }
}
