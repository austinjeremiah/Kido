/// Ethereum-compatible secp256k1 recovery with the same canonical rules as the EVM core.
module amane::crypto;

use sui::ecdsa_k1;
use sui::hash::keccak256;

const EBadLength: u64 = 100;
const EBadV: u64 = 101;
const EHighS: u64 = 102;
const EZeroRS: u64 = 103;

const KECCAK256: u8 = 0;

// secp256k1 n/2, big-endian.
const HALF_N: vector<u8> = x"7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0";

/// `preimage` is hashed with keccak256 by the native before recovery, so callers pass the EIP-712
/// preimage (0x1901 || domainSeparator || structHash), never the digest.
///
/// Sui's native accepts the malleable high-s twin and v in {0,1,2,3}; Amane accepts only
/// v in {27,28} and s <= n/2 so that EVM and Sui agree on every signature.
public fun recover_eth_address(preimage: &vector<u8>, signature: &vector<u8>): vector<u8> {
    assert!(signature.length() == 65, EBadLength);
    let v = signature[64];
    assert!(v == 27 || v == 28, EBadV);
    let mut r_zero = true;
    let mut s_zero = true;
    let mut i = 0;
    while (i < 32) {
        if (signature[i] != 0) r_zero = false;
        if (signature[32 + i] != 0) s_zero = false;
        i = i + 1;
    };
    assert!(!r_zero && !s_zero, EZeroRS);
    assert!(!greater_than_half_n(signature), EHighS);

    let mut sig = vector[];
    i = 0;
    while (i < 64) {
        sig.push_back(signature[i]);
        i = i + 1;
    };
    sig.push_back(v - 27);

    let compressed = ecdsa_k1::secp256k1_ecrecover(&sig, preimage, KECCAK256);
    let uncompressed = ecdsa_k1::decompress_pubkey(&compressed);
    let mut xy = vector[];
    i = 1;
    while (i < 65) {
        xy.push_back(uncompressed[i]);
        i = i + 1;
    };
    let h = keccak256(&xy);
    let mut addr = vector[];
    i = 12;
    while (i < 32) {
        addr.push_back(h[i]);
        i = i + 1;
    };
    addr
}

fun greater_than_half_n(signature: &vector<u8>): bool {
    let half = HALF_N;
    let mut i = 0;
    while (i < 32) {
        let a = signature[32 + i];
        let b = half[i];
        if (a > b) return true;
        if (a < b) return false;
        i = i + 1;
    };
    false
}
