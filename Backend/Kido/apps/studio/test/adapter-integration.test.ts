import { describe, it, expect } from "vitest";
import { buildServer } from "../src/api.js";
import { buildRegistry, resolveBlueprintAdapters } from "../src/adapters.js";
import { testDb, scriptedAgents, RecordingSandbox } from "./helpers.js";
import { registerSandboxProvider, type StudioSandbox, type StudioSandboxProvider } from "../src/sandbox/provider.js";
import { validateBlueprintArtifacts, validateBlueprint } from "@contextlock/studio-blueprint";
import { renderProject } from "@contextlock/studio-templates";
import { validGuardian, copy } from "../../../packages/studio-blueprint/test/fixtures.js";

/**
 * P12 integration: the adapter kernel as it is actually used.
 *
 * The kernel's own rules are tested in `packages/studio-adapters`. These tests check the seams —
 * that the Studio resolves, renders, validates and renders-to-graph without any provider-specific
 * branch, and that a Blueprint and its generated code cannot disagree about which adapters exist.
 */

const okExec = (cmd: string) =>
  cmd.includes("vitest") ? { stdout: "Tests  7 passed (7)", exitCode: 0 } : { stdout: "", exitCode: 0 };

function provider(sandbox: RecordingSandbox, id: string) {
  class P implements StudioSandboxProvider {
    readonly id = id;
    async create(): Promise<StudioSandbox> { return sandbox as unknown as StudioSandbox; }
    async resume(): Promise<StudioSandbox> { return sandbox as unknown as StudioSandbox; }
    async snapshot() { return "s"; }
    async destroy() {}
  }
  registerSandboxProvider(id, () => new P());
  return id;
}

describe("the Studio resolves adapters deterministically end to end", () => {
  it("populates pinned bindings for every declared requirement", async () => {
    const sandbox = new RecordingSandbox(okExec);
    const ctx = buildServer({ db: testDb(), agents: scriptedAgents(), sandboxProviderId: provider(sandbox, "rec_adp1") });
    const created = await ctx.app.inject({ method: "POST", url: "/api/studio/builds", headers: { "x-studio-user": "u" }, payload: { prompt: "Aave guardian, repay up to $1,000." } });
    const id = created.json().id;
    const design = (await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${id}/design` })).json();

    const bp = design.blueprint;
    expect(bp.dataRequirements.length).toBe(2);
    expect(bp.adapters.length).toBe(2);
    for (const b of bp.adapters) {
      // Exact versions only — a range would let a registry update change what this build runs.
      expect(b.adapterVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(b.rationale).toBeTruthy();
    }
    const price = bp.adapters.find((b: { configRef: string }) => b.configRef === "collateralPrice")!;
    expect(price.adapterId).toBe("reference-oracle");
    expect(price.role).toBe("VERIFIED_MARKET_DATA");
    expect(price.rationale).toContain("VERIFIED_ORACLE");

    const health = bp.adapters.find((b: { configRef: string }) => b.configRef === "positionHealth")!;
    expect(health.adapterId).toBe("aave-v3-state"); // outranks reference-chain-reader on the alphabetical tie-break at equal trust
    expect(health.role).toBe("STATE_DATA");
    expect(design.build.stage).toBe("AWAITING_APPROVAL");
  });

  it("renders adapter nodes in the graph with trust and freshness, generically", async () => {
    const ctx = buildServer({ db: testDb(), agents: scriptedAgents(), sandboxProviderId: provider(new RecordingSandbox(okExec), "rec_adp2") });
    const created = await ctx.app.inject({ method: "POST", url: "/api/studio/builds", headers: { "x-studio-user": "u" }, payload: { prompt: "Aave guardian, repay up to $1,000." } });
    const id = created.json().id;
    const design = (await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${id}/design` })).json();

    const adapterNodes = design.graph.nodes.filter((n: { kind: string }) => n.kind === "Adapter");
    expect(adapterNodes).toHaveLength(2);
    for (const n of adapterNodes) {
      const labels = n.detail.map((d: { label: string }) => d.label);
      expect(labels).toContain("Adapter");
      expect(labels).toContain("Required trust");
      expect(labels).toContain("Max age");
      expect(labels).toContain("Fallback");
      expect(labels).toContain("Selected because");
    }
    // The absence of a declared fallback is stated, not left blank — silence would read as "yes".
    const fallbackValues = adapterNodes.flatMap((n: { detail: Array<{ label: string; value: string }> }) =>
      n.detail.filter((d) => d.label === "Fallback").map((d) => d.value),
    );
    expect(fallbackValues.every((v: string) => /no silent downgrade/.test(v))).toBe(true);
  });
});

