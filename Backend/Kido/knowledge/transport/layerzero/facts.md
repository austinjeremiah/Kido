# LayerZero — runtime facts (verified 2026-09-26)

Only facts TRACE verified are here. Knowing these facts never authorizes using this provider.

## Core concepts

- **EndpointV2** (immutable per chain): `send` (assigns nonce, calls the send library), `verify`/`commit` (from the receive library), `lzReceive` delivery to the OApp, and `clear`/`skip`/`nilify`/`burn` for stuck messages (V(docs) general V2 design. The Sui endpoint package has modules `endpoint_send`, `lz_receive`, `lz_compose`, `messaging_channel`, `oapp_registry`, V(live)).
- **Message library ULN302**: SendUln302 / ReceiveUln302 enforce the **Security Stack**, an X-of-Y-of-N DVN config per pathway: "every required DVN must verify the payloadHash" (V(docs)).
- **DVNs** (Decentralized Verifier Networks) attest `payloadHash` after N block confirmations. The **Executor** is permissionless delivery. It "does not participate in security verification" (V(docs)).
- **OApp / OFT**: application contracts. OFT = burn/mint or lock (Adapter) token with **shared decimals (default 6)** and dust removal (V(docs)).
- **Defaults**: "Defaults are placeholder configurations — they may be Dead DVNs that prevent message delivery, may include only a single DVN, and may change without notice." (V(docs) security-stack page).
- **Sui specifics**: no dynamic dispatch. An OApp registers with the shared `EndpointV2`, holds a `CallCap`, and uses **PTB builders** (`EndpointPtbBuilder`, `Uln302PtbBuilder`) to assemble the multi-call PTB for send/receive (V(docs) overview. Objects V(live) §6).

## Required fields

- `SendParam { dstEid: uint32 (40378 / 40161), to: bytes32 (Sui address or EVM address left-padded), amountLD, minAmountLD, extraOptions: bytes (type-3 options, e.g. lzReceive gas), composeMsg: bytes, oftCmd: bytes }` (V(docs) Sui OFT page).
- `MessagingFee { nativeFee, lzTokenFee }` from `quoteSend`. `refundAddress` (V(docs)/I).
- Peer: `setPeer(eid, bytes32 peer)` on both sides. On Sui the peer is the OApp identifier (I: exact Sui peer format, whether package or OApp object address, is U).
- Sui init: `OFTInitTicket` (created at OFT publish) plus `TreasuryCap<T>` (mint/burn) or none (adapter) (V(docs)).

## Upgrade / version behaviour

- EVM EndpointV2 and ULN302 are immutable contracts. New libraries are added by registering new message libs, and **defaults can be changed by LayerZero**. An OApp that relies on defaults inherits those changes (V(docs) quote §4).
- Sui: the LZ packages checked show `packageVersionsAfter` empty (v1) (V(live)). The OFT object has `upgrade_version: 1` (V(live)). OFT packages are owned by the deployer and upgradeable by their UpgradeCap holder (I).
- SDK: `lz-sui-sdk-v2` is pinned to the Sui TS SDK v1 line, while Kido is on v2.33.1. Expect a major-version clash (I from package.json).

## Failure modes

- **Transport**: `lz-sui-sdk-v2`/`lz-sui-oft-sdk-v2` expect a v1 `SuiClient` (JSON-RPC). Public Sui JSON-RPC is shut down (TRACE baseline §1), so these SDKs need a third-party JSON-RPC provider or a hand-written gRPC PTB path (V(live) package inspection. Runtime failure I).
- Dead DVN / blocked library on an unconfigured pathway, which means the message is never verified (V(docs)).
- Insufficient `extraOptions` gas, so `lzReceive` fails at the destination and must be retried or cleared (V(docs)/I).
- Shared decimals: amounts below `10^(localDecimals-6)` are removed as dust. The Sui `u64` cap means you should avoid 18 local decimals on Sui (V(docs)).
- OFT rate limit or pause on Sui OFT (both optional features) (V(docs)).
- Nonce ordering: a stuck earlier nonce blocks later ones until cleared/skipped (I, standard V2 ordered delivery).

## Limitations

- No canonical token route: Kido must deploy and operate the OFTs on both chains.
- Sui TS SDK is on `@mysten/sui` v1 and JSON-RPC based (V(live)).
- Testnet defaults are a single DVN and are not production-representative (V(live)).
- Sui u64 balances (V(docs)).

## Common mistakes

- Using the Sui **package** ID `0xabf96294…` where the **shared EndpointV2 object** `0x2b96537c…` is required, and vice versa.
- Using EID values as EVM chain IDs (40161 ≠ 11155111), or mainnet EIDs (30xxx) on testnet.
- Relying on default config in production. Explicitly `setConfig` DVNs and confirmations on both sides.
- Installing `lz-sui-sdk-v2` next to `@mysten/sui@2.x` without isolating it, which gives two incompatible `Transaction` classes (I).
- Mixing `lz-definitions` 3.1.x with 3.0.168 packages without checking the enum/EID tables (I).
- Using the older deprecated Sui LayerZero Labs DVN ids (three are flagged `deprecated:true` in metadata).
