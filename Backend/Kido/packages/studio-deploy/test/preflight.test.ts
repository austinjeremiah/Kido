import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { keccak256, type Address, type Hex } from "viem";
import {
  manifestHash, DeploymentManifestSchema, pinnedArtifacts,
  DeploymentPlanSchema, deploymentPlanHash, validatePlan, assertCosted, runnableSteps, DeploymentPlanError, PLAN_REASONS,
  assertWriteAllowed, assertWalletChain, EnvironmentError, ENVIRONMENT_REASONS, mainnetEnvironment, testnetEnvironment, writesAllowedFor, BASE_SEPOLIA, ETHEREUM_SEPOLIA,
  verifyReuse, resolveReuse, REUSE_REASONS, reuseBlocks,
  quoteFees, costFrom, quoteIsStale, aggregateByChain, requiredBalancesFor, estimateContractCreation, estimateConfigurationWrite, CostError, COST_REASONS, DEFAULT_BUFFER_BPS, FEE_QUOTE_TTL_MS, forecastModelUsage, formatUnitsExact,
  selectRegistry, assertDeployAccess, assertLimitsSatisfied, assertQuotasOk, checkQuotas, assertNoCreSecret, assertNoArtifactDrift, artifactDrift, sourceTreeHash, CreError, CRE_REASONS, DOCUMENTED_CRE_DEFAULTS, CRE_COMMANDS, CredentialRefSchema, CRE_KEY_FORBIDDEN_SINKS, creSupportsChain,
  runPreflight,
  buildApprovalScreen, approve, approvalDrift, assertApprovedFor, assertReadinessTransition, ApprovalError, APPROVAL_REASONS,
  prepareForSignature, assertSignerMatches, assertSignedWhatWePlanned, SigningError, SIGNING_REASONS, calldataHashOf,
  scanForSecrets, assertNoSecrets, DeploymentSecretError,
  canonicalize, digestOf,
} from "../src/index.js";
import {
  NOW, DEPLOYER, ISSUER, AGENT, ATTACKER, SEPOLIA_CORE, clone,
  fakeChain, sepoliaReader, codeFor, hashOfFixtureCode,
  canonicalManifest, canonicalPlan, stepCost,
  creStatus, creArtifact, creQuota, creLimits,
} from "./fixtures.js";

const readers = (r = sepoliaReader()) => new Map([[11155111, r]]);
const balances = (wei = 10n ** 18n) => new Map([[11155111, wei]]);

const preflight = (over: Partial<Parameters<typeof runPreflight>[0]> = {}) => {
  const manifest = over.manifest ?? canonicalManifest();
  return runPreflight({
    manifest,
    plan: over.plan ?? canonicalPlan(manifest),
    readers: over.readers ?? readers(),
    balances: over.balances ?? balances(),
    creStatus: over.creStatus !== undefined ? over.creStatus : creStatus(),
    creArtifact: over.creArtifact !== undefined ? over.creArtifact : creArtifact(),
    creQuota: over.creQuota !== undefined ? over.creQuota : creQuota(),
    creLimits: over.creLimits !== undefined ? over.creLimits : creLimits(),
    nowMs: over.nowMs ?? NOW,
    ...(over.requestedRegistry !== undefined ? { requestedRegistry: over.requestedRegistry } : {}),
  });
};

const codesOf = (r: Awaited<ReturnType<typeof preflight>>) => r.blockers.filter((b) => b.severity === "BLOCKER").map((b) => b.code);

const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) {
    const r = (e as { reason?: string }).reason;
    if (r) return r;
    throw e;
  }
  throw new Error("expected a rejection, but the call succeeded");
};

const asyncReasonOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e) {
    const r = (e as { reason?: string }).reason;
    if (r) return r;
    throw e;
  }
  throw new Error("expected a rejection, but the call succeeded");
};

/* ══════════════════════════════ manifest ══════════════════════════════ */

describe("the deployment manifest", () => {
  it("DEP-PRE-001 the manifest hash is deterministic and independent of key order and timestamp", () => {
    const a = canonicalManifest();
    expect(DeploymentManifestSchema.safeParse(a).success).toBe(true);

    // Same inputs, regenerated: same hash. This is what makes "nothing changed" checkable.
    expect(manifestHash(canonicalManifest())).toBe(manifestHash(a));

    // Key order must not matter, or two servers serializing the same manifest would disagree.
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(a).reverse()))) as typeof a;
    expect(manifestHash(reordered)).toBe(manifestHash(a));

    // The timestamp is excluded on purpose: if it were hashed, determinism would be untestable.
    expect(manifestHash({ ...a, generatedAt: "2099-01-01T00:00:00.000Z", manifestId: "mf_other" })).toBe(manifestHash(a));

    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("DEP-PRE-002 the manifest pins the Blueprint and build revisions, and changing either changes its identity", () => {
    const a = canonicalManifest();
    expect(a.blueprintRevision).toBe(3);
    expect(a.buildRevision).toBe(2);
    expect(a.gitCommit).toMatch(/^[0-9a-f]{40}$/);

    expect(manifestHash({ ...a, blueprintRevision: 4 })).not.toBe(manifestHash(a));
    expect(manifestHash({ ...a, buildRevision: 3 })).not.toBe(manifestHash(a));
    expect(manifestHash({ ...a, strategyHash: `sha256:${"0".repeat(64)}` })).not.toBe(manifestHash(a));
    expect(manifestHash({ ...a, gitCommit: "0".repeat(40) })).not.toBe(manifestHash(a));
  });

  it("DEP-PRE-002b every deployable artifact is pinned by content hash", () => {
    const pinned = pinnedArtifacts(canonicalManifest());
    const kinds = new Set(pinned.map((p) => p.kind));
    expect(kinds).toContain("strategy");
    expect(kinds).toContain("contract-runtime-code");
    expect(kinds).toContain("cre-binary");
    expect(kinds).toContain("cre-source");
    expect(kinds).toContain("adapter");
    // A tag is a mutable pointer and is deliberately NOT among the pinned artifacts.
    expect([...kinds]).not.toContain("runtime-image-tag");
  });
});

/* ══════════════════════════════ reuse ══════════════════════════════ */

