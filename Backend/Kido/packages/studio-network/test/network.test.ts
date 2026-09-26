import { describe, expect, it } from "vitest";
import {
  NETWORK_ROLES, NetworkRefSchema, NetworkRoleSchema, WRITE_CAPABLE_ROLES, PUBLIC_WRITE_ROLES,
  approvedNetworks, executionNetworks, readOnlySources, lookupNetwork, isProductionChain, PRODUCTION_CHAIN_IDS,
  assertExecutionAllowed, assertReadAllowed, assertWalletNetworkSafe, NetworkGuardError, APPROVED_NETWORK_REASONS,
  networkLabel, FORBIDDEN_LABELS,
  CRE_EXECUTION_MODES, CreExecutionModeSchema, isSimulated, SIMULATED_MODES,
  PLATFORM_SIMULATION_AVAILABILITY, PLATFORM_SIMULATION_BLOCKER, assertPlatformSimulationAllowed,
  CreSimulationIdSchema, CreWorkflowIdSchema, isSimulationId, isWorkflowId, assertRealWorkflowId,
  CRE_SIMULATION_ID_PREFIX, CreModeError, CRE_MODE_REASONS,
  privacyEvidenceFor, assertPrivacyEvidenceHonest, PrivacyEvidenceSchema, creModeLabel,
  BROADCAST_MODES, BroadcastModeSchema, broadcastFlags, BroadcastError, BROADCAST_REASONS,
  BROADCAST_SIGNERS, assertNotUserWallet, assertBurnerUsable, EphemeralBurnerSchema, BURNER_KEY_FORBIDDEN_SINKS,
  limitsFlags, assertLimitsSatisfyGate, LimitsError, LIMITS_MODES,
  type NetworkRef,
} from "../src/index.js";

const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};

const net = (chainId: number, role: NetworkRef["role"], over: Partial<NetworkRef> = {}): NetworkRef =>
  ({ chainId, role, forkedFrom: null, forkBlock: null, ...over });

const SEPOLIA = net(11155111, "TESTNET_EXECUTION");
const BASE_SEPOLIA = net(84532, "TESTNET_EXECUTION");
const FORK = net(31337, "LOCAL_FORK", { forkedFrom: 1, forkBlock: "21000000" });
const MAINNET_READ = net(1, "READ_ONLY_SOURCE");

/* ═════════════════════════ the write fence ═════════════════════════ */

