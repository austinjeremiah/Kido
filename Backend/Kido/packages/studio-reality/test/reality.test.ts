import { describe, expect, it } from "vitest";
import {
  RPC_READ_METHODS, RPC_FORBIDDEN_METHODS, FORBIDDEN_RPC_NAMESPACES, RPC_FENCE_REASONS,
  assertRpcMethodAllowed, assertNoSignerCredential, assertReadSourceAllowed,
  RpcFenceError, FORBIDDEN_PROVIDER_MEMBERS, ReadSourceEndpointSchema, SIGNER_CREDENTIAL_FIELDS,
  FencedJsonRpcProvider, corroborateBlockNumber,
  MarketSnapshotSchema, ObservationSchema, SnapshotSourceSchema, sealSnapshot, computeSnapshotHash,
  verifySnapshotHash, correctSnapshot, snapshotState, assertSnapshotUsable, SnapshotError,
  SNAPSHOT_REASONS, SNAPSHOT_SCHEMA_VERSION, HASHED_FIELDS, UNHASHED_FIELDS, computeCoherence,
  canonicalAssets, resolveAsset, assertAssetIdentity, mapAssetToChain, assertAddressBelongsToChain,
  AssetIdentityError, ASSET_REASONS,
  selectSource, selectFrom, marketSources, sourceById, SourceError, SOURCE_REASONS, assertNoSilentMigration,
  compareReadings, assertFallbackAuthorized, deprecationWarning, DATA_SOURCE_DEPRECATION_WARNING,
  stalenessThresholdMs, sourceAgeLimits, sourceVerificationAgeDays,
  pinBlock, resolveBlockForTimestamp, planReplaySources, assertSourcePinnable, markNonHistorical,
  replaysAgree, ReplayError, REPLAY_REASONS, CURATED_EVENTS,
  auditRealityEvaluation, assertAuditable, AUDIT_QUESTIONS, AuditabilityError,
} from "../src/index.js";
import { lookupNetwork, executionNetworks, readOnlySources, NETWORK_ROLES } from "@contextlock/studio-network";
import * as assetsModule from "../src/assets.js";
import * as realityIndex from "../src/index.js";
import {
  snapshotInput, priceObservation, rateObservation, feedSource, rpcSource, FakeChainProvider,
  REAL_ANCHOR, WETH_MAINNET, USDC_MAINNET, USDC_SEPOLIA, sourceLines, isComment,
} from "./fixtures.js";

/**
 * The Reality Engine.
 *
 * The standing rule from FND-V2-25-002 governs every multi-guard function below: **a fixture that
 * trips two independent guards proves neither guard.** Where a function has N guards there are N
 * tests, each differing from a valid input in exactly one way.
 */

const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};

/* ═════════════════════════ REALITY-001 … 003 : the snapshot ═════════════════════════ */

describe("REALITY-001 the MarketSnapshot schema", () => {
  it("REALITY-001 a sealed snapshot validates, and carries every field the audit needs", () => {
    const s = sealSnapshot(snapshotInput());
    expect(MarketSnapshotSchema.safeParse(s).success).toBe(true);
    expect(s.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(s.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(s.anchorBlock).toBe(REAL_ANCHOR.number.toString());
    expect(s.canonicalAssetIds).toEqual(["weth"]);
  });

  it("REALITY-001b an observation keeps its value exact, as a string with an exponent", () => {
    // A price with eight decimals does not survive a double. The schema refuses a float outright.
    expect(ObservationSchema.safeParse({ ...priceObservation(), value: 2434.42 as never }).success).toBe(false);
    expect(ObservationSchema.safeParse({ ...priceObservation(), value: "243442066354" }).success).toBe(true);
    const s = sealSnapshot(snapshotInput());
    expect(s.observations[0]?.value).toBe("243442066354");
    expect(s.observations[0]?.decimals).toBe(8);
  });

  it("REALITY-001c a snapshot is frozen, and a correction produces a new one", () => {
    const s = sealSnapshot(snapshotInput());
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.observations)).toBe(true);
    expect(() => { (s as { snapshotId: string }).snapshotId = "tampered"; }).toThrow(TypeError);
    expect(() => { (s.observations as MarketObservationArray).push(rateObservation()); }).toThrow(TypeError);

    const corrected = correctSnapshot(s, { observations: [priceObservation({ value: "1" })] }, "snap-test-2");
    expect(corrected.supersedes).toBe("snap-test-1");
    expect(corrected.snapshotHash).not.toBe(s.snapshotHash);
    // The original is untouched, which is the entire point.
    expect(s.snapshotHash).toBe(sealSnapshot(snapshotInput()).snapshotHash);
  });

  it("REALITY-001d a snapshot with no source does not validate", () => {
    expect(() => sealSnapshot(snapshotInput({ sources: [] }))).toThrow();
  });
});

type MarketObservationArray = Array<ReturnType<typeof priceObservation>>;

describe("REALITY-002 the snapshot hash is deterministic", () => {
  it("REALITY-002 the same content hashes the same, twice", () => {
    expect(sealSnapshot(snapshotInput()).snapshotHash).toBe(sealSnapshot(snapshotInput()).snapshotHash);
  });

  it("REALITY-002b field order and array order do not change the hash", () => {
    /*
     * Canonical serialization exists for this: two structurally identical snapshots built by
     * different code paths must agree, or the hash measures how the object was constructed.
     */
    const a = sealSnapshot(snapshotInput());
    const b = sealSnapshot(snapshotInput({
      sources: [rpcSource(), feedSource()],
      observations: [rateObservation(), priceObservation()],
    }));
    expect(b.snapshotHash).toBe(a.snapshotHash);
  });

  it("REALITY-002c the recorded hash matches the content, and tampering is detected", () => {
    const s = sealSnapshot(snapshotInput());
    expect(() => verifySnapshotHash(s)).not.toThrow();
    const tampered = { ...s, observations: [priceObservation({ value: "999" }), rateObservation()] };
    expect(reasonOf(() => verifySnapshotHash(tampered))).toBe(SNAPSHOT_REASONS.HASH_MISMATCH);
  });
});