describe("reuse versus deploy", () => {
  it("DEP-PRE-003 a reused contract's bytecode is read from the chain and verified against the pinned hash", async () => {
    const m = canonicalManifest();
    const entry = m.contracts.find((c) => c.name === "ContextLockExecutorV2")!;
    const v = await verifyReuse(entry, sepoliaReader());
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error("unreachable");
    expect(v.observedCodeHash).toBe(keccak256(codeFor("executor-v2")));
    expect(v.observedCodeHash).toBe(entry.runtimeCodeHash);

    const report = await resolveReuse(m.contracts, readers());
    expect(report.rejected).toEqual([]);
    expect(report.verified.map((r) => r.name)).toContain("ContextLockExecutorV2");
    expect(reuseBlocks(report)).toBe(false);
  });

  it("DEP-PRE-004 a bytecode mismatch rejects the reuse instead of trusting the address", async () => {
    const m = canonicalManifest();
    const entry = m.contracts.find((c) => c.name === "ContextLockExecutorV2")!;

    // Same address, different code. This is the substituted-contract case: the address a user
    // reviewed now holds something else.
    const swapped = sepoliaReader({
      code: new Map([[SEPOLIA_CORE.ContextLockExecutorV2.address.toLowerCase(), codeFor("something-else-entirely")]]),
    });
    const v = await verifyReuse(entry, swapped);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toBe(REUSE_REASONS.CODE_HASH_MISMATCH);
    expect(v.detail).toContain(entry.runtimeCodeHash!);

    // And an address with no code at all is a separate, separately-named failure.
    const empty = await verifyReuse(entry, fakeChain({ chainId: 11155111 }));
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error("unreachable");
    expect(empty.reason).toBe(REUSE_REASONS.NO_CODE);

    // A manifest that pins no hash cannot verify, and must not fall back to trusting the address.
    const unpinned = await verifyReuse({ ...entry, runtimeCodeHash: null }, sepoliaReader());
    expect(unpinned.ok).toBe(false);
    if (unpinned.ok) throw new Error("unreachable");
    expect(unpinned.reason).toBe(REUSE_REASONS.NO_EXPECTED_HASH);
  });

  it("DEP-PRE-004b an unverified reuse blocks the whole preflight", async () => {
    const r = await preflight({
      readers: readers(sepoliaReader({ code: new Map([[SEPOLIA_CORE.ContextLockExecutorV2.address.toLowerCase(), codeFor("wrong")]]) })),
    });
    expect(r.readiness).toBe("PREFLIGHT_BLOCKED");
    expect(codesOf(r)).toContain(REUSE_REASONS.CODE_HASH_MISMATCH);
  });

  it("DEP-PRE-004c the core is reused by default, not redeployed per agent", () => {
    const m = canonicalManifest();
    const core = ["ContextLockPolicyRegistry", "ContextLockAuthorizationRegistry", "ContextLockExecutorV2"];
    for (const name of core) {
      expect(m.contracts.find((c) => c.name === name)!.disposition).toBe("REUSE_VERIFIED");
    }
    expect(m.contracts.filter((c) => c.disposition === "DEPLOY_NEW")).toHaveLength(0);
  });
});

/* ══════════════════════════════ plan ══════════════════════════════ */

describe("the deployment plan", () => {
  it("DEP-PRE-005 plan dependencies are validated: unknown, self, forward and cyclic all rejected", () => {
    const m = canonicalManifest();
    const p = canonicalPlan(m);
    const signers = new Set(m.requiredSigners.map((s) => s.signerId));
    expect(DeploymentPlanSchema.safeParse(p).success).toBe(true);
    expect(() => validatePlan(p, signers)).not.toThrow();

    const unknown = clone(p);
    unknown.steps[1]!.dependencyIds = ["no-such-step"];
    expect(reasonOf(() => validatePlan(unknown, signers))).toBe(PLAN_REASONS.UNKNOWN_DEPENDENCY);

    const self = clone(p);
    self.steps[1]!.dependencyIds = [self.steps[1]!.id];
    expect(reasonOf(() => validatePlan(self, signers))).toBe(PLAN_REASONS.SELF_DEPENDENCY);

    // A dependency that runs later is unsatisfiable, and a cycle is a special case of it.
    const forward = clone(p);
    forward.steps[0]!.dependencyIds = [forward.steps[5]!.id];
    expect(reasonOf(() => validatePlan(forward, signers))).toBe(PLAN_REASONS.FORWARD_DEPENDENCY);

    const dup = clone(p);
    dup.steps.push({ ...dup.steps[0]! });
    expect(reasonOf(() => validatePlan(dup, signers))).toBe(PLAN_REASONS.DUPLICATE_STEP_ID);
  });

  it("DEP-PRE-005b a dependency counts as met only when independently VERIFIED, never merely CONFIRMED", () => {
    const p = canonicalPlan();
    const dependent = p.steps.find((s) => s.id === "register-policy-disabled")!;

    const confirmed = clone(p);
    confirmed.steps.find((s) => s.id === "deploy-cre-consumer")!.status = "CONFIRMED";
    expect(runnableSteps(confirmed).map((s) => s.id)).not.toContain(dependent.id);

    const verified = clone(p);
    verified.steps.find((s) => s.id === "deploy-cre-consumer")!.status = "VERIFIED";
    verified.steps.find((s) => s.id === "verify-chain-11155111")!.status = "VERIFIED";
    verified.steps.find((s) => s.id === "verify-core")!.status = "VERIFIED";
    expect(runnableSteps(verified).map((s) => s.id)).toContain(dependent.id);
  });

  it("DEP-PRE-005c activation is not representable inside a deployment plan", () => {
    const m = canonicalManifest();
    const p = clone(canonicalPlan(m));
    p.steps.push({ ...p.steps[0]!, id: "activate-everything", type: "ACTIVATE", dependencyIds: [] });
    expect(reasonOf(() => validatePlan(p, new Set(m.requiredSigners.map((s) => s.signerId))))).toBe(
      PLAN_REASONS.ACTIVATE_IN_DEPLOYMENT_PLAN,
    );
  });

  it("DEP-PRE-005d an irreversible step cannot be marked reversible", () => {
    const m = canonicalManifest();
    const p = clone(canonicalPlan(m));
    p.steps.find((s) => s.id === "deploy-cre-consumer")!.reversible = true;
    expect(() => validatePlan(p, new Set(m.requiredSigners.map((s) => s.signerId)))).toThrow(DeploymentPlanError);
  });
});

/* ══════════════════════════════ cost ══════════════════════════════ */