describe("the testnet write boundary", () => {
  it("NET-001 a Sepolia write is accepted", () => {
    const n = assertExecutionAllowed(SEPOLIA, "PUBLIC_WRITE", "test");
    expect(n.name).toBe("Ethereum Sepolia");
    expect(n.role).toBe("TESTNET_EXECUTION");
    // Selectors are STRINGS. Two neighbouring uint64s collapse to one double.
    expect(n.chainSelector).toBe("16015286601757825753");
  });

  it("NET-002 a Base Sepolia write is accepted where configured", () => {
    const n = assertExecutionAllowed(BASE_SEPOLIA, "PUBLIC_WRITE", "test");
    expect(n.chainId).toBe(84532);
    expect(n.chainSelector).toBe("10344971235874465080");
  });

  it("NET-003h an Ethereum mainnet write is refused, whatever role it claims", () => {
    // The honest claim.
    expect(reasonOf(() => assertExecutionAllowed(MAINNET_READ, "PUBLIC_WRITE", "test"))).toBe("PRODUCTION_NETWORK_WRITE_PROHIBITED");

    // The dishonest one. A caller asserting chain 1 is a testnet is confused or hostile; the role
    // is a claim and the chain id is the fact, so the chain id is checked FIRST.
    expect(reasonOf(() => assertExecutionAllowed(net(1, "TESTNET_EXECUTION"), "PUBLIC_WRITE", "test"))).toBe("PRODUCTION_NETWORK_WRITE_PROHIBITED");
    expect(() => assertExecutionAllowed(net(1, "TESTNET_EXECUTION"), "PUBLIC_WRITE", "test"))
      .toThrow(/testnet laboratory.*no flag that enables it/s);

    // Every production chain, not just Ethereum.
    for (const chainId of [1, 10, 56, 137, 8453, 42161, 43114, 59144, 534352]) {
      expect(reasonOf(() => assertExecutionAllowed(net(chainId, "TESTNET_EXECUTION"), "PUBLIC_WRITE", "test")), String(chainId))
        .toBe("PRODUCTION_NETWORK_WRITE_PROHIBITED");
    }
  });

  it("NET-003b a read-only source can never execute, and an unknown chain is a different error", () => {
    expect(reasonOf(() => assertExecutionAllowed(net(11155111, "READ_ONLY_SOURCE"), "PUBLIC_WRITE", "test")))
      .toBe(APPROVED_NETWORK_REASONS.READ_ONLY_WRITE);
    expect(() => assertExecutionAllowed(net(11155111, "READ_ONLY_SOURCE"), "PUBLIC_WRITE", "t"))
      .toThrow(/may inform a decision; it may never authorize execution/);

    // Not approved and production are separate reasons: one is a config gap, the other the boundary.
    expect(reasonOf(() => assertExecutionAllowed(net(999999, "TESTNET_EXECUTION"), "PUBLIC_WRITE", "test")))
      .toBe(APPROVED_NETWORK_REASONS.NOT_APPROVED);
  });

  it("NET-003c a local fork may write locally and never publicly", () => {
    expect(() => assertExecutionAllowed(FORK, "LOCAL_WRITE", "test")).not.toThrow();
    const r = reasonOf(() => assertExecutionAllowed(FORK, "PUBLIC_WRITE", "test"));
    expect(r).toBe(APPROVED_NETWORK_REASONS.FORK_PUBLIC_WRITE);
    expect(() => assertExecutionAllowed(FORK, "PUBLIC_WRITE", "t")).toThrow(/exist only on this machine/);

    expect(WRITE_CAPABLE_ROLES.has("LOCAL_FORK")).toBe(true);
    expect(PUBLIC_WRITE_ROLES.has("LOCAL_FORK")).toBe(false);
    expect(WRITE_CAPABLE_ROLES.has("READ_ONLY_SOURCE")).toBe(false);
  });

  it("NET-003d the registry's role is authoritative over the caller's", () => {
    // Chain 31337 is registered LOCAL_FORK. Relabelling it a testnet is caught.
    expect(reasonOf(() => assertExecutionAllowed(net(31337, "TESTNET_EXECUTION"), "PUBLIC_WRITE", "test")))
      .toBe(APPROVED_NETWORK_REASONS.ROLE_MISMATCH);
    expect(reasonOf(() => assertExecutionAllowed(net(11155111, "LOCAL_FORK"), "LOCAL_WRITE", "test")))
      .toBe(APPROVED_NETWORK_REASONS.ROLE_MISMATCH);
  });

  it("NET-003e the EXECUTION registry is short, and holds no production chain", () => {
    /*
     * Phase 27 added Ethereum mainnet to the registry as a `READ_ONLY_SOURCE`, so the Reality
     * Engine can name what it reads and provenance has something to point at.
     *
     * The security property this test has always asserted is unchanged and now stated where it
     * belongs: no production chain may EXECUTE. `executionNetworks()` is derived from the roles
     * rather than hand-maintained, so mainnet cannot join it by an edit to a list.
     */
    const execution = executionNetworks();
    expect(execution.map((n) => n.chainId).sort((a, b) => a - b)).toEqual([31337, 84532, 11155111]);
    for (const n of execution) {
      expect(isProductionChain(n.chainId), `${n.name} must not be a production chain`).toBe(false);
      expect(n.rpcCapability, `${n.name}`).toBe("READ_WRITE");
    }
    for (const n of approvedNetworks()) {
      expect(n.verifiedBy.length, `${n.name} must record what verified it`).toBeGreaterThan(10);
      expect(n.canonicalName, `${n.name}`).toMatch(/^[a-z0-9-]+$/);
    }

    // Mainnet is known, and known to be unexecutable — a stronger statement than being absent.
    const mainnet = lookupNetwork(1);
    expect(mainnet?.role).toBe("READ_ONLY_SOURCE");
    expect(mainnet?.environment).toBe("PRODUCTION");
    expect(mainnet?.rpcCapability).toBe("READ_ONLY");
    expect(executionNetworks().some((n) => n.chainId === 1)).toBe(false);
    expect(readOnlySources().map((n) => n.chainId)).toEqual([1]);
    expect(lookupNetwork(11155111)?.name).toBe("Ethereum Sepolia");
  });

  it("NET-003i registering mainnet as a source did not make it executable", () => {
    /*
     * The regression this guards is specific: a network becomes readable by being added to the
     * registry, and the registry is also what `assertExecutionAllowed` consults. Every intent and
     * every claimed role is checked here, so "we added mainnet for the Reality Engine" cannot
     * quietly have added it for the relayer too.
     */
    for (const role of NETWORK_ROLES) {
      for (const intent of ["PUBLIC_WRITE", "LOCAL_WRITE"] as const) {
        expect(
          () => assertExecutionAllowed({ chainId: 1, role, forkedFrom: null, forkBlock: null }, intent, "regression"),
          `chain 1 as ${role} / ${intent}`,
        ).toThrow(NetworkGuardError);
      }
    }
  });

  it("NET-008b a wallet on a production network is refused, and never silently switched", () => {
    const r = reasonOf(() => assertWalletNetworkSafe(1, SEPOLIA, "signing"));
    expect(r).toBe("PRODUCTION_NETWORK_WRITE_PROHIBITED");
    // The dangerous convenience, refused explicitly.
    expect(() => assertWalletNetworkSafe(1, SEPOLIA, "signing")).toThrow(/will not switch networks and sign on your behalf/);
    expect(() => assertWalletNetworkSafe(11155111, SEPOLIA, "signing")).not.toThrow();
    expect(reasonOf(() => assertWalletNetworkSafe(84532, SEPOLIA, "signing"))).toBe(APPROVED_NETWORK_REASONS.ROLE_MISMATCH);
  });

  it("NET-003f reading is unrestricted, because mainnet data is the point", () => {
    expect(() => assertReadAllowed(MAINNET_READ, "market data")).not.toThrow();
    expect(() => assertReadAllowed(net(1, "READ_ONLY_SOURCE"), "the graph")).not.toThrow();
  });

  it("NET-003g the UI labels are honest and the forbidden ones are enumerated", () => {
    expect(networkLabel(MAINNET_READ)).toBe("MAINNET DATA — READ ONLY");
    expect(networkLabel(SEPOLIA)).toBe("TESTNET");
    expect(networkLabel(FORK)).toBe("LOCAL MAINNET FORK — NO PUBLIC TRANSACTIONS");
    for (const forbidden of FORBIDDEN_LABELS) {
      for (const ref of [MAINNET_READ, SEPOLIA, FORK]) {
        expect(networkLabel(ref), forbidden).not.toContain(forbidden);
      }
    }
    expect(FORBIDDEN_LABELS).toContain("Live Mainnet Agent");
  });
});