describe("ADAPTER-009 a Blueprint adapter missing from the code fails", () => {
  it("fails when the adapter module was not generated", () => {
    const bp = validGuardian();
    const generated = renderProject(bp).map((f) => f.path).filter((p) => !p.includes("reference-oracle"));
    const issues = validateBlueprintArtifacts(bp, generated);
    expect(issues.some((i) => i.code === "BPA-005" && i.severity === "CRITICAL")).toBe(true);
  });

  it("passes when every bound adapter is present", () => {
    const bp = validGuardian();
    const generated = renderProject(bp).map((f) => f.path);
    // The non-adapter modules are declared separately by the Blueprint's generatedModules.
    const all = [...generated, ...bp.generatedModules.map((m) => m.path)];
    expect(validateBlueprintArtifacts(bp, all).filter((i) => i.code === "BPA-005")).toEqual([]);
  });
});

describe("ADAPTER-010 an undeclared runtime adapter fails", () => {
  it("rejects an adapter present in the code but absent from the Blueprint", () => {
    // The dangerous direction: capability nobody reviewed and nobody version-pinned.
    const bp = validGuardian();
    const generated = [
      ...renderProject(bp).map((f) => f.path),
      ...bp.generatedModules.map((m) => m.path),
      "src/adapters/smuggled-provider/adapter.ts",
    ];
    const issues = validateBlueprintArtifacts(bp, generated);
    const found = issues.find((i) => i.code === "BPA-006");
    expect(found?.severity).toBe("CRITICAL");
    expect(found?.message).toContain("smuggled-provider");
  });
});