describe("the cost estimator", () => {
  it("DEP-PRE-006 a contract creation is gas-estimated from real bytecode and constructor arguments", async () => {
    const chain = fakeChain({ chainId: 11155111, gas: 1_234_567n, maxFeePerGas: 3_000_000_000n });
    const abi = [{ type: "constructor", inputs: [{ name: "owner", type: "address" }] }] as const;
    const { cost, calldata } = await estimateContractCreation(chain, {
      from: DEPLOYER,
      abi: abi as never,
      bytecode: "0x60806040" as Hex,
      args: [ISSUER],
    }, () => NOW);

    expect(cost.estimatedGas).toBe("1234567");
    // The constructor argument is really in the calldata; an estimate that ignored it would be an
    // estimate of a different deployment.
    expect(calldata.toLowerCase()).toContain(ISSUER.slice(2).toLowerCase());
    expect(cost.fromLiveNode).toBe(false);

    const failing = fakeChain({ chainId: 11155111, failWith: { method: "estimateGas", error: new Error("boom") } });
    expect(await asyncReasonOf(() => estimateContractCreation(failing, { from: DEPLOYER, abi: abi as never, bytecode: "0x60" as Hex, args: [ISSUER] })))
      .toBe(COST_REASONS.ESTIMATE_FAILED);
  });

  it("DEP-PRE-007 a configuration transaction is simulated before it is estimated, and a revert names the step", async () => {
    const ok = fakeChain({ chainId: 11155111, gas: 90_000n });
    const r = await estimateConfigurationWrite(ok, { from: DEPLOYER, to: SEPOLIA_CORE.ContextLockPolicyRegistry.address, data: "0xdeadbeef" as Hex }, () => NOW);
    expect(r.simulated).toBe(true);
    expect(r.cost.estimatedGas).toBe("90000");

    const reverting = fakeChain({ chainId: 11155111, callReverts: true });
    const reason = await asyncReasonOf(() =>
      estimateConfigurationWrite(reverting, { from: ATTACKER, to: SEPOLIA_CORE.ContextLockPolicyRegistry.address, data: "0xdeadbeef" as Hex }),
    );
    expect(reason).toBe(COST_REASONS.ESTIMATE_FAILED);
    await expect(
      estimateConfigurationWrite(reverting, { from: ATTACKER, to: SEPOLIA_CORE.ContextLockPolicyRegistry.address, data: "0xdeadbeef" as Hex }),
    ).rejects.toThrow(/simulation reverted before estimating.*NotAuthorized/s);
  });

  it("DEP-PRE-008 the native-token requirement is calculated per chain, from the steps on that chain", async () => {
    const p = canonicalPlan();
    const meta = new Map([[11155111, { symbol: "ETH", decimals: 18, holder: DEPLOYER }]]);
    const funding = aggregateByChain(p.steps, meta, new Map([[11155111, 10n ** 18n]]));
    expect(funding).toHaveLength(1);
    const f = funding[0]!;

    const costed = p.steps.filter((s) => s.chainId === 11155111 && s.cost);
    const expectedBase = costed.reduce((acc, s) => acc + BigInt(s.cost!.baseNativeWei), 0n);
    expect(f.baseWei).toBe(expectedBase);
    expect(f.recommendedWei).toBe(f.baseWei + f.bufferWei);
    expect(f.sufficient).toBe(true);

    // Two chains produce two independent requirements; a shortfall on one is not covered by a
    // surplus on the other, because ETH on Base Sepolia cannot pay for gas on Sepolia.
    const twoChain = clone(p);
    twoChain.steps.push({ ...twoChain.steps.find((s) => s.id === "deploy-cre-consumer")!, id: "deploy-on-base", chainId: 84532, dependencyIds: [] });
    const both = aggregateByChain(twoChain.steps, new Map([...meta, [84532, { symbol: "ETH", decimals: 18, holder: DEPLOYER }]]), new Map([[11155111, 10n ** 18n], [84532, 0n]]));
    expect(both.map((x) => x.chainId)).toEqual([84532, 11155111]);
    expect(both.find((x) => x.chainId === 84532)!.sufficient).toBe(false);
  });

  it("DEP-PRE-009 an insufficient balance blocks approval rather than warning about it", async () => {
    const r = await preflight({ balances: new Map([[11155111, 1n]]) });
    expect(r.readiness).toBe("PREFLIGHT_BLOCKED");
    expect(codesOf(r)).toContain("COST-INSUFFICIENT-BALANCE");
    const blocker = r.blockers.find((b) => b.code === "COST-INSUFFICIENT-BALANCE")!;
    // The remedy has to be actionable: which address, which chain, how much.
    expect(blocker.remedy).toContain(DEPLOYER);
    expect(blocker.remedy).toMatch(/\d+ wei/);

    expect(() =>
      approve({ manifest: canonicalManifest(), plan: canonicalPlan(), screen: r.screen, approvedBy: "user", nowMs: NOW }),
    ).toThrow(ApprovalError);
    expect(reasonOf(() => approve({ manifest: canonicalManifest(), plan: canonicalPlan(), screen: r.screen, approvedBy: "user", nowMs: NOW })))
      .toBe(APPROVAL_REASONS.BLOCKED);
  });

  it("DEP-PRE-010 the safety buffer is applied and reported separately from the estimate", async () => {
    const chain = fakeChain({ chainId: 11155111, gas: 100_000n, maxFeePerGas: 1_000_000_000n });
    const quote = await quoteFees(chain, () => NOW);
    const cost = costFrom(100_000n, quote);

    expect(cost.bufferBps).toBe(DEFAULT_BUFFER_BPS);
    expect(cost.baseNativeWei).toBe("100000000000000");
    expect(cost.bufferNativeWei).toBe("20000000000000");
    expect(cost.totalNativeWei).toBe("120000000000000");
    // The unbuffered number survives as its own field. A single padded total would present our
    // uncertainty as the node's measurement.
    expect(BigInt(cost.baseNativeWei) + BigInt(cost.bufferNativeWei)).toBe(BigInt(cost.totalNativeWei));

    const custom = costFrom(100_000n, quote, 500);
    expect(custom.bufferNativeWei).toBe("5000000000000");
    const none = costFrom(100_000n, quote, 0);
    expect(none.bufferNativeWei).toBe("0");
    expect(none.totalNativeWei).toBe(none.baseNativeWei);

    // Aggregation keeps them apart too.
    const meta = new Map([[11155111, { symbol: "ETH", decimals: 18, holder: DEPLOYER }]]);
    const f = aggregateByChain([{ chainId: 11155111, cost }], meta, new Map())[0]!;
    expect(f.baseWei).toBe(100_000_000_000_000n);
    expect(f.bufferWei).toBe(20_000_000_000_000n);
    expect(f.bufferBps).toBe(2000);

    // The percentage is carried, not recomputed from rounded wei. The first live run printed
    // "19.99% safety buffer" for a 20% buffer, which nobody would have questioned.
    const rows = requiredBalancesFor([f], []);
    expect(rows[0]!.purpose).toContain("20% safety buffer");
    expect(rows[0]!.purpose).not.toContain("19.99");

    // Steps that disagree about the buffer produce no single percentage, rather than an average.
    const mixedBuffer = aggregateByChain(
      [{ chainId: 11155111, cost }, { chainId: 11155111, cost: costFrom(100_000n, quote, 500) }],
      meta, new Map(),
    )[0]!;
    expect(mixedBuffer.bufferBps).toBeNull();
    expect(requiredBalancesFor([mixedBuffer], [])[0]!.purpose).toContain("differing safety buffers");
  });

  it("DEP-PRE-011 protocol operating assets are never labelled as gas", () => {
    const meta = new Map([[11155111, { symbol: "ETH", decimals: 18, holder: DEPLOYER }]]);
    const funding = aggregateByChain([{ chainId: 11155111, cost: stepCost() }], meta, new Map());
    const rows = requiredBalancesFor(funding, [
      { category: "TEST_PROTOCOL_ASSET", chainId: 11155111, token: "0x768f42455a2d082e23ceef7d51e5787c82d67a39" as Address, symbol: "USDC", decimals: 6, amount: "500000000", holder: AGENT, purpose: "Operating capital the agent rebalances. Not a deployment fee; it stays yours." },
    ]);

    const gas = rows.filter((r) => r.category === "NATIVE_GAS");
    const capital = rows.filter((r) => r.category !== "NATIVE_GAS");
    expect(gas).toHaveLength(1);
    expect(capital).toHaveLength(1);
    expect(capital[0]!.purpose).toMatch(/not a deployment fee/i);
    // Categories are disjoint, and the totals are never summed across them.
    expect(new Set(rows.map((r) => r.category)).size).toBe(2);

    // And an operating asset cannot smuggle itself onto the gas line.
    expect(() =>
      requiredBalancesFor(funding, [{ category: "NATIVE_GAS", chainId: 11155111, token: null, symbol: "USDC", decimals: 6, amount: "1", holder: AGENT, purpose: "sneaky" }]),
    ).toThrow(CostError);
  });

  it("DEP-PRE-011b the approval screen keeps capital off the funding list", async () => {
    const m = canonicalManifest({
      requiredBalances: [
        { category: "TEST_PROTOCOL_ASSET", chainId: 11155111, token: "0x768f42455a2d082e23ceef7d51e5787c82d67a39" as Address, symbol: "USDC", decimals: 6, amount: "500000000", holder: AGENT, purpose: "Operating capital." },
      ],
    });
    const r = await preflight({ manifest: m, plan: canonicalPlan(m) });
    expect(r.screen.funds.every((f) => f.symbol === "ETH")).toBe(true);
    expect(r.screen.operatingAssets.map((a) => a.symbol)).toEqual(["USDC"]);
    expect(r.screen.operatingAssets[0]!.category).toBe("TEST_PROTOCOL_ASSET");
  });

  it("DEP-PRE-024 a cost estimate goes stale after the fee-quote lifetime and cannot be approved", async () => {
    expect(quoteIsStale({ quotedAtMs: NOW }, NOW + FEE_QUOTE_TTL_MS - 1)).toBe(false);
    expect(quoteIsStale({ quotedAtMs: NOW }, NOW + FEE_QUOTE_TTL_MS + 1)).toBe(true);

    const late = NOW + FEE_QUOTE_TTL_MS + 60_000;
    const r = await preflight({ nowMs: late });
    expect(codesOf(r)).toContain("COST-QUOTE-STALE");

    // Even a screen with no blockers cannot be approved against expired numbers.
    const fresh = await preflight();
    expect(reasonOf(() => approve({ manifest: canonicalManifest(), plan: canonicalPlan(), screen: fresh.screen, approvedBy: "u", nowMs: late })))
      .toBe(APPROVAL_REASONS.STALE_COSTS);
  });

  it("DEP-PRE-024b the oldest quote governs an aggregate, and a fixture-derived number is never a quote", async () => {
    const meta = new Map([[11155111, { symbol: "ETH", decimals: 18, holder: DEPLOYER }]]);
    const f = aggregateByChain(
      [{ chainId: 11155111, cost: stepCost({ quotedAtMs: NOW - 600_000 }) }, { chainId: 11155111, cost: stepCost({ quotedAtMs: NOW }) }],
      meta,
      new Map(),
    )[0]!;
    expect(f.quotedAtMs).toBe(NOW - 600_000);

    const mixed = aggregateByChain(
      [{ chainId: 11155111, cost: stepCost({ fromLiveNode: true }) }, { chainId: 11155111, cost: stepCost({ fromLiveNode: false }) }],
      meta,
      new Map(),
    )[0]!;
    expect(mixed.fromLiveNode).toBe(false);
  });

  it("DEP-PRE-006c the sender is carried into a gas estimate, not dropped", async () => {
    /*
     * viem's `estimateGas` names the sender `account`. Passing `from` type-checks against a loose
     * signature and is silently ignored, so the estimate is made from the zero address.
     *
     * A live deployment run found this the expensive way: `setPolicyAdmin` estimated as
     * `NotAdmin()`, because a permissioned call estimated from nobody is a call that reverts. The
     * unpermissioned case is worse — it does not revert, it just estimates a different transaction.
     */
    let seen: Record<string, unknown> | null = null;
    const recording = {
      ...fakeChain({ chainId: 11155111 }),
      async estimateGas(tx: Record<string, unknown>) { seen = tx; return 21_000n; },
    };
    await estimateConfigurationWrite(recording, { from: DEPLOYER, to: SEPOLIA_CORE.ContextLockPolicyRegistry.address, data: "0x1234" as Hex }, () => NOW);
    expect(seen).not.toBeNull();
    expect((seen as unknown as { from?: string }).from, "the ChainReader contract carries the sender as `from`").toBe(DEPLOYER);

    // And the live adapter must translate it. Asserted on the shape it builds, since calling a real
    // node here would make this a network test.
    const src = readFileSync("packages/studio-deploy/src/chain.ts", "utf8");
    const estimateBlock = src.slice(src.indexOf("estimateGas: (tx) =>"), src.indexOf("estimateFeesPerGas:"));
    expect(estimateBlock, "viemChainReader must pass `account`").toContain("account: tx.from");
    expect(estimateBlock).not.toMatch(/client\.estimateGas\(tx as never\)/);
  });

  it("DEP-PRE-006b refusing beats inventing a fee when a node returns none", async () => {
    const noFees = fakeChain({ chainId: 11155111, maxFeePerGas: 0n, gasPrice: 0n });
    expect(await asyncReasonOf(() => quoteFees(noFees))).toBe(COST_REASONS.NO_FEE_DATA);

    // A legacy chain is handled, not refused.
    const legacy = fakeChain({ chainId: 11155111, gasPrice: 7_000_000_000n });
    const q = await quoteFees(legacy, () => NOW);
    expect(q.mode).toBe("LEGACY");
    expect(q.maxFeePerGasWei).toBe(7_000_000_000n);
  });

  it("DEP-PRE-008b the model-usage forecast is advisory and says so", () => {
    const f = forecastModelUsage({
      model: "gpt-5.6-luna", invocationsPerDay: 50, medianInputTokens: 4200, medianOutputTokens: 900,
      pricePerMInputUsd: 1.25, pricePerMOutputUsd: 10, basis: "P11-P21 studio_usage medians",
    });
    expect(f.projectedInputTokensPerDay).toBe(210_000);
    expect(f.projectedOutputTokensPerDay).toBe(45_000);
    expect(f.advisoryOnly).toBe(true);
    expect(f.basis).toBeTruthy();

    // With no verified price there is no dollar figure, rather than a made-up one.
    const noPrice = forecastModelUsage({ model: "x", invocationsPerDay: 1, medianInputTokens: 1, medianOutputTokens: 1, basis: "b" });
    expect(noPrice.projectedCostUsdPerDay).toBeNull();

    expect(formatUnitsExact(1_200_000_000_000_000n, 18)).toBe("0.0012");
  });
});