/* ═════════════════════════ CRE modes ═════════════════════════ */

describe("CRE execution modes", () => {
  it("CRELAB-001 the mode schema is closed and simulation is distinguishable from deployment", () => {
    expect(CRE_EXECUTION_MODES).toEqual(["SIMULATED_PLATFORM", "SIMULATED_USER", "DEPLOYED_USER"]);
    expect(CreExecutionModeSchema.safeParse("DEPLOYED_PLATFORM").success).toBe(false);
    expect(isSimulated("SIMULATED_PLATFORM")).toBe(true);
    expect(isSimulated("SIMULATED_USER")).toBe(true);
    expect(isSimulated("DEPLOYED_USER")).toBe(false);
    expect(SIMULATED_MODES.has("DEPLOYED_USER")).toBe(false);
  });

  it("CRELAB-002 a simulation id cannot parse as a workflow id, or the reverse", () => {
    const sim = `${CRE_SIMULATION_ID_PREFIX}prj_guardian/session/3f2504e0-4f89-41d3-9a0c-0305e82c3301`;
    const workflow = "00da21b8b3e117e31f3a3e8a0795225cbde6c00283a84395117669691f2b7856";

    expect(isSimulationId(sim)).toBe(true);
    expect(isWorkflowId(sim)).toBe(false);
    expect(isWorkflowId(workflow)).toBe(true);
    expect(isSimulationId(workflow)).toBe(false);

    // The shapes are not even similar: a URI versus 64 hex.
    expect(CreWorkflowIdSchema.safeParse(sim).success).toBe(false);
    expect(CreSimulationIdSchema.safeParse(workflow).success).toBe(false);

    const r = reasonOf(() => assertRealWorkflowId(sim, "the deployment record"));
    expect(r).toBe(CRE_MODE_REASONS.SIMULATION_IS_NOT_DEPLOYMENT);
    expect(() => assertRealWorkflowId(sim, "x")).toThrow(/never reaches a DON/);
    expect(assertRealWorkflowId(workflow, "x")).toBe(workflow);
  });

  it("CRELAB-014 platform simulation is internal-only until Chainlink policy is established", () => {
    expect(PLATFORM_SIMULATION_AVAILABILITY).toBe("INTERNAL_ONLY");
    expect(PLATFORM_SIMULATION_BLOCKER).toBe("BLK-CRE-PLATFORM-MULTITENANT");

    expect(() => assertPlatformSimulationAllowed(true)).not.toThrow();
    const r = reasonOf(() => assertPlatformSimulationAllowed(false));
    expect(r).toBe(CRE_MODE_REASONS.PLATFORM_NOT_PUBLIC);
    expect(() => assertPlatformSimulationAllowed(false)).toThrow(/has not been established by this project/);
    expect(() => assertPlatformSimulationAllowed(false)).toThrow(/Use SIMULATED_USER/);
  });

  it("CRELAB-015 a simulated mode cannot claim DON consensus", () => {
    for (const mode of ["SIMULATED_PLATFORM", "SIMULATED_USER"] as const) {
      const honest = privacyEvidenceFor(mode, true);
      expect(honest.realDonConsensus).toBe(false);
      expect(honest.officialCreSimulation).toBe(true);
      expect(() => assertPrivacyEvidenceHonest(mode, honest)).not.toThrow();

      const lying = { ...honest, realDonConsensus: true };
      expect(reasonOf(() => assertPrivacyEvidenceHonest(mode, lying)), mode).toBe(CRE_MODE_REASONS.FALSE_DON_CLAIM);
      expect(() => assertPrivacyEvidenceHonest(mode, lying)).toThrow(/No DON participates and no consensus occurs/);
    }
    // A real deployment may claim it.
    expect(privacyEvidenceFor("DEPLOYED_USER", false).realDonConsensus).toBe(true);
  });

  it("CRELAB-016 a TEE claim requires an attestation, and a simulator can never make one", () => {
    const base = privacyEvidenceFor("SIMULATED_USER", true);
    expect(base.realTeeExecution).toBe(false);
    expect(base.teeAttestation).toBe(false);

    expect(reasonOf(() => assertPrivacyEvidenceHonest("SIMULATED_USER", { ...base, realTeeExecution: true })))
      .toBe(CRE_MODE_REASONS.FALSE_TEE_CLAIM);
    // Even for a real deployment, TEE without attestation is refused.
    expect(reasonOf(() => assertPrivacyEvidenceHonest("DEPLOYED_USER", { ...privacyEvidenceFor("DEPLOYED_USER", false), realTeeExecution: true, teeAttestation: false })))
      .toBe(CRE_MODE_REASONS.FALSE_TEE_CLAIM);
    expect(() => assertPrivacyEvidenceHonest("DEPLOYED_USER", { ...privacyEvidenceFor("DEPLOYED_USER", false), realTeeExecution: true, teeAttestation: false }))
      .toThrow(/'we believe it did' is not a confidentiality guarantee/);

    // The secret isolation claims are true in every mode, and are separate fields.
    expect(base.agentCannotReadSecret).toBe(true);
    expect(base.privatePolicyNotShownToAgent).toBe(true);
    expect(Object.keys(PrivacyEvidenceSchema.shape)).toHaveLength(6);
  });

  it("CRELAB-015b the mode labels never say DON or TEE for a simulation", () => {
    for (const mode of ["SIMULATED_PLATFORM", "SIMULATED_USER"] as const) {
      const l = creModeLabel(mode);
      expect(l.headline).toMatch(/SIMULATED/);
      expect(l.don).toBe("NOT DEPLOYED");
      expect(l.tee).toBe("NOT ACTIVE");
      expect(l.provider).toMatch(/Official Chainlink CRE CLI/);
    }
    expect(creModeLabel("DEPLOYED_USER").don).toBe("DEPLOYED");
    // Even a real deployment does not claim a TEE without evidence.
    expect(creModeLabel("DEPLOYED_USER").tee).toBe("NOT ESTABLISHED");
  });
});

