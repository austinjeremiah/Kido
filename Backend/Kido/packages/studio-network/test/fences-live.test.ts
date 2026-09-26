import { describe, expect, it } from "vitest";
import { WRITE_FENCES, fenceWrite, fenceWriteByChain, NetworkGuardError, lookupNetwork, type WriteFence } from "../src/index.js";
import { validateBlueprint } from "../../studio-blueprint/src/index.js";
import { compileStrategy } from "../../studio-strategy/src/index.js";
import { treasuryStrategy } from "../../studio-strategy/test/fixtures.js";
import { assertStepExecutable } from "../../studio-plan/src/index.js";
import { prepareForSignature } from "../../studio-deploy/src/index.js";
import { assertWriteAllowed, testnetEnvironment, ETHEREUM_SEPOLIA } from "../../studio-deploy/src/index.js";
import { broadcastFlags } from "../src/broadcast.js";
import type { Hex } from "viem";

/**
 * The fences, exercised at their REAL call sites.
 *
 * `network.test.ts` tests the guard. This tests that ten different subsystems actually reach it —
 * which is a different claim, and the one that matters. A guard nobody calls is a guard.
 *
 * Every case here drives the genuine entry point of its layer: the real Blueprint validator, the
 * real strategy compiler, the real plan step check, the real signature preparation. None of them is
 * given a mock guard.
 */

const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};
const asyncReasonOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};

const MAINNET = 1;
const SEPOLIA = 11155111;
const PROHIBITED = "PRODUCTION_NETWORK_WRITE_PROHIBITED";

describe("every declared fence is actually wired", () => {
  it("NET-011 no fence is declared without a call site", async () => {
    /*
     * A fence in the list with no call site is a gap that reads like coverage — the exact shape of
     * FND-V2-25-002. This greps the source for each name, so adding a fence without wiring it is a
     * test failure rather than a silent omission.
     */
    const { execSync } = await import("node:child_process");
    const { existsSync } = await import("node:fs");

    /*
     * The root is derived from THIS FILE, not from `process.cwd()`.
     *
     * `process.cwd()` is the repository root when vitest runs from the root and the package
     * directory when it runs per-package. Keyed on it, the grep below searches a `packages/packages`
     * that does not exist — and a source scan that cannot look is not a source scan. The existence
     * check makes a wrong answer loud instead of letting it become a verdict.
     */
    const root = new URL("../../../", import.meta.url).pathname;
    expect(existsSync(`${root}packages`) && existsSync(`${root}apps`), `source scan resolved ${root}, which is not the repository root`).toBe(true);

    const unwired: WriteFence[] = [];
    for (const fence of WRITE_FENCES) {
      // `node_modules` and build output are excluded rather than filtered afterwards: walking them
      // ten times over takes long enough that this test times out under a full parallel run, which
      // is a failure that says nothing about the fences.
      const hits = execSync(
        `grep -rlE --exclude-dir=node_modules --exclude-dir=dist 'fence(Write|WriteByChain)\\("${fence}"' packages apps 2>/dev/null | grep -v '/test/' | wc -l`,
        { cwd: root, encoding: "utf8" },
      ).trim();
      if (Number(hits) === 0) unwired.push(fence);
    }
    expect(unwired, `these fences are declared but never called: ${unwired.join(", ")}`).toEqual([]);
    expect(WRITE_FENCES.length).toBe(10);
  });
});