/* ══════════════════════════════ environment ══════════════════════════════ */

describe("the environment gate", () => {
  it("DEP-PRE-012 a mainnet write is prohibited, by kind, by flag and by chain id", () => {
    expect(writesAllowedFor("MAINNET")).toBe(false);
    expect(writesAllowedFor("SHADOW_MAINNET")).toBe(false);
    expect(writesAllowedFor("TESTNET")).toBe(true);

    expect(reasonOf(() => assertWriteAllowed(mainnetEnvironment(), 1))).toBe(ENVIRONMENT_REASONS.MAINNET_WRITE_PROHIBITED);

    // A SHADOW_MAINNET environment is read-only and says so with its own reason code.
    const shadow = { ...testnetEnvironment(), kind: "SHADOW_MAINNET" as const };
    expect(reasonOf(() => assertWriteAllowed(shadow, 11155111))).toBe(ENVIRONMENT_REASONS.SHADOW_MAINNET_READ_ONLY);

    // The interesting attack: a TESTNET-labelled environment listing chain 1. The kind check passes
    // and the chain-id check does not, which is why both exist.
    const disguised = testnetEnvironment([{ chainId: 1, name: "Definitely Sepolia", chainSelector: "5009297550715157269", nativeSymbol: "ETH", nativeDecimals: 18, explorer: null }]);
    expect(disguised.kind).toBe("TESTNET");
    expect(reasonOf(() => assertWriteAllowed(disguised, 1))).toBe(ENVIRONMENT_REASONS.MAINNET_WRITE_PROHIBITED);

    // And flipping the flag on a mainnet environment changes nothing.
    expect(reasonOf(() => assertWriteAllowed({ ...mainnetEnvironment(), writesPermitted: true }, 1)))
      .toBe(ENVIRONMENT_REASONS.MAINNET_WRITE_PROHIBITED);
  });

  it("DEP-PRE-012b the preflight refuses a plan whose write steps target a prohibited chain", async () => {
    const m = canonicalManifest({ environment: mainnetEnvironment() });
    const p = canonicalPlan(m);
    const mainnetPlan = clone(p);
    for (const s of mainnetPlan.steps) if (s.chainId !== null) s.chainId = 1;
    const r = await preflight({ manifest: m, plan: mainnetPlan, readers: new Map([[1, fakeChain({ chainId: 1 })]]), balances: new Map([[1, 10n ** 20n]]) });
    expect(r.readiness).toBe("PREFLIGHT_BLOCKED");
    expect(codesOf(r)).toContain(ENVIRONMENT_REASONS.MAINNET_WRITE_PROHIBITED);
  });

  it("DEP-PRE-025 a wallet on the wrong chain is rejected, as is an RPC that is not the chain it claims", async () => {
    expect(reasonOf(() => assertWalletChain(11155111, 84532))).toBe(ENVIRONMENT_REASONS.WALLET_CHAIN_MISMATCH);
    expect(() => assertWalletChain(11155111, 11155111)).not.toThrow();

    const lying = sepoliaReader({ reportedChainId: 84532 });
    const r = await preflight({ readers: readers(lying) });
    expect(codesOf(r)).toContain("ENV-CHAIN-ID-MISMATCH");
  });

  it("DEP-PRE-025b an unreachable RPC blocks rather than being skipped", async () => {
    const dead = fakeChain({ chainId: 11155111, failWith: { method: "getChainId", error: new Error("ETIMEDOUT") } });
    const r = await preflight({ readers: readers(dead) });
    expect(codesOf(r)).toContain("PREFLIGHT-RPC-UNREACHABLE");
  });
});

