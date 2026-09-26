# SuiNS — runtime facts (verified 2026-09-26)

Only facts TRACE verified are here. Knowing these facts never authorizes using this provider.

## Core concepts

- **SuiNS shared object** (`suins::SuiNS`): the global object. It holds the registry, configs (as dynamic fields `ConfigKey<T>`), authorized apps (`AppKey<App>` → `true`) and collected balances. verified(live), dynamic-field listing.
- **Registry**: `Table<Domain, NameRecord>` (`registry` id `0xb120c0d5…56e4`) plus a reverse table `address → Domain` (`reverse_registry` id `0xcee9dbb0…e465`). verified(live).
- **NameRecord**: `nft_id`, `expiration_timestamp_ms`, `target_address: Option<address>`, `data: VecMap<String,String>`. There are also leaf records (`name_record::is_leaf_record`). verified(live), function list for `name_record`.
- **SuinsRegistration NFT** (`0x22fa…::suins_registration::SuinsRegistration`) is the capability for an SLD. `SubDomainRegistration` is the capability for node subnames. verified(live).
- **Target address vs default name**. The target address is forward resolution, and the NFT holder can set it to any address. The default name (reverse) can only be set by the target address itself, and it resets when the target changes. The docs say: "Do not use ownership of a SuiNS NFT as a resolution method… you should trust the default address over target address". verified(docs).
- **Apps / versioning**: registration, renewal, subnames and payments live in separately published "app" packages that the core authorizes. The docs say "The core package cannot change, nor can the core SuiNS object"; the secondary packages can be replaced. verified(docs).
- **Subnames**. Docs text: "Node subnames … have an NFT … Leaf subnames … do not have an NFT … the parent controls their configuration … typical use case for leaf subnames is to use them programmatically." Max nesting is 8 levels below the SLD (10 total). There is no fee. verified(docs). The live `SubDomainConfig` for `0x3c272…` is `max_depth 10, min_label_size 1, minimum_duration 86400000` (1 day). There is also a `subdomains::App` registry entry with `min_label_size 3`. verified(live).

## Supported operations Kido would use

| Operation | How | Label |
|---|---|---|
| Resolve name → address | `grpc.core.resolveNameServiceAddress({name})`. It returned `{"address":"0xee5ad470…e92e"}` for `demo.sui`. GraphQL: `{ address(name:"demo.sui"){ address } }` | verified(live) |
| Reverse lookup (default name) | `grpc.core.defaultNameServiceName({address})` returned `{"data":{"name":"demo.sui"}}`. GraphQL: `address(address:…){ defaultNameRecord{ domain } }` (this replaces the removed `defaultSuinsName`) | verified(live) |
| Full record | `suins.getNameRecord('demo.sui')` returned `{name, nftId:"0x3bffa338…08da", targetAddress:"0xee5ad470…e92e", expirationTimestampMs:1915955894212, data:{}}`. `walrus-vitwit.sui` returned `data.walrus_site_id` plus a `walrusSiteId` convenience field | verified(live) |
| Price lists | `getPriceList()` returned `{[3,3]:50000000,[4,4]:10000000,[5,63]:1000000}`. `getRenewalPriceList()` returned `{[3,3]:15000000,[4,4]:5000000,[5,63]:500000}`. Units are the base currency (TESTUSDC, 6 decimals). `calculatePrice({name:'kidoagent.sui',years:1})` returned `1000000` (1 TESTUSDC) | verified(live) |
| Coin discounts | `getCoinTypeDiscount()`: TESTUSDC 0, SUI 0, **TESTNS 25%** | verified(live) |
| Register | PTB: `payment::init_registration(&mut SuiNS, String) → PaymentIntent`, then `payments::handle_base_payment<USDC>` (base currency, no oracle) **or** `payments::handle_payment_pro<T>(…, &PriceInfoObject, user_price_guard)` (SUI/NS, needs Pyth), then `payment::register(Receipt, &mut SuiNS, &Clock, ctx) → SuinsRegistration`. SDK: `new SuinsTransaction(client, tx).register({domain, years, coinConfig, coin?, priceInfoObjectId?, maxAmount?})`. For years > 1 the SDK calls `renew` inside the same PTB | verified(live) signatures via GraphQL `module(name:"payment"/"payments"){functions}`; SDK source `dist/suins-transaction.mjs` |
| Set target address | `controller::set_target_address(&mut SuiNS, &SuinsRegistration, Option<address>, &Clock)`. SDK `setTargetAddress({nft, address, isSubname})`. For subnames the SDK routes to `subdomain_proxy::set_target_address` | verified(live) signature |
| Set default (reverse) | `controller::set_reverse_lookup(&mut SuiNS, String, &TxContext)`. The sender must equal the target. SDK `setDefault(name)`. Also `unset_reverse_lookup` and `set_object_reverse_lookup(&mut UID, String)` | verified(live) signature, verified(docs) sender rule |
| User data | `controller::set_user_data(&mut SuiNS, &SuinsRegistration, key, value, &Clock)` / `unset_user_data`. The SDK only allows the keys `avatar`, `content_hash`, `walrus_site_id` (`ALLOWED_METADATA`, it throws `Invalid key` otherwise) | verified(docs) SDK `constants.mjs` / `suins-transaction.mjs:348` |
| Create node subname | `subdomains::new(&mut SuiNS, &SuinsRegistration, &Clock, name, expiration_ms, allow_child_creation, allow_time_extension, ctx) → SubDomainRegistration` | verified(live) signature on `0x3c272…` |
| Create / remove leaf subname | `subdomains::new_leaf(&mut SuiNS, &SuinsRegistration, &Clock, name, target: address, ctx)` / `remove_leaf(…)`. If the parent is itself a subname, the SDK uses `subdomain_proxy::new_leaf` | verified(live) |
| Burn expired | `controller::burn_expired` / `burn_expired_subname` | verified(live) |

