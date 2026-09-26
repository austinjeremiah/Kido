import type { Chain } from "@kido/agents";
import { signAmane, type AmaneEvmEndpoint, type AmaneOutcome, type AmaneSuiEndpoint, type ActionIntent, type TypedDataSigner } from "@kido/amane-bridge";
import type { EventLog, KidoEventType, Severity } from "./events.js";
import type { SemanticStep } from "./plan.js";

/** A Cetus pool the Sui SWAP adapter can route through (from the Amane manifest). */
export interface SuiSwapRoute {
  adapterPackage: string;
  coinA: string;
  coinB: string;
  pool: string;
  globalConfig: string;
}

export interface ExecutorDeps {
  evm?: AmaneEvmEndpoint | undefined;
  sui?: AmaneSuiEndpoint | undefined;
  /** Sui coin type for each asset symbol, needed as Move type arguments. */
  suiCoinTypes: Record<string, string>;
  suiRoutes: SuiSwapRoute[];
  agent: TypedDataSigner;
  log: EventLog;
  agentId: string;
}

const OUTCOME: Record<AmaneOutcome["kind"], [KidoEventType, Severity]> = {
  EXECUTED: ["ACTION_EXECUTED", "INFO"],
  REJECTED_BY_AMANE: ["ACTION_REJECTED_BY_AMANE", "NOTICE"],
  NONCE_CONSUMED: ["ACTION_NONCE_CONSUMED", "WARNING"],
  OPERATIONAL_FAILURE: ["ACTION_OPERATIONAL_FAILURE", "ERROR"],
};

/**
 * Signs compiled intents with the agent key and relays them through the Amane SDK. It decides
 * nothing: it routes by chain and action, records what Amane returned, and lands rejections
 * on-chain so every reported rejection has a receipt.
 */
export class ActionExecutor {
  constructor(private readonly d: ExecutorDeps) {}

  async submit(intent: ActionIntent, step: SemanticStep): Promise<AmaneOutcome> {
    const sig = await signAmane(this.d.agent, "ActionIntent", intent);
    const base = { agentId: this.d.agentId, planHash: intent.planHash, chain: step.chain };
    this.d.log.append({ ...base, type: "ACTION_SUBMITTED", severity: "INFO", data: { stepId: step.stepId, action: step.action, asset: step.asset, amount: step.amount.toString(), nonce: intent.nonce.toString() } });
    let outcome: AmaneOutcome;
    try {
      outcome = await this.route(intent, sig, step);
    } catch (err) {
      outcome = { kind: "OPERATIONAL_FAILURE", chain: step.chain, message: (err as Error).message.slice(0, 300) } as AmaneOutcome;
    }
    const [type, severity] = OUTCOME[outcome.kind];
    this.d.log.append({
      ...base,
      type,
      severity,
      tx: "tx" in outcome ? (outcome.tx as string | undefined) : undefined,
      code: outcome.kind === "REJECTED_BY_AMANE" ? outcome.code : undefined,
      data: { stepId: step.stepId, ...(outcome.kind === "OPERATIONAL_FAILURE" ? { message: outcome.message } : {}) },
    });
    return outcome;
  }

  private route(intent: ActionIntent, sig: `0x${string}`, step: SemanticStep): Promise<AmaneOutcome> {
    const opts = { submitRejected: true };
    if (step.chain === "ethereum-sepolia") {
      if (!this.d.evm) throw new Error("no EVM endpoint configured");
      return this.d.evm.executeAction(intent, sig, opts);
    }
    if (!this.d.sui) throw new Error("no Sui endpoint configured");
    if (step.action === "PAY") return this.d.sui.pay(this.coinType(step.asset), intent, sig, opts);
    if (step.action === "SWAP") {
      const [cin, cout] = [this.coinType(step.asset), this.coinType(step.assetOut ?? "")];
      const r = this.d.suiRoutes.find((x) => (x.coinA === cin && x.coinB === cout) || (x.coinA === cout && x.coinB === cin));
      if (!r) throw new Error(`KIDO_REGISTRY_NO_ROUTE: ${step.asset} -> ${step.assetOut} on ${step.chain}`);
      return this.d.sui.swapCetus({ ...r, a2b: r.coinA === cin }, intent, sig, opts);
    }
    throw new Error(`KIDO_REGISTRY_NO_ADAPTER: ${step.action} on ${step.chain as Chain}`);
  }

  private coinType(asset: string): string {
    const t = this.d.suiCoinTypes[asset];
    if (!t) throw new Error(`KIDO_REGISTRY_NO_COIN_TYPE: ${asset}`);
    return t;
  }
}
