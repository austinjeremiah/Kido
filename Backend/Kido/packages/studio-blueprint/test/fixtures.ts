import { aaveGuardianSkeleton } from "../src/templates/aave-guardian.js";
import type { ContextLockAgentBlueprint } from "../src/schema.js";

/** A complete, valid Aave Guardian Blueprint — the canonical P11 subject under test. */
export function validGuardian(over: Partial<ContextLockAgentBlueprint> = {}): ContextLockAgentBlueprint {
  const bp = {
    ...aaveGuardianSkeleton({
      blueprintId: "bp-test",
      ensName: "guardian.test.eth",
      objective: "Protect an Aave position from liquidation.",
    }),
    revision: 1,
    createdAt: "1970-01-01T00:00:00.000Z",
    triggers: [
      {
        id: "hf-floor",
        kind: "threshold" as const,
        description: "Health factor below the confidential floor",
        thresholdIsConfidential: true,
        confidentialParameterName: "healthFactorFloorBps",
      },
    ],
    permissions: {
      allowed: [
        { id: "p-repay", statement: "repay outstanding debt", actionRef: "repay-debt" },
        { id: "p-supply", statement: "add collateral", actionRef: "add-collateral" },
      ],
      denied: [
        { id: "d-withdraw", statement: "withdraw collateral" },
        { id: "d-transfer", statement: "arbitrary transfer" },
        { id: "d-approve", statement: "arbitrary token approval" },
      ],
    },
    autonomousPolicy: {
      maxValueUsdCents: { known: true as const, value: 100_000, sourceQuote: "Repay up to $1,000 automatically" },
      allowedActionRefs: ["repay-debt", "add-collateral"],
    },
    /*
     * A RESOLVED Blueprint. The skeleton declares data requirements with no bindings; the
     * deterministic resolver fills these in during the pipeline's Blueprint stage. The fixture
     * represents the post-resolution state, which is what the validator and the graph actually see.
     */
    adapters: [
      {
        adapterId: "reference-chain-reader",
        adapterVersion: "1.0.0",
        role: "STATE_DATA" as const,
        configRef: "positionHealth",
        rationale: "reference-chain-reader@1.0.0 offers DIRECT_CHAIN_DATA for aave_position_health_factor",
      },
      {
        adapterId: "reference-oracle",
        adapterVersion: "1.0.0",
        role: "VERIFIED_MARKET_DATA" as const,
        configRef: "collateralPrice",
        rationale: "reference-oracle@1.0.0 offers VERIFIED_ORACLE for collateral_asset_usd_price",
      },
    ],
    escalationPolicy: {
      minValueUsdCents: { known: true as const, value: 100_000, sourceQuote: "$1,000-$5,000 requires Ledger" },
      maxValueUsdCents: { known: true as const, value: 500_000, sourceQuote: "$1,000-$5,000 requires Ledger" },
      mechanism: "approval-registry-standin" as const,
      denyIsTerminal: true as const,
    },
  } as ContextLockAgentBlueprint;
  return { ...bp, ...over };
}

/** Deep clone so a mutation test cannot accidentally compare an object with itself (cf. FND-006). */
export function copy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export const ALL_GENERATED_PATHS = [
  "src/adapters/kernel.ts",
  "src/adapters/reference-chain-reader/adapter.ts",
  "src/adapters/reference-chain-reader/config.ts",
  "src/adapters/reference-oracle/adapter.ts",
  "src/adapters/reference-oracle/config.ts",
  "src/contextlock/core.ts",
  "src/identity/ens.ts",
  "workflows/cre/policy.ts",
  "src/ledger/key-ring.ts",
  "src/ledger/escalation.ts",
  "src/adapters/aave.ts",
  "src/agent/runtime.ts",
  "test/security.test.ts",
];
