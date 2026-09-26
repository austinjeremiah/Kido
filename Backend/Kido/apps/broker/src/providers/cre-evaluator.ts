import { createPublicClient, createWalletClient, http, decodeFunctionData, encodeAbiParameters, keccak256, parseAbiParameters, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { OperationalError, ReasonCode, type Verdict } from "@contextlock/protocol";
import {
  evaluatePolicy,
  verdictToUint,
  type MarketContext,
  type PrivatePolicy,
  type EvaluationRequest as PolicyRequest,
} from "@contextlock/policy";
import type { EvaluationInput, EvaluationResult, PolicyEvaluator } from "./interfaces.js";

/**
 * ContextLock <-> Chainlink CRE policy boundary.
 *
 * HONEST LABELLING — read this before citing it as a Chainlink integration:
 *
 * The decision logic is imported directly from
 * `workflows/cre-policy/contextlock-policy/policy.ts`, which is the SAME module the real
 * `handlerInTee` confidential workflow executes. There is one policy implementation, not two.
 *
 * What differs by mode is WHERE it runs and WHO attests the result:
 *
 *   `cre-live`          - the CRE DON runs it inside an attested AWS Nitro enclave, the Vault DON
 *                         releases the private policy into that enclave, and a DON-signed report
 *                         is delivered on-chain by the Chainlink forwarder. NOT ACHIEVED — see
 *                         reports/phase-04/blockers/BLK-001.
 *   `cre-workflow-local`- this class runs the same module in the broker process, reading the
 *                         private policy from local secret storage, and delivers the result
 *                         through ContextLockCreConsumer using the configured forwarder key.
 *                         The decision is identical; the CONFIDENTIALITY and ATTESTATION
 *                         guarantees are NOT. This mode must never be described as confidential,
 *                         as TEE-executed, or as simulator output.
 *
 * The security architecture is unaffected either way: the executor requires an authorization
 * recorded by the consumer contract, bound to the exact request hash. Swapping this class for a
 * live DON changes who writes the record, not what the executor demands.
 */
export type CreEvaluatorMode = "cre-live" | "cre-workflow-local";

const CONSUMER_ABI = [
  { type: "function", name: "onReport", stateMutability: "nonpayable", inputs: [{ name: "report", type: "bytes" }], outputs: [] },
  { type: "function", name: "computeAuthorizationId", stateMutability: "pure",
    inputs: [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }], outputs: [{ type: "bytes32" }] },
] as const;

const GATEWAY_ABI = [
  { type: "function", name: "requestEvaluation", stateMutability: "nonpayable", inputs: [
      { name: "agentIdentityHash", type: "bytes32" }, { name: "agent", type: "address" },
      { name: "ensNode", type: "bytes32" }, { name: "target", type: "address" },
      { name: "value", type: "uint256" }, { name: "callData", type: "bytes" },
      { name: "intentHash", type: "bytes32" }, { name: "policyId", type: "bytes32" },
      { name: "policyVersion", type: "uint64" }, { name: "actionKind", type: "bytes32" },
    ], outputs: [{ type: "bytes32" }] },
] as const;