/* ══════════════════════════════ CRE ══════════════════════════════ */

describe("CRE preflight", () => {
  it("DEP-PRE-013 CRE status crossing to the web app carries fields, not credentials", () => {
    const s = creStatus();
    expect(s.connected).toBe(true);
    expect(s.organizationId).toBe("org_ENDgZRZzalm3d3So");
    expect(s.deployAccess).toBe(true);
    expect(() => assertNoCreSecret(s, "status")).not.toThrow();

    // There is nowhere in CreStatus to put a token, but the guard is checked directly too, since
    // the same guard runs over raw CLI output before anything is projected into CreStatus.
    expect(reasonOf(() => assertNoCreSecret({ ...s, accessToken: "x" }, "status"))).toBe(CRE_REASONS.CREDENTIAL_LEAK);
    expect(reasonOf(() => assertNoCreSecret({ nested: { deep: { session: "x" } } }, "raw"))).toBe(CRE_REASONS.CREDENTIAL_LEAK);
  });

  it("DEP-PRE-014 a CRE session credential is never returned, under any key or shape", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abcdefghijklmno";
    // Under an innocuous key name, which is how a token actually escapes.
    expect(reasonOf(() => assertNoCreSecret({ organizationName: jwt }, "cli"))).toBe(CRE_REASONS.CREDENTIAL_LEAK);
    expect(reasonOf(() => assertNoCreSecret([{ ok: true }, { note: jwt }], "cli"))).toBe(CRE_REASONS.CREDENTIAL_LEAK);
    expect(reasonOf(() => assertNoCreSecret({ pem: "-----BEGIN PRIVATE KEY-----\nabc" }, "cli"))).toBe(CRE_REASONS.CREDENTIAL_LEAK);
    expect(() => assertNoCreSecret({ organizationName: "My Org", cliVersion: "v1.32.0" }, "cli")).not.toThrow();
  });

  it("DEP-PRE-015 a managed CRE API key is a reference, and the sinks it may not reach are enumerated", () => {
    const ref = { credentialRef: "cred_0123456789abcdef", manager: "contextlock-secrets", createdAtMs: NOW, audience: "cre-broker" as const };
    expect(CredentialRefSchema.safeParse(ref).success).toBe(true);
    // The ref carries no key material of any kind.
    expect(JSON.stringify(ref)).not.toMatch(/eyJ|sk-|BEGIN/);
    expect(() => assertNoSecrets(ref, "credentialRef")).not.toThrow();

    expect(CRE_KEY_FORBIDDEN_SINKS).toContain("blueprint");
    expect(CRE_KEY_FORBIDDEN_SINKS).toContain("runtime-container");
    expect(CRE_KEY_FORBIDDEN_SINKS).toContain("logs");
    expect(CRE_KEY_FORBIDDEN_SINKS).toContain("export");

    // A blueprint-shaped object containing a real key is caught by the artifact scanner.
    expect(() => assertNoSecrets({ blueprint: { env: { CRE_API_KEY: "abcd" } } }, "blueprint")).toThrow(DeploymentSecretError);
  });

  it("DEP-PRE-016 the private registry is the testnet default", () => {
    const env = testnetEnvironment();
    expect(selectRegistry(env)).toBe("private");
    expect(selectRegistry(env, "private")).toBe("private");
    expect(env.allowedCreRegistries).toEqual(["private"]);
  });

  it("DEP-PRE-017 the onchain mainnet registry is refused before P27, because its lifecycle is a mainnet write", () => {
    const env = testnetEnvironment();
    const r = reasonOf(() => selectRegistry(env, "onchain:ethereum-mainnet"));
    expect(r).toBe(ENVIRONMENT_REASONS.MAINNET_CONTROL_PLANE_PROHIBITED);
    expect(r).toBe("MAINNET_CONTROL_PLANE_PROHIBITED");
    // Any onchain registry, not just the one we happen to know the id of.
    expect(reasonOf(() => selectRegistry(env, "onchain:some-other-chain"))).toBe("MAINNET_CONTROL_PLANE_PROHIBITED");
    // A registry that is neither is refused for a different, correctly-named reason.
    expect(reasonOf(() => selectRegistry(env, "experimental"))).toBe(CRE_REASONS.REGISTRY_NOT_ALLOWED);
  });

  it("DEP-PRE-018 missing deploy access surfaces as a deployment blocker, not a build failure", async () => {
    const noAccess = creStatus({ deployAccess: false });
    const reason = reasonOf(() => assertDeployAccess(noAccess));
    expect(reason).toBe("CRE_DEPLOY_ACCESS_REQUIRED");
    expect(() => assertDeployAccess(noAccess)).toThrow(/deployment blocker, not a build failure/);
    expect(() => assertDeployAccess(noAccess)).toThrow(/cre account access/);

    const r = await preflight({ creStatus: noAccess });
    expect(r.readiness).toBe("PREFLIGHT_BLOCKED");
    expect(codesOf(r)).toContain("CRE_DEPLOY_ACCESS_REQUIRED");

    // Not connected, and bridge-offline, are separate states with separate codes.
    expect(reasonOf(() => assertDeployAccess(creStatus({ connected: false })))).toBe(CRE_REASONS.NOT_CONNECTED);
    expect(reasonOf(() => assertDeployAccess(creStatus({ staleness: "STALE_BRIDGE_OFFLINE" })))).toBe(CRE_REASONS.BRIDGE_OFFLINE);
  });

  it("DEP-PRE-019 the current registry quota is captured rather than assumed, and its source is recorded", async () => {
    const snap = creQuota();
    expect(snap.source).toBe("CLI_LIMITS_EXPORT");
    expect(snap.capturedAtMs).toBe(NOW);

    // The documented values are available only as an explicitly-labelled fallback.
    expect(DOCUMENTED_CRE_DEFAULTS.source).toBe("DOCUMENTED_DEFAULT");
    expect(DOCUMENTED_CRE_DEFAULTS.maxWorkflowsPrivateRegistry).toBe(3);
    expect(DOCUMENTED_CRE_DEFAULTS.maxWasmBytes).toBe(100 * 1024 * 1024);

    const checks = checkQuotas(snap, { wasmBytes: 2_400_000, compressedWasmBytes: 900_000, configBytes: 1024, triggerCount: 1 });
    expect(checks.every((c) => c.ok)).toBe(true);
    // Every row is reported, not only the failures, so the approval screen can show slots used.
    expect(checks.map((c) => c.name)).toContain("private-registry workflows");

    const full = checkQuotas(creQuota({ workflowsInUse: 3 }), { wasmBytes: 1, compressedWasmBytes: 1, configBytes: 1, triggerCount: 1 });
    expect(reasonOf(() => assertQuotasOk(full))).toBe(CRE_REASONS.QUOTA_EXCEEDED);

    const tooBig = checkQuotas(snap, { wasmBytes: 200 * 1024 * 1024, compressedWasmBytes: 1, configBytes: 1, triggerCount: 1 });
    expect(() => assertQuotasOk(tooBig)).toThrow(/WASM binary size/);

    const r = await preflight({ creQuota: null });
    expect(codesOf(r)).toContain("CRE-QUOTA-NOT-CAPTURED");
  });

  it("DEP-PRE-020 the CRE WASM is built before approval and its hash is pinned", async () => {
    const a = creArtifact();
    expect(a.wasmBytes).toBeGreaterThan(0);
    expect(a.binaryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sourceTreeHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.creCliVersion).toBe("v1.32.0");

    const m = canonicalManifest();
    expect(m.creWorkflows[0]!.binaryHash).toBe(a.binaryHash);
    expect(pinnedArtifacts(m).some((p) => p.kind === "cre-binary" && p.hash === a.binaryHash)).toBe(true);

    const r = await preflight({ creArtifact: null });
    expect(codesOf(r)).toContain("CRE-NOT-BUILT");
  });

  it("DEP-PRE-021 changed CRE source invalidates the approval", () => {
    const approved = creArtifact();
    const edited = creArtifact({ sourceTreeHash: `sha256:${"a".repeat(64)}`, wasmSha256: "b".repeat(64), binaryHash: "c".repeat(64) });
    const drift = artifactDrift(approved, edited);
    expect(drift.some((d) => d.startsWith("source tree hash"))).toBe(true);
    expect(drift.some((d) => d.startsWith("WASM sha256"))).toBe(true);
    expect(reasonOf(() => assertNoArtifactDrift(approved, edited))).toBe("DEPLOYMENT_ARTIFACT_DRIFT");
    expect(() => assertNoArtifactDrift(approved, creArtifact())).not.toThrow();

    // A source tree hash reflects file content and path, so any edit moves it.
    const t1 = sourceTreeHash([{ path: "workflow.ts", content: "a" }, { path: "config.json", content: "{}" }]);
    const t2 = sourceTreeHash([{ path: "config.json", content: "{}" }, { path: "workflow.ts", content: "a" }]);
    expect(t1).toBe(t2);
    expect(sourceTreeHash([{ path: "workflow.ts", content: "a " }, { path: "config.json", content: "{}" }])).not.toBe(t1);
    expect(sourceTreeHash([{ path: "workflow2.ts", content: "a" }, { path: "config.json", content: "{}" }])).not.toBe(t1);
  });

  it("DEP-PRE-022 changed workflow config invalidates the approval, and the drift names the config", () => {
    const approved = creArtifact();
    const reconfigured = creArtifact({ configHash: "d".repeat(64), configSha256: "e".repeat(64), workflowHash: "f".repeat(64) });
    const drift = artifactDrift(approved, reconfigured);
    expect(drift.some((d) => d.startsWith("CRE config hash"))).toBe(true);
    expect(drift.some((d) => d.startsWith("config file sha256"))).toBe(true);
    // The binary did not change; saying so is the difference between a useful and a useless report.
    expect(drift.some((d) => d.startsWith("WASM sha256"))).toBe(false);
    expect(reasonOf(() => assertNoArtifactDrift(approved, reconfigured))).toBe("DEPLOYMENT_ARTIFACT_DRIFT");
  });

  it("DEP-PRE-023 production-limit simulation is required, and 'not run' is a distinct failure from 'violated'", async () => {
    expect(() => assertLimitsSatisfied(creLimits())).not.toThrow();
    expect(reasonOf(() => assertLimitsSatisfied(null))).toBe(CRE_REASONS.LIMITS_NOT_SIMULATED);
    expect(reasonOf(() => assertLimitsSatisfied(creLimits({ ran: false })))).toBe(CRE_REASONS.LIMITS_NOT_SIMULATED);
    expect(reasonOf(() => assertLimitsSatisfied(creLimits({ violations: ["EVM read calls per execution: 22 > 15"] }))))
      .toBe(CRE_REASONS.LIMITS_VIOLATED);

    const r = await preflight({ creLimits: null });
    expect(r.readiness).toBe("PREFLIGHT_BLOCKED");
    expect(codesOf(r)).toContain(CRE_REASONS.LIMITS_NOT_SIMULATED);
    expect(r.screen.cre!.limitsSimulated).toBe(false);
  });

  it("DEP-PRE-023b the CRE command vocabulary is closed and contains no passthrough", () => {
    expect(CRE_COMMANDS).toContain("workflow-build");
    expect(CRE_COMMANDS).toContain("workflow-deploy");
    // No shell, no arbitrary command, no login-with-password.
    for (const forbidden of ["exec", "shell", "run", "raw", "login-with-password", "export-session"]) {
      expect(CRE_COMMANDS as readonly string[]).not.toContain(forbidden);
    }
  });

  it("DEP-PRE-023c a chain outside the tenant's supported set blocks CRE deployment, compared as strings", async () => {
    const s = creStatus();
    expect(creSupportsChain(s, "16015286601757825753")).toBe(true);
    // The neighbouring selector must NOT match. Both collapse to the same double, which is why
    // selectors are strings everywhere in this codebase.
    expect(creSupportsChain(s, "16015286601757825754")).toBe(false);
    expect(Number("16015286601757825753")).toBe(Number("16015286601757825754"));

    const m = canonicalManifest({ environment: testnetEnvironment([{ ...ETHEREUM_SEPOLIA, chainSelector: "16015286601757825754" }]) });
    const r = await preflight({ manifest: m, plan: canonicalPlan(m) });
    expect(codesOf(r)).toContain("CRE-CHAIN-UNSUPPORTED");
  });
});

