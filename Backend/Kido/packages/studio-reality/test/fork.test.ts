import { describe, expect, it } from "vitest";
import {
  AnvilForkProvider, assertLocalForkEndpoint, LOCAL_FORK_HOSTS, explorerUrlFor,
  forkNetworkRef, ForkError, FORK_REASONS, ForkTransactionSchema, LOCAL_FORK_TX_LABEL,
  FORBIDDEN_TX_LABELS, ANVIL_DEV_ACCOUNTS, LOCAL_FORK_ONLY, KEY_FORBIDDEN_STORES,
  assertDevKeyStoreAllowed, assertImpersonationAllowed, IMPERSONATED_FOR_SIMULATION,
  IMPERSONATION_CANNOT_PROVE, assertEnvironmentBinding, FORK_LIMITS, assertForkQuota,
  ForkDescriptorSchema, type EnvironmentBinding,
} from "../src/index.js";
import { assertExecutionAllowed, NetworkGuardError } from "@contextlock/studio-network";
import { anvilRecorder, fakeAnvilRpc, REAL_ANCHOR, sourceLines, isComment } from "./fixtures.js";

/**
 * The fork.
 *
 * A fork is the one place mainnet addresses are legitimately used for a write, so it is the place
 * where a false claim is easiest to make by accident. These tests drive the shipped provider with a
 * scripted node; `reality-live.test.ts` and the evidence run drive the real Anvil.
 */

const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};

const asyncReasonOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e) { const r = (e as { reason?: string }).reason; if (r) return r; throw e; }
  throw new Error("expected a rejection, but the call succeeded");
};

const REAL_HASH = REAL_ANCHOR.hash;

const newProvider = (rpcOpts: Parameters<typeof fakeAnvilRpc>[0] = {}) => {
  const rec = anvilRecorder();
  const anvil = fakeAnvilRpc({ blockNumber: REAL_ANCHOR.number, blockHash: REAL_HASH, ...rpcOpts });
  const provider = new AnvilForkProvider({
    spawnFn: rec.spawnFn,
    rpc: anvil.fn,
    nowMs: () => 1_789_057_607_000,
    anvilBinary: "/opt/foundry/anvil",
  });
  return { provider, rec, anvil };
};

const created = async (p: AnvilForkProvider, over: Record<string, unknown> = {}) =>
  p.create({
    sourceChainId: 1,
    forkBlock: REAL_ANCHOR.number.toString(),
    upstreamRpcUrl: "https://ethereum-rpc.publicnode.com",
    sourceProviderId: "publicnode",
    ...over,
  } as Parameters<AnvilForkProvider["create"]>[0]);

/* ═════════════════════════ FORK-001 … 004 : startup and endpoint ═════════════════════════ */

describe("FORK-001 Anvil starts at an exact block", () => {
  it("FORK-001 the fork is created with the exact block on the command line", async () => {
    const { provider, rec } = newProvider();
    const fork = await created(provider);
    expect(ForkDescriptorSchema.safeParse(fork).success).toBe(true);
    expect(fork.forkBlock).toBe(REAL_ANCHOR.number.toString());
    const args = rec.calls[0]?.args ?? [];
    expect(args).toContain("--fork-block-number");
    expect(args[args.indexOf("--fork-block-number") + 1]).toBe(REAL_ANCHOR.number.toString());
    expect(args).toContain("--fork-url");
    // The fork's own chain id is 31337, never the source's.
    expect(args[args.indexOf("--chain-id") + 1]).toBe("31337");
    expect(args).toContain("--host");
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1");
  });

  it("FORK-001b \"latest\" is refused, because evidence has to be reproducible", async () => {
    const { provider } = newProvider();
    expect(await asyncReasonOf(() => created(provider, { forkBlock: "latest" }))).toBe(FORK_REASONS.NO_EXACT_BLOCK);
  });

  it("FORK-001c the descriptor separates the fork's chain id from the chain it copies", async () => {
    const { provider } = newProvider();
    const fork = await created(provider);
    expect(fork.chainId).toBe(31337);
    expect(fork.sourceChainId).toBe(1);
    const ref = forkNetworkRef(fork);
    expect(ref.chainId).toBe(31337);
    expect(ref.forkedFrom).toBe(1);
    expect(ref.role).toBe("LOCAL_FORK");
  });
});

