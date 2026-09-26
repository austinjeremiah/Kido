import { keccak256, toHex, type Address, type Hex } from "viem";
import { openDb, type DB } from "./db.js";
import { Broker, type BrokerConfig, type PublicPolicy } from "./broker.js";
import {
  StubEnsIdentityProvider,
  StubHumanApprovalProvider,
  StubPolicyEvaluator,
  StubSecretProvider,
} from "./providers/stubs.js";

/** Shared wiring for tests and the local demo, so both exercise the same code path. */
export const TEST_AGENT_NAME = "treasury.agents.contextlock-test.eth";
export const TEST_POLICY_ID = "treasury-v1";

export type Harness = {
  db: DB;
  broker: Broker;
  ens: StubEnsIdentityProvider;
  evaluator: StubPolicyEvaluator;
  secrets: StubSecretProvider;
  approvals: StubHumanApprovalProvider;
  policy: PublicPolicy;
};

export function makeHarness(opts: {
  dbPath?: string;
  executor: Address;
  target: Address;
  agent: Address;
  issuerPrivateKey: Hex;
  chainId?: number;
}): Harness {
  const db = openDb(opts.dbPath ?? ":memory:");

  const policy: PublicPolicy = {
    policyId: TEST_POLICY_ID,
    policyHash: keccak256(toHex("policy-treasury-v1")),
    enabled: true,
    allowedActionKinds: ["MOCK_TRANSFER"],
    allowedTargets: [opts.target],
    maxValueHardCap: 10n ** 18n,
    target: opts.target,
  };

  const cfg: BrokerConfig = {
    chainId: opts.chainId ?? 31337,
    executor: opts.executor,
    capabilityIssuerPrivateKey: opts.issuerPrivateKey,
    capabilityTtlSeconds: 300,
    policies: { [TEST_POLICY_ID]: policy },
  };

  const ens = new StubEnsIdentityProvider();
  ens.bind(TEST_AGENT_NAME, opts.agent, 1n);

  const evaluator = new StubPolicyEvaluator();
  const secrets = new StubSecretProvider();
  secrets.set("risk-api-token", "test-token-NOT-a-real-credential-8f3a1c");
  const approvals = new StubHumanApprovalProvider();

  const broker = new Broker(db, cfg, ens, evaluator, secrets, approvals);
  return { db, broker, ens, evaluator, secrets, approvals, policy };
}