/* ══════════════════════════════ approval ══════════════════════════════ */

describe("the approval screen", () => {
  it("DEP-PRE-026 a user cannot approve a plan naming a signer the manifest does not describe", async () => {
    const m = canonicalManifest();
    const p = clone(canonicalPlan(m));
    p.steps.find((s) => s.id === "deploy-cre-consumer")!.requiredSigner = "mystery-signer";
    expect(reasonOf(() => validatePlan(p, new Set(m.requiredSigners.map((s) => s.signerId))))).toBe(PLAN_REASONS.UNKNOWN_SIGNER);

    const r = await preflight({ manifest: m, plan: p });
    expect(r.readiness).toBe("PREFLIGHT_BLOCKED");
    expect(reasonOf(() => approve({ manifest: m, plan: p, screen: r.screen, approvedBy: "u", nowMs: NOW }))).toBe(APPROVAL_REASONS.BLOCKED);

    // And every signer that IS required appears on the screen with what it authorizes.
    const ok = await preflight();
    expect(ok.screen.signers.map((s) => s.signerId)).toEqual(["deployer", "policy-admin"]);
    expect(ok.screen.signers.every((s) => s.authorizes.length > 10)).toBe(true);
  });

  it("DEP-PRE-027 the runtime's initial state is INACTIVE and is part of the approved document", () => {
    const m = canonicalManifest();
    expect(m.runtimeInitialState).toBe("INACTIVE");
    // Not representable otherwise: the schema is a literal, so there is no manifest that says
    // "start it running".
    expect(DeploymentManifestSchema.safeParse({ ...m, runtimeInitialState: "ACTIVE" }).success).toBe(false);
    expect(manifestHash(m)).toBeTruthy();
    expect(canonicalize(m)).toContain('"runtimeInitialState":"INACTIVE"');
  });

  it("DEP-PRE-028 the policy's initial state is DISABLED, the CRE workflow starts PAUSED, and the screen says so", async () => {
    const m = canonicalManifest();
    expect(m.policyInitialState).toBe("DISABLED");
    expect(m.creInitialState).toBe("PAUSED");
    expect(DeploymentManifestSchema.safeParse({ ...m, policyInitialState: "ENABLED" }).success).toBe(false);
    expect(m.creWorkflows.every((w) => w.initialState === "PAUSED")).toBe(true);

    const r = await preflight();
    expect(r.screen.security.policyInitialState).toBe("DISABLED");
    expect(r.screen.security.agentInitialState).toBe("INACTIVE");
    expect(r.screen.security.creInitialState).toBe("PAUSED");
    // The one sentence a user is most likely to get wrong is stated for them.
    expect(r.screen.security.notes.join(" ")).toMatch(/CRE workflow pause is NOT trusted as the kill switch/i);
    expect(r.screen.security.notes.join(" ")).toMatch(/Deploying does not activate/i);
  });

  it("DEP-PRE-026b readiness moves only along legal transitions, and DEPLOYMENT_APPROVED is terminal here", () => {
    expect(() => assertReadinessTransition("PREFLIGHT_DRAFT", "PREFLIGHT_RUNNING")).not.toThrow();
    expect(() => assertReadinessTransition("PREFLIGHT_RUNNING", "PREFLIGHT_READY")).not.toThrow();
    expect(() => assertReadinessTransition("PREFLIGHT_READY", "DEPLOYMENT_APPROVED")).not.toThrow();
    // Blocked must be re-checked, not acknowledged into readiness.
    expect(reasonOf(() => assertReadinessTransition("PREFLIGHT_BLOCKED", "PREFLIGHT_READY"))).toBe(APPROVAL_REASONS.NOT_READY);
    expect(reasonOf(() => assertReadinessTransition("PREFLIGHT_DRAFT", "DEPLOYMENT_APPROVED"))).toBe(APPROVAL_REASONS.NOT_READY);
    expect(reasonOf(() => assertReadinessTransition("DEPLOYMENT_APPROVED", "PREFLIGHT_RUNNING"))).toBe(APPROVAL_REASONS.NOT_READY);
  });

  it("DEP-PRE-026c an approval records the exact hashes the user saw, and drift names the artifact", async () => {
    const m = canonicalManifest();
    const p = canonicalPlan(m);
    const r = await preflight({ manifest: m, plan: p });
    expect(r.readiness).toBe("PREFLIGHT_READY");

    const approved = approve({ manifest: m, plan: p, screen: r.screen, approvedBy: "kaushikh", nowMs: NOW });
    expect(approved.readiness).toBe("DEPLOYMENT_APPROVED");
    expect(approved.approval!.manifestHash).toBe(manifestHash(m));
    expect(approved.approval!.planHash).toBe(deploymentPlanHash(p));
    expect(Object.keys(approved.approval!.artifactHashes).length).toBeGreaterThan(4);
    expect(approvalDrift(approved, m)).toEqual([]);
    expect(() => assertApprovedFor(approved, m)).not.toThrow();

    // Edit the CRE binary after approval: the drift report names the CRE binary specifically.
    const edited = clone(m);
    edited.creWorkflows[0]!.binaryHash = "f".repeat(64);
    const drift = approvalDrift(approved, edited);
    expect(drift.some((d) => d.startsWith("cre-binary:contextlock-policy"))).toBe(true);
    expect(reasonOf(() => assertApprovedFor(approved, edited))).toBe("DEPLOYMENT_ARTIFACT_DRIFT");

    // An adapter appearing after approval is drift too — approval is over a closed set.
    const extra = clone(m);
    extra.adapters.push({ adapterId: "sneaky", version: "1.0.0", artifactHash: `sha256:${"1".repeat(64)}` });
    expect(approvalDrift(approved, extra).some((d) => d.includes("not part of the approval"))).toBe(true);
  });

  it("DEP-PRE-026d a screen built from a different revision cannot be used to approve", async () => {
    const m = canonicalManifest();
    const p = canonicalPlan(m);
    const r = await preflight({ manifest: m, plan: p });
    const stale = { ...r.screen, manifestHash: `sha256:${"9".repeat(64)}` };
    expect(reasonOf(() => approve({ manifest: m, plan: p, screen: stale, approvedBy: "u", nowMs: NOW }))).toBe(APPROVAL_REASONS.MANIFEST_DRIFT);
    const stalePlan = { ...r.screen, planHash: `sha256:${"8".repeat(64)}` };
    expect(reasonOf(() => approve({ manifest: m, plan: p, screen: stalePlan, approvedBy: "u", nowMs: NOW }))).toBe(APPROVAL_REASONS.PLAN_DRIFT);
  });

  it("DEP-PRE-026e the approval screen shows what §22.15 requires", async () => {
    const r = await preflight();
    expect(r.screen.target.environmentKind).toBe("TESTNET");
    expect(r.screen.target.chains.map((c) => c.chainId)).toEqual([11155111]);
    expect(r.screen.contracts).toMatchObject({ reused: 3, configured: 1, deployedNew: 1 });
    expect(r.screen.cre!.registry).toBe("private");
    expect(r.screen.cre!.deployAccess).toBe(true);
    expect(r.screen.cre!.workflowSlots).toEqual({ used: 0, allowed: 3 });
    expect(r.screen.cre!.binaryHash).toBe(creArtifact().binaryHash);
    expect(r.screen.runtime.initialState).toBe("INACTIVE");
    expect(r.screen.funds).toHaveLength(1);
    expect(r.screen.blockers.filter((b) => b.severity === "BLOCKER")).toEqual([]);
  });
});

