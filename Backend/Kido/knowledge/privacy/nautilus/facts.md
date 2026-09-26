# Nautilus (verifiable off-chain compute for Sui) — runtime facts (verified 2026-09-26)

Only facts TRACE verified are here. Knowing these facts never authorizes using this provider.

## Core concepts

- **Enclave endpoints**: `/health_check`, `/get_attestation` (signed attestation over the enclave's ephemeral Ed25519 pubkey), `/process_data` (app logic, returns `{response, signature}`). verified(docs) design.md.
- **PCRs**: SHA-384 measurements. PCR0 is the OS/boot image, PCR1 the kernel/app, PCR2 the runtime config (`run.sh`, traffic rules). Reproducible builds let anyone recompute them. Debug mode gives **all-zero PCRs**. verified(docs).
- **`sui::nitro_attestation`** (framework 1.80.1), verified(live) GraphQL `package(address:"0x2"){module(name:"nitro_attestation"){structs{…} functions{…}}}` + cache source:
  - `entry fun load_nitro_attestation(attestation: vector<u8>, clock: &Clock): NitroAttestationDocument`. It is **non-public entry**, so call it as a PTB command, not from Move.
  - `NitroAttestationDocument has drop { module_id, timestamp, digest, pcrs: vector<PCREntry>, public_key: Option<vector<u8>>, user_data: Option<vector<u8>>, nonce: Option<vector<u8>> }`.
  - `PCREntry { index: u8, value: vector<u8> }`.
  - Accessors: `module_id`, `timestamp`, `digest`, `pcrs`, `public_key`, `user_data`, `nonce`, `index`, `value`.
  - Errors: `ENotSupportedError 0`, `EParseError 1`, `EVerifyError 2`, `EInvalidPCRsError 3`.
  - `pcrs()` always includes required PCRs 0 to 4 and 8, and custom PCRs 5 to 7 and 9 to 31 only if non-zero.
- **`enclave::enclave` pattern** (repo `move/enclave/sources/enclave.move`), verified(docs):
  - `new_cap<T: drop>(witness, ctx) → Cap<T>`.
  - `create_enclave_config<T>(&Cap<T>, name, pcr0, pcr1, pcr2, ctx)` shares `EnclaveConfig<T>{pcrs, capability_id, version}`.
  - `register_enclave<T>(&EnclaveConfig<T>, NitroAttestationDocument, ctx)` asserts that the document PCR0..2 equal the config (`EInvalidPCRs = 0`), takes `public_key` (it aborts if the key is `none`), and shares `Enclave<T>{pk, config_version, owner}`.
  - `verify_signature<T, P: drop>(&Enclave<T>, intent_scope: u8, timestamp_ms: u64, payload: P, signature: &vector<u8>): bool` runs `ed25519_verify` over `bcs(IntentMessage{intent, timestamp_ms, payload})`.
  - `update_pcrs` (Cap-gated, bumps `version`), `update_name`, `destroy_old_enclave` (when `config_version < version`), `deploy_old_enclave_by_owner`.
  - Test-only `new_enclave_for_testing<T>(pk, ctx)` and `destroy`.
- Attestation verification is gas-heavy, so it runs **once at registration**. After that, only cheap Ed25519 checks run. verified(docs) design.md.
- **Seal + Nautilus**: Seal can keep long-term secrets and release them only to an attested enclave (the `move/seal-policy` example). verified(docs) overview; details not reviewed.

## Supported operations Kido would use

| Op | Call | Label |
|---|---|---|
| Publish app + enclave packages | `sui client publish` | needs gas; not run |
| Create config | `enclave::new_cap(OTW)` then `create_enclave_config(&cap, name, pcr0, pcr1, pcr2)` | verified(live) in unit test |
| Register enclave | PTB: `doc = 0x2::nitro_attestation::load_nitro_attestation(att_bytes, 0x6)` then `enclave::register_enclave<T>(&config, doc)` | verified(live) in unit test with a real fixture. On-chain: **BLOCKED_ENV** (needs a live attestation from a real Nitro enclave; a stale one aborts with code 2) |
| Verify enclave output | the app's Move function calls `enclave.verify_signature(scope, ts, payload, &sig)` and checks timestamp freshness itself | verified(live) unit tests (mock key) |
| Rotate PCRs | `update_pcrs(&mut config, &cap, …)`, re-register, then `destroy_old_enclave` | verified(docs) |

## Required fields

- `EnclaveConfig`: `name: String`, `pcr0/1/2: vector<u8>` (48-byte SHA-384 each), `Cap<T>` from a one-time/witness type `T: drop`. verified(docs).
- Registration: raw attestation document bytes (CBOR COSE_Sign1 from NSM, served at `/get_attestation`) and `Clock 0x6`. verified(docs)/verified(live).
- Signed response: `intent_scope: u8`, `timestamp_ms: u64`, the app payload struct (BCS layout must match the Rust side exactly), and a 64-byte Ed25519 signature. verified(docs) `test_serde` vector `0020b1d110960100000d53616e204672616e636973636f0d00000000000000`.

## Upgrade / version behaviour

- `nitro_attestation` parsing has evolved behind feature flags (upgraded parsing, required-PCR handling). Older frameworks may parse the PCR list differently. verified(live) flags; details inferred.
- PCR rotation: `update_pcrs` bumps `EnclaveConfig.version`. Enclaves registered earlier keep their old `config_version`, and **`verify_signature` does not check it**, so app code must compare `enclave.config_version()` with `config.version()` if old enclaves should be rejected. verified(docs) source (the comment on `config_version` says exactly this).
- The template repo has no releases, so pin a commit. verified(live).

## Failure modes

| Failure | Abort / symptom | Label |
|---|---|---|
| Stale or expired attestation cert | `0x2::nitro_attestation` abort **2** (`EVerifyError`) | verified(live) on-chain dry-run + unit test |
| Malformed attestation bytes | abort **1** (`EParseError`) | verified(docs) framework test |
| PCR mismatch vs config | `enclave::enclave` abort **0** (`EInvalidPCRs`) | verified(live) unit test |
| Attestation without `public_key` | `destroy_some` abort in `load_pk` | inferred from source |
| Wrong cap for config | abort 2 `EInvalidCap` | verified(docs) |
| BCS layout mismatch Rust ↔ Move | `verify_signature` returns **false** (no abort) | verified(live) tampered-payload test |
| Debug-mode enclave (all-zero PCRs) registered | works, but provides **no attestation guarantee** | verified(docs) |
| Not on AWS Nitro (a plain VM) | `/get_attestation` cannot reach the NSM, so there is no attestation | inferred |

## Limitations

- Supported TEEs are AWS Nitro only (self-managed) or Marlin Oyster (Docker). No SGX/TDX/SEV path is documented. (verified(docs))
- An attestation must be registered while fresh. Nitro docs certs are short-lived (the framework test uses 3 h to show expiry), and our 2025 fixture is rejected today. (verified(live))
- One `Enclave` object per running instance. Every restart means a new key and re-registration (a gas-heavy verify). (verified(docs))
- The template is unaudited and not feature complete. (verified(docs))

## Common mistakes

- Trying to call `load_nitro_attestation` from inside a Move function. It is non-public `entry`, so call it as a PTB command and pass the result on.
- Registering debug (all-zero) PCRs "temporarily" and never rotating.
- Not checking response freshness or `config_version`.
- Letting the Move payload struct drift from the Rust struct (the signature silently fails).
- Pinning the docs' example enclave IDs as your own.
- Claiming "ran in a TEE" when only the simulator or unit tests ran. Kido's honesty guard already bans this (`/Users/kaushikh/Kido Master/Kido/apps/studio/src/honesty.ts:71`).
