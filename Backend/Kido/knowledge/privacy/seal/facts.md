# Seal (decentralized secrets management for Sui) — runtime facts (verified 2026-09-26)

Only facts TRACE verified are here. Knowing these facts never authorizes using this provider.

## Core concepts

- **IBE (Boneh-Franklin, BLS12-381) KEM plus DEM.** The DEM is AES-256-GCM (default, preferred) or HMAC-CTR (needed only for on-chain decryption). verified(docs) design.md.
- **Identity namespace.** The full identity is `[PkgId][inner id]`. A package controls every identity prefixed by its *original* package ID, and upgrades keep the same namespace. `seal_approve*` receives only the inner id. verified(docs). Live check: `EncryptedObject.parse` returned `packageId` = the policy package and `id` = `000fd2c9…0102030405`, i.e. the inner id, which for the allowlist pattern is prefixed with the Allowlist object id.
- **Access policy**: Move `seal_approve*` functions in the policy package. verified(docs) using-seal:
  - The first param is `id: vector<u8>`.
  - The function aborts to deny.
  - It should be non-public `entry`, side-effect free, and avoid `Random` or fast-changing state.
  - Only `seal_approve*` calls into a single package are allowed in the PTB.
  - Key servers evaluate it by **dry-run on their fullnode**. The evaluation is not atomic across servers, and inputs are resolved to their latest version.
- **Live example of the pattern**: package `0xc5ce2742cac46421b62028557f1d7aea8a4c50f651379a79afdf12cd88628807` (Seal example app) has `allowlist::seal_approve(vector<u8>, &Allowlist, &TxContext)` and `subscription::seal_approve(vector<u8>, &Subscription, &Service, &Clock)`, both `PRIVATE entry`. verified(live) GraphQL `package(address:…){modules{nodes{name functions{nodes{name isEntry visibility parameters{repr}}}}}}`.
- **Key servers**: on-chain `KeyServer` objects whose dynamic field `KeyServerV1{name,url,key_type,pk}` or `KeyServerV2{…, server_type}` holds the URL and master public key. **The object ID is the source of truth, not the URL.** verified(live)/verified(docs).
  - **Independent** servers hold one master secret each.
  - **Committee** (MPC, decentralized) servers are reached through an aggregator URL.
  - Modes: **Open** means anyone can use it for any package, with a source rate limit. **Permissioned** means the provider must allowlist your package id and issue an API key (`X-API-Key`).
- **Threshold**: `t-of-n` over the chosen servers, set **at encryption time**. Weights let one server count several times. "The set of key servers is not dynamic once the data is encrypted." A committee server counts as one server, and its internal threshold is fixed. verified(docs).
- **Session key**: the user signs a personal message once per package, for a TTL in minutes. The dapp then fetches keys without further prompts. `TxContext::sender()` in `seal_approve` is the session-key signer's address. verified(docs). Live message text: `Accessing keys of package 0xc5ce…8807 for 10 mins from 2026-09-26 02:36:15 UTC, session key 1s1zYuu+…`. verified(live).

## Supported operations Kido would use (with live results)

| Operation | Call | Result on 2026-09-26 | Label |
|---|---|---|---|
| Load and verify key servers | `new SealClient({suiClient: grpc, serverConfigs:[{objectId:'0x73d0…',weight:1},{objectId:'0xf5d1…',weight:1}], verifyKeyServers:true}).getKeyServers()` | returned `mysten-v1-1` / `mysten-v1-2`, `serverType:"Independent"`, URLs match the objects (the verify step checks `/v1/service` against the object id) | verified(live) |
| Committee server | `serverConfigs:[{objectId:'0xb012…1e98', weight:1, aggregatorUrl:'https://seal-aggregator-testnet.mystenlabs.com'}]` | `serverType:"Committee"`, url = aggregator | verified(live) |
| Encrypt | `client.encrypt({threshold:2, packageId, id, data})` | 369-byte ciphertext, `threshold:2`, services = both Mysten servers. The committee with t=1 gave 304 bytes | verified(live) |
| Session key | `SessionKey.create({address, packageId, ttlMin:10, suiClient: grpc, signer})` | OK | verified(live) |
| Decrypt / fetch keys | `tx.moveCall({target:`${pkg}::allowlist::seal_approve`, arguments:[tx.pure.vector('u8', fromHex(id)), tx.object(allowlist)]})`, then `tx.build({client, onlyTransactionKind:true})`, then `client.decrypt({data, sessionKey, txBytes})` | **`NoAccessError: User does not have access to one or more of the requested keys`** from both the independent pair and the committee. This is the expected result: the Allowlist `0x000fd2c9…9628` has an empty `list` | verified(live), negative path |
| Positive decrypt | same call, with the sender on an allowlist / policy satisfied | **not executed.** It needs a policy object that includes our address, which means sending a transaction or publishing a package, and that was out of scope (no spend) | NOT RUN |
| Batch keys | `client.fetchKeys({ids, txBytes, sessionKey, threshold})` | — | verified(docs) |
| On-chain decrypt | `getDerivedKeys` → `bf_hmac_encryption::verify_derived_keys` → `decrypt` (HMAC-CTR only) | — | verified(docs) |