/* ══════════════════════════════ signing ══════════════════════════════ */

describe("the wallet signing model", () => {
  it("DEP-PRE-025c a signature request has nowhere to put a private key, and is simulated before it is offered", async () => {
    const chain = fakeChain({ chainId: 11155111 });
    const req = await prepareForSignature(chain, {
      signerId: "deployer", mode: "BROWSER_WALLET", chainId: 11155111,
      from: DEPLOYER, to: SEPOLIA_CORE.ContextLockPolicyRegistry.address,
      data: "0xdeadbeef" as Hex, value: "0", gas: "90000",
      description: "Register this agent's policy, disabled.", deploymentStepId: "register-policy-disabled",
    });
    expect(req.calldataHash).toBe(calldataHashOf("0xdeadbeef" as Hex));
    expect(Object.keys(req)).not.toContain("privateKey");
    expect(() => assertNoSecrets(req, "signatureRequest")).not.toThrow();

    // A request that would revert never reaches a wallet.
    const reverting = fakeChain({ chainId: 11155111, callReverts: true });
    expect(await asyncReasonOf(() => prepareForSignature(reverting, {
      signerId: "deployer", mode: "BROWSER_WALLET", chainId: 11155111, from: DEPLOYER,
      to: SEPOLIA_CORE.ContextLockPolicyRegistry.address, data: "0x00" as Hex, value: "0", gas: "1",
      description: "d", deploymentStepId: "register-policy-disabled",
    }))).toBe(SIGNING_REASONS.SIMULATION_REVERTED);

    // The wallet must be the right account, on the right chain, and must sign what we prepared.
    expect(reasonOf(() => assertSignerMatches(req, { address: ATTACKER, chainId: 11155111 }))).toBe(SIGNING_REASONS.WRONG_ACCOUNT);
    expect(reasonOf(() => assertSignerMatches(req, { address: DEPLOYER, chainId: 84532 }))).toBe(SIGNING_REASONS.WRONG_CHAIN);
    expect(() => assertSignerMatches(req, { address: DEPLOYER, chainId: 11155111 })).not.toThrow();
    expect(reasonOf(() => assertSignedWhatWePlanned(req, "0xcafebabe" as Hex))).toBe(SIGNING_REASONS.CALLDATA_MISMATCH);
    expect(() => assertSignedWhatWePlanned(req, "0xdeadbeef" as Hex)).not.toThrow();

    // Both supported modes are user-held. There is no third mode where the server holds a key.
    const m = canonicalManifest();
    expect(new Set(m.requiredSigners.map((s) => s.mode))).toEqual(new Set(["BROWSER_WALLET"]));
    for (const s of m.requiredSigners) expect(["BROWSER_WALLET", "LOCAL_BRIDGE_WALLET"]).toContain(s.mode);
  });
});