describe("REALITY-003 a security-relevant change alters the hash", () => {
  const base = sealSnapshot(snapshotInput());

  /*
   * §P27.8 names seven things that must change the hash. Each gets its own case, each differing
   * from the base in exactly one field — a fixture that changed several would prove only that
   * *something* is hashed.
   */
  const cases: Array<[string, ReturnType<typeof snapshotInput>]> = [
    ["price", snapshotInput({ observations: [priceObservation({ value: "243442066355" }), rateObservation()] })],
    ["block", snapshotInput({ observations: [priceObservation({ blockNumber: "25948177" }), rateObservation()] })],
    ["source", snapshotInput({ observations: [priceObservation({ sourceId: "somewhere-else" }), rateObservation()] })],
    ["trust class", snapshotInput({ observations: [priceObservation({ trustClass: "EXTERNAL_API" }), rateObservation()] })],
    ["asset identity", snapshotInput({ observations: [priceObservation({ canonicalAssetId: "usdc" }), rateObservation()] })],
    ["timestamp", snapshotInput({ observations: [priceObservation({ sourceTimestampMs: 1789057584000 }), rateObservation()] })],
    ["adapter version", snapshotInput({ observations: [priceObservation({ adapterVersion: "1.0.1" }), rateObservation()] })],
    ["anchor block", snapshotInput({ anchorBlock: "25948177" })],
    ["anchor block hash", snapshotInput({ anchorBlockHash: `0x${"9".repeat(64)}` })],
    ["mode", snapshotInput({ mode: "HISTORICAL_REPLAY" })],
    ["source trust", snapshotInput({ sources: [feedSource({ trustClass: "EXTERNAL_API" }), rpcSource()] })],
    ["source health", snapshotInput({ sources: [feedSource({ healthy: false }), rpcSource()] })],
  ];

  for (const [what, input] of cases) {
    it(`REALITY-003 changing the ${what} changes the hash`, () => {
      expect(sealSnapshot(input).snapshotHash).not.toBe(base.snapshotHash);
    });
  }

  it("REALITY-003c every schema field is either hashed or documented as unhashed", () => {
    /*
     * The bug this catches: a field added to the schema and not added to the hash list is silently
     * outside the hash. Comparing the two lists turns "remember to update the hash" into a test
     * failure rather than a convention.
     */
    const obsKeys = Object.keys(ObservationSchema.shape).sort();
    expect([...HASHED_FIELDS.observation].sort()).toEqual(obsKeys);

    const srcKeys = Object.keys(SnapshotSourceSchema.shape).sort();
    const accountedFor = [...HASHED_FIELDS.source, ...UNHASHED_FIELDS.source].sort();
    expect(accountedFor).toEqual(srcKeys);
  });

  it("REALITY-003d a purely cosmetic change does not change the hash", () => {
    // `detail` is prose a provider may reword. If it were hashed, a reworded string would look like
    // a changed measurement, and every real change would be one more thing nobody looks at.
    const a = sealSnapshot(snapshotInput());
    const b = sealSnapshot(snapshotInput({ sources: [feedSource({ detail: "reworded" }), rpcSource()] }));
    expect(b.snapshotHash).toBe(a.snapshotHash);
  });
});

/* ═════════════════════════ REALITY-004 … 009 : the RPC boundary ═════════════════════════ */

describe("REALITY-004 mainnet reads are accepted", () => {
  it("REALITY-004 every read method on the allowlist passes the fence", () => {
    for (const m of RPC_READ_METHODS) expect(() => assertRpcMethodAllowed(m), m).not.toThrow();
    expect(RPC_READ_METHODS).toContain("eth_call");
    expect(RPC_READ_METHODS).toContain("eth_getLogs");
    expect(RPC_READ_METHODS).toContain("eth_getStorageAt");
  });

  it("REALITY-004b a read provider for mainnet is constructible, and reads", async () => {
    const p = new FakeChainProvider({ chainId: 1, head: 25948176n });
    expect(await p.getBlockNumber()).toBe(25948176n);
    expect((await p.getBlock(25948176n)).number).toBe(25948176n);
  });

  it("REALITY-004c two providers are corroborated rather than trusted individually", async () => {
    const a = new FakeChainProvider({ providerId: "a", head: 100n });
    const b = new FakeChainProvider({ providerId: "b", head: 103n });
    const out = await corroborateBlockNumber([a, b]);
    // The lowest reading is the conservative anchor: every provider has at least that block.
    expect(out.agreed).toBe(100n);
    expect(out.maxSkew).toBe(3n);
    expect(out.readings.map((r) => r.providerId)).toEqual(["a", "b"]);
  });

  it("REALITY-004d one provider failing does not lose the other's answer", async () => {
    const good = new FakeChainProvider({ providerId: "good", head: 50n });
    const bad = { ...new FakeChainProvider({ providerId: "bad" }), getBlockNumber: async () => { throw new Error("down"); } } as unknown as FakeChainProvider;
    const out = await corroborateBlockNumber([good, bad]);
    expect(out.agreed).toBe(50n);
    expect(out.readings.find((r) => r.providerId === "bad")?.error).toBe("down");
  });
});

describe("REALITY-005 write methods are rejected", () => {
  it("REALITY-005 every named write and signing method is refused", () => {
    for (const m of RPC_FORBIDDEN_METHODS) {
      const reason = reasonOf(() => assertRpcMethodAllowed(m));
      expect([RPC_FENCE_REASONS.WRITE_METHOD, RPC_FENCE_REASONS.SIGNING_METHOD], m).toContain(reason);
    }
  });

  it("REALITY-005b the specific methods §P27.4 names are refused by name", () => {
    for (const m of ["eth_sendTransaction", "eth_sendRawTransaction", "eth_sign", "eth_signTransaction", "eth_accounts"]) {
      expect(() => assertRpcMethodAllowed(m), m).toThrow(RpcFenceError);
    }
    for (const m of ["personal_sign", "personal_sendTransaction", "wallet_switchEthereumChain", "wallet_sendTransaction"]) {
      expect(() => assertRpcMethodAllowed(m), m).toThrow(RpcFenceError);
    }
  });

  it("REALITY-005c the explicit deny survives the method being added to the read allowlist", () => {
    /*
     * The two guards are independent and this exercises the FIRST alone. The mandatory mutation
     * "add eth_sendRawTransaction to the read allowlist" is caught here, because the forbidden-name
     * check runs before the allowlist is consulted.
     */
    const forbidden = new Set<string>(RPC_FORBIDDEN_METHODS);
    for (const m of RPC_READ_METHODS) {
      expect(forbidden.has(m), `${m} is on both lists, which would make the ordering matter`).toBe(false);
    }
    expect(reasonOf(() => assertRpcMethodAllowed("eth_sendRawTransaction"))).toBe(RPC_FENCE_REASONS.WRITE_METHOD);
  });

  it("REALITY-005d a whole namespace is refused, not only the methods we listed", () => {
    for (const ns of FORBIDDEN_RPC_NAMESPACES) {
      expect(() => assertRpcMethodAllowed(`${ns}somethingNobodyHasWrittenYet`), ns).toThrow(RpcFenceError);
    }
  });

  it("REALITY-005e case variations do not slip through", () => {
    for (const m of ["ETH_SENDRAWTRANSACTION", "Personal_Sign", "WALLET_sendTransaction"]) {
      expect(() => assertRpcMethodAllowed(m), m).toThrow(RpcFenceError);
    }
  });
});

describe("REALITY-006 an unknown RPC method is rejected", () => {
  it("REALITY-006 default deny", () => {
    /*
     * The second guard alone: a method that is on no list at all. An allowlist is used rather than
     * a deny-list because the set of RPC methods is open — every provider adds namespaces, and a
     * deny-list is a promise to have anticipated all of them.
     */
    for (const m of ["eth_someFutureMethod", "alchemy_getAssetTransfers", "trace_call", "flashbots_sendBundle", ""]) {
      expect(reasonOf(() => assertRpcMethodAllowed(m)), m).toBe(RPC_FENCE_REASONS.UNKNOWN_METHOD);
    }
  });

  it("REALITY-006b the fence is on the transport, so bypassing the typed interface still hits it", async () => {
    let sent: string | null = null;
    const fetchFn = (async (_u: string, init: { body: string }) => {
      sent = JSON.parse(init.body).method;
      return { ok: true, status: 200, json: async () => ({ result: "0x1" }) };
    }) as never;
    const p = new FencedJsonRpcProvider(ReadSourceEndpointSchema.parse({ chainId: 1, providerId: "t", url: "https://example.org" }), { fetchFn });

    // `request` is public on purpose: a caller reaching past the wrappers gets the fence rather
    // than being pushed to build their own transport.
    await expect(p.request("eth_sendRawTransaction", ["0xdeadbeef"])).rejects.toThrow(RpcFenceError);
    expect(sent, "nothing must reach the wire").toBeNull();

    await p.request("eth_blockNumber");
    expect(sent).toBe("eth_blockNumber");
  });
});

