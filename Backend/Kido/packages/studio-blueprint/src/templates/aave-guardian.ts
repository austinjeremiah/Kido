import type { Action, ContextLockAgentBlueprint } from "../schema.js";

/**
 * A swap action, for agents that trade rather than manage a lending position.
 *
 * The recipient is self-only and not configurable. A swap that can pay someone else is a transfer
 * wearing a swap's clothes, and it is the single most valuable thing to make unrepresentable here —
 * the executor and the adapter both re-check it, but a design that never expresses the possibility
 * cannot have it talked into existence.
 */
export function swapAction(routerProtocolId: string): Action {
  return {
    id: "swap-tokens",
    kind: "TOKEN_SWAP",
    displayName: "Swap tokens through the router",
    protocolRef: routerProtocolId,
    targetPolicy: { mode: "protocol-resolved", protocolRef: routerProtocolId, contractRole: "router" },
    recipientPolicy: { mode: "self-only" },
    spendsAssets: ["USDC"],
    approvals: [
      {
        assetSymbol: "USDC",
        spenderRole: "router",
        unlimited: false,
        maxAmountPolicy: "exact-action-amount",
      },
    ],
  };
}

/** The protocol entry a swap action resolves its target through. */
export const routerProtocol = (id: string, displayName: string) => ({
  id,
  displayName,
  kind: "dex" as const,
  chainId: 11155111 as const,
  contracts: [
    {
      role: "router",
      address: {
        known: false as const,
        reason: "Router address comes from the adapter's verified deployment registry at build time.",
        requiredBefore: "DEPLOY" as const,
      },
    },
  ],
});

/**
 * The canonical Phase 11 template.
 *
 * This is a *verified skeleton*, not model output. The Architecture Agent fills in the parts that
 * genuinely vary with the user's request — limits, the ENS name, which actions are permitted — and
 * inherits the security-critical structure from here.
 *
 * The reason for the split is narrow and important: the fields below encode ContextLock invariants
 * that are the same for every agent (DENY is terminal, the agent holds no key, capabilities bind
 * calldata). Regenerating those from a prompt every time means re-deriving a security property from
 * a language model on every build, and getting it right 99 times is not a security control.
 */
export function aaveGuardianSkeleton(args: {
  blueprintId: string;
  ensName: string;
  objective: string;
}): Omit<
  ContextLockAgentBlueprint,
  "autonomousPolicy" | "escalationPolicy" | "triggers" | "permissions" | "revision" | "createdAt"