describe("FORK-002 the anchor block is verified", () => {
  it("FORK-002 a matching anchor makes the fork READY and records the version", async () => {
    const { provider } = newProvider();
    const fork = await created(provider);
    const ready = await provider.verifyAnchor(fork.forkId, REAL_HASH);
    expect(ready.state).toBe("READY");
    expect(ready.forkBlockHash).toBe(REAL_HASH.toLowerCase());
    expect(ready.anvilVersion).toBe("anvil/v1.2.3");
  });

  it("FORK-002b guard one alone: a block hash that differs from upstream", async () => {
    /*
     * Chain id and block number are correct, so only the hash comparison can fire. A fork holding
     * different state than it claims is worse than no fork: every result computed on it looks
     * legitimate.
     */
    const { provider } = newProvider({ blockHash: `0x${"11".repeat(32)}` });
    const fork = await created(provider);
    expect(await asyncReasonOf(() => provider.verifyAnchor(fork.forkId, REAL_HASH))).toBe(FORK_REASONS.ANCHOR_MISMATCH);
  });

  it("FORK-002c guard two alone: the wrong block number, with a hash nobody contests", async () => {
    const { provider } = newProvider({ blockNumber: 25948000n });
    const fork = await created(provider);
    expect(await asyncReasonOf(() => provider.verifyAnchor(fork.forkId))).toBe(FORK_REASONS.ANCHOR_MISMATCH);
  });

  it("FORK-002d guard three alone: a fork that kept its source chain id", async () => {
    /*
     * Block number and hash are right; only the chain-id check can fire. A fork reporting chain 1
     * signs transactions that are valid on the real chain — the replay risk that makes 31337
     * matter.
     */
    const { provider } = newProvider({ chainId: "0x1" });
    const fork = await created(provider);
    expect(await asyncReasonOf(() => provider.verifyAnchor(fork.forkId, REAL_HASH))).toBe(FORK_REASONS.ANCHOR_MISMATCH);
  });

  it("FORK-002e a mismatched fork is destroyed rather than left running", async () => {
    const { provider, rec } = newProvider({ blockHash: `0x${"22".repeat(32)}` });
    const fork = await created(provider);
    await provider.verifyAnchor(fork.forkId, REAL_HASH).catch(() => undefined);
    expect(provider.get(fork.forkId)?.state).toBe("DESTROYED");
    expect(rec.children[0]?.signals).toContain("SIGTERM");
  });

  it("FORK-002f an unverified fork cannot execute", async () => {
    const { provider } = newProvider();
    const fork = await created(provider);
    expect(await asyncReasonOf(() => provider.execute(fork.forkId, { from: `0x${"1".repeat(40)}`, to: `0x${"2".repeat(40)}`, data: "0x" })))
      .toBe(FORK_REASONS.NOT_READY);
  });
});

describe("FORK-003 the fork endpoint must be local", () => {
  it("FORK-003 every local host form is accepted", () => {
    for (const host of LOCAL_FORK_HOSTS) {
      const url = host.includes(":") && !host.startsWith("[") ? `http://[${host}]:8545` : `http://${host}:8545`;
      expect(() => assertLocalForkEndpoint(url, "test"), host).not.toThrow();
    }
  });

  it("FORK-003b a public RPC as the fork's own endpoint is refused", () => {
    for (const url of [
      "https://ethereum-rpc.publicnode.com",
      "http://mainnet.infura.io/v3/abc",
      "https://eth-mainnet.g.alchemy.com/v2/key",
      "http://10.0.0.5:8545",
      "http://example.org:8545",
    ]) {
      expect(reasonOf(() => assertLocalForkEndpoint(url, "fork execute")), url).toBe(FORK_REASONS.NOT_LOCAL);
    }
  });

  it("FORK-003c the refusal explains that fork writes must not leave the machine", () => {
    try { assertLocalForkEndpoint("https://ethereum-rpc.publicnode.com", "fork"); } catch (e) {
      expect((e as Error).message).toMatch(/not a local address|something remote/);
    }
  });

  it("FORK-003d a non-http scheme is refused", () => {
    expect(reasonOf(() => assertLocalForkEndpoint("https://127.0.0.1:8545", "fork"))).toBe(FORK_REASONS.NOT_LOCAL);
    expect(reasonOf(() => assertLocalForkEndpoint("not a url", "fork"))).toBe(FORK_REASONS.NOT_LOCAL);
  });
});

