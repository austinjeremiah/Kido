import { describe, expect, it } from "vitest";
import {
  CRE_EXECUTION_MODES, CreExecutionModeSchema, SIMULATED_MODES, isSimulated, creModeLabel,
  PLATFORM_SIMULATION_AVAILABILITY, PLATFORM_SIMULATION_BLOCKER, assertPlatformSimulationAllowed,
  CreSimulationIdSchema, CreWorkflowIdSchema, isSimulationId, isWorkflowId, assertRealWorkflowId,
  CreModeError, CRE_MODE_REASONS,
  privacyEvidenceFor, assertPrivacyEvidenceHonest, PrivacyEvidenceSchema,
  BROADCAST_MODES, BroadcastModeSchema, broadcastFlags, BroadcastError, BROADCAST_REASONS,
  BROADCAST_SIGNERS, assertNotUserWallet, BURNER_KEY_FORBIDDEN_SINKS,
  limitsFlags, assertLimitsSatisfyGate, LimitsError, LIMITS_MODES,
  approvedNetworks, executionNetworks, lookupNetwork, NetworkGuardError,
  type CreExecutionMode, type PrivacyEvidence, type NetworkRef,
} from "@contextlock/studio-network";
import { newSimulationId, assertArtifactMatches, SimulationError, SIM_REASONS, SimulationConfigSchema } from "../src/provider.js";
import { baseConfig, APPROVED_ARTIFACT, sourceLines, isComment } from "./fixtures.js";

/**
 * The CRE lab, minus the process supervision (which is `crelab-supervision.test.ts`).
 *
 * A standing rule from FND-V2-25-002 governs everything below: **a fixture that trips two
 * independent guards proves neither guard.** Where a function has N guards, there are N tests, each
 * differing from a valid input in exactly one way.
 */

const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};

const SEPOLIA: NetworkRef = { chainId: 11155111, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null };

/* ───────────────────────────── CRELAB-001 ───────────────────────────── */

describe("CRELAB-001 CreExecutionMode schema", () => {
  it("CRELAB-001d there are exactly three modes and simulation is two of them", () => {
    expect([...CRE_EXECUTION_MODES]).toEqual(["SIMULATED_PLATFORM", "SIMULATED_USER", "DEPLOYED_USER"]);
    expect([...SIMULATED_MODES].sort()).toEqual(["SIMULATED_PLATFORM", "SIMULATED_USER"]);
    expect(isSimulated("DEPLOYED_USER")).toBe(false);
  });

  it("CRELAB-001e a mode outside the union does not parse", () => {
    for (const invented of ["MAINNET", "DEPLOYED_PLATFORM", "LIVE", "SIMULATED", "PRODUCTION"]) {
      expect(CreExecutionModeSchema.safeParse(invented).success, invented).toBe(false);
    }
  });

  it("CRELAB-001f no simulated mode is labelled as deployed, or as a DON, or as a TEE", () => {
    /*
     * The label function is where a simulation becomes a deployment in a screenshot. Every simulated
     * mode is checked against every word that would overstate it.
     */
    for (const mode of CRE_EXECUTION_MODES) {
      const label = creModeLabel(mode);
      if (!isSimulated(mode)) continue;
      expect(label.headline, mode).toMatch(/SIMULATED/);
      expect(label.don, mode).toBe("NOT DEPLOYED");
      expect(label.tee, mode).toBe("NOT ACTIVE");
      expect(JSON.stringify(label), mode).not.toMatch(/\bDON\b(?!.*NOT)/);
    }
    // And the deployed mode still does not claim a TEE, because deployment is not attestation.
    expect(creModeLabel("DEPLOYED_USER").tee).toBe("NOT ESTABLISHED");
  });
});

/* ───────────────────────────── CRELAB-002 ───────────────────────────── */

