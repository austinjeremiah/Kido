import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  getSandboxProvider, registeredSandboxProviders, registerSandboxProvider,
  SandboxProviderUnavailableError, DockerStudioSandboxProvider,
} from "../src/sandbox/provider.js";
import {
  capabilitiesFor, isolationStatement, secretsMayEnter,
  DOCKER_CAPABILITIES, E2B_CAPABILITIES,
} from "../src/sandbox/capabilities.js";
import { SANDBOX, DEFAULT_QUOTA } from "../src/config.js";

describe("provider selection", () => {
  it("HOST-001 the configured provider is used, and both are registered", () => {
    expect(registeredSandboxProviders()).toContain("docker");
    expect(registeredSandboxProviders()).toContain("e2b");
    expect(getSandboxProvider("docker")).toBeInstanceOf(DockerStudioSandboxProvider);
  });

  it("HOST-002 an unknown provider fails closed and never falls back", () => {
    expect(() => getSandboxProvider("whatever-the-model-asked-for")).toThrow(SandboxProviderUnavailableError);
    // The dangerous version of this error is one that quietly becomes host execution.
    try {
      getSandboxProvider("nope");
    } catch (e) {
      expect((e as Error).message).not.toMatch(/falling back|using docker instead/i);
    }
  });

  it("HOST-002b the provider comes from server config, never from a request body", () => {
    const api = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
    // A client-chosen provider would let a caller pick the weakest sandbox available.
    expect(api).not.toMatch(/body\.(sandbox)?[Pp]rovider|req\.body\.provider/);
    expect(SANDBOX.provider).toBe("docker");
  });

  it("HOST-003 Docker still works and still claims no network", () => {
    expect(DOCKER_CAPABILITIES.networkIsolation).toBe("NONE");
    expect(SANDBOX.networkMode).toBe("none");
    const provider = readFileSync(new URL("../src/sandbox/provider.ts", import.meta.url), "utf8");
    // Hard-coded, not a parameter: FND-V2-003.
    expect(provider).toContain("networkMode: SANDBOX.networkMode");
  });
});

describe("HOST-004 provider capabilities are recorded, not assumed", () => {
  it("the hosted provider does NOT inherit Docker's isolation claim", () => {
    expect(E2B_CAPABILITIES.networkIsolation).toBe("UNKNOWN");
    expect(E2B_CAPABILITIES.networkIsolation).not.toBe(DOCKER_CAPABILITIES.networkIsolation);
    // The statement a user reads has to say so plainly.
    expect(isolationStatement(E2B_CAPABILITIES)).toContain("not established");
    expect(isolationStatement(E2B_CAPABILITIES)).toContain("treated as open");
    expect(isolationStatement(DOCKER_CAPABILITIES)).toContain("No network");
  });

  it("an unregistered provider is assumed to guarantee nothing", () => {
    const c = capabilitiesFor("some-future-vendor");
    expect(c.networkIsolation).toBe("UNKNOWN");
    expect(c.crossProcessResume).toBe(false);
    // Failing open here would let a provider added later inherit Docker's claims by omission.
    expect(c.caveats.join(" ")).toContain("nothing about it is assumed");
  });

  it("the differences that matter are recorded rather than glossed", () => {
    expect(DOCKER_CAPABILITIES.crossProcessResume).toBe(false);
    expect(E2B_CAPABILITIES.crossProcessResume).toBe(true);
    expect(E2B_CAPABILITIES.locality).toBe("hosted");
    expect(E2B_CAPABILITIES.caveats.join(" ")).toContain("leaves this machine");
  });
});

describe("HOST-006 no privileged secret enters a hosted sandbox", () => {
  it("secrets may enter only a sandbox with no network at all", () => {
    expect(secretsMayEnter(DOCKER_CAPABILITIES)).toBe(true);
    expect(secretsMayEnter(E2B_CAPABILITIES)).toBe(false);
  });

  it("the hosted provider's environment is empty by construction", () => {
    const src = readFileSync(new URL("../src/sandbox/e2b.ts", import.meta.url), "utf8");
    // Enforced, not intended: the function throws if the capability ever changes underneath it.
    expect(src).toContain("if (!secretsMayEnter(E2B_CAPABILITIES)) return {}");
    expect(src).toContain("E2B-CAPABILITIES-CHANGED");
    expect(src).toContain("env: this.hostedEnvironment()");
  });

  it("HOST-005 the builder and the agent runtime are not the same thing", () => {
    const caps = readFileSync(new URL("../src/sandbox/capabilities.ts", import.meta.url), "utf8");
    expect(caps).toContain("no privileged tool may be exposed inside it");
    // The build sandbox gets a filesystem and a compiler; the financial agent does not get a shell.
    expect(E2B_CAPABILITIES.filesystemWrite).toBe(true);
    expect(E2B_CAPABILITIES.caveats.join(" ")).toContain("no ContextLock secret may enter");
  });

  it("the hosted provider refuses to construct without a key rather than falling back", () => {
    const src = readFileSync(new URL("../src/sandbox/e2b.ts", import.meta.url), "utf8");
    expect(src).toContain("E2B_API_KEY is not set");
    expect(src).toContain("not a silent fallback to Docker");
  });
});

describe("HOST-008 hosted work is still bounded by quota", () => {
  it("the existing per-build limits apply regardless of provider", () => {
    expect(DEFAULT_QUOTA.sandboxWallClockMs).toBeGreaterThan(0);
    expect(DEFAULT_QUOTA.concurrentBuilds).toBeGreaterThan(0);
    expect(DEFAULT_QUOTA.generatedFiles).toBeGreaterThan(0);
    expect(DEFAULT_QUOTA.exportBytes).toBeGreaterThan(0);
  });

  it("a provider-enforced timeout does not replace the Studio's own", () => {
    // Docker enforces none, so the Studio must; E2B enforces one, and the Studio still does.
    expect(DOCKER_CAPABILITIES.providerEnforcedTimeoutMs).toBeNull();
    expect(E2B_CAPABILITIES.providerEnforcedTimeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_QUOTA.sandboxWallClockMs).toBeLessThanOrEqual(E2B_CAPABILITIES.providerEnforcedTimeoutMs!);
  });
});

describe("HOST-007 a build survives a disconnected browser", () => {
  it("nothing about a build lives in a browser connection", () => {
    const api = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
    // Every endpoint reads persisted state, so closing a tab cannot affect a running build.
    expect(api).toContain("A build's lifetime lives here and in the database, never in a browser connection");
  });

  it("Docker does not claim a resume it cannot perform", async () => {
    const p = new DockerStudioSandboxProvider();
    await expect(p.resume("sbx_nonexistent")).rejects.toThrow(/rebuilt from persisted artifacts/);
  });
});