describe("FORK-004 fork execution never reaches a public RPC", () => {
  it("FORK-004 every write goes to the local endpoint", async () => {
    const seen: string[] = [];
    const rec = anvilRecorder();
    const anvil = fakeAnvilRpc({ blockNumber: REAL_ANCHOR.number, blockHash: REAL_HASH });
    const provider = new AnvilForkProvider({
      spawnFn: rec.spawnFn,
      rpc: async (endpoint, method, params) => { seen.push(endpoint); return anvil.fn(endpoint, method, params); },
      anvilBinary: "/opt/foundry/anvil",
    });
    const fork = await created(provider);
    await provider.verifyAnchor(fork.forkId, REAL_HASH);
    await provider.execute(fork.forkId, { from: `0x${"1".repeat(40)}`, to: `0x${"2".repeat(40)}`, data: "0x" });
    for (const endpoint of seen) expect(new URL(endpoint).hostname).toBe("127.0.0.1");
  });

  it("FORK-004b the endpoint is re-checked at execution, not only at creation", async () => {
    /*
     * A check that ran once at startup does not cover a descriptor mutated afterwards. This forces
     * the descriptor to a public endpoint after the fork is READY and asserts the write is refused.
     */
    const { provider } = newProvider();
    const fork = await created(provider);
    await provider.verifyAnchor(fork.forkId, REAL_HASH);
    const live = provider.get(fork.forkId) as { endpoint: string };
    (live as { endpoint: string }).endpoint = "https://ethereum-rpc.publicnode.com";
    expect(await asyncReasonOf(() => provider.execute(fork.forkId, { from: `0x${"1".repeat(40)}`, to: `0x${"2".repeat(40)}`, data: "0x" })))
      .toBe(FORK_REASONS.NOT_LOCAL);
  });

  it("FORK-004c a fork write goes through the product-wide network guard", async () => {
    const { provider } = newProvider();
    const fork = await created(provider);
    await provider.verifyAnchor(fork.forkId, REAL_HASH);
    // The same guard every other subsystem calls, with LOCAL_WRITE intent.
    expect(() => assertExecutionAllowed(forkNetworkRef(fork), "LOCAL_WRITE", "fork")).not.toThrow();
    // And the fork may not produce a PUBLIC transaction.
    expect(() => assertExecutionAllowed(forkNetworkRef(fork), "PUBLIC_WRITE", "fork")).toThrow(NetworkGuardError);
  });
});

/* ═════════════════════════ FORK-005 … 008 : keys, impersonation, labels ═════════════════════════ */

