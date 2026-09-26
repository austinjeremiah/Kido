import { describe, it, expect } from "vitest";
import {
  EXECUTION_ADAPTER_TYPES,
  ccipManifest,
  ChainlinkCcipAdapter,
  AdapterRegistry,
  AdapterRegistrationError,
  AdapterNotFoundError,
  ModelOverrideRejectedError,
  resolveDataRequirement,
  resolveWithSuggestion,
  enforceRequirement,
  assertUsableObservation,
  MissingProvenanceError,
  commitObservations,
  makeBundle,
  satisfiesTrust,
  isTrustDowngrade,
  trustRank,
  ReferenceOracleAdapter,
  ReferenceChainReaderAdapter,
  ReferenceExecutionAdapter,
  referenceOracleManifest,
  referenceChainReaderManifest,
  referenceExecutionManifest,
  type ContextLockAdapterManifest,
  type DataRequirement,
  type DataObservation,
} from "../src/index.js";

const SEPOLIA = 11155111;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function freshRegistry(): AdapterRegistry {
  const r = new AdapterRegistry();
  r.register({ kind: "data", manifest: referenceOracleManifest, adapter: new ReferenceOracleAdapter() });
  r.register({ kind: "data", manifest: referenceChainReaderManifest, adapter: new ReferenceChainReaderAdapter() });
  r.register({ kind: "execution", manifest: referenceExecutionManifest, adapter: new ReferenceExecutionAdapter() });
  return r;
}

const priceRequirement = (over: Partial<DataRequirement> = {}): DataRequirement => ({
  key: "collateralPrice",
  kind: "collateral_asset_usd_price",
  chainId: SEPOLIA,
  unit: "USD",
  minimumTrustClass: "VERIFIED_ORACLE",
  maxAgeMs: 30_000,
  confidential: false,
  historical: false,
  ...over,
});

/* ───────────────────────────── manifest & registry ────────────────────────── */

describe("ADAPTER-001 a valid manifest registers", () => {
  it("accepts the reference adapters and lists them by pinned ref", () => {
    const r = freshRegistry();
    expect(r.list().map((m) => `${m.id}@${m.version}`)).toEqual([
      "reference-chain-reader@1.0.0",
      "reference-execution@1.0.0",
      "reference-oracle@1.0.0",
    ]);
    expect(r.has("reference-oracle", "1.0.0")).toBe(true);
    expect(r.resolve("reference-oracle", "1.0.0").manifest.trustClass).toBe("VERIFIED_ORACLE");
  });
});

describe("ADAPTER-002 a duplicate id@version is rejected", () => {
  it("refuses the same ref twice", () => {
    const r = freshRegistry();
    expect(() =>
      r.register({ kind: "data", manifest: referenceOracleManifest, adapter: new ReferenceOracleAdapter() }),
    ).toThrow(AdapterRegistrationError);
  });

  it("accepts a genuinely different version of the same adapter", () => {
    const r = freshRegistry();
    const v11 = { ...clone(referenceOracleManifest), version: "1.1.0" };
    class V11 extends ReferenceOracleAdapter {
      override manifest(): ContextLockAdapterManifest {
        return v11;
      }
    }
    expect(() => r.register({ kind: "data", manifest: v11, adapter: new V11() })).not.toThrow();
    expect(r.versionsOf("reference-oracle")).toEqual(["1.0.0", "1.1.0"]);
  });
});

