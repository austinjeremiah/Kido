// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @notice Chainlink CRE receiver interface, as called by the KeystoneForwarder.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title KidoCreReceiver
/// @notice Records DECISION_ONLY verdicts produced by a Kido CRE workflow over private inputs. Only
/// the configured Chainlink forwarder may deliver; the workflow owner and name can be pinned; a
/// decision for a key can only move forward in time. No private value is ever stored or emitted.
contract KidoCreReceiver is IReceiver {
    error NotForwarder(address caller);
    error ForwarderHasNoCode(address forwarder);
    error UnexpectedWorkflowOwner(address owner);
    error UnexpectedWorkflowName(bytes10 name);
    error MalformedMetadata();
    error MalformedReport();
    error NotNewer(bytes32 key, uint64 evaluatedAt, uint64 latest);

    struct Decision {
        bool act;
        bytes32 blueprintHash;
        uint64 evaluatedAt;
        bytes32 workflowCid;
    }

    /// @dev forwarder metadata: workflow_cid (32) ‖ workflow_name (10) ‖ workflow_owner (20) ‖ report_id (2)
    uint256 internal constant METADATA_LENGTH = 64;
    /// @dev abi.encode(bytes32 key, bool act, bytes32 blueprintHash, uint64 evaluatedAt)
    uint256 internal constant REPORT_LENGTH = 128;

    address public immutable forwarder;
    /// @notice address(0) accepts any workflow owner (simulation deployments only).
    address public immutable expectedWorkflowOwner;
    /// @notice bytes10(0) accepts any workflow name.
    bytes10 public immutable expectedWorkflowName;

    mapping(bytes32 => Decision) public decisions;

    event DecisionRecorded(bytes32 indexed key, bool act, bytes32 blueprintHash, uint64 evaluatedAt, bytes32 workflowCid, bytes2 reportId);

    constructor(address forwarder_, address expectedWorkflowOwner_, bytes10 expectedWorkflowName_) {
        if (forwarder_.code.length == 0) revert ForwarderHasNoCode(forwarder_);
        forwarder = forwarder_;
        expectedWorkflowOwner = expectedWorkflowOwner_;
        expectedWorkflowName = expectedWorkflowName_;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender);
        if (metadata.length != METADATA_LENGTH) revert MalformedMetadata();
        bytes32 cid = bytes32(metadata[0:32]);
        bytes10 name = bytes10(metadata[32:42]);
        address wfOwner = address(bytes20(metadata[42:62]));
        bytes2 reportId = bytes2(metadata[62:64]);
        if (expectedWorkflowOwner != address(0) && wfOwner != expectedWorkflowOwner) revert UnexpectedWorkflowOwner(wfOwner);
        if (expectedWorkflowName != bytes10(0) && name != expectedWorkflowName) revert UnexpectedWorkflowName(name);

        if (report.length != REPORT_LENGTH) revert MalformedReport();
        (bytes32 key, bool act, bytes32 blueprintHash, uint64 evaluatedAt) = abi.decode(report, (bytes32, bool, bytes32, uint64));
        uint64 latest = decisions[key].evaluatedAt;
        if (evaluatedAt <= latest) revert NotNewer(key, evaluatedAt, latest);

        decisions[key] = Decision(act, blueprintHash, evaluatedAt, cid);
        emit DecisionRecorded(key, act, blueprintHash, evaluatedAt, cid, reportId);
    }
}