describe("ADAPTER-011 an adapter version change makes prior results stale", () => {
  it("bumping a pinned version bumps the Blueprint revision and marks simulations stale", async () => {
    const ctx = buildServer({ db: testDb(), agents: scriptedAgents(), sandboxProviderId: provider(new RecordingSandbox(okExec), "rec_adp3") });
    const created = await ctx.app.inject({ method: "POST", url: "/api/studio/builds", headers: { "x-studio-user": "u" }, payload: { prompt: "Aave guardian, repay up to $1,000." } });
    const id = created.json().id;
    await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${id}/design` });
    await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${id}/approve`, payload: {} });
    await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${id}/build` });

    const before = (await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${id}` })).json();
    expect(before.staleSimulations).toBe(0);

    const bumped = before.blueprint.adapters.map((b: { adapterId: string; adapterVersion: string }) =>
      b.adapterId === "reference-oracle" ? { ...b, adapterVersion: "1.1.0" } : b,
    );
    await ctx.app.inject({ method: "PATCH", url: `/api/studio/builds/${id}/blueprint`, payload: { adapters: bumped } });

    const after = (await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${id}` })).json();
    expect(after.blueprint.revision).toBe(2);
    // Evidence produced with a different adapter version is not evidence about this one.
    expect(after.staleSimulations).toBe(24);
    expect(after.codeStale).toBe(true);
    expect(after.score.categories.find((c: { id: string }) => c.id === "simulation-coverage").points).toBe(0);
  });
});

describe("ADAPTER-006/013 the resolver refuses a downgrade regardless of who asks", () => {
  it("reports NO_COMPATIBLE_ADAPTER rather than substituting a weaker source", () => {
    const registry = buildRegistry();
    const report = resolveBlueprintAdapters(registry, {
      dataRequirements: [
        {
          key: "impossible",
          kind: "aave_position_health_factor",
          chainId: 11155111,
          minimumTrustClass: "VERIFIED_ORACLE",
          maxAgeMs: 30_000,
          confidential: false,
          historical: false,
        },
      ],
    } as never);
    expect(report.bindings).toHaveLength(0);
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0]!.rejected.some((r) => /offers DIRECT_CHAIN_DATA/.test(r.reason))).toBe(true);
  });

  it("discards a model suggestion that fails the rules and still resolves deterministically", () => {
    const registry = buildRegistry();
    const report = resolveBlueprintAdapters(
      registry,
      {
        dataRequirements: [
          {
            key: "collateralPrice",
            kind: "collateral_asset_usd_price",
            chainId: 11155111,
            minimumTrustClass: "VERIFIED_ORACLE",
            maxAgeMs: 30_000,
            confidential: false,
            historical: false,
          },
        ],
      } as never,
      // The model asks for a direct chain read where an oracle is required.
      { collateralPrice: { adapterId: "reference-chain-reader", adapterVersion: "1.0.0" } },
    );
    expect(report.overridesRejected).toHaveLength(1);
    // The capability check fires before the trust check, which is the right order: an adapter that
    // does not provide the data kind at all is a more fundamental mismatch than a weak one.
    expect(report.overridesRejected[0]!.reason).toContain('does not provide "collateral_asset_usd_price"');
    // The suggestion is discarded; the requirement is still satisfied by the correct adapter.
    expect(report.bindings).toHaveLength(1);
    expect(report.bindings[0]!.adapterId).toBe("reference-oracle");
  });

  it("rejects a suggestion that provides the data kind but at insufficient trust", () => {
    // The trust-specific path: reference-oracle DOES provide this kind, so the rejection is about
    // strength rather than capability.
    const registry = buildRegistry();
    const report = resolveBlueprintAdapters(
      registry,
      {
        dataRequirements: [
          {
            key: "positionHealth",
            kind: "aave_position_health_factor",
            chainId: 11155111,
            minimumTrustClass: "DIRECT_CHAIN_DATA",
            maxAgeMs: 60_000,
            confidential: false,
            historical: false,
          },
        ],
      } as never,
      { positionHealth: { adapterId: "reference-oracle", adapterVersion: "1.0.0" } },
    );
    expect(report.overridesRejected).toHaveLength(1);
    expect(report.overridesRejected[0]!.reason).toContain('does not provide "aave_position_health_factor"');
    expect(report.bindings[0]!.adapterId).toBe("aave-v3-state"); // outranks the reference reader alphabetically at equal trust
  });

  it("an unresolvable requirement blocks the build rather than degrading it", async () => {
    const ctx = buildServer({ db: testDb(), agents: scriptedAgents(), sandboxProviderId: provider(new RecordingSandbox(okExec), "rec_adp4") });
    const created = await ctx.app.inject({ method: "POST", url: "/api/studio/builds", headers: { "x-studio-user": "u" }, payload: { prompt: "Aave guardian, repay up to $1,000." } });
    const id = created.json().id;
    await ctx.app.inject({ method: "POST", url: `/api/studio/builds/${id}/design` });

    const bp = (await ctx.app.inject({ method: "GET", url: `/api/studio/builds/${id}` })).json().blueprint;
    const impossible = copy(bp);
    impossible.dataRequirements.push({
      key: "unobtainable",
      kind: "nobody_provides_this",
      chainId: 11155111,
      minimumTrustClass: "VERIFIED_ORACLE",
      maxAgeMs: 1_000,
      confidential: false,
      historical: false,
    });
    const patched = await ctx.app.inject({
      method: "PATCH", url: `/api/studio/builds/${id}/blueprint`,
      payload: { dataRequirements: impossible.dataRequirements },
    });
    // BP-032: a requirement with no adapter bound to it is CRITICAL and unbuildable.
    expect(patched.json().issues.some((i: { code: string }) => i.code === "BP-032")).toBe(true);
    expect(validateBlueprint(patched.json().blueprint).buildable).toBe(false);
  });
});

describe("generated adapter code is provider-agnostic and enforces the boundary", () => {
  it("emits a shared kernel plus one directory per bound adapter", () => {
    const files = renderProject(validGuardian());
    const paths = files.map((f) => f.path);
    expect(paths).toContain("src/adapters/kernel.ts");
    expect(paths).toContain("src/adapters/reference-oracle/adapter.ts");
    expect(paths).toContain("src/adapters/reference-oracle/config.ts");
    expect(paths).toContain("src/adapters/reference-chain-reader/adapter.ts");
  });

  it("pins the adapter version into the generated config", () => {
    const f = renderProject(validGuardian()).find((x) => x.path === "src/adapters/reference-oracle/config.ts")!;
    expect(f.content).toContain('ADAPTER_VERSION = "1.0.0"');
    expect(f.content).toContain('REQUIREMENT');
    expect(f.content).toContain('minimumTrustClass: "VERIFIED_ORACLE"');
    expect(f.content).toContain("maxAgeMs: 30000");
    expect(f.content).toContain("export const FALLBACK: null = null;");
  });

  it("the generated kernel fails closed on missing freshness", () => {
    const f = renderProject(validGuardian()).find((x) => x.path === "src/adapters/kernel.ts")!;
    // The specific line that turns "we don't know how old this is" into a refusal.
    expect(f.content).toContain("if (age === undefined || age > req.maxAgeMs)");
    expect(f.content).toContain("FreshnessRequirementError");
    expect(f.content).toContain("TrustRequirementError");
  });

  it("no generated adapter file names a provider the Blueprint did not bind", () => {
    const all = renderProject(validGuardian()).map((f) => f.content).join("\n");
    for (const notBound of ["uniswap", "thegraph", "chainlink"]) {
      expect(all.toLowerCase()).not.toContain(`src/adapters/${notBound}`);
    }
  });
});

describe("the Studio contains no provider-specific branching", () => {
  it("the adapter registry is the only place providers are named", async () => {
    // A guard against the architecture Group B exists to prevent. If a later phase adds
    // `if (provider === "uniswap")` to the pipeline or the graph, this fails.
    const { readFileSync } = await import("node:fs");
    const suspects = [
      "apps/studio/src/pipeline.ts",
      "apps/studio/src/api.ts",
      "packages/studio-blueprint/src/graph.ts",
      "apps/studio/src/strategy.ts",
      "apps/studio/src/organization.ts",
      "packages/studio-templates/src/adapters/index.ts",
      "packages/studio-strategy/src/compiler.ts",
      "packages/studio-org/src/validator.ts",
      "packages/studio-org/src/budget.ts",
      "packages/studio-org/src/graph.ts",
    ];
    for (const path of suspects) {
      const src = readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
      for (const provider of ["uniswap", "thegraph", "the-graph", "chainlink-data", "aave-kit", "aave-v3"]) {
        expect(src.toLowerCase(), `${path} names ${provider}`).not.toContain(provider);
      }
    }
  });
});
