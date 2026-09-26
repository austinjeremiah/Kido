import type { Chain } from "@kido/agents";
import { signAmane, toAuditDraft, type AmaneEvmEndpoint, type AmaneOutcome, type AmaneSuiEndpoint, type ActionIntent, type TypedDataSigner } from "@kido/amane-bridge";
import type { EventDraft, EventStore } from "@contextlock/studio-events";

export interface AuditScope {
  organizationId: string | null;
  projectId: string;
  deploymentId: string;
  agentId: string | null;
  correlationId: string;
}

export interface ExecutorDeps {
  evm: AmaneEvmEndpoint;
  sui: AmaneSuiEndpoint;
  /** Sui coin type for each asset symbol, needed as the Move type argument. */
  suiCoinTypes: Record<string, string>;
  agent: TypedDataSigner;
  store: EventStore;
  scope: AuditScope;
  clock?: () => number;
}

/**
 * Signs compiled intents with the agent key and relays them through the Amane SDK. The executor
 * decides nothing: it records what Amane returned, and a rejection is landed on-chain so every
 * reported rejection has a receipt.
 */
export class ActionExecutor {
  constructor(private readonly d: ExecutorDeps) {}

  async submit(intent: ActionIntent, chain: Chain, asset: string): Promise<AmaneOutcome> {
    const now = (this.d.clock ?? Date.now)();
    const sig = await signAmane(this.d.agent, "ActionIntent", intent);
    this.record("ACTION_SUBMITTED", "INFO", now, intent, chain, {});
    const outcome =
      chain === "ethereum-sepolia"
        ? await this.d.evm.executeAction(intent, sig, { submitRejected: true })
        : await this.d.sui.pay(this.coinType(asset), intent, sig, { submitRejected: true });
    this.d.store.append(
      toAuditDraft(outcome, {
        ...this.d.scope,
        planHash: intent.planHash,
        planStep: intent.planStep,
        leaseId: intent.leaseId,
        nonce: intent.nonce.toString(),
        adapterId: intent.adapterId,
        chainId: chain === "ethereum-sepolia" ? 11155111 : null,
        timestamp: (this.d.clock ?? Date.now)(),
      }),
      (this.d.clock ?? Date.now)(),
    );
    return outcome;
  }

  record(type: EventDraft["type"], severity: EventDraft["severity"], at: number, intent: ActionIntent | null, chain: Chain | null, meta: Record<string, unknown>) {
    this.d.store.append(
      {
        ...this.d.scope,
        source: "RUNTIME",
        type,
        severity,
        timestamp: at,
        agentRunId: null,
        modelRunId: null,
        strategyEvaluationId: null,
        creExecutionId: null,
        authorizationId: intent?.leaseId ?? null,
        capabilityId: null,
        chainId: chain === "ethereum-sepolia" ? 11155111 : null,
        blockNumber: null,
        txHash: null,
        creWorkflowId: null,
        adapterId: intent?.adapterId ?? null,
        runtimeRevision: null,
        buildRevision: null,
        deploymentRevision: null,
        correctsEventId: null,
        publicMetadata: { ...(intent ? { planHash: intent.planHash, planStep: intent.planStep, nonce: intent.nonce.toString(), chain } : {}), ...meta },
      },
      at,
    );
  }

  private coinType(asset: string): string {
    const t = this.d.suiCoinTypes[asset];
    if (!t) throw new Error(`KIDO_REGISTRY_NO_COIN_TYPE: ${asset}`);
    return t;
  }
}
