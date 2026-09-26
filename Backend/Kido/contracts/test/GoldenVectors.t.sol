// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Capability, ContextLockTypes} from "../src/ContextLockTypes.sol";

/// @notice Differential hashing: Solidity must independently reproduce the golden vectors that
///         the TypeScript package produced from the same written schema.
///
/// @dev    This test never calls TypeScript, and the TypeScript test never calls Solidity. Both
///         read the same committed JSON and recompute. That is what makes agreement evidence
///         rather than a tautology — calling one implementation from the other would only prove
///         that a function returns its own result.
contract GoldenVectorsTest is Test {
    using stdJson for string;

    string internal json;

    function setUp() public {
        json = vm.readFile("test-vectors/capability-vectors.json");
    }

    function _cap(string memory key) internal view returns (Capability memory c) {
        c.version = uint8(json.readUint(string.concat(key, ".version")));
        c.agentIdentityHash = json.readBytes32(string.concat(key, ".agentIdentityHash"));
        c.agent = json.readAddress(string.concat(key, ".agent"));
        c.chainId = vm.parseUint(json.readString(string.concat(key, ".chainId")));
        c.executor = json.readAddress(string.concat(key, ".executor"));
        c.target = json.readAddress(string.concat(key, ".target"));
        c.value = vm.parseUint(json.readString(string.concat(key, ".value")));
        c.calldataHash = json.readBytes32(string.concat(key, ".calldataHash"));
        c.intentHash = json.readBytes32(string.concat(key, ".intentHash"));
        c.policyHash = json.readBytes32(string.concat(key, ".policyHash"));
        c.authorizationId = json.readBytes32(string.concat(key, ".authorizationId"));
        c.contextCommitment = json.readBytes32(string.concat(key, ".contextCommitment"));
        c.issuedAt = uint64(vm.parseUint(json.readString(string.concat(key, ".issuedAt"))));
        c.expiresAt = uint64(vm.parseUint(json.readString(string.concat(key, ".expiresAt"))));
        c.nonce = vm.parseUint(json.readString(string.concat(key, ".nonce")));
    }

    function _domainSeparator(uint256 chainId, address executor) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ContextLock"),
                keccak256("1"),
                chainId,
                executor
            )
        );
    }

    /// The type strings and typehashes must match byte for byte.
    function test_typehashesMatchFixture() public view {
        assertEq(
            ContextLockTypes.CAPABILITY_TYPEHASH,
            json.readBytes32(".capabilityTypehash"),
            "capability typehash drift between Solidity and TypeScript"
        );
        assertEq(
            ContextLockTypes.REQUEST_TYPEHASH,
            json.readBytes32(".requestTypehash"),
            "request typehash drift between Solidity and TypeScript"
        );
        assertEq(ContextLockTypes.CAPABILITY_TYPE, json.readString(".capabilityTypeString"));
        assertEq(ContextLockTypes.REQUEST_TYPE, json.readString(".requestTypeString"));
    }

    /// Every vector: structHash, domainSeparator, full digest and requestHash.
    function test_allVectorsReproduceIdentically() public view {
        uint256 n = 16;
        bytes32[] memory seenDigests = new bytes32[](n);

        for (uint256 i = 0; i < n; i++) {
            string memory k = string.concat(".vectors[", vm.toString(i), "]");
            string memory name = json.readString(string.concat(k, ".name"));
            Capability memory c = _cap(string.concat(k, ".capability"));

            assertEq(
                ContextLockTypes.hashStruct(c),
                json.readBytes32(string.concat(k, ".structHash")),
                string.concat("structHash mismatch: ", name)
            );

            bytes32 ds = _domainSeparator(c.chainId, c.executor);
            assertEq(
                ds,
                json.readBytes32(string.concat(k, ".domainSeparator")),
                string.concat("domainSeparator mismatch: ", name)
            );

            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ds, ContextLockTypes.hashStruct(c)));
            assertEq(digest, json.readBytes32(string.concat(k, ".digest")), string.concat("digest mismatch: ", name));

            assertEq(
                ContextLockTypes.requestHash(c),
                json.readBytes32(string.concat(k, ".requestHash")),
                string.concat("requestHash mismatch: ", name)
            );

            seenDigests[i] = digest;
        }

        // No two vectors share a digest: every mutated field is genuinely bound by the schema.
        for (uint256 i = 0; i < n; i++) {
            for (uint256 j = i + 1; j < n; j++) {
                assertTrue(seenDigests[i] != seenDigests[j], "two vectors produced the same digest");
            }
        }
    }

    /// requestHash must ignore capability-scoped fields and bind transaction-scoped ones.
    function test_requestHashScope() public view {
        Capability memory base_ = _cap(".vectors[0].capability");
        bytes32 baseline = ContextLockTypes.requestHash(base_);

        // Re-read rather than `= base_`: memory struct assignment aliases in Solidity, so
        // mutating a "copy" would mutate base_ and the assertion would compare it to itself.
        Capability memory withNewNonce = _cap(".vectors[0].capability");
        withNewNonce.nonce = base_.nonce + 1;
        assertEq(ContextLockTypes.requestHash(withNewNonce), baseline, "nonce must not affect requestHash");

        Capability memory withNewExpiry = _cap(".vectors[0].capability");
        withNewExpiry.expiresAt = base_.expiresAt + 1;
        assertEq(ContextLockTypes.requestHash(withNewExpiry), baseline, "expiry must not affect requestHash");

        Capability memory withNewTarget = _cap(".vectors[0].capability");
        withNewTarget.target = address(0xDEAD);
        assertTrue(ContextLockTypes.requestHash(withNewTarget) != baseline, "target MUST affect requestHash");

        Capability memory withNewCalldata = _cap(".vectors[0].capability");
        withNewCalldata.calldataHash = keccak256("attacker");
        assertTrue(ContextLockTypes.requestHash(withNewCalldata) != baseline, "calldata MUST affect requestHash");
    }
}