## Required fields

- `SealClient`: `suiClient` (any `ClientWithExtensions<{core}>`, gRPC OK), `serverConfigs[]` = `{objectId, weight, aggregatorUrl?, apiKeyName?, apiKey?}`, `verifyKeyServers?`, `timeout?`. verified(docs) `dist/types.d.mts`.
- `encrypt`: `threshold`, `packageId` (**the policy package**, not the Seal package), `id` (hex inner id), `data: Uint8Array`, optional `kemType`, `demType`, `aad`. verified(docs).
- `SessionKey.create`: `address`, `packageId`, `ttlMin`, `suiClient`, optional `signer`, `mvrName`. verified(docs).
- `decrypt`: `data`, `sessionKey`, `txBytes` (a transaction-kind-only PTB calling `seal_approve*`). verified(docs).

## Upgrade / version behaviour

- The Seal package upgrades in place (v1 → v6 on testnet). Key-server object types keep the original id. verified(live).
- "Both the SDK and the Key Server are configured to expect specific versions from each other. Either component can reject messages from outdated or deprecated counterparties." The SDK exposes `DeprecatedSDKVersionError` / `InvalidSDKVersionError`, so keep `@mysten/seal` current. verified(docs) index.md + SDK exports.
- Policy-package upgrades keep the identity namespace. An upgradeable policy package lets its owner change who can decrypt at any time. The docs recommend versioned shared objects. verified(docs).

## Failure modes

| Failure | Detail | Label |
|---|---|---|
| `NoAccessError` | `seal_approve` aborted on the key server's dry-run | verified(live) |
| `InvalidParameter` for fresh objects | the key server's fullnode has not indexed a just-created object yet. Retry after a few seconds | verified(docs) |
| Inconsistent answers across servers | each server dry-runs against its own fullnode view. Rapidly changing state causes splits (`InconsistentKeyServersError`, `toMajorityError`) | verified(docs) + SDK export names |
| Threshold unreachable | if too many of the servers chosen at encryption go offline, the data is **permanently undecryptable**. Testnet servers make no persistence promise | verified(docs) |
| Rate limiting | Open servers have a fixed source-based rate limit (`TooManyFailedFetchKeyRequestsError` exists) | verified(docs) |
| Expired session | `ExpiredSessionKeyError` after `ttlMin` | verified(docs) SDK export |
| Impersonated key server | anyone can create a `KeyServer` object with a known URL and their own pk. Use `verifyKeyServers:true`, or pin object IDs | verified(docs) |
| Wrong `packageId` in encrypt | the ciphertext is bound to that namespace. It is decryptable only through that package's `seal_approve*` | inferred from design |

## Limitations

- Client-side encryption only. Server-side encryption and DRM are listed as possible future features. (verified(docs))
- The server set is fixed per ciphertext. Use envelope encryption (Seal-encrypt a DEK) to allow rotation. (verified(docs))
- `seal_approve*` must be side-effect free, cannot compose with other PTB commands, and should not depend on `Random`. (verified(docs))
- Testnet servers make no persistence promises. Do not treat testnet ciphertext as durable. (verified(docs))
- A positive decrypt on testnet needs Kido to publish a policy package or create a policy object, which needs gas. Not run here.

## Common mistakes

- Passing the **Seal package id** as `packageId` in `encrypt`. It must be the **policy** package id.
- Passing the full identity (with the package prefix) to `seal_approve`. Pass only the inner id.
- Making `seal_approve` `public` or stateful. Use non-public `entry` and version shared objects.
- Building `txBytes` without `onlyTransactionKind: true`.
- Hard-coding key-server URLs instead of object IDs.
- Using `verifyKeyServers:true` on every call (latency). Verify at startup.
- On-chain decryption: accepting caller-supplied public keys. The docs warn that this lets the caller choose the plaintext. Pin the pks in the package.
- Assuming committee mode is testnet-only, or the reverse. The docs contradict each other (§3).