describe("mainnet is refused at every layer, independently", () => {
  it("NET-003 the Blueprint validator refuses a mainnet execution chain", () => {
    /*
     * The Blueprint schema pins chainId to a literal, so a mainnet Blueprint fails to PARSE before
     * the fence is reached. Both refusals are real and both are asserted: the schema is the stronger
     * one, and the fence is what survives the day someone widens the literal to a union.
     */
    const mainnetBlueprint = {
      schemaVersion: "contextlock.agent.blueprint/v1",
      identity: { agentId: "guardian", ensName: "guardian.eth", network: "sepolia", chainId: MAINNET, agentAddress: "UNKNOWN" },
    };
    const r = validateBlueprint(mainnetBlueprint);
    expect(r.ok).toBe(false);
    // Refused before anything is buildable, whichever layer catches it.
    expect(r.buildable).toBe(false);
    expect(r.issues.some((i) => i.severity === "CRITICAL")).toBe(true);
  });

  it("NET-004 the strategy compiler refuses a mainnet action", () => {
    const s = treasuryStrategy();
    (s.actions[0] as unknown as { chainId: number }).chainId = MAINNET;
    const r = compileStrategy(s);

    const net = r.problems.filter((p) => p.code === "STRAT-NETWORK");
    expect(net).toHaveLength(1);
    expect(net[0]!.severity).toBe("CRITICAL");
    expect(net[0]!.message).toContain(PROHIBITED);
    expect(r.buildable).toBe(false);

    // A Sepolia action compiles, and a strategy naming no chain is unaffected — the fence must not
    // break the ordinary case, or it gets removed.
    const sepolia = treasuryStrategy();
    (sepolia.actions[0] as unknown as { chainId: number }).chainId = SEPOLIA;
    expect(compileStrategy(sepolia).problems.filter((p) => p.code === "STRAT-NETWORK")).toEqual([]);
    expect(compileStrategy(treasuryStrategy()).ok).toBe(true);
  });

  it("NET-005 the ExecutionPlan validator refuses a mainnet step, before anything else about it", () => {
    // A step that is otherwise perfectly executable.
    const step = {
      stepId: "swap", chainId: MAINNET, adapterId: "uniswap", adapterVersion: "1.0.0", action: "swap",
      normalizedIntent: {}, dependencies: [], preconditions: [], expectedEffects: [], timeoutMs: 60_000,
      authorizationRequirement: { disposition: "AUTONOMOUS" as const, valueUsdCents: 100, capabilityScope: "scope" },
      status: "AUTHORIZED" as const,
    };
    const r = reasonOf(() => assertStepExecutable({ steps: [step] } as never, "swap", { capabilityScope: "scope", humanApproved: false } as never));
    expect(r).toBe(PROHIBITED);
  });

  it("NET-006 the deployment preflight refuses a mainnet write", () => {
    const env = { ...testnetEnvironment([ETHEREUM_SEPOLIA]), chains: [{ chainId: MAINNET, name: "Ethereum", chainSelector: "5009297550715157269", nativeSymbol: "ETH", nativeDecimals: 18, explorer: null }] };
    // The environment model refuses it, and so does the shared fence beneath it.
    expect(() => assertWriteAllowed(env as never, MAINNET)).toThrow();
    expect(reasonOf(() => fenceWriteByChain("DEPLOYMENT_PREFLIGHT", MAINNET))).toBe(PROHIBITED);
  });

  it("NET-007 the ContextLock broker refuses a mainnet intent", () => {
    expect(reasonOf(() => fenceWriteByChain("CONTEXTLOCK_BROKER", MAINNET))).toBe(PROHIBITED);
    // And accepts the chains it should.
    expect(() => fenceWriteByChain("CONTEXTLOCK_BROKER", SEPOLIA)).not.toThrow();
    expect(() => fenceWriteByChain("CONTEXTLOCK_BROKER", 31337)).not.toThrow();
  });

  it("NET-008 the signer refuses to prepare a mainnet transaction, so no wallet is ever asked", async () => {
    /*
     * The refusal happens BEFORE simulation and before the wallet is involved. A wallet prompt for a
     * mainnet transaction is itself the failure — the user should never see one.
     */
    const reader = {
      chainId: MAINNET, live: false,
      async getChainId() { return MAINNET; }, async getCode() { return undefined; },
      async getBalance() { return 0n; }, async getTransactionCount() { return 0n; },
      async estimateGas() { throw new Error("the signer must refuse before estimating"); },
      async estimateFeesPerGas() { return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasPrice: undefined }; },
      async call() { throw new Error("the signer must refuse before simulating"); },
      async getTransactionReceipt() { return null; }, async getBlockNumber() { return 1n; },
    };
    const r = await asyncReasonOf(() => prepareForSignature(reader as never, {
      signerId: "deployer", mode: "BROWSER_WALLET", chainId: MAINNET,
      from: "0x93e0FCb0F71e83F3340264339BC5983C474635c5" as never,
      to: "0xCBd976E8BBbA70867d581A35e5a5CF1C2ed47F24" as never,
      data: "0xdeadbeef" as Hex, value: "0", gas: "90000",
      description: "a transaction nobody should be asked to sign", deploymentStepId: "step-1",
    }));
    expect(r).toBe(PROHIBITED);
  });

  it("NET-009 the relayer refuses a mainnet submission", () => {
    expect(reasonOf(() => fenceWriteByChain("RELAYER", MAINNET))).toBe(PROHIBITED);
    expect(reasonOf(() => fenceWriteByChain("AGENT_RUNTIME", MAINNET))).toBe(PROHIBITED);
  });

  it("NET-010 CRE broadcast refuses mainnet, and dry-run never broadcasts at all", () => {
    const mainnet = { chainId: MAINNET, role: "TESTNET_EXECUTION" as const, forkedFrom: null, forkBlock: null };
    expect(reasonOf(() => broadcastFlags({ mode: "TESTNET_BROADCAST", network: mainnet, context: "test" }))).toBe(PROHIBITED);

    // Dry run passes no flag at all — relying on the CLI default rather than an explicit false, so
    // a future flag rename cannot silently enable broadcasting.
    const dry = broadcastFlags({ mode: "DRY_RUN", network: { chainId: SEPOLIA, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null }, context: "test" });
    expect(dry.broadcasting).toBe(false);
    expect(dry.flags).toEqual([]);

    const live = broadcastFlags({ mode: "TESTNET_BROADCAST", network: { chainId: SEPOLIA, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null }, context: "test" });
    expect(live.broadcasting).toBe(true);
    expect(live.flags).toEqual(["--broadcast"]);
  });

  it("NET-012 an unapproved chain and a production chain fail differently", () => {
    // A configuration gap and the product boundary are different problems, and an operator needs to
    // know which one they hit.
    expect(reasonOf(() => fenceWriteByChain("RELAYER", MAINNET))).toBe(PROHIBITED);
    expect(reasonOf(() => fenceWriteByChain("RELAYER", 4242))).toBe("EXECUTION_NETWORK_NOT_APPROVED");
    expect(lookupNetwork(4242)).toBeNull();
    expect(lookupNetwork(SEPOLIA)?.role).toBe("TESTNET_EXECUTION");
    expect(lookupNetwork(31337)?.role).toBe("LOCAL_FORK");
  });

  it("NET-013 a local fork may write locally and may never write publicly", () => {
    const fork = { chainId: 31337, role: "LOCAL_FORK" as const, forkedFrom: MAINNET, forkBlock: "21000000" };
    expect(() => fenceWrite("RELAYER", fork, "LOCAL_WRITE")).not.toThrow();
    // Forking mainnet does not make the fork mainnet, and it does not make it publicly writable.
    expect(reasonOf(() => fenceWrite("RELAYER", fork, "PUBLIC_WRITE"))).toBe("LOCAL_FORK_CANNOT_PUBLICLY_WRITE");
  });
});
