import { BLUEPRINT_SCHEMA_VERSION, type KidoAgentBlueprint } from "./schema.js";
import { deriveKidoAgentId } from "./identity.js";

/** An empty revision-0 blueprint: nothing resolved, nothing authorized, everything restrictive. */
export function emptyBlueprint(projectId: string, salt: string, objective: string): KidoAgentBlueprint {
  return {
    schemaVersion: BLUEPRINT_SCHEMA_VERSION,
    projectId,
    kidoAgentId: deriveKidoAgentId(projectId, salt),
    revision: 0,
    parentRevisionHash: null,
    objective: { statement: objective, summary: null },
    requirements: [],
    chains: [],
    identity: { public: null, organization: null, bindings: [], advertisedCapabilities: [], endpoints: {} },
    protocols: [],
    assets: [],
    dataSources: [],
    privacy: { required: null, values: [], providers: [] },
    authority: {
      mode: null,
      provider: null,
      autonomy: null,
      allowedActions: [],
      forbiddenActions: ["BORROW", "WITHDRAW"],
      limits: [],
      payees: [],
      beneficiaries: [],
      bridgeAllowed: null,
      leaseLifetimeSeconds: 3600,
      swapFloors: [],
    },
    monitors: [],
    triggers: [],
    actions: [],
    reasoning: { model: "env", wakeConditions: [], maxModelCallsPerHour: 30 },
    agents: [],
    recovery: { onPartialExecution: null, allowedRecoveryActions: [], maxRecoveryAttempts: 1, onOracleUnavailable: "FAIL_CLOSED" },
    simulationScenarios: [],
    securityAssertions: [],
    generatedModules: [],
    deployment: { environment: "testnet", chains: [] },
  };
}
