// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {KidoCreReceiver, IReceiver, IERC165} from "../src/KidoCreReceiver.sol";

/// @dev Mirrors the KeystoneForwarder delivery path: ERC-165 check, then onReport(metadata, report)
/// with metadata = rawReport[45:109] and report = rawReport[109:].
contract ForwarderHarness {
    function deliver(address receiver, bytes calldata rawReport) external returns (bool ok, bool invalidReceiver) {
        (bool s1, bytes memory r1) = receiver.staticcall(abi.encodeCall(IERC165.supportsInterface, (type(IERC165).interfaceId)));
        (bool s2, bytes memory r2) = receiver.staticcall(abi.encodeCall(IERC165.supportsInterface, (bytes4(0xffffffff))));
        (bool s3, bytes memory r3) = receiver.staticcall(abi.encodeCall(IERC165.supportsInterface, (type(IReceiver).interfaceId)));
        if (!(s1 && abi.decode(r1, (bool)) && s2 && !abi.decode(r2, (bool)) && s3 && abi.decode(r3, (bool)))) return (false, true);
        (ok,) = receiver.call(abi.encodeCall(IReceiver.onReport, (rawReport[45:109], rawReport[109:])));
    }
}

contract KidoCreReceiverTest is Test {
    ForwarderHarness fwd;
    KidoCreReceiver receiver;
    address constant WF_OWNER = address(0xC0FFEE);
    bytes10 constant WF_NAME = bytes10("kido-dec01");
    bytes32 constant CID = keccak256("workflow-cid");
    bytes32 constant KEY = keccak256("kido:agent:x/risk-threshold");
    bytes32 constant BP = keccak256("blueprint");

    function setUp() public {
        fwd = new ForwarderHarness();
        receiver = new KidoCreReceiver(address(fwd), WF_OWNER, WF_NAME);
    }

    function raw(bytes10 name, address owner, bytes memory report) internal pure returns (bytes memory) {
        // version(1) ‖ execution id(32) ‖ timestamp(4) ‖ don id(4) ‖ config version(4) ‖ cid(32) ‖ name(10) ‖ owner(20) ‖ report id(2)
        return bytes.concat(bytes1(0x01), keccak256("exec"), bytes4(0), bytes4(uint32(1)), bytes4(uint32(1)), CID, name, bytes20(owner), bytes2(0x0001), report);
    }

    function payload(bool act, uint64 at) internal pure returns (bytes memory) {
        return abi.encode(KEY, act, BP, at);
    }

    function test_forwarder_delivery_records_decision() public {
        (bool ok, bool invalid) = fwd.deliver(address(receiver), raw(WF_NAME, WF_OWNER, payload(true, 100)));
        assertTrue(ok);
        assertFalse(invalid);
        (bool act, bytes32 bp, uint64 at, bytes32 cid) = receiver.decisions(KEY);
        assertTrue(act);
        assertEq(bp, BP);
        assertEq(at, 100);
        assertEq(cid, CID);
    }

    function test_supports_receiver_interface() public view {
        assertTrue(receiver.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(receiver.supportsInterface(type(IERC165).interfaceId));
        assertFalse(receiver.supportsInterface(0xffffffff));
    }

    function test_rejects_direct_caller() public {
        vm.expectRevert(abi.encodeWithSelector(KidoCreReceiver.NotForwarder.selector, address(this)));
        receiver.onReport(new bytes(64), payload(true, 1));
    }

    function test_rejects_unexpected_workflow_owner() public {
        (bool ok,) = fwd.deliver(address(receiver), raw(WF_NAME, address(0xBAD), payload(true, 1)));
        assertFalse(ok);
        (,, uint64 at,) = receiver.decisions(KEY);
        assertEq(at, 0);
    }

    function test_rejects_unexpected_workflow_name() public {
        (bool ok,) = fwd.deliver(address(receiver), raw(bytes10("other-wf00"), WF_OWNER, payload(true, 1)));
        assertFalse(ok);
    }

    function test_rejects_replay_and_older_decisions() public {
        (bool ok,) = fwd.deliver(address(receiver), raw(WF_NAME, WF_OWNER, payload(true, 100)));
        assertTrue(ok);
        (ok,) = fwd.deliver(address(receiver), raw(WF_NAME, WF_OWNER, payload(false, 100)));
        assertFalse(ok);
        (ok,) = fwd.deliver(address(receiver), raw(WF_NAME, WF_OWNER, payload(false, 99)));
        assertFalse(ok);
        (bool act,,,) = receiver.decisions(KEY);
        assertTrue(act);
    }

    function test_rejects_malformed_report() public {
        (bool ok,) = fwd.deliver(address(receiver), raw(WF_NAME, WF_OWNER, abi.encode(KEY, true)));
        assertFalse(ok);
    }

    function test_constructor_rejects_codeless_forwarder() public {
        vm.expectRevert(abi.encodeWithSelector(KidoCreReceiver.ForwarderHasNoCode.selector, address(0x6481)));
        new KidoCreReceiver(address(0x6481), WF_OWNER, WF_NAME);
    }

    function test_open_expectations_accept_any_workflow() public {
        KidoCreReceiver open = new KidoCreReceiver(address(fwd), address(0), bytes10(0));
        (bool ok,) = fwd.deliver(address(open), raw(bytes10("anything00"), address(0x1234), payload(false, 5)));
        assertTrue(ok);
    }

    function testFuzz_only_forwarder(address caller) public {
        vm.assume(caller != address(fwd));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(KidoCreReceiver.NotForwarder.selector, caller));
        receiver.onReport(new bytes(64), payload(true, 1));
    }
}
