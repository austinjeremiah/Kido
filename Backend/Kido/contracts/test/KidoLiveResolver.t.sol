// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KidoLiveResolver} from "../src/KidoLiveResolver.sol";

contract KidoLiveResolverTest is Test {
    KidoLiveResolver r;
    uint256 signerKey = 0xA11CE;
    address signerAddr;

    function setUp() public {
        signerAddr = vm.addr(signerKey);
        r = new KidoLiveResolver("https://gw.example/{sender}/{data}.json", signerAddr);
    }

    function _sign(uint256 key, uint64 expires, bytes memory request, bytes memory result) internal view returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(key, r.makeSignatureHash(address(r), expires, request, result));
        return abi.encodePacked(rr, s, v);
    }

    function test_resolve_defers_to_the_gateway() public {
        bytes memory name = hex"046c69766508747265617375727903657468";
        bytes memory data = abi.encodeWithSignature("text(bytes32,string)", bytes32(0), "kido.status");
        string[] memory urls = new string[](1);
        urls[0] = r.url();
        bytes memory callData = abi.encodeWithSelector(r.resolve.selector, name, data);
        vm.expectRevert(abi.encodeWithSelector(KidoLiveResolver.OffchainLookup.selector, address(r), urls, callData, r.resolveWithProof.selector, callData));
        r.resolve(name, data);
    }

    function test_accepts_a_signed_fresh_answer() public view {
        bytes memory request = hex"1234";
        bytes memory result = abi.encode("ACTIVE");
        uint64 expires = uint64(block.timestamp + 300);
        bytes memory out = r.resolveWithProof(abi.encode(result, expires, _sign(signerKey, expires, request, result)), request);
        assertEq(abi.decode(out, (string)), "ACTIVE");
    }

    function test_rejects_another_signer() public {
        bytes memory request = hex"1234";
        bytes memory result = abi.encode("ACTIVE");
        uint64 expires = uint64(block.timestamp + 300);
        bytes memory sig = _sign(0xB0B, expires, request, result);
        vm.expectRevert(KidoLiveResolver.InvalidSigner.selector);
        r.resolveWithProof(abi.encode(result, expires, sig), request);
    }

    function test_rejects_an_answer_for_another_request() public {
        bytes memory result = abi.encode("ACTIVE");
        uint64 expires = uint64(block.timestamp + 300);
        bytes memory sig = _sign(signerKey, expires, hex"1234", result);
        vm.expectRevert(KidoLiveResolver.InvalidSigner.selector);
        r.resolveWithProof(abi.encode(result, expires, sig), hex"5678");
    }

    function test_rejects_an_expired_answer() public {
        vm.warp(1_000_000);
        bytes memory request = hex"1234";
        bytes memory result = abi.encode("ACTIVE");
        uint64 expires = uint64(block.timestamp - 1);
        bytes memory sig = _sign(signerKey, expires, request, result);
        vm.expectRevert(KidoLiveResolver.SignatureExpired.selector);
        r.resolveWithProof(abi.encode(result, expires, sig), request);
    }

    function test_only_the_owner_moves_the_gateway() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(KidoLiveResolver.NotOwner.selector);
        r.setUrl("https://evil.example");
        r.setUrl("https://kido.example/{sender}/{data}.json");
        assertEq(r.url(), "https://kido.example/{sender}/{data}.json");
    }

    function test_supports_extended_resolver() public view {
        assertTrue(r.supportsInterface(0x9061b923));
        assertTrue(r.supportsInterface(0x01ffc9a7));
        assertFalse(r.supportsInterface(0x12345678));
    }
}
