# Wormhole — runtime facts (verified 2026-09-26)

Only facts TRACE verified are here. Knowing these facts never authorizes using this provider.

## Core concepts

- **Core contract** (V(docs)): emits messages (`publishMessage` on EVM, `publish_message` on Sui). Each message carries (emitterChain, emitterAddress, sequence, consistencyLevel, payload).
- **Guardians** sign a message's body digest. The signed result is a **VAA**. A VAA is valid when signed by a quorum (2/3+1) of the current guardian set.
- **Token Bridge / WTT**: lock-and-mint. The source chain locks native tokens (or burns wrapped ones) and emits a transfer VAA (payload 1 = Transfer, 3 = TransferWithPayload, 2 = AttestMeta). The destination verifies the VAA and releases native tokens or mints the **wrapped** representation. A token must be **attested** (payload 2, `create_wrapped` on Sui) before its first transfer to a chain.
- **NTT**: the issuer deploys its **own** NTT Manager plus Transceiver per chain, in burning or locking (hub-and-spoke) mode. It moves the issuer's canonical token instead of a Wormhole-wrapped one, with per-chain rate limits. There is **no shared public NTT deployment to "use"**. Kido has to deploy one (V(docs), deploy-to-sui guide).
- **Executor**: permissionless relaying. It takes a signed quote from a relay provider and delivers VAAs on the destination (request prefixes: ERV1 = VAA v1, ERN1 = NTT, ERC1/ERC2 = CCTP v1/v2) (I from prefix naming plus V(live) capabilities).
- **Sui specifics** (V(live)): state lives in **shared `State` objects**. The callable package ID is **not** fixed. It is read from the `package_utils::CurrentPackage` dynamic field of the State object (the SDK does this in `sdk-sui/utils.js getPackageId`).

## Required fields (token transfer)

- Source: `token` (EVM address / Sui coin type), `amount` (u256 EVM, u64 Sui, **normalized to 8 decimals by the token bridge**, so dust below 1e-8 is dropped), `recipientChain` (u16 = 21 / 10002), `recipient` (bytes32: Sui address or object id, or left-padded EVM address), `arbiterFee` (relayer fee, 0 for manual), `nonce` (u32), `payload` (bytes, for TransferWithPayload only). Plus `msg.value = messageFee()` (0 now). V(docs)/I (standard ABI; `normalized_amount` module exists on Sui, V(live)).
- VAA lookup key: `(emitterChain, emitterAddress32, sequence)`. The sequence comes from the `LogMessagePublished` event on Sepolia or `WormholeMessage` on Sui. V(docs)/V(live) API path.
- Sui redeem: VAA bytes, core State `0x31358d…d790`, token-bridge State `0x6fb10c…d6da`, `0x6` Clock, the coin type T (for a wrapped Sepolia asset T is the Sui wrapped coin type, which is created by `create_wrapped` after attestation).

## Upgrade / version behaviour

- Sui (V(live)): packages are upgraded by governance VAA, which moves `CurrentPackage` (core v1→v3, TB v1→v12 on testnet). `version_control` gates old packages, so **calls into a stale package ID abort** (I, standard Wormhole Sui design: `package_utils::assert_package_upgrade_only`/version check). Resolve the current package from the State at runtime or pin and re-verify it. Type origins (`0xf47329…`, `0x562760…`) never change, so wrapped coin **types** stay stable across upgrades.
- EVM (V(live)): proxies. Implementations can change by governance VAA. Pin proxy addresses, not implementations.
- SDK: `sdk-*` 6.x vs NTT 8.x are versioned separately. NTT pins exact core versions.

## Failure modes

- VAA not yet signed (finality wait on Sepolia is roughly 13–20 min for 72 blocks / finalized) (I). Wormholescan returns 404 or empty until the guardian signs.
- Single testnet guardian down means **no VAAs at all**. There is no redundancy on testnet (V(live) set size 1).
- Redeem aborts: VAA already consumed (replay), token not attested / wrapped type missing, wrong package ID after an upgrade, bridge paused (a `pause` module exists on the testnet TB), guardian set expired (`seconds_to_live 86400` for old sets) (I from module names).
- Amount truncation to 8 decimals. `u64` overflow on Sui for large 18-decimal EVM amounts (I).
- Wrong asset: the Sepolia TB `WETH()` is `0xeef12A83…5D9c`, which is **not** Uniswap WETH9 `0xfFf99767…` nor Aave WETH `0xC558DB…` (V(live)).
- Coins delivered to a Sui **object ID** recipient land as `Receiving<T>` objects owned by that object. The Amane account needs an explicit `public_receive` deposit function (bible §15.6) (I).
- Old tooling: `sui 1.50.1` CLI speaks JSON-RPC, which is dead (B-0100). NTT CLI Sui deploy shells out to `sui move build` and governance uses `sui client chain-identifier` (V(live) gh source grep).

## Limitations

- Testnet has **one guardian**, so it is not representative of mainnet security or latency (V(live)).
- No generic Wormhole Relayer on Sui. Automatic delivery has to go through the Executor (V(docs)/V(live)).
- NTT needs Kido to own and deploy managers on both chains, move the TreasuryCap (burning mode), and accept frozen metadata afterwards: "Once the treasury-cap object is moved to the NTT manager, you will no longer be able to modify the token's metadata" (V(docs) deploy-to-sui).
- NTT on Sui requires a legacy `CoinMetadata` coin (`coin::create_currency`) (V(docs)). This matches bible §15.6.
- CCTP V1 is being deprecated, and CCTP V2 does not exist on Sui yet (V(docs) Circle).

## Common mistakes

- Using the Sui **State object ID** as a package ID, or the **original** package ID for calls. Calls need the `CurrentPackage` (core `0x21473617…`, TB `0xad5d68fb…`). Types use the originals (`0xf47329…`, `0x562760…`).
- Installing `@wormhole-foundation/sdk@6.1.5` alongside `sdk-*-ntt@8.0.1`: NTT peers want **exactly 6.1.4**, which causes npm ERESOLVE or duplicate module instances (`instanceof`/registry mismatches). Pin all `sdk-*` to 6.1.4 when using NTT, or use overrides (V(live) `npm view … peerDependencies`; the consequence is I).
- Assuming "USDC" via the token bridge is Circle USDC. It becomes a Wormhole-wrapped USDC on Sui (I).
- Using the Wormhole Relayer / "automatic CCTP" route to Sui. It does not exist.
- Treating the bible's "Wormhole bridge" as one thing: WTT, NTT, Executor and CCTP have different trust and ownership models.
- Relying on Sui JSON-RPC clients (`@mysten/sui/jsonRpc`, sui CLI 1.50.1).