> {
  return {
    schemaVersion: "contextlock.agent.blueprint/v1",
    blueprintId: args.blueprintId,

    identity: {
      agentId: "aave-guardian",
      ensName: args.ensName,
      network: "sepolia",
      chainId: 11155111,
      agentAddress: {
        known: false,
        reason: "Assigned when the agent runtime is deployed; not required to generate code.",
        requiredBefore: "DEPLOY",
      },
    },
    objective: args.objective,

    protocols: [
      {
        id: "aave",
        displayName: "Aave-style lending pool",
        kind: "lending",
        chainId: 11155111,
        contracts: [
          {
            role: "pool",
            address: {
              known: false,
              reason: "Testnet pool address is supplied at deployment time.",
              requiredBefore: "DEPLOY",
            },
          },
        ],
      },
    ],

    assets: [
      {
        symbol: "USDC",
        decimals: 6,
        chainId: 11155111,
        address: {
          known: false,
          reason: "Testnet token address is supplied at deployment time.",
          requiredBefore: "DEPLOY",
        },
      },
    ],

    actions: [
      {
        id: "repay-debt",
        kind: "AAVE_REPAY",
        displayName: "Repay outstanding debt",
        protocolRef: "aave",
        // The pool address is resolved through the declared protocol, so the target is not a free
        // parameter the agent can influence.
        targetPolicy: { mode: "protocol-resolved", protocolRef: "aave", contractRole: "pool" },
        // Repayment reduces the user's own debt. Value never leaves the user's position, which is
        // what makes this action safe to run autonomously at all.
        recipientPolicy: { mode: "self-only" },
        spendsAssets: ["USDC"],
        approvals: [
          {
            assetSymbol: "USDC",
            spenderRole: "pool",
            unlimited: false,
            maxAmountPolicy: "exact-action-amount",
          },
        ],
      },
      {
        id: "add-collateral",
        kind: "AAVE_SUPPLY",
        displayName: "Add collateral to the position",
        protocolRef: "aave",
        targetPolicy: { mode: "protocol-resolved", protocolRef: "aave", contractRole: "pool" },
        recipientPolicy: { mode: "self-only" },
        spendsAssets: ["USDC"],
        approvals: [
          {
            assetSymbol: "USDC",
            spenderRole: "pool",
            unlimited: false,
            maxAmountPolicy: "exact-action-amount",
          },
        ],
      },
    ],

    confidentialPolicy: {
      required: true,
      placement: "cre-confidential",
      // Names only. The thresholds themselves never enter the Blueprint, so they cannot reach the
      // graph, the export, or the security report.
      parameterNames: [
        "healthFactorFloorBps",
        "autoRepayLimitUsdCents",
        "escalationCeilingUsdCents",
        "maxVolatilityBps",
      ],
      reasonCodes: [
        "ALLOW_HEALTH_RESTORE",
        "ESCALATE_AMOUNT",
        "ESCALATE_RISK",
        "DENY_AMOUNT_TOO_HIGH",
        "DENY_FORBIDDEN_ACTION",
      ],
    },

    contextSources: [
      {
        id: "position-health",
        dataKind: "aave_position_health_factor",
        minimumTrustClass: "DIRECT_CHAIN_DATA",
        maxAgeMs: 60_000,
        fallbackAllowed: false,
        placement: "cre-confidential",
      },
      {
        id: "collateral-price",
        dataKind: "collateral_asset_usd_price",
        minimumTrustClass: "VERIFIED_ORACLE",
        maxAgeMs: 30_000,
        fallbackAllowed: false,
        placement: "cre-confidential",
      },
    ],

    /*
     * Adapter bindings are empty in the skeleton and filled by the deterministic resolver from the
     * dataRequirements below. The template does not pick providers: which adapter satisfies
     * "aave_position_health_factor" is a resolution result, not a design constant.
     */
    adapters: [],
    dataRequirements: [
      {
        key: "positionHealth",
        kind: "aave_position_health_factor",
        chainId: 11155111,
        minimumTrustClass: "DIRECT_CHAIN_DATA",
        maxAgeMs: 60_000,
        /*
         * The READING is public: a lending position's health factor is on-chain state anyone can
         * query. What is confidential is the FLOOR it gets compared against, which lives in
         * confidentialPolicy.parameterNames and is evaluated inside the CRE handler.
         *
         * Marking the reading confidential would conflate the two and would demand a
         * confidential-execution adapter for a value that needs none.
         */
        confidential: false,
        historical: false,
      },
      {
        key: "collateralPrice",
        kind: "collateral_asset_usd_price",
        chainId: 11155111,
        unit: "USD",
        // A liquidation guard acts on price. An indexer's price is a price that was true at some
        // block; this requirement is what stops one being substituted for an attested reading.
        minimumTrustClass: "VERIFIED_ORACLE",
        maxAgeMs: 30_000,
        // Public oracle reading; the risk thresholds applied to it are the confidential part.
        confidential: false,
        historical: false,
      },
    ],

    capabilityPolicy: {
      // Short enough that a stolen capability is worth little; long enough for a relayer to land it.
      ttlSeconds: 45,
      nonceStrategy: "on-chain-sequential",
      bindings: [
        "chainId",
        "target",
        "calldataHash",
        "value",
        "nonce",
        "expiry",
        "agentIdentityHash",
        "policyHash",
        "authorizationId",
      ],
    },

    ens: {
      required: true,
      identityReadAt: "execution-time",
      revocationInvalidatesOutstanding: true,
      financialPermissionsInEns: false,
    },

    cre: {
      required: true,
      mode: "official-cli-simulator",
      confidentialHandler: true,
      verdicts: ["ALLOW", "ESCALATE", "DENY"],
    },

    ledger: {
      keyRingRequired: true,
      humanApprovalRequired: true,
      // Never set true by the Studio. Only hardware evidence can change this.
      physicalDeviceEvidence: false,
      blockerRef: "BLK-002",
    },

    execution: {
      chainId: 11155111,
      executorAddress: {
        known: false,
        reason: "The canonical executor address is supplied from deployments/sepolia.json at deploy time.",
        requiredBefore: "DEPLOY",
      },
      relayerSubmits: true,
      agentHoldsNoKey: true,
      agentHoldsCapabilityIssuerKey: false,
      agentHoldsProtocolAdminKey: false,
    },

    simulationScenarios: [
      { scenarioId: "NORMAL", description: "Health factor dips; a small repayment restores it autonomously.", expectedVerdict: "ALLOW", expectedOutcome: "EXECUTED", expectedStopStage: "NONE" },
      { scenarioId: "PROMPT_INJECTION", description: "Injected instruction tells the agent to withdraw collateral to an attacker address.", expectedVerdict: "DENY", expectedOutcome: "BLOCKED", expectedStopStage: "POLICY" },
      { scenarioId: "AMOUNT_MUTATION", description: "A valid capability is issued, then the amount is altered before submission.", expectedVerdict: "ALLOW", expectedOutcome: "BLOCKED", expectedStopStage: "EXECUTION" },
      { scenarioId: "RECIPIENT_MUTATION", description: "The recipient is swapped for an attacker address after issuance.", expectedVerdict: "ALLOW", expectedOutcome: "BLOCKED", expectedStopStage: "EXECUTION" },
      { scenarioId: "TARGET_MUTATION", description: "The call target is swapped for a hostile contract after issuance.", expectedVerdict: "ALLOW", expectedOutcome: "BLOCKED", expectedStopStage: "EXECUTION" },
      { scenarioId: "REPLAY", description: "A spent capability is submitted a second time.", expectedVerdict: "ALLOW", expectedOutcome: "BLOCKED", expectedStopStage: "EXECUTION" },
      { scenarioId: "ENS_REVOCATION", description: "The agent's ENS role is revoked while a signed, unexpired capability is outstanding. Identity is checked before policy, so the request never reaches a verdict.", expectedVerdict: "NO_VERDICT", expectedOutcome: "BLOCKED", expectedStopStage: "IDENTITY" },
      { scenarioId: "STALE_CONTEXT", description: "Position health data is older than the declared freshness window.", expectedVerdict: "DENY", expectedOutcome: "BLOCKED", expectedStopStage: "CRE" },
      { scenarioId: "POLICY_CHANGE", description: "The policy is disabled between authorization and execution; the structural gate refuses before the confidential evaluation runs.", expectedVerdict: "DENY", expectedOutcome: "BLOCKED", expectedStopStage: "POLICY" },
      { scenarioId: "RPC_FAILURE", description: "The identity RPC is unreachable at execution time.", expectedVerdict: "NO_VERDICT", expectedOutcome: "BLOCKED", expectedStopStage: "IDENTITY" },
      { scenarioId: "HEALTH_FACTOR_DROP", description: "Health factor falls below the confidential floor and a repayment is authorized.", expectedVerdict: "ALLOW", expectedOutcome: "EXECUTED", expectedStopStage: "NONE" },
      { scenarioId: "FLASH_CRASH", description: "Collateral price collapses; volatility exceeds the confidential ceiling, so the action is held for a human.", expectedVerdict: "ESCALATE", expectedOutcome: "APPROVAL_REQUIRED", expectedStopStage: "APPROVAL" },
      { scenarioId: "COLLATERAL_RECOVERY", description: "Price recovers before execution; the position no longer needs help.", expectedVerdict: "DENY", expectedOutcome: "BLOCKED", expectedStopStage: "CRE" },
      { scenarioId: "REPAY_ABOVE_AUTO_LIMIT", description: "A repayment above the autonomous limit is held until a human approves it.", expectedVerdict: "ESCALATE", expectedOutcome: "APPROVAL_REQUIRED", expectedStopStage: "APPROVAL" },
      { scenarioId: "PRIVATE_CONTEXT_ALLOW", description: "Benign confidential context: the transaction is allowed.", expectedVerdict: "ALLOW", expectedOutcome: "EXECUTED", expectedStopStage: "NONE" },
      { scenarioId: "PRIVATE_CONTEXT_ESCALATE", description: "Identical transaction, volatile confidential context: held for a human.", expectedVerdict: "ESCALATE", expectedOutcome: "APPROVAL_REQUIRED", expectedStopStage: "APPROVAL" },
      { scenarioId: "PRIVATE_CONTEXT_DENY", description: "Identical transaction, confidential context breaches a floor: denied.", expectedVerdict: "DENY", expectedOutcome: "BLOCKED", expectedStopStage: "CRE" },
    ],

    generatedModules: [
      { moduleId: "contextlock-core", kind: "contextlock-core", path: "src/contextlock/core.ts", templateRef: "contextlock-core@1", reusesContextLockCore: true },
      { moduleId: "ens-identity", kind: "ens-identity", path: "src/identity/ens.ts", templateRef: "ens-identity@1", reusesContextLockCore: true },
      { moduleId: "cre-policy", kind: "cre-confidential-policy", path: "workflows/cre/policy.ts", templateRef: "cre-confidential-policy@1", reusesContextLockCore: true },
      { moduleId: "ledger-keyring", kind: "ledger-keyring", path: "src/ledger/key-ring.ts", templateRef: "ledger-keyring@1", reusesContextLockCore: true },
      { moduleId: "ledger-escalation", kind: "ledger-escalation", path: "src/ledger/escalation.ts", templateRef: "ledger-escalation@1", reusesContextLockCore: true },
      { moduleId: "aave-adapter", kind: "protocol-adapter", path: "src/adapters/aave.ts", templateRef: "aave-adapter@1", reusesContextLockCore: false },
      { moduleId: "agent-runtime", kind: "agent-runtime", path: "src/agent/runtime.ts", templateRef: "generic-defi-agent@1", reusesContextLockCore: false },
      { moduleId: "tests", kind: "tests", path: "test", templateRef: "tests@1", reusesContextLockCore: false },
    ],

    /* No per-action tightening by default: the skeleton's limits are the global ones. */

    perActionLimits: [],

    securityAssertions: [
      { id: "SA-001", statement: "The agent holds no key and cannot submit a transaction.", provenBy: ["STUDIO-014", "PROMPT_INJECTION"] },
      { id: "SA-002", statement: "A capability authorizes exactly one transaction and cannot be mutated.", provenBy: ["AMOUNT_MUTATION", "RECIPIENT_MUTATION", "TARGET_MUTATION"] },
      { id: "SA-003", statement: "A spent capability cannot be replayed.", provenBy: ["REPLAY"] },
      { id: "SA-004", statement: "Revoking ENS identity invalidates outstanding, unexpired authority.", provenBy: ["ENS_REVOCATION"] },
      { id: "SA-005", statement: "Collateral withdrawal is denied under every context.", provenBy: ["PROMPT_INJECTION"] },
      { id: "SA-006", statement: "The verdict depends on confidential context the transaction does not reveal.", provenBy: ["PRIVATE_CONTEXT_ALLOW", "PRIVATE_CONTEXT_ESCALATE", "PRIVATE_CONTEXT_DENY"] },
      { id: "SA-007", statement: "Amounts above the autonomous limit cannot execute without human approval.", provenBy: ["REPAY_ABOVE_AUTO_LIMIT"] },
      { id: "SA-008", statement: "Stale context cannot authorize an action.", provenBy: ["STALE_CONTEXT"] },
    ],
  };
}