describe("FORK-005 development keys are local-only", () => {
  it("FORK-005 every development account is labelled LOCAL_FORK_ONLY", () => {
    expect(ANVIL_DEV_ACCOUNTS.length).toBeGreaterThan(0);
    for (const a of ANVIL_DEV_ACCOUNTS) {
      expect(a.label, a.address).toBe(LOCAL_FORK_ONLY);
      expect(a.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("FORK-005b a development key is refused by every real credential store", () => {
    for (const store of KEY_FORBIDDEN_STORES) {
      expect(reasonOf(() => assertDevKeyStoreAllowed(store, "test")), store).toBe(FORK_REASONS.KEY_ESCAPED);
    }
  });

  it("FORK-005c an ephemeral local store is fine", () => {
    expect(() => assertDevKeyStoreAllowed("fork-worker-memory", "test")).not.toThrow();
  });

  it("FORK-005d no private key or mnemonic is recorded alongside the accounts", () => {
    // Only addresses. The keys are public knowledge and still have no reason to be in this repo.
    const serialized = JSON.stringify(ANVIL_DEV_ACCOUNTS);
    expect(serialized).not.toMatch(/0x[0-9a-f]{64}/i);
    expect(serialized.toLowerCase()).not.toMatch(/test test test|mnemonic|privatekey/);
  });
});

describe("FORK-006 impersonation is local-only", () => {
  it("FORK-006 impersonation works on a fork and is stamped", async () => {
    const { provider } = newProvider();
    const fork = await created(provider);
    await provider.verifyAnchor(fork.forkId, REAL_HASH);
    const actor = await provider.impersonate(fork.forkId, `0x${"ab".repeat(20)}`, "simulate a whale");
    expect(actor.metadata).toBe(IMPERSONATED_FOR_SIMULATION);
    expect(actor.forkId).toBe(fork.forkId);
    expect(actor.reason).toBe("simulate a whale");
  });

  it("FORK-006b impersonation on a public testnet is refused", () => {
    expect(reasonOf(() => assertImpersonationAllowed({ chainId: 11155111, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null }, "t")))
      .toBe(FORK_REASONS.IMPERSONATION_OUTSIDE_FORK);
  });

  it("FORK-006c impersonation on a read-only source is refused too", () => {
    expect(reasonOf(() => assertImpersonationAllowed({ chainId: 1, role: "READ_ONLY_SOURCE", forkedFrom: null, forkBlock: null }, "t")))
      .toBe(FORK_REASONS.IMPERSONATION_OUTSIDE_FORK);
  });

  it("FORK-006d an impersonated transaction is marked, so it cannot read as identity evidence", async () => {
    const { provider } = newProvider();
    const fork = await created(provider);
    await provider.verifyAnchor(fork.forkId, REAL_HASH);
    const tx = await provider.execute(fork.forkId, { from: `0x${"ab".repeat(20)}`, to: `0x${"cd".repeat(20)}`, data: "0x", impersonate: true });
    expect(tx.impersonated).toBe(true);
    // Enumerated so the claim "this proves nothing about identity" is itself testable.
    expect([...IMPERSONATION_CANNOT_PROVE]).toContain("ownership");
    expect([...IMPERSONATION_CANNOT_PROVE]).toContain("authorization");
  });
});

describe("FORK-007 a fork transaction is labelled LOCAL", () => {
  it("FORK-007 the label is fixed by the schema and cannot say anything else", async () => {
    const { provider } = newProvider();
    const fork = await created(provider);
    await provider.verifyAnchor(fork.forkId, REAL_HASH);
    const tx = await provider.execute(fork.forkId, { from: `0x${"1".repeat(40)}`, to: `0x${"2".repeat(40)}`, data: "0x" });
    expect(tx.label).toBe(LOCAL_FORK_TX_LABEL);
    expect(tx.chainId).toBe(31337);
    expect(tx.forkedFrom).toBe(1);
    expect(tx.forkBlock).toBe(REAL_ANCHOR.number.toString());
  });

  it("FORK-007b no other label parses — the mandatory mutation is a schema error", () => {
    /*
     * "label a local fork tx as MAINNET" is a mandatory mutation. It cannot be expressed: the
     * schema pins the field to a literal, so the mutation fails to parse rather than producing a
     * transaction that lies.
     */
    const valid = {
      hash: `0x${"ab".repeat(32)}`, forkId: "fork-1", chainId: 31337, forkedFrom: 1,
      forkBlock: "1", blockNumber: "2", from: `0x${"1".repeat(40)}`, to: `0x${"2".repeat(40)}`,
      status: "success", gasUsed: "21000", label: LOCAL_FORK_TX_LABEL, impersonated: false,
    };
    expect(ForkTransactionSchema.safeParse(valid).success).toBe(true);
    for (const bad of FORBIDDEN_TX_LABELS) {
      expect(ForkTransactionSchema.safeParse({ ...valid, label: bad }).success, bad).toBe(false);
    }
  });

  it("FORK-007c a fork transaction cannot claim chain 1", () => {
    const valid = {
      hash: `0x${"ab".repeat(32)}`, forkId: "fork-1", chainId: 1, forkedFrom: 1,
      forkBlock: "1", blockNumber: "2", from: `0x${"1".repeat(40)}`, to: `0x${"2".repeat(40)}`,
      status: "success", gasUsed: "21000", label: LOCAL_FORK_TX_LABEL, impersonated: false,
    };
    expect(ForkTransactionSchema.safeParse(valid).success).toBe(false);
  });
});

describe("FORK-008 no explorer link is generated for a fork transaction", () => {
  it("FORK-008 a local transaction gets no URL", () => {
    expect(explorerUrlFor({ chainId: 31337, hash: `0x${"ab".repeat(32)}` })).toBeNull();
  });

  it("FORK-008b mainnet gets no URL either, because no transaction of ours is on it", () => {
    expect(explorerUrlFor({ chainId: 1, hash: `0x${"ab".repeat(32)}` })).toBeNull();
  });

  it("FORK-008c a real testnet transaction does get one, so the check is not vacuous", () => {
    expect(explorerUrlFor({ chainId: 11155111, hash: `0x${"ab".repeat(32)}` })).toBe(`https://sepolia.etherscan.io/tx/0x${"ab".repeat(32)}`);
    expect(explorerUrlFor({ chainId: 84532, hash: "0xff" })).toMatch(/basescan/);
  });

  it("FORK-008d no etherscan.io URL is constructed anywhere in the source", () => {
    /*
     * A local hash is 32 bytes and looks exactly like a mainnet hash. Pasted into an Etherscan URL
     * it produces "unable to locate this TxnHash", which reads as "not indexed yet" rather than
     * "this never happened".
     */
    /*
     * The MAINNET host specifically. `sepolia.etherscan.io` is legitimate and is constructed in two
     * places; a pattern that caught both would have to be either disabled or weakened, and a
     * weakened one is how this check would stop meaning anything.
     */
    const hits = sourceLines(/(\/\/|www\.)etherscan\.io/).filter((l) => !isComment(l.text));
    expect(hits.map((l) => `${l.file}:${l.text.trim()}`)).toEqual([]);
    // Not vacuous: the testnet explorer IS constructed, and the scan finds it.
    expect(sourceLines(/sepolia\.etherscan\.io/).length).toBeGreaterThan(0);
  });
});

/* ═════════════════════════ FORK-011 … 013 : binding and lifecycle ═════════════════════════ */

describe("FORK-011 a fork capability is bound to its environment", () => {
  const binding: EnvironmentBinding = {
    executionEnvironment: "LOCAL_FORK", environmentId: "fork-aaaaaaaaaaaa",
    chainId: 31337, forkedFrom: 1, forkBlock: "25948176",
  };

  it("FORK-011 a binding matching the current environment is accepted", () => {
    expect(() => assertEnvironmentBinding(binding, binding, "same")).not.toThrow();
  });

  it("FORK-011b the binding names the fork, not merely the chain", () => {
    expect(binding.environmentId).toMatch(/^fork-/);
    expect(binding.forkedFrom).toBe(1);
    expect(binding.forkBlock).toBe("25948176");
    // chainId alone would be identical across every fork on this machine.
    expect(binding.chainId).toBe(31337);
  });
});

describe("FORK-012 a fork capability is invalid outside its fork", () => {
  const binding: EnvironmentBinding = {
    executionEnvironment: "LOCAL_FORK", environmentId: "fork-aaaaaaaaaaaa",
    chainId: 31337, forkedFrom: 1, forkBlock: "25948176",
  };

  it("FORK-012 guard one alone: the wrong KIND of environment", () => {
    const testnet: EnvironmentBinding = { executionEnvironment: "TESTNET", environmentId: "fork-aaaaaaaaaaaa", chainId: 31337, forkedFrom: 1, forkBlock: "25948176" };
    expect(reasonOf(() => assertEnvironmentBinding(binding, testnet, "t"))).toBe(FORK_REASONS.ENVIRONMENT_MISMATCH);
  });

  it("FORK-012b guard two alone: the right kind, a different instance", () => {
    /*
     * The subtle one, and the reason `environmentId` exists. Two forks of the same chain at the
     * same block are still two different machines with different state histories.
     */
    const otherFork: EnvironmentBinding = { ...binding, environmentId: "fork-bbbbbbbbbbbb" };
    expect(reasonOf(() => assertEnvironmentBinding(binding, otherFork, "t"))).toBe(FORK_REASONS.ENVIRONMENT_MISMATCH);
    try { assertEnvironmentBinding(binding, otherFork, "t"); } catch (e) {
      expect((e as Error).message).toMatch(/two different machines/);
    }
  });

  it("FORK-012c guard three alone: the right kind and instance, a different chain", () => {
    const otherChain: EnvironmentBinding = { ...binding, chainId: 11155111 };
    expect(reasonOf(() => assertEnvironmentBinding(binding, otherChain, "t"))).toBe(FORK_REASONS.ENVIRONMENT_MISMATCH);
  });

  it("FORK-012d the binding schema requires an environmentId — the mandatory mutation cannot compile", async () => {
    const { EnvironmentBindingSchema } = await import("../src/fork.js");
    const { environmentId: _dropped, ...without } = binding;
    expect(EnvironmentBindingSchema.safeParse(without).success).toBe(false);
    expect(EnvironmentBindingSchema.safeParse({ ...binding, environmentId: "" }).success).toBe(false);
  });
});

describe("FORK-013 abandoned forks are destroyed", () => {
  it("FORK-013 a fork past its lifetime is reaped", async () => {
    let now = 1_000_000;
    const rec = anvilRecorder();
    const anvil = fakeAnvilRpc({ blockNumber: REAL_ANCHOR.number, blockHash: REAL_HASH });
    const provider = new AnvilForkProvider({ spawnFn: rec.spawnFn, rpc: anvil.fn, nowMs: () => now, anvilBinary: "/opt/foundry/anvil" });

    const fork = await created(provider, { lifetimeMs: 60_000 });
    await provider.verifyAnchor(fork.forkId, REAL_HASH);
    expect(await provider.reapExpired()).toEqual([]);

    now += 61_000;
    expect(await provider.reapExpired()).toEqual([fork.forkId]);
    expect(provider.get(fork.forkId)?.state).toBe("DESTROYED");
    expect(rec.children[0]?.signals).toContain("SIGTERM");
  });

  it("FORK-013b destroy is idempotent and a destroyed fork cannot be used", async () => {
    const { provider } = newProvider();
    const fork = await created(provider);
    await provider.verifyAnchor(fork.forkId, REAL_HASH);
    await provider.destroy(fork.forkId);
    await provider.destroy(fork.forkId);
    expect(await asyncReasonOf(() => provider.snapshot(fork.forkId))).toBe(FORK_REASONS.DESTROYED);
  });

  it("FORK-013c the concurrent-fork limit is enforced, with the cost explained", () => {
    expect(FORK_LIMITS.maxConcurrentPerUser).toBe(2);
    expect(() => assertForkQuota(1)).not.toThrow();
    expect(reasonOf(() => assertForkQuota(2))).toBe(FORK_REASONS.LIMIT);
    try { assertForkQuota(2); } catch (e) {
      expect((e as Error).message).toMatch(/upstream RPC bill/);
    }
  });

  it("FORK-013d an operator may raise the concurrent-fork limit for a swarm; the default still holds otherwise", async () => {
    const rec = anvilRecorder();
    const anvil = fakeAnvilRpc({ blockNumber: REAL_ANCHOR.number, blockHash: REAL_HASH });
    const raised = new AnvilForkProvider({ spawnFn: rec.spawnFn, rpc: anvil.fn, anvilBinary: "/opt/foundry/anvil", maxConcurrentForks: 5 });
    const ready = async (p: AnvilForkProvider, port: number) => p.verifyAnchor((await created(p, { port })).forkId, REAL_HASH);
    for (let i = 0; i < 5; i++) await ready(raised, 9000 + i);
    expect(await asyncReasonOf(() => created(raised, { port: 9005 }))).toBe(FORK_REASONS.LIMIT);

    const stock = new AnvilForkProvider({ spawnFn: rec.spawnFn, rpc: anvil.fn, anvilBinary: "/opt/foundry/anvil" });
    await ready(stock, 9010);
    await ready(stock, 9011);
    expect(await asyncReasonOf(() => created(stock, { port: 9012 }))).toBe(FORK_REASONS.LIMIT);
  });

  it("FORK-013d every resource bound §P27.49 names has a value", () => {
    expect(FORK_LIMITS.maxLifetimeMs).toBeGreaterThan(0);
    expect(FORK_LIMITS.maxMemoryMb).toBeGreaterThan(0);
    expect(FORK_LIMITS.maxHistoricalReplaysPerBuild).toBeGreaterThan(0);
    expect(FORK_LIMITS.maxSnapshotBytes).toBeGreaterThan(0);
  });

  it("FORK-013e a third fork is refused while two are READY", async () => {
    const { provider } = newProvider();
    const a = await created(provider, { port: 8545 });
    await provider.verifyAnchor(a.forkId, REAL_HASH);
    const b = await created(provider, { port: 8546 });
    await provider.verifyAnchor(b.forkId, REAL_HASH);
    expect(await asyncReasonOf(() => created(provider, { port: 8547 }))).toBe(FORK_REASONS.LIMIT);
  });
});

/* ═════════════════════════ snapshot / restore ═════════════════════════ */

describe("fork state snapshots", () => {
  it("FORK-014 snapshot and restore go through the local endpoint", async () => {
    const { provider, anvil } = newProvider();
    const fork = await created(provider);
    await provider.verifyAnchor(fork.forkId, REAL_HASH);
    const snap = await provider.snapshot(fork.forkId);
    expect(snap).toBe("0x1");
    expect(await provider.restore(fork.forkId, snap)).toBe(true);
    const methods = anvil.seen.map((s) => s.method);
    expect(methods).toContain("evm_snapshot");
    expect(methods).toContain("evm_revert");
  });

  it("FORK-014b a reset returns to the pinned block, not to the head", async () => {
    const { provider, anvil } = newProvider();
    const fork = await created(provider);
    await provider.verifyAnchor(fork.forkId, REAL_HASH);
    await provider.reset(fork.forkId);
    const reset = anvil.seen.find((s) => s.method === "anvil_reset");
    expect(JSON.stringify(reset?.params)).toMatch(String(REAL_ANCHOR.number));
  });
});