const TARGET_ABI = [
  { type: "function", name: "transferTo", stateMutability: "nonpayable",
    inputs: [{ name: "recipient", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
] as const;

export type CreEvaluatorConfig = {
  mode: CreEvaluatorMode;
  rpcUrl: string;
  gateway: Address;
  consumer: Address;
  /** Key permitted to deliver reports to the consumer. In live mode the DON forwarder does this. */
  forwarderPrivateKey: Hex;
  privatePolicy: PrivatePolicy;
  /** Live context source. Returns an invalid context on failure so policy fails closed. */
  fetchContext: () => Promise<MarketContext>;
};

/** Mirrors workflow.ts::policyCommitment exactly, so on-chain records agree with the workflow. */
export function policyCommitment(p: PrivatePolicy): Hex {
  return keccak256(
    toHex(
      [p.policyId, p.policyVersion, p.enabled, p.autoLimit, p.escalationLimit, p.maxSlippageBps,
       p.maxVolatilityBps, p.minLiquidity, p.targetEthAllocationBps, p.rebalanceDriftBps,
       p.minHealthFactorBps, p.targetHealthFactorBps, p.proprietaryRiskThreshold].join("|"),
    ),
  );
}

export function commitContext(ctx: MarketContext): Hex {
  return keccak256(
    toHex(`ctx:${ctx.observedAtUnix}:${ctx.slippageBps}:${ctx.volatilityBps}:${ctx.liquidity}:${ctx.healthFactorBps}`),
  );
}

export class CrePolicyEvaluator implements PolicyEvaluator {
  private readonly pub;
  private readonly forwarder;

  constructor(private readonly cfg: CreEvaluatorConfig) {
    this.pub = createPublicClient({ chain: sepolia, transport: http(cfg.rpcUrl) });
    this.forwarder = createWalletClient({
      account: privateKeyToAccount(cfg.forwarderPrivateKey), chain: sepolia, transport: http(cfg.rpcUrl),
    });
  }

  /** Public so tests can assert the broker never invents its own commitment. */
  get policyCommitmentHex(): Hex {
    return policyCommitment(this.cfg.privatePolicy);
  }

  async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
    if (this.cfg.mode === "cre-live") {
      throw new OperationalError(
        ReasonCode.CRE_UNAVAILABLE,
        "cre-live mode requires CRE CLI authentication and Confidential Workflows access (BLK-001)",
      );
    }

    // Independently decode the real action from calldata. The agent's declared amount is never
    // used for the decision — this is the CRE-014 control, and it lives here as well as in the
    // workflow so the broker cannot be tricked either.
    let decodedRecipient: string;
    let decodedAmount: bigint;
    let selector: string;
    try {
      const cd = input.calldata as Hex;
      selector = cd.slice(0, 10);
      const { functionName, args } = decodeFunctionData({ abi: TARGET_ABI, data: cd });
      if (functionName !== "transferTo") throw new Error("unsupported selector");
      decodedRecipient = (args as readonly [string, bigint])[0];
      decodedAmount = (args as readonly [string, bigint])[1];
    } catch {
      throw new OperationalError(ReasonCode.CRE_UNAVAILABLE, "calldata could not be decoded for evaluation");
    }

    // 1. Announce the request on-chain. This is the event the CRE log trigger subscribes to.
    const requestTx = await this.forwarder.writeContract({
      address: this.cfg.gateway, abi: GATEWAY_ABI, functionName: "requestEvaluation",
      args: [
        input.identity.agentIdentityHash, input.identity.agent, input.identity.node,
        input.target, input.value, input.calldata as Hex, input.intentHash,
        this.cfg.privatePolicy.policyId as Hex, BigInt(this.cfg.privatePolicy.policyVersion),
        keccak256(toHex(input.actionKind)),
      ],
    });
    await this.pub.waitForTransactionReceipt({ hash: requestTx });

    // 2. Evaluate with the SAME module the TEE handler runs.
    const ctx = await this.cfg.fetchContext();
    const nowUnix = Math.floor(Date.now() / 1000);
    const req: PolicyRequest = {
      requestHash: input.requestHash,
      agentIdentityHash: input.identity.agentIdentityHash,
      ensNode: input.identity.node,
      agent: input.identity.agent,
      chainId: 11155111,
      target: input.target,
      value: input.value,
      calldataHash: input.calldataHash,
      selector,
      decodedRecipient,
      decodedAmount,
      intentHash: input.intentHash,
      policyId: this.cfg.privatePolicy.policyId,
      policyVersion: this.cfg.privatePolicy.policyVersion,
      actionKind: keccak256(toHex(input.actionKind)),
    };
    const decision = evaluatePolicy(req, this.cfg.privatePolicy, ctx, nowUnix);

    // 3. Deliver the verdict through the restricted consumer. Only a verdict, reason code and
    //    commitments cross this boundary — never a threshold, never the raw context.
    const commitment = policyCommitment(this.cfg.privatePolicy);
    const contextCommitment = commitContext(ctx);
    const evaluatedAt = BigInt(nowUnix);
    const validUntil = evaluatedAt + BigInt(decision.ttlSeconds || 60);

    const report = encodeAbiParameters(
      parseAbiParameters(
        "bytes32 requestHash, bytes32 policyCommitment, bytes32 contextCommitment, uint8 verdict, bytes32 reasonCode, uint64 evaluatedAt, uint64 validUntil",
      ),
      [
        input.requestHash as Hex, commitment, contextCommitment,
        verdictToUint(decision.verdict), keccak256(toHex(decision.reasonCode)),
        evaluatedAt, validUntil,
      ],
    );

    const deliverTx = await this.forwarder.writeContract({
      address: this.cfg.consumer, abi: CONSUMER_ABI, functionName: "onReport", args: [report],
    });
    await this.pub.waitForTransactionReceipt({ hash: deliverTx });

    const authorizationId = await this.pub.readContract({
      address: this.cfg.consumer, abi: CONSUMER_ABI, functionName: "computeAuthorizationId",
      args: [input.requestHash as Hex, commitment, evaluatedAt],
    }) as Hex;

    return {
      authorizationId,
      requestHash: input.requestHash as Hex,
      verdict: decision.verdict as Verdict,
      reasonCode: decision.reasonCode,
      contextCommitment,
      evaluatedAt,
      approvedUntil: validUntil,
      // Never "cre-live", never "cre-simulator". This label is load-bearing.
      source: "cre-workflow-local" as unknown as EvaluationResult["source"],
    };
  }
}
