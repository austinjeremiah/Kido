import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactHash, verifyArtifact, ARTIFACT_REASONS } from "../src/artifact.js";
import { runConformance, proveDecodeIndependence, CONFORMANCE } from "../src/testkit.js";
import { encodeFunctionData } from "viem";
import { CCIP_ROUTER_ABI, ccipDeploymentFor } from "@contextlock/studio-adapters";
import { scaffoldAdapter } from "../src/scaffold.js";
import { main } from "../src/cli.js";
import { ccipManifest, ChainlinkCcipAdapter, aaveExecutionManifest, AaveExecutionAdapter } from "@contextlock/studio-adapters";

const OWNER = "0x0000000000000000000000000000000000005e1f";
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const ROUTER = ccipDeploymentFor(11155111).router;
const encodeCcip = () =>
  encodeFunctionData({
    abi: CCIP_ROUTER_ABI,
    functionName: "ccipSend",
    args: [
      10344971235874465080n,
      { receiver: `0x${"0".repeat(24)}${OWNER.slice(2)}` as `0x${string}`, data: "0x", tokenAmounts: [{ token: USDC as `0x${string}`, amount: 500_000_000n }], feeToken: "0x0000000000000000000000000000000000000000", extraArgs: "0x" },
    ],
  });

const files = [
  { path: "src/adapter.ts", content: "export class A {}" },
  { path: "src/manifest.ts", content: "export const m = 1;" },
];

const under = (over: Record<string, unknown> = {}) => ({
  manifest: ccipManifest,
  adapter: new ChainlinkCcipAdapter() as unknown as Record<string, unknown>,
  files,
  ...over,
});

const codes = (r: { findings: Array<{ code: string }> }) => r.findings.map((f) => f.code);

describe("the adapter artifact hash", () => {
  it("SDK-003 is stable and order-independent", () => {
    const a = artifactHash(files);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifactHash([...files].reverse())).toBe(a);
  });

  it("SDK-003b two different file sets never collide by concatenation", () => {
    // Without a length prefix, {a: "xy"} and {ax: "y"} hash the same.
    const x = artifactHash([{ path: "a", content: "xy" }]);
    const y = artifactHash([{ path: "ax", content: "y" }]);
    expect(x).not.toBe(y);
  });

  it("SDK-004 changed code under an unchanged version is ADAPTER_ARTIFACT_MISMATCH", () => {
    const pinned = { adapterId: "x", version: "1.0.0", artifactHash: artifactHash(files) };
    expect(verifyArtifact(pinned, files)).toEqual({ ok: true });

    // Same LENGTH, different content. A hash that only mixed in file sizes would pass a
    // different-length edit and miss this one, which is the edit an attacker would make.
    expect(files[0]!.content).toBe("export class A {}");
    const tampered = [{ ...files[0]!, content: "export class B {}" }, files[1]!];
    expect(tampered[0]!.content.length).toBe(files[0]!.content.length);
    const r = verifyArtifact(pinned, tampered);
    expect(r).toMatchObject({ ok: false, reason: ARTIFACT_REASONS.MISMATCH });
    if (r.ok) throw new Error("unreachable");
    // The message has to say what happened, because "hash mismatch" reads like corruption.
    expect(r.detail).toContain("Same version, different code");
  });

  it("an empty package cannot be pinned", () => {
    expect(() => artifactHash([])).toThrow(/ADAPTER_ARTIFACT_EMPTY/);
  });
});

