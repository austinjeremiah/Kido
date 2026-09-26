import type { Address, Hex } from "viem";
import type { ChainReader } from "@contextlock/studio-deploy";
import type { ChainQueries, ExpectedState } from "../src/chain.js";
import type { CreConnection, CreOperationsProvider, CreWorkflow, CreExecution, CreExecutionEvent, DestructiveConfirmation } from "../src/cre.js";
import type { Actor } from "../src/commands.js";

export const NOW = 1_780_000_000_000;

/** The real Group E deployment. Addresses and hashes read from chain, not invented. */
export const LIVE = {
  chainId: 11155111,
  consumer: "0xf8a3b4bf44975a2d4b3fb7a099b80db7620ad2ca" as Address,
  policyRegistry: "0xCBd976E8BBbA70867d581A35e5a5CF1C2ed47F24" as Address,
  authRegistry: "0xFAD71bbcCfFdFbFA8B500bc9b8FF6F0C7F9De8e3" as Address,
  executor: "0x9ee2E72E2D7B91D9ddeD1313df5CFCb8E9316e23" as Address,
  deployer: "0x93e0FCb0F71e83F3340264339BC5983C474635c5" as Address,
  attacker: "0x000000000000000000000000000000000000dEaD" as Address,
  agentIdentityHash: "0xd9c78c1e0b450ca8d56b5ebd1e9001086cd6f4760201c02fe29cbb0fc9541ac6" as Hex,
  policyHash: "0x1fbc7812e3291c9b6ea44e4222b3f976b52e6bb4f00c6eb14c56db1133db5454" as Hex,
  executorCodeHash: "0x250188e2403f69ad1027e1ac07fee750aa6416e99b05a70ba9f46ce8f75f8b79",
  consumerCodeHash: "0xdca8de8a30051813e680a7aae9c74560c25ee58e3cb38fdd514912146342db23",
  identityNode: "0x63d01c6138fb193c23428f06dc8df3f586dec2342fa8b37d628742b76066d341" as Hex,
  agentAddress: "0xA263b2cA150B5A1cA7bf08adF966B847c487F50f" as Address,
} as const;

export interface FakeChainOptions {
  chainId?: number;
  blockNumber?: bigint;
  code?: Map<string, Hex>;
  failGetCode?: boolean;
  failBlockNumber?: boolean;
}

export function fakeReader(opts: FakeChainOptions = {}): ChainReader {
  const code = opts.code ?? new Map<string, Hex>();
  return {
    chainId: opts.chainId ?? 11155111,
    live: false,
    async getChainId() { return opts.chainId ?? 11155111; },
    async getCode(a) { if (opts.failGetCode) throw new Error("RPC down"); return code.get(a.toLowerCase()); },
    async getBalance() { return 0n; },
    async getTransactionCount() { return 0n; },
    async estimateGas() { return 21_000n; },
    async estimateFeesPerGas() { return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasPrice: undefined }; },
    async call() { return "0x" as Hex; },
    async getTransactionReceipt() { return null; },
    async getBlockNumber() { if (opts.failBlockNumber) throw new Error("RPC down"); return opts.blockNumber ?? 11_674_400n; },
  };
}

export interface FakeQueryOptions {
  enabled?: boolean;
  cap?: bigint;
  bindingVersion?: bigint;
  admin?: Address;
  administrators?: Address[];
  boundAgent?: Address | null;
  revoked?: boolean;
  failPolicy?: boolean;
  failIdentity?: boolean;
}

export function fakeQueries(opts: FakeQueryOptions = {}): ChainQueries {
  return {
    async readPolicy() {
      if (opts.failPolicy) throw new Error("policy read failed: RPC timeout");
      return {
        enabled: opts.enabled ?? false,
        cap: opts.cap ?? 0n,
        bindingVersion: opts.bindingVersion ?? 1n,
        admin: opts.admin ?? LIVE.deployer,
      };
    },
    async resolveIdentity() {
      if (opts.failIdentity) throw new Error("resolver unreachable");
      return { boundAgent: opts.boundAgent === undefined ? LIVE.agentAddress : opts.boundAgent, revoked: opts.revoked ?? false, resolver: LIVE.executor };
    },
    async readAdministrators() {
      return opts.administrators ?? [LIVE.deployer];
    },
  };
}