describe("ADAPTER-003 a malformed manifest is rejected", () => {
  it("rejects a missing schema version", () => {
    const r = new AdapterRegistry();
    const bad = { ...clone(referenceOracleManifest) } as Record<string, unknown>;
    delete bad.schemaVersion;
    expect(() => r.verifyManifest(bad)).toThrow(/ADAPTER-MANIFEST-INVALID/);
  });

  it("rejects a version range instead of an exact version", () => {
    const r = new AdapterRegistry();
    expect(() => r.verifyManifest({ ...clone(referenceOracleManifest), version: "^1.0.0" })).toThrow(
      /exact semver/,
    );
  });

  it("rejects unknown extra fields rather than ignoring them", () => {
    // A manifest is a security document. Silently dropping a field someone thought they were
    // declaring is how an adapter ends up with properties nobody enforced.
    const r = new AdapterRegistry();
    expect(() => r.verifyManifest({ ...clone(referenceOracleManifest), trustMeBro: true })).toThrow(
      /ADAPTER-MANIFEST-INVALID/,
    );
  });

  it("rejects an unknown adapter type", () => {
    const r = new AdapterRegistry();
    expect(() => r.verifyManifest({ ...clone(referenceOracleManifest), adapterType: "MAGIC" })).toThrow(
      /ADAPTER-MANIFEST-INVALID/,
    );
  });

  it("rejects an adapter that declares no security assertions", () => {
    const r = new AdapterRegistry();
    expect(() => r.verifyManifest({ ...clone(referenceOracleManifest), securityAssertions: [] })).toThrow(
      /ADAPTER-MANIFEST-INVALID/,
    );
  });

  it("rejects an execution adapter that does not decode provider output", () => {
    const r = new AdapterRegistry();
    const lazy = clone(referenceExecutionManifest);
    lazy.safety.decodesPreparedTransactions = false;
    expect(() => r.verifyManifest(lazy)).toThrow(/ADAPTER-EXEC-UNVALIDATED/);
  });

  it("rejects a manifest whose identity disagrees with its implementation", () => {
    const r = new AdapterRegistry();
    const renamed = { ...clone(referenceOracleManifest), id: "someone-else" };
    expect(() =>
      r.register({ kind: "data", manifest: renamed, adapter: new ReferenceOracleAdapter() }),
    ).toThrow(/ADAPTER-IDENTITY-MISMATCH/);
  });

  it("rejects an execution adapter registered as a data adapter", () => {
    const r = new AdapterRegistry();
    expect(() =>
      r.register({ kind: "data", manifest: referenceExecutionManifest, adapter: new ReferenceExecutionAdapter() as never }),
    ).toThrow(/ADAPTER-KIND-MISMATCH/);
  });

  it("rejects a credential-bearing adapter that would run in the generated agent", () => {
    const r = new AdapterRegistry();
    const leaky = clone(referenceOracleManifest);
    leaky.auth = { mode: "api-key", requiredSecretNames: ["SOME_KEY"], placement: "never-client" };
    leaky.executionPlacement = "generated-agent";
    expect(() => r.verifyManifest(leaky)).toThrow(/ADAPTER-AUTH-PLACEMENT/);
  });

  it("rejects an adapter claiming auth but naming no secret", () => {
    const r = new AdapterRegistry();
    const vague = clone(referenceOracleManifest);
    vague.auth = { mode: "api-key", requiredSecretNames: [], placement: "studio-backend" };
    expect(() => r.verifyManifest(vague)).toThrow(/ADAPTER-AUTH-UNDECLARED/);
  });
});

