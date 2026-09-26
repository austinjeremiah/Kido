import type { ExecutionPlan, PlanStep } from "../src/schema.js";

export const OWNER = "0x0000000000000000000000000000000000005e1f";
export const ATTACKER = "0x000000000000000000000000000000000000dEaD";
export const USDC_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
export const SEPOLIA = 11155111;
export const BASE_SEPOLIA = 84532;
export const SEPOLIA_SELECTOR = "16015286601757825753";
export const BASE_SELECTOR = "10344971235874465080";

const step = (o: Partial<PlanStep> & Pick<PlanStep, "stepId">): PlanStep => ({
  chainId: SEPOLIA,
  adapterId: "chainlink-ccip",
  adapterVersion: "1.0.0",
  action: "CROSS_CHAIN_TOKEN_TRANSFER",
  normalizedIntent: {},
  dependencies: [],
  preconditions: [],
  expectedEffects: [],
  timeoutMs: 30 * 60_000,
  authorizationRequirement: { disposition: "AUTONOMOUS", valueUsdCents: 25_000, capabilityScope: null },
  status: "PENDING",
  ...o,
});

/**
 * The canonical two-step plan: bridge from Ethereum Sepolia, then act on Base Sepolia.
 *
 * Step 2 depends on step 1, which is the whole point — the destination action must not be reachable
 * until the bridge has actually delivered.
 */
export const bridgePlan = (): ExecutionPlan => ({
  schemaVersion: "contextlock.execution-plan/v1",
  planId: "plan-treasury-1",
  revision: 1,
  strategyId: "strat-1",
  organizationId: null,
  sourceChainId: SEPOLIA,
  steps: [
    step({
      stepId: "bridge",
      normalizedIntent: {
        action: "CROSS_CHAIN_TOKEN_TRANSFER",
        destinationChainId: BASE_SEPOLIA,
        destinationChainSelector: BASE_SELECTOR,
        receiver: OWNER,
        token: USDC_SEPOLIA,
        amount: "500000000",
      },
      expectedEffects: [
        { kind: "TOKEN_OUT", chainId: SEPOLIA, token: USDC_SEPOLIA, amount: "500000000", party: OWNER },
        { kind: "MESSAGE_SENT", chainId: SEPOLIA },
      ],
    }),
    step({
      stepId: "supply",
      chainId: BASE_SEPOLIA,
      adapterId: "aave-v3-execution",
      action: "SUPPLY",
      dependencies: ["bridge"],
      preconditions: [{ kind: "ARRIVAL_PROVEN", stepId: "bridge" }],
      normalizedIntent: { action: "SUPPLY", asset: USDC_SEPOLIA, amount: "500000000", account: OWNER },
      expectedEffects: [{ kind: "TOKEN_IN", chainId: BASE_SEPOLIA, token: USDC_SEPOLIA, amount: "500000000", party: OWNER }],
    }),
  ],
  invariants: [{ id: "INV-1", statement: "The destination receiver is never changed." }],
  timeoutPolicy: { totalMs: 60 * 60_000, perStepDefaultMs: 30 * 60_000 },
  failurePolicy: { onStepFailure: "HOLD_AND_ESCALATE", maxRetries: 1, protocolRefundAvailable: false },
  completionPolicy: { requiredStepIds: ["bridge", "supply"] },
  state: "DRAFT",
});

export const clone = (p: ExecutionPlan): ExecutionPlan => JSON.parse(JSON.stringify(p)) as ExecutionPlan;

export const withStatus = (p: ExecutionPlan, stepId: string, status: PlanStep["status"]): ExecutionPlan => {
  const c = clone(p);
  c.steps.find((s) => s.stepId === stepId)!.status = status;
  return c;
};
