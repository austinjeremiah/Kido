# ENS (Ethereum Name Service) — runtime facts (verified 2026-09-26)

Only facts TRACE verified are here. Knowing these facts never authorizes using this provider.

## Core concepts (ENSv2)

- **Hierarchical registries** (V-docs). `sub.alice.eth` is a chain Root → ETHRegistry → (alice's UserRegistry) → … linked by `subregistry` pointers. Each name entry holds `subregistry`, `resolver`, `expiry`, `eacVersionId`, `tokenVersionId`.
- **ERC1155Singleton tokens with mutable token IDs** (V-docs). The tokenId changes on every role grant or revoke and on re-registration. Never persist a tokenId as a stable identifier. Use the labelhash (anyId polymorphism) or the namehash.
- **Enhanced Access Control (EAC)** (V-docs). Roles are per resource. `ROOT_RESOURCE = 0` is contract-wide. There are 32 regular roles plus 32 admin roles, one nybble each, and at most 15 holders per role per resource. The admin role is `role << 128`. EAC replaces NameWrapper fuses, and revocation is reversible while an admin role is still held.
- **Per-account Permissioned Resolver** (V-docs). Each account deploys a UUPS proxy of `PermissionedResolverImpl` through the Verifiable Factory. Records are numbered bundles that names link to. Setters take the **DNS-encoded name (bytes)**, not a namehash.
- **Verifiable Factory** (V-docs). CREATE2 minimal proxies. `verifyContract(proxy)` returns the implementation, so the provenance of a resolver or registry is checkable on-chain. Verified live on two production resolvers (§7).
- **Grace period** (V-docs). 28 days (ENSv1: 90), followed by a 21-day decaying premium.

## Supported operations Kido would use

### 5.1 Register a `.eth` 2LD (ETHRegistrar `0xabe7…`)

1. `ETHRegistrar.isAvailable(label) → bool` (V-live: true for a fresh label).
2. `ETHRegistrar.getRegisterPrice(label, duration, paymentToken) → (base, premium)`.
   - V-live: a 5+ char label for 1y in MockUSDC costs `8000021` (8.000021 USDC, 6 dp). In MockDAI it costs `8000020944000000000`. For 28 days in MockUSDC it costs `613701`.
3. `paymentToken.approve(ETHRegistrar, base+premium)`.
4. `commitment = makeCommitment(label, owner, secret, subregistry, resolver, duration, referrer)`, then `commit(commitment)`.
5. Wait ≥ `MIN_COMMITMENT_AGE` = **60 s** (V-live). The commitment expires after `MAX_COMMITMENT_AGE` = **86400 s** (V-live).
6. `register(label, owner, secret, subregistry, resolver, duration, paymentToken, referrer) → tokenId`. The duration must be ≥ `MIN_REGISTER_DURATION` = **2419200 s (28 days)** (V-live).

The owner receives the fixed `REGISTRATION_ROLE_BITMAP` (V-docs): `ROLE_SET_SUBREGISTRY(+ADMIN) | ROLE_SET_RESOLVER(+ADMIN) | ROLE_CAN_TRANSFER_ADMIN`. The owner does **not** get `ROLE_UNREGISTER` or `ROLE_RENEW`. Anyone can `renew`. The constant is not exposed as a getter: `REGISTRATION_ROLE_BITMAP()` reverts (V-live).

Registrar selectors checked against `0x657e…`/`0xabe7…` bytecode in F-0300 (V-live).

### 5.2 Deploy a Permissioned Resolver (per account)

`VerifiableFactory(0x9e72…).deployProxy(PermissionedResolverImpl 0x14f0…, salt, initData)` (selectors present, V-live).

- `salt = uint256(keccak256(abi.encode(keccak256("OwnedResolver"), owner, version)))` (V-docs).
- `initData = initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)`. Selector `0x33cc44a0` is present in the current impl (V-live).
- `calls` run as a multicall with role checks skipped, so the initial `agent-context` records can be set in the deploy transaction (V-docs).
- Then call `ETHRegistry.setResolver(anyId, resolverProxy)`, which needs `ROLE_SET_RESOLVER` (V-docs; selector present, V-live).
- Alternatively, pass the resolver directly in `register(...)`.

### 5.3 Create a subname (`agent.kido-x.eth`)

1. Deploy a UserRegistry proxy: `deployProxy(UserRegistryImpl 0xa803…, salt, initialize((address,uint256)[] grants))`, with `salt = keccak256(abi.encode(keccak256("UserRegistry"), namehash(parent), version))` (V-docs; `initialize((address,uint256)[])` `0x37cb53a8` present, V-live).
2. `ETHRegistry.setSubregistry(parentLabelhash, userRegistry)`. The parent owner holds `ROLE_SET_SUBREGISTRY` (V-docs; selector present).
3. `userRegistry.setParent(ETHRegistry, "kido-x")`, which needs `ROLE_SET_PARENT` on root (V-docs; selector `0x5357263f` present).
4. `userRegistry.register(label, owner, subregistry, resolver, roleBitmap, expiry)` (`0x85f3e643` present, V-live).
   - The caller needs `ROLE_REGISTRAR` on the UserRegistry ROOT_RESOURCE.
   - `roleBitmap` is chosen by the parent. This is how Kido scopes what an agent subname owner can do.
   - Passing `owner = 0` reserves the name (V-docs).

Whether the subname expiry is capped by the parent's expiry: **U**.

### 5.4 Set ENSIP-26 text records

- `PermissionedResolver.setText(bytes dnsName, string key, string value)`, selector `0xc7279f88`, present (V-live).
- **The ENSv1 node-based `setText(bytes32,string,string)` (`0x10f13a8c`) is ABSENT from the current impl** (V-live). See F-0400.
- Keys (ENSIP-26, **Status: draft**, created 2025-05-17, V-docs):
  - `agent-context`: any format (text/MD/YAML/JSON), read via `text(bytes32,string)`.
  - `agent-endpoint[mcp]`, `agent-endpoint[a2a]`, `agent-endpoint[web]`: the value MUST be a valid URL (`https://`, `http://`, `ipfs://`). Additional protocol values MAY be used.
- Optional ENSIP-25 (**draft**, 2025-10-02): `agent-registration[<ERC-7930 registry addr hex>][<agentId>]` = `"1"` (non-empty).
- Batch the writes with `multicall(bytes[])` (`0xac9650d8` present).
- Reading: `UniversalResolver proxy 0xeEeE….resolve(dnsName, abi.encodeCall(text,(namehash,key))) → (bytes result, address resolver)`.
  - V-live example: `tokologies.eth` returns addr `0xdf94…b72e` and resolver `0x74ac…09Ac`.
  - An unset key returns an ABI-encoded empty string, not a revert (V-live).

### 5.5 Scoped record managers (EAC on the resolver)

Role values are V-docs; the selectors are V-live on impl `0x14f0…`.

| Role | Value | Scope |
|---|---|---|
| ROLE_SET_ADDRESS | 1<<0 | root or coinType |
| ROLE_SET_TEXT | 1<<4 | root or text key |
| ROLE_SET_CONTENTHASH | 1<<8 | root |
| ROLE_SET_ABI | 1<<12 | root or content type |
| ROLE_SET_INTERFACE | 1<<16 | root or interfaceId |
| ROLE_SET_NAME | 1<<20 | root |
| ROLE_SET_DATA | 1<<24 | root or data key |
| ROLE_LINK | 1<<28 | root |
| ROLE_CAN_NAME | 1<<120 | root |
| ROLE_UPGRADE | 1<<124 | root |

- **Grant one text key only:** `grantSetterRoles(encode(setText("0x", "agent-endpoint[mcp]", "")), manager)` (`0xccd3eaff`). The resource is `keccak256(bytes(key))`.
- **Grant all text keys:** `grantRootRoles(1<<4, manager)` (`0x072d5d77`).
- `grantRoles()` on the resolver is disabled and always reverts `EACCannotGrantRoles` (V-docs).
- **Key caveat (V-docs):** "There is no per-name scoping: a role holder can write the covered records on every name served by the resolver instance." To scope a manager to one agent name, give that agent name **its own resolver instance** (deploy with a different `version` salt or a different owner).

### 5.6 Registry roles relevant to Kido (Permissioned Registry, V-docs)

| Role | Value |
|---|---|
| ROLE_REGISTRAR | 1<<0 (root) |
| ROLE_REGISTER_RESERVED | 1<<4 |
| ROLE_SET_PARENT | 1<<8 |
| ROLE_UNREGISTER | 1<<12 |
| ROLE_RENEW | 1<<16 |
| ROLE_SET_SUBREGISTRY | 1<<20 |
| ROLE_SET_RESOLVER | 1<<24 |
| ROLE_CAN_TRANSFER_ADMIN | (1<<28)<<128 |
| ROLE_SET_URI | 1<<36 |
| ROLE_UPGRADE | 1<<124 |

- Admin roles on an individual name can only be granted at registration time. After that, only regular roles can be granted on a name.
- Each grant or revoke regenerates the tokenId.

### 5.7 Revocation options (identity / discovery only, never financial)

| Goal | Call | Effect |
|---|---|---|
| Remove a scoped text manager | `resolver.revokeRoles(keccak256(bytes(key)), 1<<4, manager)` | Immediate |
| Remove a resolver-wide manager | `resolver.revokeRootRoles(roleBitmap, manager)` | Immediate |
| Remove a delegated registry role (e.g. set-resolver) | `registry.revokeRoles(labelhash, role, account)` | Regenerates tokenId |
| Kill an agent subname | `userRegistry.unregister(anyId)` | Needs ROLE_UNREGISTER. Burns the token; expiry becomes `now`. |
| Blank the agent's records | `resolver.linkToRecord(dnsName, 0)` (needs ROLE_LINK), or `setText(name, "agent-context", "")` | Records are never deleted, only unlinked |
| Permanently lock a record type | revoke role + admin + ROLE_LINK(+admin) + ROLE_UPGRADE(+admin) from every holder | Irreversible (V-docs) |

## Required fields (Kido provider manifest)

- `chainId: 11155111`
- `ensVersion: "v2-beta"`
- `rootRegistry`, `ethRegistry`, `ethRegistrar`, `verifiableFactory`, `permissionedResolverImpl`, `userRegistryImpl`, `universalResolver` (the proxy `0xeEeE…EeEe`), `rentPriceOracle`, and `paymentToken` (MockUSDC `0x16f9…`)
- `abiSourceCommit: 71a3b733…`
- Per agent: `parentName`, `label`, `dnsName`, `namehash`, `labelhash`, `resolverInstance`, `records{agent-context, agent-endpoint[...]}`, `recordManagers[{account, scope: root|key, role}]`

## Upgrade / version behaviour

- The ENSv2 beta set has been **redeployed at least twice** since 2026-09-06 (F-0300). Treat addresses as mutable config and guard with a live check: `RootRegistry.getSubregistry("eth") == pinned ETHRegistry`.
- Resolver and UserRegistry instances are UUPS proxies. `ROLE_UPGRADE` on the instance root can change the implementation. Check provenance with `VerifiableFactory.verifyContract(proxy)` and compare the result with the pinned impl.
- The UR is behind the upgradable proxy `0xeEeE…`. Always call the proxy.
- ETHRegistrar governance is OpenZeppelin `Ownable`. The owner can `setRentPriceOracle` (V-docs). Prices are immutable per oracle.

## Failure modes

- UR `resolve` reverts `0x77209fe8` (resolver not found) for names under a superseded registry (V-live, F-0300).
- `register` reverts if the commitment is younger than 60 s or older than 24 h, if the name is unavailable, if the duration is < 28 d, or if the token allowance is insufficient.
- A setter without the role reverts `EACUnauthorizedAccountRoles` (V-docs).
- `grantRoles` on a resolver reverts `EACCannotGrantRoles`. `grantRoles`/`revokeRoles` with `ROOT_RESOURCE` revert; use the `*RootRoles` variants.
- A role can have at most 15 holders per resource.
- `safeTransferFrom` of a name reverts `TransferUnsafeUntilRegistryIsEmancipated` / `TransferUnsafeWithMultipleAssignees` if other accounts hold roles on it.
- `linkToNode` reverts `InvalidRecord` if the target has no record.
- An expired name: `ownerOf` returns 0 and `getResolver` returns 0, so resolution fails silently (returns empty). Monitor expiry.

## Limitations

- Beta: interfaces "may change prior to mainnet".
- The ENS docs page carries no version or date stamp.
- Only 15 holders per role per resource.
- There is no per-name scoping inside one resolver instance.
- ENSIP-25 and ENSIP-26 are **drafts**.
- The Alchemy free tier limits `eth_getLogs` to 10 blocks, so indexing needs a different RPC or the ENS subgraph.
- The ENSv2 app and the explorer are on `app.ens.dev` / `explorer.ens.dev`, not `sepolia.app.ens.domains` (V-docs links).

## Common mistakes

1. Pinning an older ENSv2 beta set (Kido today, F-0300).
2. Using the node-based setters `setText(bytes32,…)` / `setAddr(bytes32,…)` from old artifacts. The current resolver takes a DNS-encoded name (F-0400).
3. Paying with Aave test USDC `0x94a9…`, which is not a payment token.
4. Treating a tokenId as stable. It changes on every role change.
5. Calling UR V2 impl `0x5d25…` directly instead of proxy `0xeEeE…`.
6. Assuming a key-scoped text manager is also scoped to one name.
7. Using ENSv1 `ETHRegistrarController` (de-authorised).
8. Forgetting `setParent` on a subname registry, which breaks canonical-name lookup (UniversalHelper `findCanonicalName`).
9. Passing a full name instead of the label to `makeCommitment`/`register`.

## Kido adapter mapping

`EnsIdentityAdapter` (identity/discovery only, never a financial gate; bible §29.5, F-0301).

**Config:** the §6 fields plus a live guard (`RootRegistry.getSubregistry("eth") == ethRegistry`, and `verifyContract(resolver) == permissionedResolverImpl`).

**Operations:**

| Operation | Calls |
|---|---|
| `ensureParent(label)` | `isAvailable` → `getRegisterPrice` → MockUSDC `mint` + `approve` → `commit` → wait ≥ 60 s → `register` (with resolver = the owner's PermissionedResolver) |
| `ensureAgentSubname(parent, agentLabel, managerAccount)` | Deploy a UserRegistry (once per parent) → `setSubregistry` → `setParent` → `register(agentLabel, owner, 0, agentResolver, roleBitmap, expiry)`. Use a **dedicated resolver instance per agent** so record managers are name-scoped. |
| `publishAgentRecords(name, {context, endpoints})` | `multicall([setText(dns, "agent-context", …), setText(dns, "agent-endpoint[mcp]", …), …])` |
| `grantRecordManager(name, key \| all)` | `grantSetterRoles` / `grantRootRoles(1<<4)` |
| `revokeRecordManager(...)` | `revokeRoles(keccak(key), 1<<4, acct)` / `revokeRootRoles` |
| `resolveAgent(name)` | UR proxy `resolve(dns, text(node, "agent-context"))` plus each endpoint key |

**Evidence recorded:** tx hashes, the resolved values, the resolver address and `verifyContract` output, and the block number.

**Status mapping:** `ENS_ACTIVE` / `ENS_RECORDS_STALE` / `ENS_REVOKED` are shown independently from the Amane lease status.