describe("REALITY-007 signer methods are absent from the type", () => {
  it("REALITY-007 no write member exists on a read provider instance", () => {
    /*
     * §P27.3 asks for absence rather than presence-and-throw. This enumerates the instance's own
     * members and its prototype's, so a method added later is caught even if nothing calls it.
     */
    const p = new FencedJsonRpcProvider(
      ReadSourceEndpointSchema.parse({ chainId: 1, providerId: "t", url: "https://example.org" }),
      { fetchFn: (async () => ({ ok: true, status: 200, json: async () => ({ result: "0x1" }) })) as never },
    );
    const members = new Set([...Object.keys(p), ...Object.getOwnPropertyNames(Object.getPrototypeOf(p))]);
    for (const forbidden of FORBIDDEN_PROVIDER_MEMBERS) {
      expect(members.has(forbidden), `a read provider must not have a "${forbidden}" member`).toBe(false);
    }

    /*
     * The list is also checked for its own contents.
     *
     * Without this, the loop above uses `FORBIDDEN_PROVIDER_MEMBERS` as its own oracle: deleting
     * entries makes it check fewer things and still pass. A mutation that removed
     * `sendTransaction` and `sendRawTransaction` from the list escaped the entire suite, which made
     * the list — not the provider — the thing under test.
     */
    for (const required of ["sendTransaction", "sendRawTransaction", "writeContract", "signMessage", "account", "privateKey"]) {
      expect(FORBIDDEN_PROVIDER_MEMBERS as readonly string[], `"${required}" must stay on the forbidden list`).toContain(required);
    }
    expect(FORBIDDEN_PROVIDER_MEMBERS.length).toBeGreaterThanOrEqual(14);
  });

  it("REALITY-007b the Reality Engine exports nothing that signs or sends", () => {
    const exported = Object.keys(realityIndex);
    const dangerous = exported.filter((k) => /^(sign|send|broadcast|deploy|write)[A-Z]/.test(k) || /WalletClient$/.test(k));
    // `submitToPublicMainnet` is the deliberate exception: it exists to throw, so §P27.36's test
    // has something to call. Anything else matching would be a real capability.
    expect(dangerous).toEqual([]);
    expect(exported).toContain("submitToPublicMainnet");
  });
});

describe("REALITY-008 a mainnet credential is absent", () => {
  it("REALITY-008 an endpoint config carrying a private key is refused", () => {
    expect(reasonOf(() => assertNoSignerCredential(
      { chainId: 1, url: "https://example.org", privateKey: `0x${"11".repeat(32)}` },
      "read source",
    ))).toBe(RPC_FENCE_REASONS.CREDENTIAL_PRESENT);
  });

  it("REALITY-008b guard one alone: a credential-shaped FIELD NAME with a harmless value", () => {
    // The value is not key-shaped, so only the field-name guard can fire.
    expect(reasonOf(() => assertNoSignerCredential({ chainId: 1, mnemonic: "not actually a mnemonic" }, "read source")))
      .toBe(RPC_FENCE_REASONS.CREDENTIAL_PRESENT);
    for (const field of SIGNER_CREDENTIAL_FIELDS) {
      expect(() => assertNoSignerCredential({ [field]: "x" }, "read source"), field).toThrow(RpcFenceError);
    }
  });

  it("REALITY-008c guard two alone: a key-shaped VALUE under an innocuous field name", () => {
    /*
     * The realistic accident: a whole deployment config passed where an endpoint was expected, with
     * the key under a name nobody thought to list. The shape catches what the name misses.
     */
    expect(reasonOf(() => assertNoSignerCredential({ chainId: 1, notes: `0x${"ab".repeat(32)}` }, "read source")))
      .toBe(RPC_FENCE_REASONS.CREDENTIAL_PRESENT);
  });

  it("REALITY-008d nesting does not hide a credential", () => {
    expect(() => assertNoSignerCredential({ a: { b: [{ c: { privateKey: "x" } }] } }, "nested")).toThrow(RpcFenceError);
  });

  it("REALITY-008e a clean endpoint config passes, and the schema holds nothing else", () => {
    const cfg = ReadSourceEndpointSchema.parse({ chainId: 1, providerId: "publicnode", url: "https://ethereum-rpc.publicnode.com" });
    expect(() => assertNoSignerCredential(cfg, "read source")).not.toThrow();
    // Enumerated, so a credential-shaped field added to the endpoint schema fails here.
    expect(Object.keys(ReadSourceEndpointSchema.shape).sort()).toEqual(["archiveDepth", "chainId", "providerId", "rateLimitPerSecond", "timeoutMs", "url"]);
  });

  it("REALITY-008f constructing a provider from a credentialled config fails before the URL is kept", () => {
    expect(() => new FencedJsonRpcProvider(
      { chainId: 1, providerId: "x", url: "https://example.org", rateLimitPerSecond: 1, timeoutMs: 1000, privateKey: `0x${"11".repeat(32)}` } as never,
    )).toThrow(RpcFenceError);
  });

  it("REALITY-008g no mainnet signing key exists in the environment contract", () => {
    // The repository's env contract names Sepolia keys and no mainnet ones. Checked in the source
    // so adding one is a test failure rather than a quiet capability.
    const mainnetKeys = sourceLines(/MAINNET_PRIVATE_KEY|MAINNET_DEPLOYER_KEY|MAINNET_SIGNER/).filter((l) => !isComment(l.text));
    expect(mainnetKeys.map((l) => `${l.file}:${l.text.trim()}`)).toEqual([]);
  });
});

describe("REALITY-009 source and execution networks are separate", () => {
  it("REALITY-009 mainnet is a read source and is in no execution list", () => {
    const mainnet = lookupNetwork(1);
    expect(mainnet?.role).toBe("READ_ONLY_SOURCE");
    expect(mainnet?.rpcCapability).toBe("READ_ONLY");
    expect(mainnet?.environment).toBe("PRODUCTION");
    expect(readOnlySources().map((n) => n.chainId)).toEqual([1]);
    expect(executionNetworks().some((n) => n.chainId === 1)).toBe(false);
  });

  it("REALITY-009b every execution network is write-capable and no read source is", () => {
    for (const n of executionNetworks()) expect(n.rpcCapability, n.name).toBe("READ_WRITE");
    for (const n of readOnlySources()) expect(n.rpcCapability, n.name).toBe("READ_ONLY");
  });

  it("REALITY-009c the role model has exactly the three roles §P27.1 names", () => {
    expect([...NETWORK_ROLES]).toEqual(["READ_ONLY_SOURCE", "TESTNET_EXECUTION", "LOCAL_FORK"]);
  });

  it("REALITY-009d every registry entry carries the five descriptor fields", () => {
    for (const n of [...executionNetworks(), ...readOnlySources()]) {
      expect(n.chainId, n.name).toBeTypeOf("number");
      expect(n.canonicalName, n.name).toMatch(/^[a-z0-9-]+$/);
      expect(NETWORK_ROLES as readonly string[], n.name).toContain(n.role);
      expect(["PRODUCTION", "TESTNET", "LOCAL"], n.name).toContain(n.environment);
      expect(["READ_ONLY", "READ_WRITE"], n.name).toContain(n.rpcCapability);
    }
  });

  it("REALITY-009e reading a source is allowed and does not require an execution permission", () => {
    expect(() => assertReadSourceAllowed(1, "reality engine")).not.toThrow();
    expect(() => assertReadSourceAllowed(11155111, "reality engine")).not.toThrow();
    expect(() => assertReadSourceAllowed(999999, "reality engine")).toThrow(RpcFenceError);
  });
});