/* ═════════════════════════ broadcast ═════════════════════════ */

describe("CRE broadcast", () => {
  const req = (over: Partial<Parameters<typeof broadcastFlags>[0]> = {}) => ({
    mode: "DRY_RUN" as const, network: SEPOLIA, signer: "EPHEMERAL_TESTNET_BURNER" as const, context: "test", ...over,
  });

  it("CRELAB-017 dry run is the default and produces no broadcast flag", () => {
    const r = broadcastFlags(req());
    expect(r.broadcasting).toBe(false);
    expect(r.flags).toEqual([]);
    // No `--broadcast=false` either: relying on the CLI default means a flag rename cannot silently
    // turn broadcasting on.
    expect(r.flags.join(" ")).not.toContain("broadcast");
    expect(r.network).toMatch(/no transaction will be sent/);
  });

  it("CRELAB-018 a testnet broadcast succeeds only on an approved network", () => {
    const ok = broadcastFlags(req({ mode: "TESTNET_BROADCAST" }));
    expect(ok.broadcasting).toBe(true);
    expect(ok.flags).toEqual(["--broadcast"]);
    expect(ok.network).toContain("Ethereum Sepolia");

    expect(broadcastFlags(req({ mode: "TESTNET_BROADCAST", network: BASE_SEPOLIA })).broadcasting).toBe(true);

    // The same guard the rest of the product uses. A broadcast is a write.
    expect(reasonOf(() => broadcastFlags(req({ mode: "TESTNET_BROADCAST", network: net(1, "TESTNET_EXECUTION") }))))
      .toBe("PRODUCTION_NETWORK_WRITE_PROHIBITED");
    expect(reasonOf(() => broadcastFlags(req({ mode: "TESTNET_BROADCAST", network: FORK }))))
      .toBe(APPROVED_NETWORK_REASONS.FORK_PUBLIC_WRITE);
  });

  it("CRELAB-019 a mainnet broadcast mode is unrepresentable, not disabled", () => {
    // Two members. A third would have to be typed by someone, and the guard would refuse it anyway.
    expect(BROADCAST_MODES).toEqual(["DRY_RUN", "TESTNET_BROADCAST"]);
    expect(BROADCAST_MODES as readonly string[]).not.toContain("MAINNET_BROADCAST");
    expect(BroadcastModeSchema.safeParse("MAINNET_BROADCAST").success).toBe(false);
    expect(reasonOf(() => broadcastFlags(req({ mode: "MAINNET_BROADCAST" as never })))).toBe(BROADCAST_REASONS.UNKNOWN_MODE);
  });

  it("CRELAB-012b the broadcast signer can only be an ephemeral burner", () => {
    expect(BROADCAST_SIGNERS).toEqual(["EPHEMERAL_TESTNET_BURNER", "LOCAL_BRIDGE_TESTNET"]);
    expect(BROADCAST_SIGNERS as readonly string[]).not.toContain("USER_WALLET");
    expect(reasonOf(() => assertNotUserWallet("USER_WALLET", "0xabc"))).toBe(BROADCAST_REASONS.USER_WALLET_REFUSED);
    expect(() => assertNotUserWallet("USER_WALLET", "0xabc")).toThrow(/never from a user wallet/);
    expect(() => assertNotUserWallet("EPHEMERAL_TESTNET_BURNER", "0xabc")).not.toThrow();

    const burner = {
      deploymentId: "dep_1", address: "0x1111111111111111111111111111111111111111",
      chainId: 11155111, createdAtMs: 1000, expiresAtMs: 100_000, keyRef: "burner_0123456789abcdef",
    };
    expect(EphemeralBurnerSchema.safeParse(burner).success).toBe(true);
    // The key is a reference; the object has nowhere to put the key itself.
    expect(Object.keys(burner)).not.toContain("privateKey");
    expect(() => assertBurnerUsable(burner, SEPOLIA, 5000)).not.toThrow();
    expect(reasonOf(() => assertBurnerUsable(burner, BASE_SEPOLIA, 5000))).toBe(BROADCAST_REASONS.BROADCAST_NETWORK_NOT_APPROVED);
    expect(reasonOf(() => assertBurnerUsable(burner, SEPOLIA, 200_000))).toBe(BROADCAST_REASONS.BURNER_REQUIRED);

    for (const sink of ["agent-runtime", "model-gateway", "ui", "runtime-event", "logs"]) {
      expect(BURNER_KEY_FORBIDDEN_SINKS as readonly string[]).toContain(sink);
    }
  });
});