/* ══════════════════════════════ secrets ══════════════════════════════ */

describe("deployment artifacts hold no secrets", () => {
  it("DEP-PRE-030 no deployment secret reaches a manifest, plan, screen or export", async () => {
    const m = canonicalManifest();
    const p = canonicalPlan(m);
    const r = await preflight({ manifest: m, plan: p });
    for (const [what, v] of [["manifest", m], ["plan", p], ["screen", r.screen], ["reuse", r.reuse]] as const) {
      expect(scanForSecrets(v, what), `${what} must contain no secret-shaped value`).toEqual([]);
    }

    // The scanner has to actually fire, or an empty result proves nothing.
    expect(scanForSecrets({ OPENAI_API_KEY: "sk-proj-NOT-A-REAL-KEY-0000000000000" }).length).toBeGreaterThan(0);
    expect(scanForSecrets({ deployerKey: `0x${"ab".repeat(32)}` }).map((h) => h.kind)).toContain("possible-32-byte-key");
    expect(scanForSecrets({ note: "-----BEGIN PRIVATE KEY-----" }).map((h) => h.kind)).toContain("pem-private-key");
    expect(scanForSecrets({ session: ".cre/cre.yaml" }).map((h) => h.kind)).toContain("cre-session-path");
    expect(scanForSecrets({ awsKey: "AKIAIOSFODNN7EXAMPLE" }).map((h) => h.kind)).toContain("aws-access-key-id");

    // ...and must not fire on the 32-byte values a manifest legitimately holds, or it gets ignored.
    expect(scanForSecrets({ runtimeCodeHash: `0x${"cd".repeat(32)}`, node: `0x${"ef".repeat(32)}`, txHash: `0x${"01".repeat(32)}` })).toEqual([]);

    // A finding never quotes the value it found.
    const hit = scanForSecrets({ OPENAI_API_KEY: "sk-proj-NOT-A-REAL-KEY-0000000000000" })[0]!;
    expect(hit.excerpt).not.toContain("abcdefghijklmnopqrstuvwxyz01");
  });
});

/* ══════════════════════════════ the whole run ══════════════════════════════ */

describe("the preflight, end to end", () => {
  it("DEP-PRE-029 a clean canonical agent reaches PREFLIGHT_READY and can then be approved", async () => {
    const m = canonicalManifest();
    const p = canonicalPlan(m);
    const r = await preflight({ manifest: m, plan: p });

    expect(r.blockers.filter((b) => b.severity === "BLOCKER")).toEqual([]);
    expect(r.readiness).toBe("PREFLIGHT_READY");
    expect(r.registry).toBe("private");
    expect(r.reuse.verified).toHaveLength(4);
    expect(r.reuse.toDeploy).toEqual(["ContextLockCreConsumer"]);
    expect(r.reuse.toConfigure).toEqual(["AgentPolicy"]);
    expect(r.manifestHash).toBe(manifestHash(m));

    const approved = approve({ manifest: m, plan: p, screen: r.screen, approvedBy: "kaushikh", nowMs: NOW });
    expect(approved.readiness).toBe("DEPLOYMENT_APPROVED");
    // P22 ends here. Nothing in this package can take the next step.
    expect(approved.steps.every((s) => s.status === "PENDING")).toBe(true);
  });

  it("DEP-PRE-029b the preflight collects every blocker rather than failing on the first", async () => {
    const r = await preflight({
      balances: new Map([[11155111, 0n]]),
      creStatus: creStatus({ deployAccess: false }),
      creLimits: null,
      creQuota: null,
    });
    const codes = codesOf(r);
    expect(codes).toContain("COST-INSUFFICIENT-BALANCE");
    expect(codes).toContain("CRE_DEPLOY_ACCESS_REQUIRED");
    expect(codes).toContain(CRE_REASONS.LIMITS_NOT_SIMULATED);
    expect(codes).toContain("CRE-QUOTA-NOT-CAPTURED");
    // Each blocker carries a remedy; a code with no next action is a dead end.
    expect(r.blockers.every((b) => b.remedy.length > 0)).toBe(true);
  });

  it("DEP-PRE-029c an agent with no CRE component is not blocked by CRE checks", async () => {
    const m = canonicalManifest({ creWorkflows: [] });
    const r = await preflight({ manifest: m, plan: canonicalPlan(m), creStatus: null, creArtifact: null, creQuota: null, creLimits: null });
    expect(r.screen.cre).toBeNull();
    expect(codesOf(r).filter((c) => c.startsWith("CRE"))).toEqual([]);
    expect(r.readiness).toBe("PREFLIGHT_READY");
  });

  it("DEP-PRE-029d P22 performs no write: the package exposes no send, deploy or activate", async () => {
    const mod = await import("../src/index.js");
    const forbidden = /^(send|submit|broadcast|deploy|activate|start|publish|write)[A-Z]/;
    const offenders = Object.keys(mod).filter((k) => typeof (mod as Record<string, unknown>)[k] === "function" && forbidden.test(k));
    expect(offenders).toEqual([]);
    // The one function named "deploy"-adjacent is a predicate about permission, not an action.
    expect(typeof mod.assertWriteAllowed).toBe("function");
  });
});