/* ═════════════════════════ REALITY-010 … 013 : asset identity ═════════════════════════ */

describe("REALITY-010 canonical asset mapping", () => {
  it("REALITY-010 an asset resolves by chain and address", () => {
    const found = resolveAsset(1, WETH_MAINNET);
    expect(found?.asset.id).toBe("weth");
    expect(found?.deployment.decimals).toBe(18);
    expect(resolveAsset(1, WETH_MAINNET.toLowerCase())?.asset.id).toBe("weth");
  });

  it("REALITY-010b every deployment records who verified it", () => {
    for (const a of canonicalAssets()) {
      for (const d of a.deployments) {
        expect(d.verifiedBy.length, `${a.id} on ${d.chainId}`).toBeGreaterThan(10);
        expect(d.address, `${a.id} on ${d.chainId}`).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    }
  });

  it("REALITY-010c the same asset has different addresses on different chains", () => {
    const usdc = canonicalAssets().find((a) => a.id === "usdc");
    const mainnet = usdc?.deployments.find((d) => d.chainId === 1);
    const sepolia = usdc?.deployments.find((d) => d.chainId === 11155111);
    expect(mainnet?.address).not.toBe(sepolia?.address);
    expect(mainnet?.decimals).toBe(sepolia?.decimals);
  });
});

describe("REALITY-011 symbol-only matching is refused", () => {
  it("REALITY-011 there is no function that resolves an asset from a symbol", () => {
    /*
     * The strongest form of "we do not match on symbol" is that there is nothing to call. The
     * module's exports are enumerated, so adding `assetBySymbol` later fails this test.
     */
    const bySymbol = Object.keys(assetsModule).filter((k) => /bySymbol|fromSymbol|resolveSymbol|lookupSymbol/i.test(k));
    expect(bySymbol).toEqual([]);
    expect(Object.keys(assetsModule)).toContain("resolveAsset");
  });

  it("REALITY-011b a hostile token reporting a known symbol at an unknown address is refused", () => {
    const evil = "0xdEaD00000000000000000000000000000000BEEF";
    expect(reasonOf(() => assertAssetIdentity({ chainId: 1, address: evil, symbol: "USDC", decimals: 6 }, "usdc")))
      .toBe(ASSET_REASONS.IDENTITY_MISMATCH);
  });

  it("REALITY-011c a registered address for the WRONG asset is refused", () => {
    // WETH's real mainnet address, claimed to be USDC. Address is registered; identity is not.
    expect(reasonOf(() => assertAssetIdentity({ chainId: 1, address: WETH_MAINNET, symbol: "WETH", decimals: 18 }, "usdc")))
      .toBe(ASSET_REASONS.IDENTITY_MISMATCH);
  });

  it("REALITY-011d a registered address whose symbol changed is refused", () => {
    /*
     * The address is right and the asset is right, so the first two guards pass and only the symbol
     * guard can fire — the isolated fixture for that guard.
     */
    expect(reasonOf(() => assertAssetIdentity({ chainId: 1, address: USDC_MAINNET, symbol: "USDT", decimals: 6 }, "usdc")))
      .toBe(ASSET_REASONS.IDENTITY_MISMATCH);
  });

  it("REALITY-011e the honest case passes, using the real live-read values", () => {
    expect(() => assertAssetIdentity({ chainId: 1, address: WETH_MAINNET, symbol: "WETH", decimals: 18 }, "weth")).not.toThrow();
    expect(() => assertAssetIdentity({ chainId: 1, address: USDC_MAINNET, symbol: "USDC", decimals: 6 }, "usdc")).not.toThrow();
  });
});

describe("REALITY-012 a decimals mismatch is refused", () => {
  it("REALITY-012 the right address and symbol with the wrong exponent is refused alone", () => {
    /*
     * Address, asset and symbol all correct — only the decimals guard can fire. This is the
     * eighteen-decimal USDC attack, and the consequence is being wrong by 10^12.
     */
    const reason = reasonOf(() => assertAssetIdentity({ chainId: 1, address: USDC_MAINNET, symbol: "USDC", decimals: 18 }, "usdc"));
    expect(reason).toBe(ASSET_REASONS.DECIMALS_MISMATCH);
  });

  it("REALITY-012b the error says how wrong it would have been", () => {
    try {
      assertAssetIdentity({ chainId: 1, address: USDC_MAINNET, symbol: "USDC", decimals: 18 }, "usdc");
    } catch (e) {
      expect((e as Error).message).toMatch(/10\^12/);
    }
  });
});

describe("REALITY-013 a mainnet address is never copied into a Sepolia transaction", () => {
  it("REALITY-013 mapping to a chain returns that chain's own deployment", () => {
    const sepolia = mapAssetToChain("usdc", 11155111);
    expect(sepolia.address).toBe(USDC_SEPOLIA);
    expect(sepolia.address).not.toBe(USDC_MAINNET);
    expect(sepolia.chainId).toBe(11155111);
  });

  it("REALITY-013b an asset with no deployment on the target is refused, never substituted", () => {
    // DAI is registered on mainnet only. The tempting fallback is the mainnet address.
    const reason = reasonOf(() => mapAssetToChain("dai", 11155111));
    expect(reason).toBe(ASSET_REASONS.NO_DEPLOYMENT);
  });

  it("REALITY-013c a mainnet address offered for a Sepolia transaction is refused, and says why", () => {
    let err: AssetIdentityError | null = null;
    try { assertAddressBelongsToChain(USDC_MAINNET, 11155111, "sepolia intent"); } catch (e) { err = e as AssetIdentityError; }
    expect(err?.reason).toBe(ASSET_REASONS.CROSS_ENVIRONMENT_ADDRESS);
    expect(err?.message).toMatch(/ethereum-mainnet/);
    expect(err?.message).toMatch(/ethereum-testnet-sepolia/);
    expect(err?.message).toMatch(/different contract or none at all/);
  });

  it("REALITY-013d the Sepolia address is accepted for Sepolia", () => {
    expect(() => assertAddressBelongsToChain(USDC_SEPOLIA, 11155111, "sepolia intent")).not.toThrow();
  });
});

/* ═════════════════════════ REALITY-014 … 020 : sources ═════════════════════════ */

describe("REALITY-014 The Graph's indexed block is recorded", () => {
  it("REALITY-014 a snapshot source carries the block it indexed and its lag", () => {
    const graph = rpcSource({ sourceId: "thegraph", kind: "THE_GRAPH", trustClass: "INDEXED_CHAIN_DATA", observedBlock: "25948100", lagBlocks: 76 });
    const s = sealSnapshot(snapshotInput({
      sources: [feedSource(), graph],
      observations: [priceObservation(), rateObservation({ sourceId: "thegraph", trustClass: "INDEXED_CHAIN_DATA", blockNumber: "25948100" })],
    }));
    const stored = s.sources.find((x) => x.sourceId === "thegraph");
    expect(stored?.observedBlock).toBe("25948100");
    expect(stored?.lagBlocks).toBe(76);
  });

  it("REALITY-014b the schema requires the lag field to exist, even as null", () => {
    expect(SnapshotSourceSchema.safeParse({ ...feedSource(), lagBlocks: undefined }).success).toBe(false);
  });
});

describe("REALITY-015 indexer lag is surfaced", () => {
  it("REALITY-015 a lagging source shows up as block skew", () => {
    const coherence = computeCoherence(
      [priceObservation(), rateObservation({ sourceId: "thegraph", blockNumber: "25948100" })],
      [feedSource(), rpcSource({ sourceId: "thegraph", observedBlock: "25948100" })],
      { maxTimeSkewMs: 3_600_000, anchorChainId: 1, nowMs: 1789057607000, maxSourceAgeMs: 5_400_000 },
    );
    expect(coherence.maxBlockSkew).toBe(76);
  });

  it("REALITY-015b blocks on different chains are not compared", () => {
    /*
     * A Sepolia block number and a mainnet block number are both integers, and their difference is
     * meaningless. Incomparable sources are named rather than silently subtracted.
     */
    const coherence = computeCoherence(
      [priceObservation(), rateObservation({ sourceChainId: 11155111 })],
      [feedSource(), rpcSource({ sourceChainId: 11155111, observedBlock: "9000000" })],
      { maxTimeSkewMs: 3_600_000, anchorChainId: 1, nowMs: 1789057607000, maxSourceAgeMs: 5_400_000 },
    );
    expect(coherence.maxBlockSkew).toBeNull();
    expect(coherence.incomparableSources).toContain("aave-v3-mainnet-reserves");
  });

  it("REALITY-015c a source that reports no block is incomparable, not assumed current", () => {
    const coherence = computeCoherence(
      [priceObservation()],
      [feedSource({ observedBlock: null })],
      { maxTimeSkewMs: 3_600_000, anchorChainId: 1, nowMs: 1789057607000, maxSourceAgeMs: 5_400_000 },
    );
    expect(coherence.incomparableSources).toContain("chainlink-feed-eth-usd-mainnet");
  });
});

describe("REALITY-016 The Graph cannot satisfy an oracle requirement", () => {
  it("REALITY-016 an indexed source does not meet a VERIFIED_ORACLE policy", () => {
    const err = (() => { try { selectSource({ subject: "uniswap-v3:history", chainId: 1, requiredTrust: "VERIFIED_ORACLE", maxAgeMs: 600_000 }); } catch (e) { return e as SourceError; } return null; })();
    expect(err?.reason).toBe(SOURCE_REASONS.NO_COMPATIBLE);
  });

  it("REALITY-016b a lower-trust substitute is refused unless it was authorized in advance", () => {
    expect(reasonOf(() => assertFallbackAuthorized("VERIFIED_ORACLE", "INDEXED_CHAIN_DATA", false, "price")))
      .toBe(SOURCE_REASONS.TRUST_NOT_MET);
    expect(() => assertFallbackAuthorized("VERIFIED_ORACLE", "INDEXED_CHAIN_DATA", true, "price")).not.toThrow();
  });

  it("REALITY-016c a stronger source always satisfies a weaker requirement", () => {
    expect(() => assertFallbackAuthorized("INDEXED_CHAIN_DATA", "VERIFIED_ORACLE", false, "price")).not.toThrow();
  });
});

describe("REALITY-017 a verified Chainlink source is accepted", () => {
  it("REALITY-017 the resolver picks the Data Feed for an ordinary price policy", () => {
    const sel = selectSource({ subject: "weth/usd", chainId: 1, requiredTrust: "VERIFIED_ORACLE", maxAgeMs: 3_600_000 });
    expect(sel.source.sourceId).toBe("chainlink-feed-eth-usd-mainnet");
    expect(sel.source.kind).toBe("CHAINLINK_DATA_FEED");
    expect(sel.source.trustClass).toBe("VERIFIED_ORACLE");
    expect(sel.warnings).toEqual([]);
  });

  it("REALITY-017b the selected source records what verified it, and when", () => {
    const s = sourceById("chainlink-feed-eth-usd-mainnet");
    expect(s?.verifiedBy).toMatch(/ETH \/ USD/);
    expect(s?.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sourceVerificationAgeDays(s!, "2026-09-10")).toBe(0);
    expect(sourceVerificationAgeDays(s!, "2026-09-20")).toBe(10);
  });

  it("REALITY-017c a policy demanding fresher data than the feed's heartbeat gets nothing, not a downgrade", () => {
    // §P27.13: the resolver considers required freshness. An hourly feed cannot satisfy a 30s policy.
    const reason = (() => { try { selectSource({ subject: "weth/usd", chainId: 1, requiredTrust: "VERIFIED_ORACLE", maxAgeMs: 30_000 }); } catch (e) { return (e as SourceError).reason; } return null; })();
    expect(reason).toBe(SOURCE_REASONS.NO_COMPATIBLE);
  });

  it("REALITY-017d nothing in the resolver ranks a source by novelty", () => {
    /*
     * §P27.13 warns against choosing Data Streams because they sound newer. The rejection list is
     * the audit answer to "why this one?", and every entry names a policy reason.
     */
    const sel = selectSource({ subject: "weth/usd", chainId: 1, requiredTrust: "VERIFIED_ORACLE", maxAgeMs: 3_600_000 });
    for (const r of sel.rejected) expect(Object.values(SOURCE_REASONS)).toContain(r.reason);
  });
});

describe("REALITY-018 a deprecated source is surfaced", () => {
  const scheduled = {
    sourceId: "stream-x", kind: "CHAINLINK_DATA_STREAM" as const, subject: "weth/usd", chainId: 1,
    identity: "0xstream", trustClass: "VERIFIED_ORACLE" as const, heartbeatMs: 1_000, decimals: 18,
    lifecycle: "DEPRECATION_SCHEDULED" as const, deprecationDate: "2026-12-01", replacedBy: "stream-y",
    historical: false, requiresAuth: true, verifiedBy: "fixture for the lifecycle test", verifiedAt: "2026-09-10",
  };

  it("REALITY-018 a scheduled deprecation produces a warning naming date and replacement", () => {
    const w = deprecationWarning(scheduled);
    expect(w.code).toBe(DATA_SOURCE_DEPRECATION_WARNING);
    expect(w.effectiveDate).toBe("2026-12-01");
    expect(w.replacement).toBe("stream-y");
    expect(w.message).toMatch(/scheduled for deprecation/);
  });

  it("REALITY-018b the five lifecycle states exist and an ACTIVE source still says what it needs", () => {
    const states = marketSources().map((s) => s.lifecycle);
    expect(states).toContain("ACTIVE");
    // Every registered source was verified live, and each says when and how. A source that was
    // never checked would be UNKNOWN, which is a different fact from ACTIVE; the schema keeps all five.
    for (const s of marketSources()) {
      expect(s.lifecycle, s.sourceId).toBe("ACTIVE");
      expect(s.verifiedAt, s.sourceId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // The Graph was verified WITH a key; ACTIVE describes the source, `requiresAuth` what this
    // backend must hold to use it. The two are separate on purpose (ROUTE-003c/d).
    const graph = sourceById("thegraph-uniswap-v3-mainnet");
    expect(graph?.lifecycle).toBe("ACTIVE");
    expect(graph?.requiresAuth).toBe(true);
    expect(graph?.identity).toMatch(/^gateway\.thegraph\.com\/api\/subgraphs\/id\/[1-9A-HJ-NP-Za-km-z]{40,}$/);
  });

  it("REALITY-018d a DEPRECATED source is refused, with its own reason", () => {
    /*
     * The registry holds no retired source today, so this branch had nothing to exercise it and a
     * mutation deleting it escaped the whole suite. `selectFrom` takes the candidate list, so every
     * lifecycle state can be driven rather than only the ones that happen to be configured.
     */
    const retired = { ...scheduled, sourceId: "retired-feed", lifecycle: "DEPRECATED" as const, deprecationDate: "2026-01-01" };
    const out = (() => { try { selectFrom([retired], { subject: "weth/usd", chainId: 1, requiredTrust: "VERIFIED_ORACLE", maxAgeMs: 3_600_000 }); } catch (e) { return e as SourceError; } return null; })();
    expect(out?.message).toMatch(/MARKET_SOURCE_DEPRECATED/);
    expect(out?.message).toMatch(/retired on 2026-01-01/);
  });

  it("REALITY-018e an UNKNOWN lifecycle is refused too — never checked is not the same as fine", () => {
    const unchecked = { ...scheduled, sourceId: "unchecked-feed", lifecycle: "UNKNOWN" as const };
    const out = (() => { try { selectFrom([unchecked], { subject: "weth/usd", chainId: 1, requiredTrust: "VERIFIED_ORACLE", maxAgeMs: 3_600_000 }); } catch (e) { return e as SourceError; } return null; })();
    expect(out?.message).toMatch(/MARKET_SOURCE_LIFECYCLE_UNKNOWN/);
  });

  it("REALITY-018f a DEPRECATION_SCHEDULED source is usable and warns", () => {
    const sel = selectFrom([scheduled], { subject: "weth/usd", chainId: 1, requiredTrust: "VERIFIED_ORACLE", maxAgeMs: 3_600_000, availableCredentials: new Set(["stream-x"]) });
    expect(sel.source.sourceId).toBe("stream-x");
    expect(sel.warnings[0]?.code).toBe(DATA_SOURCE_DEPRECATION_WARNING);
  });

  it("REALITY-018g an ACTIVE source is preferred over one scheduled for retirement", () => {
    // §P27.12: new builds prefer a supported alternative where one exists.
    const active = { ...scheduled, sourceId: "stream-active", lifecycle: "ACTIVE" as const, deprecationDate: null, replacedBy: null };
    const sel = selectFrom([scheduled, active], { subject: "weth/usd", chainId: 1, requiredTrust: "VERIFIED_ORACLE", maxAgeMs: 3_600_000, availableCredentials: new Set(["stream-x", "stream-active"]) });
    expect(sel.source.sourceId).toBe("stream-active");
  });

  it("REALITY-018c an unavailable source is excluded with its reason recorded", () => {
    const reason = (() => { try { selectSource({ subject: "uniswap-v3:history", chainId: 1, requiredTrust: "INDEXED_CHAIN_DATA", maxAgeMs: 600_000 }); } catch (e) { return e as SourceError; } return null; })();
    expect(reason?.message).toMatch(/thegraph-uniswap-v3-mainnet/);
  });
});

describe("REALITY-019 a deprecated source cannot silently migrate", () => {
  it("REALITY-019 changing an approved deployment's source without revalidation is refused", () => {
    expect(reasonOf(() => assertNoSilentMigration("chainlink-feed-eth-usd-mainnet", "mainnet-read-rpc", false)))
      .toBe(SOURCE_REASONS.SILENT_MIGRATION);
  });

  it("REALITY-019b the refusal names what changed about the trust and the freshness", () => {
    try {
      assertNoSilentMigration("chainlink-feed-eth-usd-mainnet", "mainnet-read-rpc", false);
    } catch (e) {
      expect((e as Error).message).toMatch(/VERIFIED_ORACLE/);
      expect((e as Error).message).toMatch(/DIRECT_CHAIN_DATA/);
      expect((e as Error).message).toMatch(/needs a new review/);
    }
  });

  it("REALITY-019c an explicit revalidation permits it, and an unchanged source is a no-op", () => {
    expect(() => assertNoSilentMigration("a", "b", true)).not.toThrow();
    expect(() => assertNoSilentMigration("a", "a", false)).not.toThrow();
  });
});

describe("REALITY-020 a stale source is rejected", () => {
  it("REALITY-020 staleness comes from each source's own heartbeat, not one global number", () => {
    /*
     * This is the defect the first live run exposed: an hourly Chainlink feed sitting beside
     * per-block RPC reads was marked stale for behaving exactly as specified.
     */
    const feed = sourceById("chainlink-feed-eth-usd-mainnet")!;
    const rpc = sourceById("mainnet-read-rpc")!;
    expect(stalenessThresholdMs(feed)).toBe(5_400_000);
    expect(stalenessThresholdMs(rpc)).toBe(90_000);
    const limits = sourceAgeLimits([feed.sourceId, rpc.sourceId]);
    expect(limits.get(feed.sourceId)).toBe(5_400_000);
    expect(limits.get(rpc.sourceId)).toBe(90_000);
  });

  it("REALITY-020b a genuinely stale reading is caught, and a slow-but-healthy one is not", () => {
    const now = 1789057607000;
    const limits = sourceAgeLimits(["chainlink-feed-eth-usd-mainnet", "aave-v3-mainnet-reserves"]);

    // An hour-old feed reading: within the feed's own contract.
    const healthy = computeCoherence(
      [priceObservation({ sourceTimestampMs: now - 3_500_000 })],
      [feedSource()],
      { maxTimeSkewMs: 5_400_000, anchorChainId: 1, nowMs: now, maxSourceAgeMs: 5_400_000, sourceMaxAgeMs: limits },
    );
    expect(healthy.staleSources).toEqual([]);

    // Two hours: the feed has missed its heartbeat with margin.
    const stale = computeCoherence(
      [priceObservation({ sourceTimestampMs: now - 7_200_000 })],
      [feedSource()],
      { maxTimeSkewMs: 999_999_999, anchorChainId: 1, nowMs: now, maxSourceAgeMs: 999_999_999, sourceMaxAgeMs: limits },
    );
    expect(stale.staleSources).toEqual(["chainlink-feed-eth-usd-mainnet"]);
    expect(stale.coherent).toBe(false);
  });

  it("REALITY-020c a stale snapshot cannot authorize a new action", () => {
    const s = sealSnapshot(snapshotInput());
    const later = s.observedAtMs + 600_000;
    expect(snapshotState(s, later, 60_000).state).toBe("STALE");
    expect(reasonOf(() => assertSnapshotUsable(s, later, 60_000, "shadow"))).toBe(SNAPSHOT_REASONS.NO_VALID_CONTEXT);
    expect(() => assertSnapshotUsable(s, s.observedAtMs, 60_000, "shadow")).not.toThrow();
  });
});

/* ═════════════════════════ REALITY-021 … 024 : coherence and replay ═════════════════════════ */

describe("REALITY-021 snapshot coherence is computed", () => {
  it("REALITY-021 coherence measures skew rather than counting successes", () => {
    /*
     * §P27.9's trap: five sources that all answered, describing five different moments, is five
     * successes and one incoherent picture.
     */
    const now = 1789057607000;
    const spread = computeCoherence(
      [priceObservation({ sourceTimestampMs: now - 300_000 }), rateObservation({ sourceTimestampMs: now })],
      [feedSource(), rpcSource()],
      { maxTimeSkewMs: 60_000, anchorChainId: 1, nowMs: now, maxSourceAgeMs: 999_999_999 },
    );
    expect(spread.maxTimeSkewMs).toBe(300_000);
    expect(spread.coherent).toBe(false);
    expect(spread.reason).toMatch(/span 300s/);
  });

  it("REALITY-021b a source's own timestamp is used where it has one", () => {
    // Using our retrieval clock for a value the source timestamped would understate the skew.
    const now = 1789057607000;
    const c = computeCoherence(
      [priceObservation({ sourceTimestampMs: now - 3_600_000, retrievedAtMs: now })],
      [feedSource()],
      { maxTimeSkewMs: 60_000, anchorChainId: 1, nowMs: now, maxSourceAgeMs: 999_999_999 },
    );
    expect(c.oldestObservationMs).toBe(now - 3_600_000);
  });

  it("REALITY-021c an unhealthy source makes a snapshot incoherent even with no skew", () => {
    const c = computeCoherence(
      [priceObservation()],
      [feedSource({ healthy: false })],
      { maxTimeSkewMs: 60_000, anchorChainId: 1, nowMs: 1789057607000, maxSourceAgeMs: 999_999_999 },
    );
    expect(c.coherent).toBe(false);
    expect(c.reason).toMatch(/unhealthy/);
  });

  it("REALITY-021d an empty snapshot is not coherent by default", () => {
    const c = computeCoherence([], [feedSource()], { maxTimeSkewMs: 60_000, anchorChainId: 1, nowMs: 1, maxSourceAgeMs: 1 });
    expect(c.coherent).toBe(false);
    expect(c.reason).toMatch(/no observations/);
  });
});

describe("REALITY-022 the exact historical block is stored", () => {
  it("REALITY-022 an explicit block is pinned with its hash", async () => {
    const p = new FakeChainProvider({ head: 1_000_000n });
    const target = await pinBlock(p, "999000");
    expect(target.blockNumber).toBe("999000");
    expect(target.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(target.resolvedFrom).toBe("EXPLICIT_BLOCK");
  });

  it("REALITY-022b \"latest\" is refused for a replay", () => {
    const p = new FakeChainProvider();
    return expect(pinBlock(p, "latest")).rejects.toMatchObject({ reason: REPLAY_REASONS.NO_EXACT_BLOCK });
  });

  it("REALITY-022c a timestamp resolves to one exact block, deterministically", async () => {
    const p = new FakeChainProvider({ head: 100_000n, genesisMs: 1_500_000_000_000 });
    const targetMs = 1_500_000_000_000 + 50_000 * 12_000;
    const a = await resolveBlockForTimestamp(p, targetMs);
    const b = await resolveBlockForTimestamp(p, targetMs);
    expect(a.blockNumber).toBe("50000");
    expect(b.blockNumber).toBe(a.blockNumber);
    expect(a.resolvedFrom).toBe("TIMESTAMP_SEARCH");
    // The requested time is kept alongside the resolved block, so the choice is reproducible.
    expect(a.requestedTimestampMs).toBe(targetMs);
  });

  it("REALITY-022d the resolved block is at or before the requested time, never after", async () => {
    const p = new FakeChainProvider({ head: 100_000n, genesisMs: 1_500_000_000_000 });
    const targetMs = 1_500_000_000_000 + 50_000 * 12_000 + 5_000;
    const t = await resolveBlockForTimestamp(p, targetMs);
    expect(t.blockTimestampMs).toBeLessThanOrEqual(targetMs);
    expect(Number(t.blockNumber)).toBe(50_000);
  });

  it("REALITY-022e a future timestamp is refused rather than clamped to the head", async () => {
    const p = new FakeChainProvider({ head: 1000n, genesisMs: 1_500_000_000_000 });
    await expect(resolveBlockForTimestamp(p, 2_000_000_000_000)).rejects.toMatchObject({ reason: REPLAY_REASONS.UNRESOLVABLE_TIMESTAMP });
  });
});

describe("REALITY-023 an unsupported historical source is surfaced", () => {
  const nonHistorical = {
    sourceId: "some-rest-api", kind: "EXTERNAL_API" as const, subject: "weth/usd", chainId: 1,
    identity: "https://example.org/price", trustClass: "EXTERNAL_API" as const, heartbeatMs: 60_000,
    decimals: 8, lifecycle: "ACTIVE" as const, deprecationDate: null, replacedBy: null,
    historical: false, requiresAuth: false, verifiedBy: "fixture for the replay test", verifiedAt: "2026-09-10",
  };

  it("REALITY-023 an unpinnable source is excluded under the strict policy", () => {
    expect(reasonOf(() => assertSourcePinnable(nonHistorical, "EXCLUDE_NON_HISTORICAL", "replay")))
      .toBe(REPLAY_REASONS.MIXED_TIME_NOT_ALLOWED);
  });

  it("REALITY-023b under the permissive policy it is included AND marked, never quietly", () => {
    expect(() => assertSourcePinnable(nonHistorical, "ALLOW_MIXED_TIME", "replay")).not.toThrow();
    const marked = markNonHistorical(priceObservation(), "25948176");
    expect(marked.blockNumber).toBeNull();
    expect(marked.provenance).toMatch(/^NON_HISTORICAL_SOURCE:/);
    expect(marked.provenance).toMatch(/is CURRENT/);
  });

  it("REALITY-023c the plan says whether the whole snapshot is mixed-time", () => {
    const strict = planReplaySources(["chainlink-feed-eth-usd-mainnet", "mainnet-read-rpc"], "EXCLUDE_NON_HISTORICAL");
    expect(strict.mixedTimeSnapshot).toBe(false);
    expect(strict.included.length).toBe(2);

    // A subgraph answers at a block, so it is a historical source and joins a strict replay.
    const withGraph = planReplaySources(["chainlink-feed-eth-usd-mainnet", "thegraph-uniswap-v3-mainnet"], "EXCLUDE_NON_HISTORICAL");
    expect(withGraph.included.map((s) => s.source.sourceId)).toContain("thegraph-uniswap-v3-mainnet");
    expect(withGraph.mixedTimeSnapshot).toBe(false);
    // A source that is not in the registry is excluded with that reason, never silently.
    const unknown = planReplaySources(["chainlink-feed-eth-usd-mainnet", "no-such-source"], "EXCLUDE_NON_HISTORICAL");
    expect(unknown.excluded).toEqual([{ sourceId: "no-such-source", reason: "not in the source registry" }]);
  });

  it("REALITY-023d curated events point at exact blocks with evidence, or there are none", () => {
    // §P27.21 makes these optional and forbids unsourced stories, so the list is empty rather than
    // populated with plausible-sounding events whose blocks nobody checked.
    for (const e of CURATED_EVENTS) {
      expect(e.blockNumber).toMatch(/^\d+$/);
      expect(e.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(e.evidence.length).toBeGreaterThan(10);
    }
  });
});

describe("REALITY-024 a replay is reproducible", () => {
  it("REALITY-024 two replays of the same block agree", () => {
    const target = { blockNumber: "25948176", blockHash: REAL_ANCHOR.hash, blockTimestampMs: 1789057607000, chainId: 1, resolvedFrom: "EXPLICIT_BLOCK" as const, requestedTimestampMs: null };
    const a = { target, observations: [priceObservation()] };
    const b = { target, observations: [priceObservation({ observationId: "different-id", retrievedAtMs: 1789057999000 })] };
    // Ids and retrieval clocks differ between runs and are not what reproducibility means.
    expect(replaysAgree(a, b).agree).toBe(true);
  });

  it("REALITY-024b a different pinned value is a disagreement", () => {
    const target = { blockNumber: "25948176", blockHash: REAL_ANCHOR.hash, blockTimestampMs: 1789057607000, chainId: 1, resolvedFrom: "EXPLICIT_BLOCK" as const, requestedTimestampMs: null };
    const out = replaysAgree({ target, observations: [priceObservation()] }, { target, observations: [priceObservation({ value: "1" })] });
    expect(out.agree).toBe(false);
    expect(out.differences[0]).toMatch(/weth\/usd:price/);
  });

  it("REALITY-024c a different block is a disagreement even with identical values", () => {
    const t1 = { blockNumber: "25948176", blockHash: REAL_ANCHOR.hash, blockTimestampMs: 1789057607000, chainId: 1, resolvedFrom: "EXPLICIT_BLOCK" as const, requestedTimestampMs: null };
    const t2 = { ...t1, blockNumber: "25948177" };
    expect(replaysAgree({ target: t1, observations: [] }, { target: t2, observations: [] }).agree).toBe(false);
  });

  it("REALITY-024d unpinned observations are excluded from the comparison", () => {
    // A mixed-time value differs legitimately between runs; comparing it would make every replay
    // irreproducible and the check worthless.
    const target = { blockNumber: "25948176", blockHash: REAL_ANCHOR.hash, blockTimestampMs: 1789057607000, chainId: 1, resolvedFrom: "EXPLICIT_BLOCK" as const, requestedTimestampMs: null };
    const a = { target, observations: [priceObservation(), rateObservation({ blockNumber: null, value: "1" })] };
    const b = { target, observations: [priceObservation(), rateObservation({ blockNumber: null, value: "2" })] };
    expect(replaysAgree(a, b).agree).toBe(true);
  });
});

/* ═════════════════════════ cross-source disagreement ═════════════════════════ */

describe("cross-source disagreement is preserved, never averaged", () => {
  it("REALITY-025 two disagreeing readings are both kept and the spread is measured", () => {
    const d = compareReadings("weth/usd:price", [
      { sourceId: "chainlink", value: "243442066354", decimals: 8, trustClass: "VERIFIED_ORACLE" },
      { sourceId: "thegraph", value: "240000000000", decimals: 8, trustClass: "INDEXED_CHAIN_DATA" },
    ], 100);
    expect(d.readings.length).toBe(2);
    expect(d.disagrees).toBe(true);
    // The authoritative reading is the highest-trust one, not a blend.
    expect(d.authoritative.sourceId).toBe("chainlink");
    expect(d.spreadBps).toBeGreaterThan(100);
  });

  it("REALITY-025b nothing in the result is an average of the inputs", () => {
    const d = compareReadings("weth/usd:price", [
      { sourceId: "a", value: "100", decimals: 0, trustClass: "VERIFIED_ORACLE" },
      { sourceId: "b", value: "200", decimals: 0, trustClass: "INDEXED_CHAIN_DATA" },
    ], 10_000);
    const values = d.readings.map((r) => r.value);
    expect(values).toEqual(["100", "200"]);
    expect(d.authoritative.value).toBe("100");
    expect(values).not.toContain("150");
  });

  it("REALITY-025c readings with different exponents are normalized before comparison", () => {
    // 100 with 0 decimals and 10000 with 2 decimals are the same number.
    const d = compareReadings("x", [
      { sourceId: "a", value: "100", decimals: 0, trustClass: "VERIFIED_ORACLE" },
      { sourceId: "b", value: "10000", decimals: 2, trustClass: "VERIFIED_ORACLE" },
    ], 0);
    expect(d.spreadBps).toBe(0);
    expect(d.disagrees).toBe(false);
  });
});

/* ═════════════════════════ auditability ═════════════════════════ */

describe("the auditability gate", () => {
  it("REALITY-026 all seven questions are answered from a real snapshot and decision", () => {
    const s = sealSnapshot(snapshotInput());
    const decision = {
      decisionId: "d1", marketSnapshotHash: s.snapshotHash, scenarioHash: null,
      strategyRevision: 1, blueprintRevision: 1, creSimulationId: null,
      verdict: "ALLOW" as const, reasonCode: "ALLOW_POLICY_MATCH",
      proposedMainnetSemanticAction: { kind: "SUPPLY" as const, assetId: "weth", counterAssetId: null, amount: "1", decimals: 18, protocol: "aave-v3", rationale: "test" },
      executionEnvironment: "LOCAL_FORK" as const, environmentId: "fork-1", executionChainId: 31337,
      simulatedExecutionResult: { executed: true, txHash: "0xabc", label: "LOCAL FORK TRANSACTION", detail: "ok" },
      decidedAtMs: 1789057607000,
    };
    const audit = assertAuditable(s, decision);
    expect(audit.answers.length).toBe(AUDIT_QUESTIONS.length);
    expect(audit.auditable).toBe(true);
    expect(audit.answers.every((a) => a.answer.length > 0)).toBe(true);
  });

  it("REALITY-026b a snapshot with no decision cannot answer where execution happened", () => {
    const s = sealSnapshot(snapshotInput());
    const audit = auditRealityEvaluation(s, null);
    expect(audit.auditable).toBe(false);
    expect(audit.unanswered).toEqual(["Where was execution actually performed?"]);
    expect(() => assertAuditable(s, null)).toThrow(AuditabilityError);
  });

  it("REALITY-026c \"no synthetic modifications\" is a complete answer, not an unanswered one", () => {
    const s = sealSnapshot(snapshotInput());
    const audit = auditRealityEvaluation(s, null);
    const synthetic = audit.answers.find((a) => a.question === "What modifications were synthetic?");
    expect(synthetic?.answered).toBe(true);
    expect(synthetic?.answer).toMatch(/none/);
  });
});