## Required fields

- Name: a full string including `.sui` (e.g. `kido-agent.sui`). The SDK normalizes names and validates them with `isValidSuiNSName`. Labels are 3 to 63 chars for SLDs (`CoreConfig.min_label_length 3`, `max_label_length 63`). verified(live).
- Years: 1 to 5 (`CoreConfig.max_years 5`; the SDK's `validateYears` enforces the same). verified(live)/verified(docs).
- `coinConfig` = `suinsClient.config.coins.{USDC|SUI|NS}` = `{type, feed}`. verified(docs).
- `coin`: a payment coin object for USDC/NS. For SUI the SDK can split from gas. `priceInfoObjectId` is required for SUI/NS. `maxAmount` is a slippage guard (u64, default MAX_U64). verified(docs).
- `SuiNS` object, `Clock` (`0x6`), and BBB vault (`0xa0b7a4dc…43e5`) as inputs. verified(live).

## Upgrade / version behaviour

- The core package upgrades in place (v1 to v5 on testnet). The type origin stays `0x22fa…`, so struct types are always `0x22fa…::…`. Call functions at the **latest** `0x40ee…`. verified(live).
- App packages are separate. The core authorizes and deauthorizes them via `AppKey<App>` dynamic fields. Several old subdomain lineages are still authorized: `0x5afdc6b0…bf54`, `0x7e00a6df…6391`, `0xb9ad120c…c32b`, plus `0x3c272…`. There is also an old payments lineage `0x9e8b8527…c10c` with its own `PaymentsConfig` (different SUI feed id `50c67b3f…`). The SDK uses `0xc391…`/`0x4f33…`. verified(live) dynamic-field listing.
- The docs say: "Always keep the dependency updated so you get the latest constants. If you do not, some of your transactions might fail to build". verified(docs) `/sdk`.
- `payments` exposes both `handle_payment` (legacy Pyth `0xabf837e9…` PriceInfoObject) and `handle_payment_pro` (Pyth Pro `0xd1ac23e1…`). The SDK uses the `_pro` variants. verified(live) signatures + SDK source.

## Failure modes

| Failure | Observed / expected | Label |
|---|---|---|
| `SuinsClient.getNameRecord` for a non-existent name **throws** `Object 0x… not found` instead of returning `null`, even though the typed return is `NameRecord \| null` | observed for `zz-kido-nonexistent-xyz.sui` | verified(live) |
| GraphQL `nameRecord{ contents{ json } }` returns `INTERNAL_SERVER_ERROR "Unexpected type"`. `domain`/`target` still work | observed for `sui.sui`, `demo.sui` | verified(live) |
| Public JSON-RPC `suix_resolveNameServiceAddress` is dead | the baseline found JSON-RPC shut down on public fullnodes; the docs say to migrate | verified(docs) + baseline |
| SUI/NS registration without `pythAccessToken` → SDK throws "A `pythAccessToken` is required…" | SDK source `suins-client.mjs:189` | verified(docs) |
| Stale Pyth price (> `max_age` 60 s) → payment aborts | inferred from `PaymentsConfig.max_age` | inferred |
| `setDefault` from an address that is not the target → abort | docs | verified(docs) |
| Expired name: record exists but `has_expired`. Past grace → can be re-registered / burned | `name_record::has_expired`, `has_expired_past_grace_period` | verified(live) function list; grace length unverified |
| Leaf subname target cannot be empty. Node subname target can | docs table | verified(docs) |
| `setUserData` with a key other than avatar/content_hash/walrus_site_id → SDK throws `Invalid key` | SDK | verified(docs) |

## Limitations

- Only 3 user-data keys are sanctioned by the SDK. Arbitrary text records (like ENS `text()`) are not supported via the SDK. (verified(docs))
- There is no native "agent-registration"/ENSIP-25-style record. Kido identity data would have to live elsewhere (e.g. a Walrus site / object referenced by `walrus_site_id`, or a Kido Move object). (inferred)
- Queries such as "all names pointing to address X" or "all subnames of X" need the suins-indexer, not RPC. (verified(docs))
- Registering a name through the SDK with SUI needs a Pyth access token (see §8).

## Common mistakes

- Using the v1 address `0x22fa…` for calls. Call `0x40ee…` (latest). Use `0x22fa…` only for types.
- Querying GraphQL `package(address:"0x22fa…")` without `version:` returns the **latest** (v5) package, not v1. Pass `version:N` to inspect a specific version. (verified(live))
- Assuming the subnames proxy constant is latest. The SDK and docs pin `0x295a…` (v1), and on-chain latest is `0xf0c1…` (v2). v1 still exposes the functions the SDK calls, so SDK calls should work (inferred). Leaf-metadata functions exist only on v2.
- Treating price-list numbers as SUI MIST. They are USDC 6-decimal units.
- Trusting forward resolution for identity display instead of reverse (`defaultNameRecord`).
- Expecting `getNameRecord` to return `null` for missing names (it throws).
- Using `@mysten/sui/jsonRpc` + `getJsonRpcFullnodeUrl` (the SDK JSDoc still shows it; the public endpoint is dead).