/** What the deployment record claims. Compared against chain; never substituted for it. */
export function expectedState(over: Partial<ExpectedState> = {}): ExpectedState {
  return {
    policyEnabled: false,
    policyAdmin: LIVE.deployer,
    bindingVersion: "1",
    contracts: [
      { name: "ContextLockExecutorV2", address: LIVE.executor, runtimeCodeHash: LIVE.executorCodeHash },
      { name: "ContextLockCreConsumer", address: LIVE.consumer, runtimeCodeHash: LIVE.consumerCodeHash },
    ],
    administrators: [LIVE.deployer],
    identity: { node: LIVE.identityNode, boundAgent: LIVE.agentAddress },
    runtimeImageDigest: `sha256:${"1".repeat(64)}`,
    ...over,
  };
}

export const codeMap = (entries: Array<[Address, Hex]>): Map<string, Hex> =>
  new Map(entries.map(([a, c]) => [a.toLowerCase(), c]));

/* ────────────────────────────── CRE fixtures ────────────────────────────── */

export const liveConnection = (over: Partial<CreConnection> = {}): CreConnection => ({
  connected: true,
  organizationId: "org_ENDgZRZzalm3d3So",
  organizationName: "My Org",
  accountLabel: "kaushikh2003@gmail.com",
  // The real state of this tenant. See BLK-V2-CRE-DEPLOY.
  deployAccess: false,
  availableRegistryIds: ["private", "onchain:ethereum-mainnet"],
  cliVersion: "v1.32.0",
  ...over,
});

/**
 * A FIXTURE workflow.
 *
 * Marked, and named with the `fixture-` prefix, so `assertNotFixture` can refuse it. §25.47: a
 * fixture identifier must never enter a deployment record as live evidence.
 */
export const fixtureWorkflow = (over: Partial<CreWorkflow> = {}): CreWorkflow => ({
  workflowId: "fixture-00da21b8b3e117e31f3a3e8a0795225cbde6c00283a84395117669691f2b7856",
  workflowName: "contextlock-policy",
  registry: "private",
  status: "PAUSED",
  binaryHash: "800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0",
  lastExecutionAtMs: null,
  totalRuns: 0,
  successCount: 0,
  failureCount: 0,
  provenance: "FIXTURE",
  ...over,
});

export class FakeCreProvider implements CreOperationsProvider {
  readonly id = "fixture-bridge";
  readonly calls: string[] = [];
  offline = false;
  deleted: string[] = [];

  constructor(
    private readonly connection: CreConnection = liveConnection(),
    private readonly workflow: CreWorkflow | null = null,
    private readonly executions: CreExecution[] = [],
    private readonly events: CreExecutionEvent[] = [],
  ) {}

  private guard(op: string): void {
    this.calls.push(op);
    if (this.offline) throw new Error("the Local Bridge is offline");
  }

  async getConnectionStatus() { this.guard("getConnectionStatus"); return this.connection; }
  async listWorkflows() { this.guard("listWorkflows"); return this.workflow ? [this.workflow] : []; }
  async getWorkflow(name: string) { this.guard("getWorkflow"); return this.workflow?.workflowName === name ? this.workflow : null; }
  async listExecutions() { this.guard("listExecutions"); return this.executions; }
  async getExecutionStatus(id: string) { this.guard("getExecutionStatus"); return this.executions.find((e) => e.executionId === id) ?? null; }
  async getExecutionEvents(id: string) { this.guard("getExecutionEvents"); return this.events.filter((e) => e.executionId === id); }
  async getExecutionLogs() { this.guard("getExecutionLogs"); return []; }
  async activateWorkflow() { this.guard("activateWorkflow"); return { status: "ACTIVE" }; }
  async pauseWorkflow() { this.guard("pauseWorkflow"); return { status: "PAUSED" }; }
  async deleteWorkflow(name: string, _c: DestructiveConfirmation) { this.guard("deleteWorkflow"); this.deleted.push(name); return { deleted: true as const }; }
}

/* ────────────────────────────── actors ────────────────────────────── */

export const actor = (caps: Actor["capabilities"], name = "operator"): Actor => ({
  actorId: `usr_${name}`,
  displayName: name,
  capabilities: caps,
});

export const VIEWER = actor(["VIEW"], "viewer");
export const RUNTIME_OP = actor(["VIEW", "RUNTIME_CONTROL"], "runtime-op");
export const POLICY_OP = actor(["VIEW", "POLICY_CONTROL"], "policy-op");
export const INCIDENT_OP = actor(["VIEW", "RUNTIME_CONTROL", "CRE_CONTROL", "POLICY_CONTROL", "IDENTITY_CONTROL", "EMERGENCY_CONTROL"], "incident-op");