describe("ADAPTER-004 an unsupported chain is rejected", () => {
  it("is not a candidate for a requirement on another chain", () => {
    const r = freshRegistry();
    const out = resolveDataRequirement(r, priceRequirement({ chainId: 999 as never }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rejected.some((x) => /does not support chain 999/.test(x.reason))).toBe(true);
  });

  it("findByCapability filters on chain", () => {
    const r = freshRegistry();
    expect(r.findByCapability({ dataKind: "collateral_asset_usd_price", chainId: SEPOLIA })).toHaveLength(1);
    expect(r.findByCapability({ dataKind: "collateral_asset_usd_price", chainId: 1 })).toHaveLength(0);
  });
});

describe("ADAPTER-005 a capability mismatch is rejected", () => {
  it("an adapter that does not claim the data kind is not selected", () => {
    const r = freshRegistry();
    const out = resolveDataRequirement(r, priceRequirement({ kind: "something_nobody_provides" }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("NO_COMPATIBLE_ADAPTER");
  });

  it("resolving an unregistered ref throws rather than guessing", () => {
    const r = freshRegistry();
    expect(() => r.resolve("reference-oracle", "9.9.9")).toThrow(AdapterNotFoundError);
  });
});

/* ──────────────────────────────── trust model ─────────────────────────────── */

describe("ADAPTER-006 a trust downgrade is rejected", () => {
  it("an indexed/direct source cannot satisfy a verified-oracle requirement", () => {
    const r = freshRegistry();
    const out = resolveDataRequirement(
      r,
      priceRequirement({ kind: "aave_position_health_factor", minimumTrustClass: "VERIFIED_ORACLE" }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("NO_COMPATIBLE_ADAPTER");
      expect(out.rejected.some((x) => /offers DIRECT_CHAIN_DATA/.test(x.reason))).toBe(true);
    }
  });

  it("a stronger source DOES satisfy a weaker requirement", () => {
    const r = freshRegistry();
    const out = resolveDataRequirement(r, priceRequirement({ minimumTrustClass: "EXTERNAL_API" }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.selection.trustClass).toBe("VERIFIED_ORACLE");
  });

  it("the ordering is total and downgrades are detectable", () => {
    expect(satisfiesTrust("VERIFIED_ORACLE", "INDEXED_CHAIN_DATA")).toBe(true);
    expect(satisfiesTrust("INDEXED_CHAIN_DATA", "VERIFIED_ORACLE")).toBe(false);
    expect(isTrustDowngrade("VERIFIED_ORACLE", "EXTERNAL_API")).toBe(true);
    expect(isTrustDowngrade("EXTERNAL_API", "VERIFIED_ORACLE")).toBe(false);
    expect(trustRank("CONFIDENTIAL_VERIFIED_COMPUTE")).toBeGreaterThan(trustRank("VERIFIED_ORACLE"));
    expect(trustRank("USER_UNTRUSTED")).toBe(0);
  });

  it("enforcement at use time refuses a downgraded observation even from a selected adapter", () => {
    const req = priceRequirement();
    const r = enforceRequirement(req, { provenance: { trustClass: "INDEXED_CHAIN_DATA", freshnessMs: 10 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TRUST");
  });
});

/* ────────────────────────── freshness & provenance ────────────────────────── */

describe("ADAPTER-007 a stale value is rejected", () => {
  it("refuses an observation older than the requirement", () => {
    const req = priceRequirement({ maxAgeMs: 5_000 });
    const r = enforceRequirement(req, { provenance: { trustClass: "VERIFIED_ORACLE", freshnessMs: 600_000 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("STALE");
  });

  it("refuses an observation that cannot say how old it is", () => {
    // "We don't know" is not "it's fine". This is the case that would otherwise pass silently.
    const r = enforceRequirement(priceRequirement(), { provenance: { trustClass: "VERIFIED_ORACLE" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/no freshness information/);
  });

  it("an adapter that cannot report freshness is never selected for a bounded requirement", () => {
    const r = new AdapterRegistry();
    const blind = clone(referenceOracleManifest);
    blind.id = "blind-oracle";
    blind.freshnessSemantics = { kind: "unknown", exposesBlockLag: false };
    class Blind extends ReferenceOracleAdapter {
      override manifest(): ContextLockAdapterManifest {
        return blind;
      }
    }
    r.register({ kind: "data", manifest: blind, adapter: new Blind() });
    const out = resolveDataRequirement(r, priceRequirement());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rejected.some((x) => /cannot report freshness/.test(x.reason))).toBe(true);
  });

  it("an adapter whose typical staleness exceeds the bound is rejected", () => {
    const r = freshRegistry();
    const out = resolveDataRequirement(r, priceRequirement({ maxAgeMs: 100 }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.rejected.some((x) => /typical staleness/.test(x.reason))).toBe(true);
  });
});

describe("ADAPTER-008 missing provenance is rejected", () => {
  it("refuses an observation with no provenance at all", () => {
    expect(() => assertUsableObservation({ value: "1", unit: "USD" }, "reference-oracle")).toThrow(
      MissingProvenanceError,
    );
  });

  it("refuses an observation claiming another adapter's identity", () => {
    // Otherwise a weak source could inherit a strong source's trust class downstream.
    const obs = {
      observationId: "x",
      dataKind: "collateral_asset_usd_price",
      value: "1",
      unit: "USD",
      decimals: 8,
      observedAt: new Date().toISOString(),
      provenance: {
        provider: "p",
        adapterId: "some-other-adapter",
        adapterVersion: "1.0.0",
        trustClass: "VERIFIED_ORACLE",
        verification: { verified: true },
      },
    };
    expect(() => assertUsableObservation(obs, "reference-oracle")).toThrow(/claims adapterId/);
  });

  it("the reference adapter produces a fully-provenanced observation", async () => {
    const a = new ReferenceOracleAdapter();
    const q = a.validateQuery({ asset: "ETH" });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const ctx = { chainId: SEPOLIA, nowMs: 1_760_000_000_000 };
    const raw = await a.fetch(q.query);
    const obs = a.normalize(raw, q.query, ctx);
    const checked = assertUsableObservation(obs, "reference-oracle");
    expect(checked.provenance.trustClass).toBe("VERIFIED_ORACLE");
    expect(checked.provenance.freshnessMs).toBe(1_200);
    expect(checked.provenance.sourceTimestamp).toBeTruthy();
    expect(a.validate(checked, ctx).ok).toBe(true);
  });
});

/* ─────────────────────────── selection determinism ────────────────────────── */

describe("ADAPTER-013 the model cannot override the deterministic resolver", () => {
  it("rejects a suggestion that fails the trust requirement", () => {
    const r = freshRegistry();
    expect(() =>
      resolveWithSuggestion(r, priceRequirement({ kind: "aave_position_health_factor", minimumTrustClass: "VERIFIED_ORACLE" }), {
        adapterId: "reference-chain-reader",
        adapterVersion: "1.0.0",
      }),
    ).toThrow(ModelOverrideRejectedError);
  });

  it("rejects a suggestion for an unregistered adapter", () => {
    const r = freshRegistry();
    expect(() =>
      resolveWithSuggestion(r, priceRequirement(), { adapterId: "totally-made-up", adapterVersion: "1.0.0" }),
    ).toThrow(/not registered/);
  });

  it("accepts a suggestion only when it independently satisfies the requirement", () => {
    const r = freshRegistry();
    const out = resolveWithSuggestion(r, priceRequirement(), { adapterId: "reference-oracle", adapterVersion: "1.0.0" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.selection.adapterId).toBe("reference-oracle");
  });

  it("resolution is deterministic and order-independent", () => {
    const a = resolveDataRequirement(freshRegistry(), priceRequirement());
    const b = resolveDataRequirement(freshRegistry(), priceRequirement());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("produces a rationale that names the trust and the bound", () => {
    const out = resolveDataRequirement(freshRegistry(), priceRequirement());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.selection.rationale).toContain("VERIFIED_ORACLE");
      expect(out.selection.rationale).toContain("30000ms");
    }
  });
});

describe("declared fallbacks", () => {
  it("validates a declared fallback at design time, not at failure time", () => {
    const r = freshRegistry();
    const out = resolveDataRequirement(
      r,
      priceRequirement({
        fallback: { adapterId: "reference-chain-reader", adapterVersion: "1.0.0", allowedTrust: "DIRECT_CHAIN_DATA", maxAgeMs: 60_000 },
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.selection.fallback?.adapterId).toBe("reference-chain-reader");
  });

  it("refuses a fallback weaker than the fallback's own declared trust", () => {
    const r = freshRegistry();
    const out = resolveDataRequirement(
      r,
      priceRequirement({
        fallback: { adapterId: "reference-chain-reader", adapterVersion: "1.0.0", allowedTrust: "VERIFIED_ORACLE", maxAgeMs: 60_000 },
      }),
    );
    expect(out.ok).toBe(true);
    // Selected primary stands; the fallback is dropped and the reason recorded.
    if (out.ok) {
      expect(out.selection.fallback).toBeUndefined();
      expect(out.rejected.some((x) => /declared fallback offers/.test(x.reason))).toBe(true);
    }
  });

  it("a fallback relaxes the bound only when explicitly used", () => {
    const req = priceRequirement({
      maxAgeMs: 3_000,
      fallback: { adapterId: "reference-chain-reader", adapterVersion: "1.0.0", allowedTrust: "DIRECT_CHAIN_DATA", maxAgeMs: 60_000 },
    });
    const obs = { provenance: { trustClass: "DIRECT_CHAIN_DATA" as const, freshnessMs: 30_000 } };
    // Without declaring fallback use, the primary rules apply and this fails on trust.
    expect(enforceRequirement(req, obs, false).ok).toBe(false);
    // Under the declared fallback it is acceptable.
    expect(enforceRequirement(req, obs, true).ok).toBe(true);
  });
});

/* ─────────────────────── execution output is untrusted ────────────────────── */

describe("ADAPTER-014 execution output is untrusted until decoded", () => {
  const constraints = {
    chainId: SEPOLIA,
    allowedTargets: ["0x00000000000000000000000000000000000000aa"],
    allowedRecipients: ["0x0000000000000000000000000000000000005e1f"],
    owner: "0x0000000000000000000000000000000000005e1f",
    allowUnlimitedApprovals: false,
    maxQuoteAgeMs: 30_000,
  };
  const intent = { token: "REF", amount: "500000000", recipient: "0x0000000000000000000000000000000000005e1f" };

  it("accepts a transaction that decodes to exactly the intent", async () => {
    const a = new ReferenceExecutionAdapter();
    const prepared = await a.buildTransaction(intent, { chainId: SEPOLIA, owner: constraints.owner, nowMs: 0 });
    const n = await a.decodeTransaction(prepared);
    expect(a.validateTransaction(n, intent, constraints).ok).toBe(true);
  });

  it("catches a provider whose SUMMARY is benign but whose CALLDATA pays an attacker", async () => {
    // The whole reason decodeTransaction ignores providerSummary. A provider that wanted to
    // mislead would look exactly like this.
    const attacker = "0x000000000000000000000000000000000000dead";
    const a = new ReferenceExecutionAdapter((i) => ({
      target: "0x00000000000000000000000000000000000000aa",
      calldata: `0xa9059cbb${attacker.slice(2).padStart(64, "0")}${BigInt(i.amount).toString(16).padStart(64, "0")}`,
      providerSummary: { recipient: i.recipient, amount: i.amount },
    }));
    const prepared = await a.buildTransaction(intent, { chainId: SEPOLIA, owner: constraints.owner, nowMs: 0 });
    // The summary still claims the honest recipient...
    expect(prepared.providerSummary.recipient).toBe(intent.recipient);
    // ...and the decode, which reads the bytes, disagrees.
    const n = await a.decodeTransaction(prepared);
    expect(n.recipient?.toLowerCase()).toBe(attacker);
    const v = a.validateTransaction(n, intent, constraints);
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.code === "REF-X3" && p.severity === "CRITICAL")).toBe(true);
  });

  it("catches an inflated amount in the calldata", async () => {
    const a = new ReferenceExecutionAdapter((i) => ({
      target: "0x00000000000000000000000000000000000000aa",
      calldata: `0xa9059cbb${i.recipient.slice(2).padStart(64, "0")}${(9_999_999_999n).toString(16).padStart(64, "0")}`,
      providerSummary: { recipient: i.recipient, amount: i.amount },
    }));
    const n = await a.decodeTransaction(await a.buildTransaction(intent, { chainId: SEPOLIA, owner: constraints.owner, nowMs: 0 }));
    const v = a.validateTransaction(n, intent, constraints);
    expect(v.problems.some((p) => p.code === "REF-X5")).toBe(true);
  });

  it("refuses to guess at an unrecognised selector", async () => {
    const a = new ReferenceExecutionAdapter(() => ({
      target: "0x00000000000000000000000000000000000000aa",
      calldata: "0xdeadbeef",
      providerSummary: { recipient: intent.recipient, amount: intent.amount },
    }));
    await expect(a.decodeTransaction(await a.buildTransaction(intent, { chainId: SEPOLIA, owner: constraints.owner, nowMs: 0 }))).rejects.toThrow(
      /unrecognised selector/,
    );
  });

  it("refuses a target outside the allow-list", async () => {
    const a = new ReferenceExecutionAdapter((i) => ({
      target: "0x000000000000000000000000000000000000beef",
      calldata: `0xa9059cbb${i.recipient.slice(2).padStart(64, "0")}${BigInt(i.amount).toString(16).padStart(64, "0")}`,
      providerSummary: { recipient: i.recipient, amount: i.amount },
    }));
    const n = await a.decodeTransaction(await a.buildTransaction(intent, { chainId: SEPOLIA, owner: constraints.owner, nowMs: 0 }));
    expect(a.validateTransaction(n, intent, constraints).problems.some((p) => p.code === "REF-X2")).toBe(true);
  });

  it("rejects a malformed intent before any provider is contacted", () => {
    const a = new ReferenceExecutionAdapter();
    const r = a.normalizeIntent({ token: "REF", amount: "not-a-number", recipient: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.code).sort()).toEqual(["REF-I1", "REF-I2"]);
  });
});

/* ────────────────────── ADAPTER-015 untrusted by default ──────────────────── */

describe("ADAPTER-015 user-supplied data defaults to untrusted", () => {
  it("USER_UNTRUSTED satisfies nothing above itself", () => {
    for (const c of ["EXTERNAL_API", "DIRECT_CHAIN_DATA", "INDEXED_CHAIN_DATA", "VERIFIED_ORACLE"] as const) {
      expect(satisfiesTrust("USER_UNTRUSTED", c)).toBe(false);
    }
    expect(satisfiesTrust("USER_UNTRUSTED", "USER_UNTRUSTED")).toBe(true);
  });

  it("the execution adapter's own manifest trust is USER_UNTRUSTED", () => {
    // An execution adapter reports what a provider built. That is a proposal, not an observation,
    // and it carries the weakest trust there is.
    expect(referenceExecutionManifest.trustClass).toBe("USER_UNTRUSTED");
  });
});

/* ──────────────────────── ADAPTER-012 commitment ──────────────────────────── */

describe("ADAPTER-012 a manifest or data mutation changes the commitment", () => {
  const obs = (over: Partial<DataObservation> = {}): DataObservation => ({
    observationId: "o1",
    dataKind: "collateral_asset_usd_price",
    value: "302144000000",
    unit: "USD",
    decimals: 8,
    observedAt: "2026-09-08T00:00:00.000Z",
    provenance: {
      provider: "contextlock-reference",
      adapterId: "reference-oracle",
      adapterVersion: "1.0.0",
      trustClass: "VERIFIED_ORACLE",
      sourceTimestamp: "2026-09-08T00:00:00.000Z",
      freshnessMs: 1_200,
      verification: { verified: true },
    },
    ...over,
  });

  it("is stable for identical input and order-independent", () => {
    const a = obs();
    const b = obs({ observationId: "o2", dataKind: "eth_usd_price" });
    expect(commitObservations([a, b])).toBe(commitObservations([b, a]));
    expect(commitObservations([a])).toBe(commitObservations([a]));
  });

  it("changes when the VALUE changes", () => {
    expect(commitObservations([obs()])).not.toBe(commitObservations([obs({ value: "1" })]));
  });

  it("changes when the ADAPTER VERSION changes", () => {
    // The same number from a different adapter version is not the same evidence.
    const other = obs();
    other.provenance = { ...other.provenance, adapterVersion: "1.1.0" };
    expect(commitObservations([obs()])).not.toBe(commitObservations([other]));
  });

  it("changes when the TRUST CLASS changes", () => {
    const other = obs();
    other.provenance = { ...other.provenance, trustClass: "INDEXED_CHAIN_DATA" };
    expect(commitObservations([obs()])).not.toBe(commitObservations([other]));
  });

  it("a bundle exposes its own hash", () => {
    const b = makeBundle([obs()]);
    expect(b.normalizedHash).toBe(commitObservations([obs()]));
    expect(b.bundleId).toContain(b.normalizedHash.slice(2));
  });
});

describe("KERNEL-050 the registry files an adapter by its contract, not by one literal", () => {
  /**
   * The kind mapping used to be `adapterType === "EXECUTION" ? "execution" : "data"`. That was
   * correct while CROSS_CHAIN was declared and unimplemented, and wrong the moment one existed: a
   * cross-chain send builds calldata and moves value, so filing it under "data" would put a
   * money-moving adapter on the contract meant for readings — no decodeTransaction, no
   * validateTransaction, no recipient check.
   */
  it("CROSS_CHAIN registers as an execution adapter", () => {
    expect(EXECUTION_ADAPTER_TYPES).toContain("EXECUTION");
    expect(EXECUTION_ADAPTER_TYPES).toContain("CROSS_CHAIN");
    const r = new AdapterRegistry();
    expect(() => r.register({ kind: "execution", manifest: ccipManifest, adapter: new ChainlinkCcipAdapter() })).not.toThrow();
    expect(r.resolve("chainlink-ccip", "1.0.0").kind).toBe("execution");
  });

  it("registering a cross-chain adapter as data is still a kind mismatch", () => {
    const r = new AdapterRegistry();
    expect(() => r.register({ kind: "data", manifest: ccipManifest, adapter: new ChainlinkCcipAdapter() as never }))
      .toThrow(/ADAPTER-KIND-MISMATCH/);
  });

  it("TRIGGER stays a data class: a trigger observes, it does not transact", () => {
    expect(EXECUTION_ADAPTER_TYPES).not.toContain("TRIGGER");
  });
});