/* ═════════════════════════ limits ═════════════════════════ */

describe("production limits", () => {
  it("CRELAB-005 production limits are passed explicitly, not left to a default", () => {
    expect(limitsFlags("PRODUCTION_DEFAULT")).toEqual(["--limits", "default"]);
    expect(limitsFlags("PRODUCTION_FILE", "/tmp/limits.json")).toEqual(["--limits", "/tmp/limits.json"]);
    expect(() => limitsFlags("PRODUCTION_FILE")).toThrow(/needs a path/);
    expect(LIMITS_MODES).toEqual(["PRODUCTION_DEFAULT", "PRODUCTION_FILE", "NONE"]);
  });

  it("CRELAB-006 a run with --limits none cannot satisfy a deployment gate", () => {
    expect(limitsFlags("NONE")).toEqual(["--limits", "none"]);
    // A debug run may disable limits. What it may not do is count as evidence.
    for (const gate of ["READY_FOR_DEPLOYMENT", "CRE_SIMULATION_VERIFIED"]) {
      expect(() => assertLimitsSatisfyGate("NONE", gate)).toThrow(LimitsError);
      expect(reasonOf(() => assertLimitsSatisfyGate("NONE", gate))).toBe("SIMULATION_WITHOUT_LIMITS_CANNOT_SATISFY_GATE");
      expect(() => assertLimitsSatisfyGate("NONE", gate)).toThrow(/does not test whether the workflow fits inside CRE's production constraints/);
    }
    expect(() => assertLimitsSatisfyGate("PRODUCTION_DEFAULT", "READY_FOR_DEPLOYMENT")).not.toThrow();
    expect(() => assertLimitsSatisfyGate("PRODUCTION_FILE", "READY_FOR_DEPLOYMENT")).not.toThrow();
  });
});

/* ═════════════════════════ selector precision ═════════════════════════ */

describe("uint64 chain selectors", () => {
  it("CRELAB-020 selector precision is preserved end to end", () => {
    // The hazard, demonstrated: two distinct uint64 selectors are the same JS number.
    expect(Number("16015286601757825753")).toBe(Number("16015286601757825754"));

    const sepolia = lookupNetwork(11155111)!;
    const base = lookupNetwork(84532)!;
    expect(typeof sepolia.chainSelector).toBe("string");
    expect(sepolia.chainSelector).toBe("16015286601757825753");
    expect(base.chainSelector).toBe("10344971235874465080");

    // Round-tripping through JSON keeps them exact, because they are strings.
    const round = JSON.parse(JSON.stringify(approvedNetworks())) as Array<{ chainSelector: string | null }>;
    expect(round.map((n) => n.chainSelector)).toEqual([
      "16015286601757825753", "10344971235874465080", null,
      // Mainnet's selector, carried as a string for the same reason as every other one.
      "5009297550715157269",
    ]);

    // And a number would not: the corrupted value is not equal to the true one.
    expect(String(Number(sepolia.chainSelector))).not.toBe(sepolia.chainSelector);
    // BigInt is the other safe representation, and agrees with the string.
    expect(BigInt(sepolia.chainSelector!).toString()).toBe(sepolia.chainSelector);
  });

  it("CRELAB-020b the captured CRE chain list kept its selectors as strings", async () => {
    const { readFileSync } = await import("node:fs");
    // Resolved from this file, not from `process.cwd()`: the harness runs from the repository root
    // and a per-package run does not, and a path that only resolves under one of them is a test
    // that stops testing depending on how it was invoked.
    const path = new URL("../../../reports/group-testnet-lab/evidence/cre-supported-chains.json", import.meta.url);
    const captured = JSON.parse(readFileSync(path, "utf8")) as {
      chains: Array<{ chainName: string; chainSelector: string }>;
    };
    expect(captured.chains.length).toBeGreaterThan(50);
    for (const c of captured.chains) expect(typeof c.chainSelector, c.chainName).toBe("string");
    const sepolia = captured.chains.find((c) => c.chainName === "ethereum-testnet-sepolia")!;
    expect(sepolia.chainSelector).toBe("16015286601757825753");
  });
});
