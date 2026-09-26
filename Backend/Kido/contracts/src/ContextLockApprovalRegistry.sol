// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ContextLockApprovalRegistry
/// @notice Records human (Ledger) approvals for ESCALATE capabilities.
///
/// @dev An approval authorizes ONE capability digest and nothing else. The digest already commits
///      to agent identity, chain, executor, target, value, calldataHash, intentHash, policyHash,
///      authorizationId, contextCommitment, issuedAt, expiresAt and nonce — so approving a digest
///      is approving one exact transaction. Mutating any field yields a different digest and the
///      approval simply does not apply.
///
///      Approvals are:
///        - signed by a configured approver (the Ledger-held address) over EIP-712 typed data,
///        - single-use (consumed on execution),
///        - independently expiring,
///        - and available ONLY for ESCALATE. There is no function here that a DENY can reach.
contract ContextLockApprovalRegistry {
    error NotOwner();
    error NotExecutor();
    error InvalidApprovalSignature();
    error ApprovalExpired(uint64 expiresAt, uint256 nowTs);
    error ApprovalAlreadyExists(bytes32 capabilityDigest);
    error ApprovalAlreadyConsumed(bytes32 capabilityDigest);
    error ApprovalNotFound(bytes32 capabilityDigest);
    error ZeroApprover();
    error ZeroOwner();

    struct Approval {
        address approver;
        uint64 approvedAt;
        uint64 expiresAt;
        bool consumed;
        bool exists;
    }

    bytes32 public constant APPROVAL_TYPEHASH =
        keccak256("ContextLockApproval(bytes32 capabilityDigest,address approver,uint64 expiresAt)");

    bytes32 public immutable DOMAIN_SEPARATOR;

    address public owner;

    /// @notice The address whose signature constitutes human approval — held on a Ledger device.
    address public approver;

    /// @notice Only this executor may consume approvals.
    address public executor;

    mapping(bytes32 capabilityDigest => Approval) public approvals;

    event ApproverSet(address indexed previous, address indexed current);
    event ExecutorSet(address indexed previous, address indexed current);
    event ApprovalRecorded(bytes32 indexed capabilityDigest, address indexed approver, uint64 expiresAt);
    event ApprovalConsumed(bytes32 indexed capabilityDigest, address indexed consumedBy);

    constructor(address owner_, address approver_) {
        if (approver_ == address(0)) revert ZeroApprover();
        // Owner zero would lock setApprover, so a compromised approver key could never be rotated.
        if (owner_ == address(0)) revert ZeroOwner();
        owner = owner_;
        approver = approver_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ContextLockApproval"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        emit ApproverSet(address(0), approver_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setApprover(address next) external onlyOwner {
        if (next == address(0)) revert ZeroApprover();
        emit ApproverSet(approver, next);
        approver = next;
    }

    function setExecutor(address next) external onlyOwner {
        emit ExecutorSet(executor, next);
        executor = next;
    }

    /// @notice The EIP-712 digest the human signs on the Ledger device.
    function approvalDigest(bytes32 capabilityDigest, address approver_, uint64 expiresAt)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(abi.encode(APPROVAL_TYPEHASH, capabilityDigest, approver_, expiresAt))
            )
        );
    }

    /// @notice Submit a device-produced approval signature.
    /// @dev Permissionless to submit: the signature is the authority, so who relays it is
    ///      irrelevant. A relayer cannot forge one and cannot alter what it covers.
    function submitApproval(bytes32 capabilityDigest, uint64 expiresAt, bytes calldata signature) external {
        if (expiresAt <= block.timestamp) revert ApprovalExpired(expiresAt, block.timestamp);
        if (approvals[capabilityDigest].exists) revert ApprovalAlreadyExists(capabilityDigest);

        bytes32 digest = approvalDigest(capabilityDigest, approver, expiresAt);
        if (!_isValidSignature(digest, signature)) revert InvalidApprovalSignature();

        approvals[capabilityDigest] = Approval({
            approver: approver,
            approvedAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            consumed: false,
            exists: true
        });

        emit ApprovalRecorded(capabilityDigest, approver, expiresAt);
    }

    /// @notice Read-only validity check used by the executor before it commits to anything.
    function isApprovalValid(bytes32 capabilityDigest) external view returns (bool) {
        Approval memory a = approvals[capabilityDigest];
        if (!a.exists) return false;
        if (a.consumed) return false;
        if (block.timestamp > a.expiresAt) return false;
        // A later approver rotation invalidates approvals signed by the previous one.
        if (a.approver != approver) return false;
        return true;
    }

    /// @notice Consume an approval. Only the configured executor may call this.
    function consumeApproval(bytes32 capabilityDigest) external {
        if (msg.sender != executor) revert NotExecutor();
        Approval storage a = approvals[capabilityDigest];
        if (!a.exists) revert ApprovalNotFound(capabilityDigest);
        if (a.consumed) revert ApprovalAlreadyConsumed(capabilityDigest);
        if (block.timestamp > a.expiresAt) revert ApprovalExpired(a.expiresAt, block.timestamp);
        if (a.approver != approver) revert InvalidApprovalSignature();
        a.consumed = true;
        emit ApprovalConsumed(capabilityDigest, msg.sender);
    }

    function _isValidSignature(bytes32 hash, bytes calldata signature) internal view returns (bool) {
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return false;
        if (v != 27 && v != 28) return false;
        address recovered = ecrecover(hash, v, r, s);
        return recovered != address(0) && recovered == approver;
    }
}