describe("the conformance kit", () => {
  it("SDK-002a a first-party adapter passes", () => {
    const r = runConformance(under());
    expect(r.findings.filter((f) => f.severity === "CRITICAL").map((f) => `${f.code}: ${f.message}`)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.artifactHash).toMatch(/^sha256:/);
  });

  it("SDK-002b a malformed manifest is rejected with the offending path", () => {
    const r = runConformance(under({ manifest: { ...ccipManifest, id: "" } }));
    expect(codes(r)).toContain(CONFORMANCE.MANIFEST_INVALID);
    expect(r.ok).toBe(false);
  });

  it("SDK-002c a version range is refused: a range unpins a pinned Blueprint", () => {
    const r = runConformance(under({ manifest: { ...ccipManifest, version: "^1.0.0" } }));
    // The schema catches it first, and either way it cannot register.
    expect(codes(r).some((c) => c === CONFORMANCE.VERSION_RANGE || c === CONFORMANCE.MANIFEST_INVALID)).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("SDK-002d a manifest that disagrees with its implementation is refused", () => {
    const r = runConformance(under({ manifest: { ...ccipManifest, id: "pretending-to-be-someone-else" } }));
    expect(codes(r)).toContain(CONFORMANCE.IDENTITY_MISMATCH);
  });

  it("SDK-002e a third party cannot declare VERIFIED_ORACLE", () => {
    const r = runConformance(under({ manifest: { ...ccipManifest, provider: "acme-startup", trustClass: "VERIFIED_ORACLE" } }));
    expect(codes(r)).toContain(CONFORMANCE.TRUST_OVERCLAIM);
    expect(r.ok).toBe(false);
    // ...and a class it CAN support is fine, so the check discriminates rather than blocking all.
    const ok = runConformance(under({ manifest: { ...ccipManifest, provider: "acme-startup", trustClass: "EXTERNAL_API" } }));
    expect(codes(ok)).not.toContain(CONFORMANCE.TRUST_OVERCLAIM);
  });

  it("SDK-002f a live-looking credential anywhere in the manifest is refused", () => {
    // requiredSecretNames is already constrained to SCREAMING_CASE names by the schema, so the
    // interesting vector is a value smuggled into free text.
    const r = runConformance(under({
      manifest: { ...ccipManifest, documentation: { ...ccipManifest.documentation, notes: "use sk-abcdefghijklmnop0123456789 for staging" } },
    }));
    expect(codes(r)).toContain(CONFORMANCE.SECRET_IN_MANIFEST);
  });

  it("SDK-002g a credential in the generated template config is refused", () => {
    const r = runConformance(under({ templateConfig: { apiKey: "sk-abcdefghijklmnop0123456789" } }));
    expect(codes(r)).toContain(CONFORMANCE.SECRET_IN_CONFIG);
  });

  it("SDK-002h an execution adapter missing decodeTransaction is refused", () => {
    const broken = new ChainlinkCcipAdapter() as unknown as Record<string, unknown>;
    const stripped = Object.create(Object.getPrototypeOf(broken) as object) as Record<string, unknown>;
    Object.assign(stripped, broken);
    stripped.decodeTransaction = undefined;
    const r = runConformance(under({ adapter: stripped }));
    expect(codes(r)).toContain(CONFORMANCE.NO_DECODE);
  });

  it("SDK-002i decode independence is proved by behaviour, not by reading source", async () => {
    const honestData = encodeCcip();
    const probe = {
      prepared: { to: ROUTER, data: honestData, value: "0", chainId: 11155111, summary: { action: "CROSS_CHAIN_TOKEN_TRANSFER", receiver: OWNER, amount: "500000000" } },
      lying: { to: ROUTER, data: honestData, value: "0", chainId: 11155111, summary: { action: "NOTHING_HAPPENS", receiver: "0x000000000000000000000000000000000000dEaD", amount: "0" } },
    };

    // The real adapter records the summary for display and decides on none of it.
    expect(await proveDecodeIndependence(under({ summaryProbe: probe }))).toEqual([]);

    // An adapter that actually trusts the summary is caught.
    const cheat = new ChainlinkCcipAdapter() as unknown as Record<string, unknown>;
    const shim = Object.assign(Object.create(Object.getPrototypeOf(cheat) as object) as Record<string, unknown>, cheat);
    shim.decodeTransaction = async (p: { summary: { receiver: string } }) => ({ recipient: p.summary.receiver, actionType: "X" });
    const found = await proveDecodeIndependence(under({ adapter: shim, summaryProbe: probe }));
    expect(found.map((f) => f.code)).toContain(CONFORMANCE.DECODE_READS_SUMMARY);
  });

  it("SDK-002j an adapter with no probe is reported as unproven, not as passing", () => {
    const r = runConformance(under());
    expect(codes(r)).toContain(CONFORMANCE.DECODE_NOT_PROVEN);
    // MEDIUM, not CRITICAL: unexercised is not the same as broken.
    expect(r.findings.find((f) => f.code === CONFORMANCE.DECODE_NOT_PROVEN)!.severity).toBe("MEDIUM");
    expect(r.ok).toBe(true);
  });

  it("the real Aave execution adapter also passes", () => {
    const r = runConformance({ manifest: aaveExecutionManifest, adapter: new AaveExecutionAdapter() as never, files });
    expect(r.findings.filter((f) => f.severity === "CRITICAL")).toEqual([]);
  });
});

describe("the scaffolder and CLI", () => {
  it("SDK-001 a scaffolded adapter has a manifest, an adapter, a conformance test and a README", () => {
    const out = scaffoldAdapter({ id: "acme-risk", kind: "external-api", provider: "acme", chains: [11155111] });
    expect(out.map((f) => f.path).sort()).toEqual(["README.md", "package.json", "src/adapter.ts", "src/manifest.ts", "test/conformance.test.ts"]);
  });

  it("SDK-001b every security decision is left as a throw, not a plausible default", () => {
    const adapter = scaffoldAdapter({ id: "acme-risk", kind: "external-api", provider: "acme", chains: [11155111] })
      .find((f) => f.path === "src/adapter.ts")!.content;
    for (const fn of ["validateQuery", "normalize", "validate", "fixtureQuery"]) {
      expect(adapter, fn).toContain(fn);
    }
    // A scaffold that returned a permissive stub would let an author ship a decision they never made.
    expect(adapter.match(/throw new Error\("TODO/g)!.length).toBeGreaterThanOrEqual(4);
    expect(adapter).not.toMatch(/return \{ ok: true \}/);
  });

  it("SDK-001c a market-data scaffold does NOT start at VERIFIED_ORACLE", () => {
    const m = scaffoldAdapter({ id: "acme-price", kind: "verified-market-data", provider: "acme", chains: [11155111] })
      .find((f) => f.path === "src/manifest.ts")!.content;
    // Starting there is how an overclaim gets into a manifest by default rather than by decision.
    expect(m).toContain('trustClass: "EXTERNAL_API"');
    expect(m).not.toContain('trustClass: "VERIFIED_ORACLE"');
  });

  it("SDK-001d the CLI writes a working tree and refuses to clobber one", () => {
    const dir = mkdtempSync(join(tmpdir(), "scaffold-"));
    const target = join(dir, "acme");
    try {
      expect(main(["init", "--id", "acme-risk", "--kind", "external-api", "--dir", target])).toBe(0);
      expect(existsSync(join(target, "src/manifest.ts"))).toBe(true);
      expect(readFileSync(join(target, "README.md"), "utf8")).toContain("conformance kit");
      // Second run must not overwrite the author's edits.
      expect(main(["init", "--id", "acme-risk", "--kind", "external-api", "--dir", target])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SDK-001e an unknown kind is refused rather than defaulted", () => {
    expect(main(["init", "--id", "x", "--kind", "whatever"])).toBe(2);
  });

  it("SDK-001f verify does not import the adapter under test", () => {
    const dir = mkdtempSync(join(tmpdir(), "scaffold-"));
    const target = join(dir, "acme");
    try {
      main(["init", "--id", "acme-risk", "--kind", "external-api", "--dir", target]);
      // Loading third-party code to verify it would make verification the attack surface.
      expect(main(["verify", "--dir", target])).toBe(0);
      expect(readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8")).not.toMatch(/await import\(|require\(dir/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