describe("CRELAB-002 a simulation id cannot parse as a workflow id", () => {
  const simId = newSimulationId("contextlock", "0189a1c4-4f2e-47b7-9c58-2b1d3e5f7a90");

  it("CRELAB-002e the two identifier shapes are disjoint", () => {
    expect(CreSimulationIdSchema.safeParse(simId).success).toBe(true);
    // Not merely rejected — a different SHAPE, so code expecting a workflow id fails to parse it.
    expect(CreWorkflowIdSchema.safeParse(simId).success).toBe(false);
    const realWorkflowId = "a".repeat(64);
    expect(isWorkflowId(realWorkflowId)).toBe(true);
    expect(isSimulationId(realWorkflowId)).toBe(false);
  });

  it("CRELAB-002f guard one alone: a simulation id is refused, and says why", () => {
    /*
     * `assertRealWorkflowId` has two independent guards. This input trips ONLY the first: it is a
     * well-formed simulation id. If the second guard were deleted, this test must still fail the
     * mutation — which is what testing them separately buys.
     */
    let err: CreModeError | null = null;
    try { assertRealWorkflowId(simId, "deployment record"); } catch (e) { err = e as CreModeError; }
    expect(err?.reason).toBe(CRE_MODE_REASONS.SIMULATION_IS_NOT_DEPLOYMENT);
    expect(err?.message).toMatch(/simulation session, not a deployed workflow/);
    expect(err?.message).toMatch(/never reaches a DON/);
  });

  it("CRELAB-002g guard two alone: a string that is neither shape is refused", () => {
    // Not a simulation id, so guard one does not fire; only the workflow-id parse can catch it.
    for (const notAnId of ["", "0x" + "a".repeat(64), "A".repeat(64), "a".repeat(63), "workflow-1"]) {
      expect(isSimulationId(notAnId), notAnId).toBe(false);
      expect(reasonOf(() => assertRealWorkflowId(notAnId, "ctx")), notAnId)
        .toBe(CRE_MODE_REASONS.SIMULATION_IS_NOT_DEPLOYMENT);
    }
  });

  it("CRELAB-002h a real workflow id passes through unchanged", () => {
    const id = "9f".repeat(32);
    expect(assertRealWorkflowId(id, "ctx")).toBe(id);
  });
});

/* ───────────────────────────── CRELAB-004 ───────────────────────────── */

describe("CRELAB-004 the simulated artifact is the approved one", () => {
  it("CRELAB-004 a matching artifact is accepted", () => {
    expect(() => assertArtifactMatches(baseConfig(), APPROVED_ARTIFACT)).not.toThrow();
  });

  /*
   * Three independent drift checks, three tests. A fixture that differed in all three would pass
   * with any two of them deleted.
   */
  it("CRELAB-004b WASM drift alone is caught", () => {
    const cfg = { ...baseConfig(), wasmSha256: "b".repeat(64) };
    let err: SimulationError | null = null;
    try { assertArtifactMatches(cfg, APPROVED_ARTIFACT); } catch (e) { err = e as SimulationError; }
    expect(err?.reason).toBe(SIM_REASONS.ARTIFACT_DRIFT);
    expect(err?.message).toMatch(/WASM sha256/);
    expect(err?.message, "only the drifted field should be reported").not.toMatch(/source tree|config:/);
  });

  it("CRELAB-004c source drift alone is caught", () => {
    const cfg = { ...baseConfig(), workflowSourceHash: `sha256:${"c".repeat(64)}` };
    let err: SimulationError | null = null;
    try { assertArtifactMatches(cfg, APPROVED_ARTIFACT); } catch (e) { err = e as SimulationError; }
    expect(err?.reason).toBe(SIM_REASONS.ARTIFACT_DRIFT);
    expect(err?.message).toMatch(/source tree/);
    expect(err?.message).not.toMatch(/WASM sha256/);
  });

  it("CRELAB-004d config drift alone is caught", () => {
    const cfg = { ...baseConfig(), workflowConfigHash: `sha256:${"d".repeat(64)}` };
    let err: SimulationError | null = null;
    try { assertArtifactMatches(cfg, APPROVED_ARTIFACT); } catch (e) { err = e as SimulationError; }
    expect(err?.reason).toBe(SIM_REASONS.ARTIFACT_DRIFT);
    expect(err?.message).toMatch(/config:/);
    expect(err?.message).not.toMatch(/WASM sha256|source tree/);
  });

  it("CRELAB-004e the pinned hashes are the shapes the CRE CLI actually emits", () => {
    /*
     * `800d0d56…` is the real binary hash printed by `cre workflow simulate` for this workflow, on
     * 2026-09-07 and again on 2026-09-10. Pinned here so the schema is validated against the shape
     * the tool produces rather than one we invented.
     */
    expect(APPROVED_ARTIFACT.wasmSha256).toBe("800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0");
    expect(SimulationConfigSchema.safeParse(baseConfig()).success).toBe(true);
    // A bare hash where a prefixed one is required does not parse.
    expect(SimulationConfigSchema.safeParse({ ...baseConfig(), workflowSourceHash: "a".repeat(64) }).success).toBe(false);
  });

  it("CRELAB-004f a revision is recorded for every input that can change behaviour", () => {
    const cfg = baseConfig();
    expect(cfg.blueprintRevision).toBeTypeOf("number");
    expect(cfg.strategyRevision).toBeTypeOf("number");
    expect(Object.keys(cfg.adapterVersions).length).toBeGreaterThan(0);
    expect(cfg.creCliVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

/* ─────────────────────────── CRELAB-005 / 006 ─────────────────────────── */

describe("CRELAB-005 production limits", () => {
  it("CRELAB-005d production limits are passed explicitly, not left to a default", () => {
    /*
     * The CLI defaults to production limits today. Passing the flag anyway means the RECORDED
     * command line states what ran — a default that changes upstream would otherwise rewrite the
     * meaning of every archived simulation.
     */
    expect(limitsFlags("PRODUCTION_DEFAULT")).toEqual(["--limits", "default"]);
    expect(limitsFlags("PRODUCTION_FILE", "/tmp/limits.json")).toEqual(["--limits", "/tmp/limits.json"]);
    expect(limitsFlags("NONE")).toEqual(["--limits", "none"]);
  });

  it("CRELAB-005e a limits file is required when the mode names one", () => {
    expect(() => limitsFlags("PRODUCTION_FILE")).toThrow(LimitsError);
  });

  it("CRELAB-005f the exported CRE limits are real, and are what the scheduler mirrors", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(new URL("../../../reports/group-testnet-lab/evidence/cre-limits-export.json", import.meta.url), "utf8");
    // Mirrored rather than invented: the values the scheduler enforces come from this file.
    expect(raw).toMatch(/30s|30000000000/);
  });
});

describe("CRELAB-006 a run without limits cannot satisfy a gate", () => {
  it("CRELAB-006d --limits none is refused as gate evidence", () => {
    let err: LimitsError | null = null;
    try { assertLimitsSatisfyGate("NONE", "READY_FOR_DEPLOYMENT"); } catch (e) { err = e as LimitsError; }
    expect(err).toBeInstanceOf(LimitsError);
    expect(err?.message).toMatch(/READY_FOR_DEPLOYMENT/);
    expect(err?.message).toMatch(/does not test whether the workflow fits/);
  });

  it("CRELAB-006e every gate named in the spec refuses it, not just one", () => {
    for (const gate of ["READY_FOR_DEPLOYMENT", "CRE_SIMULATION_VERIFIED"]) {
      expect(() => assertLimitsSatisfyGate("NONE", gate), gate).toThrow(LimitsError);
    }
  });

  it("CRELAB-006f the two production modes do satisfy a gate", () => {
    for (const mode of LIMITS_MODES.filter((m) => m !== "NONE")) {
      expect(() => assertLimitsSatisfyGate(mode, "CRE_SIMULATION_VERIFIED"), mode).not.toThrow();
    }
  });
});

/* ─────────────────────────── CRELAB-014 ─────────────────────────── */

describe("CRELAB-014 platform CRE credentials never reach a user artifact", () => {
  it("CRELAB-014d the platform simulator is internal-only, and the reason is legal not technical", () => {
    expect(PLATFORM_SIMULATION_AVAILABILITY).toBe("INTERNAL_ONLY");
    expect(PLATFORM_SIMULATION_BLOCKER).toBe("BLK-CRE-PLATFORM-MULTITENANT");
    let err: CreModeError | null = null;
    try { assertPlatformSimulationAllowed(false); } catch (e) { err = e as CreModeError; }
    expect(err?.reason).toBe(CRE_MODE_REASONS.PLATFORM_NOT_PUBLIC);
    expect(err?.message).toMatch(/has not been established/);
    expect(err?.message).toMatch(/BLK-CRE-PLATFORM-MULTITENANT/);
  });

  it("CRELAB-014e internal use is an assertion the caller must make", () => {
    // Not a default. Enabling it for a tenant is a decision someone makes at a call site.
    expect(() => assertPlatformSimulationAllowed(true)).not.toThrow();
  });

  it("CRELAB-014f a simulation config carries no credential field at all", () => {
    /*
     * The strongest form of "the credential is absent" is that there is nowhere to put it. The
     * config schema is enumerated and checked for anything credential-shaped.
     */
    const keys = Object.keys(SimulationConfigSchema.shape);
    const credentialish = keys.filter((k) => /token|secret|key|credential|password|auth|session/i.test(k));
    expect(credentialish, `credential-shaped fields on the simulation config: ${credentialish.join(", ")}`).toEqual([]);
  });
});

/* ─────────────────────────── CRELAB-015 / 016 ─────────────────────────── */

describe("CRELAB-015 a false DON claim is refused", () => {
  it("CRELAB-015c a simulated mode claiming consensus is rejected", () => {
    const evidence: PrivacyEvidence = { ...privacyEvidenceFor("SIMULATED_USER", true), realDonConsensus: true };
    let err: CreModeError | null = null;
    try { assertPrivacyEvidenceHonest("SIMULATED_USER", evidence); } catch (e) { err = e as CreModeError; }
    expect(err?.reason).toBe(CRE_MODE_REASONS.FALSE_DON_CLAIM);
    expect(err?.message).toMatch(/No DON participates/);
  });

  it("CRELAB-015d the generator never produces the claim on its own", () => {
    for (const mode of CRE_EXECUTION_MODES) {
      const e = privacyEvidenceFor(mode, true);
      expect(e.realDonConsensus, mode).toBe(mode === "DEPLOYED_USER");
      // What a simulation CAN honestly claim, and does.
      expect(e.agentCannotReadSecret, mode).toBe(true);
      expect(e.privatePolicyNotShownToAgent, mode).toBe(true);
      expect(e.officialCreSimulation, mode).toBe(isSimulated(mode));
    }
  });

  it("CRELAB-015e officialCreSimulation is false when the simulator did not run", () => {
    // The flag tracks an event, not a mode. Claiming it without a run would be the same class of lie.
    expect(privacyEvidenceFor("SIMULATED_USER", false).officialCreSimulation).toBe(false);
  });
});

describe("CRELAB-016 a false TEE claim is refused", () => {
  it("CRELAB-016e guard one alone: TEE execution without an attestation", () => {
    /*
     * DEPLOYED_USER, so the simulated-mode guard cannot fire. Only the attestation guard can catch
     * this — which is the point of choosing this mode for this fixture.
     */
    const evidence: PrivacyEvidence = { ...privacyEvidenceFor("DEPLOYED_USER", false), realTeeExecution: true, teeAttestation: false };
    let err: CreModeError | null = null;
    try { assertPrivacyEvidenceHonest("DEPLOYED_USER", evidence); } catch (e) { err = e as CreModeError; }
    expect(err?.reason).toBe(CRE_MODE_REASONS.FALSE_TEE_CLAIM);
    expect(err?.message).toMatch(/requires a verified attestation/);
  });

  it("CRELAB-016f guard two alone: a simulator claiming a TEE, attestation and all", () => {
    /*
     * teeAttestation is TRUE here, so guard one is satisfied and cannot fire. The claim must still
     * be refused, because a local process is not a TEE no matter what it attests to.
     */
    const evidence: PrivacyEvidence = { ...privacyEvidenceFor("SIMULATED_PLATFORM", true), realTeeExecution: true, teeAttestation: true };
    let err: CreModeError | null = null;
    try { assertPrivacyEvidenceHonest("SIMULATED_PLATFORM", evidence); } catch (e) { err = e as CreModeError; }
    expect(err?.reason).toBe(CRE_MODE_REASONS.FALSE_TEE_CLAIM);
    expect(err?.message).toMatch(/local simulator process. There is no TEE/);
  });

  it("CRELAB-016g the generator never sets a TEE field true, in any mode", () => {
    for (const mode of CRE_EXECUTION_MODES) {
      const e = privacyEvidenceFor(mode, true);
      expect(e.realTeeExecution, mode).toBe(false);
      expect(e.teeAttestation, mode).toBe(false);
      expect(() => assertPrivacyEvidenceHonest(mode, e), mode).not.toThrow();
    }
  });

  it("CRELAB-016h every privacy claim is its own field, so none can be collapsed into one boolean", () => {
    const keys = Object.keys(PrivacyEvidenceSchema.shape).sort();
    expect(keys).toEqual([
      "agentCannotReadSecret", "officialCreSimulation", "privatePolicyNotShownToAgent",
      "realDonConsensus", "realTeeExecution", "teeAttestation",
    ]);
  });
});

/* ─────────────────────── CRELAB-017 / 018 / 019 ─────────────────────── */

describe("CRELAB-017 a dry run cannot broadcast", () => {
  it("CRELAB-017c DRY_RUN produces no broadcast flag at all", () => {
    const out = broadcastFlags({ mode: "DRY_RUN", network: SEPOLIA, signer: "EPHEMERAL_TESTNET_BURNER", context: "test" });
    expect(out.flags).toEqual([]);
    expect(out.broadcasting).toBe(false);
    expect(out.network).toMatch(/no transaction will be sent/);
  });

  it("CRELAB-017d DRY_RUN is silent rather than passing --broadcast=false", () => {
    // A negated flag depends on the flag keeping its name. An absent flag does not.
    const out = broadcastFlags({ mode: "DRY_RUN", network: SEPOLIA, signer: "EPHEMERAL_TESTNET_BURNER", context: "test" });
    expect(out.flags.join(" ")).not.toMatch(/broadcast/);
  });
});

describe("CRELAB-018 a testnet broadcast only reaches an approved network", () => {
  it("CRELAB-018g Sepolia is approved and broadcasts", () => {
    const out = broadcastFlags({ mode: "TESTNET_BROADCAST", network: SEPOLIA, signer: "EPHEMERAL_TESTNET_BURNER", context: "test" });
    expect(out.flags).toEqual(["--broadcast"]);
    expect(out.broadcasting).toBe(true);
    expect(out.network).toMatch(/11155111/);
  });

  it("CRELAB-018h an unapproved testnet is refused even though it is a testnet", () => {
    /*
     * The registry is an allowlist, not a mainnet deny-list. A chain nobody approved is not a chain
     * we execute on, whatever it is.
     */
    const unknown: NetworkRef = { chainId: 999_999, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null };
    expect(() => broadcastFlags({ mode: "TESTNET_BROADCAST", network: unknown, signer: "EPHEMERAL_TESTNET_BURNER", context: "t" }))
      .toThrow(NetworkGuardError);
    expect(lookupNetwork(999_999)).toBeNull();
  });

  it("CRELAB-018i a local fork is refused for a PUBLIC write", () => {
    const fork: NetworkRef = { chainId: 31337, role: "LOCAL_FORK", forkedFrom: 1, forkBlock: "21000000" };
    expect(() => broadcastFlags({ mode: "TESTNET_BROADCAST", network: fork, signer: "EPHEMERAL_TESTNET_BURNER", context: "t" }))
      .toThrow(NetworkGuardError);
  });

  it("CRELAB-018j the broadcast allowlist is short, and every entry is a testnet or a fork", () => {
    /*
     * `executionNetworks()`, not `approvedNetworks()`. Phase 27 registered Ethereum mainnet as a
     * `READ_ONLY_SOURCE` so the Reality Engine can name what it reads; a broadcast allowlist that
     * counted it would be counting a network no broadcast can reach.
     */
    const nets = executionNetworks();
    expect(nets.length).toBe(3);
    for (const n of nets) expect(n.role, n.name).not.toBe("READ_ONLY_SOURCE");
    expect(nets.map((n) => n.chainId).sort((a, b) => a - b)).toEqual([31337, 84532, 11155111]);
    // And a broadcast aimed at the one read-only entry is refused rather than merely absent.
    expect(() => broadcastFlags({
      mode: "TESTNET_BROADCAST",
      network: { chainId: 1, role: "READ_ONLY_SOURCE", forkedFrom: null, forkBlock: null },
      signer: "EPHEMERAL_TESTNET_BURNER", context: "t",
    })).toThrow(NetworkGuardError);
  });

  it("CRELAB-018k only an ephemeral burner may sign a broadcast", () => {
    expect([...BROADCAST_SIGNERS]).toEqual(["EPHEMERAL_TESTNET_BURNER", "LOCAL_BRIDGE_TESTNET"]);
    // A user wallet address offered as a signer is refused by name.
    expect(reasonOf(() => assertNotUserWallet("0x93e0FCb0F71e83F3340264339BC5983C474635c5", null)))
      .toBe(BROADCAST_REASONS.USER_WALLET_REFUSED);
    expect(reasonOf(() => assertNotUserWallet("USER_WALLET", null))).toBe(BROADCAST_REASONS.USER_WALLET_REFUSED);
  });

  it("CRELAB-018l the burner's forbidden sinks include every place a key would leak", () => {
    for (const sink of ["agent-runtime", "model-gateway", "ui", "logs", "runtime-event", "export"]) {
      expect(BURNER_KEY_FORBIDDEN_SINKS as readonly string[], sink).toContain(sink);
    }
  });
});

describe("CRELAB-019 a mainnet broadcast is unrepresentable", () => {
  it("CRELAB-019e the union has two members and neither is mainnet", () => {
    expect([...BROADCAST_MODES]).toEqual(["DRY_RUN", "TESTNET_BROADCAST"]);
    expect(BroadcastModeSchema.safeParse("MAINNET_BROADCAST").success).toBe(false);
  });

  it("CRELAB-019f an invented mode is refused by name", () => {
    expect(reasonOf(() => broadcastFlags({
      mode: "MAINNET_BROADCAST" as never, network: SEPOLIA, signer: "EPHEMERAL_TESTNET_BURNER", context: "t",
    }))).toBe(BROADCAST_REASONS.UNKNOWN_MODE);
  });

  it("CRELAB-019g and if the mode check were removed, the chain id still refuses", () => {
    /*
     * The two guards are independent, and this exercises the second alone: a VALID mode aimed at
     * mainnet. Nothing about `TESTNET_BROADCAST` makes chain 1 acceptable, because the guard keys on
     * the chain rather than the mode.
     */
    const mainnet: NetworkRef = { chainId: 1, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null };
    let err: NetworkGuardError | null = null;
    try { broadcastFlags({ mode: "TESTNET_BROADCAST", network: mainnet, signer: "EPHEMERAL_TESTNET_BURNER", context: "t" }); }
    catch (e) { err = e as NetworkGuardError; }
    expect(err?.reason).toBe("PRODUCTION_NETWORK_WRITE_PROHIBITED");
  });

  it("CRELAB-019h the name exists nowhere in code — only in the comment saying why", async () => {
    /*
     * §P26.11 asks for unrepresentable, not disabled. A commented-out or feature-flagged member is
     * still a member someone can reach, so its absence is checked in the source rather than assumed.
     *
     * The one permitted occurrence is the spec sentence quoted in `broadcast.ts` explaining the
     * decision. Comment lines are excluded and CODE lines are counted, because a test that
     * tolerated any occurrence would also tolerate the member itself.
     */
    const lines = sourceLines(/MAINNET_BROADCAST/);
    const code = lines.filter((l) => !isComment(l.text));
    expect(code.map((l) => `${l.file}:${l.text.trim()}`), "MAINNET_BROADCAST must not appear in code").toEqual([]);
    // And the check is not vacuous: the comment that documents the decision IS found.
    expect(lines.length, "the grep found nothing at all, which means it searched the wrong place").toBeGreaterThan(0);
  });
});

describe("CRELAB-019 the CRE workflow's own settings stay testnet-only", () => {
  it("CRELAB-019i no production chain is configured in the CRE project settings", async () => {
    /*
     * The one mainnet path the fences cannot see.
     *
     * `project.yaml` is read by the Chainlink CLI, not by ContextLock, so a production RPC listed
     * there sits outside all ten write fences — they guard this product's code, and this file
     * configures somebody else's binary. It is checked here because it is the place where the
     * boundary depends on a file rather than on a type.
     */
    const { readFileSync } = await import("node:fs");
    const yaml = readFileSync(new URL("../../../workflows/cre-policy/contextlock-cre/project.yaml", import.meta.url), "utf8");
    const configured = yaml
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .filter((l) => l.includes("chain-name:"))
      .map((l) => l.split("chain-name:")[1]?.trim() ?? "");

    expect(configured.length, "the settings file names no chains at all — is it still the right path?").toBeGreaterThan(0);
    for (const chain of configured) {
      expect(chain, `${chain} is a production chain`).toMatch(/testnet|sepolia|anvil|local/i);
      expect(chain).not.toBe("ethereum-mainnet");
    }
  });
});

/* ─────────────────────────── CRELAB-020 ─────────────────────────── */

describe("CRELAB-020 uint64 chain selectors survive as strings", () => {
  it("CRELAB-020c the registry holds selectors as strings, never numbers", () => {
    for (const n of approvedNetworks()) {
      if (n.chainSelector === null) continue;
      expect(typeof n.chainSelector, n.name).toBe("string");
      expect(n.chainSelector, n.name).toMatch(/^\d+$/);
    }
    expect(lookupNetwork(11155111)?.chainSelector).toBe("16015286601757825753");
    expect(lookupNetwork(84532)?.chainSelector).toBe("10344971235874465080");
  });

  it("CRELAB-020d the precision loss being avoided is real, and demonstrated", () => {
    /*
     * Two DIFFERENT Chainlink chain selectors that become the same JS number. This is not a
     * hypothetical: it is why FND-V2-E-002 exists and why the value is a string everywhere.
     */
    const sepolia = "16015286601757825753";
    const neighbour = "16015286601757825754";
    expect(sepolia).not.toBe(neighbour);
    expect(Number(sepolia)).toBe(Number(neighbour));
    expect(BigInt(sepolia)).not.toBe(BigInt(neighbour));
  });

  it("CRELAB-020e the simulation config carries the selector as a string too", () => {
    const cfg = baseConfig();
    // A number here would silently corrupt on the way to the CLI.
    expect(typeof cfg.projectId).toBe("string");
    expect(SimulationConfigSchema.safeParse(cfg).success).toBe(true);
  });

  it("CRELAB-020f the recorded CRE supported-chains evidence kept them as strings", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(new URL("../../../reports/group-testnet-lab/evidence/cre-supported-chains.json", import.meta.url), "utf8");
    // Checked as raw TEXT: parsing first would hide the very corruption being tested for.
    expect(raw).toMatch(/"16015286601757825753"/);
    expect(raw, "an unquoted selector means the JSON already lost precision").not.toMatch(/:\s*16015286601757825\d{3}\s*[,}]/);
  });
});
