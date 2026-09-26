import { nextRevision, type ChainId, type KidoAgentBlueprint, type PrivateValueSpec } from "@kido/blueprint";
import type { ProviderRegistry, ProviderStatus, TrustProfile } from "@kido/registry";

export type ValueStatus = "SATISFIED" | "SATISFIED_PLANNING_ONLY" | "UNSATISFIABLE";

export interface CompiledValue {
  valueId: string;
  chain: ChainId | null;
  requiredCapabilities: string[];
  selected: string[];
  status: ValueStatus;
  reasons: string[];
  trust: TrustProfile[];
  plaintextBoundary: PrivateValueSpec["plaintextBoundary"];
  allowedDisclosure: PrivateValueSpec["allowedDisclosure"];
}

export interface PrivacyPlan {
  required: boolean;
  values: CompiledValue[];
  providers: { providerId: string; chain: ChainId | null; capabilities: string[]; satisfies: string[] }[];
  liveBlockers: string[];
}

/** Values the running agent must use in computation (as opposed to only store). */
const COMPUTED = new Set(["PRIVATE_POLICY", "PRIVATE_STRATEGY", "PRIVATE_API_RESPONSE", "PRIVATE_INPUT", "CONFIDENTIAL_COMPUTE", "VERIFIABLE_COMPUTE", "PRIVATE_MODEL_CONTEXT"]);
const BACKEND_BLIND = new Set(["NORMAL_KIDO_BACKEND", "CLOUD_HOST", "EVERYONE_EXCEPT_APPROVED_ENCLAVE"]);

/** Bible §27.3: required capabilities for one private value, or the contradiction that makes it unsatisfiable. */
export function requiredCapabilities(v: PrivateValueSpec): { caps: string[]; contradiction?: string } {
  const blindBackend = v.hiddenFrom.some((h) => BACKEND_BLIND.has(h));
  const computed = COMPUTED.has(v.kind);
  const decision = v.allowedDisclosure === "DECISION_ONLY" || v.allowedDisclosure === "BOOLEAN_RESULT" || v.allowedDisclosure === "BUCKETED_RESULT";
  switch (v.plaintextBoundary) {
    case "KIDO_SECRET_STORE":
      if (blindBackend) return { caps: [], contradiction: "plaintext in Kido's secret store contradicts hiding it from Kido's backend or cloud host" };
      if (v.hiddenFrom.includes("AI_AGENT") && v.kind === "PRIVATE_MODEL_CONTEXT") return { caps: [], contradiction: "a value hidden from the AI agent cannot be model context" };
      return { caps: ["SECRET_STORAGE"] };
    case "USER_DEVICE":
      if (computed) return { caps: [], contradiction: "the agent needs this value at runtime, but plaintext may only exist on your device" };
      return { caps: [] };
    case "NONE":
      if (v.allowedDisclosure !== "COMMITMENT_ONLY" || computed) return { caps: [], contradiction: "a value with no plaintext anywhere can only be used as a commitment" };
      return { caps: [] };
    case "APPROVED_ENCLAVE": {
      const caps = v.kind === "ENCRYPTED_STATE" ? ["ENCRYPTED_STATE"] : ["CONFIDENTIAL_COMPUTE"];
      // Attestation is what lets a blind backend trust the result; hiding from the chain alone does not need it.
      if (blindBackend && (computed || v.kind === "PRIVATE_API_CREDENTIAL")) caps.push("VERIFIABLE_COMPUTE");
      if (v.kind === "PRIVATE_API_CREDENTIAL" || v.kind === "PRIVATE_API_RESPONSE") caps.push("PRIVATE_API_ACCESS");
      if (decision && computed) caps.push("DECISION_ONLY_OUTPUT");
      return { caps: [...new Set(caps)] };
    }
    case "DON":
      return { caps: ["CONFIDENTIAL_COMPUTE", ...(decision ? ["DECISION_ONLY_OUTPUT"] : [])] };
  }
}

const PLANNING: ProviderStatus[] = ["VERIFIED_LIVE", "VERIFIED_DOCS", "UNVERIFIED", "BLOCKED_ENV", "MOCK_ONLY"];

/**
 * Compiles privacy values into the smallest satisfying provider set per chain (bible §27.3). A value
 * nobody can satisfy is UNSATISFIABLE and blocks the build; a value only satisfiable by a provider
 * that is not live is SATISFIED_PLANNING_ONLY and its live blocker is reported, never hidden.
 */
export function compilePrivacy(bp: KidoAgentBlueprint, reg: ProviderRegistry): PrivacyPlan {
  const values: CompiledValue[] = [];
  const blockers: string[] = [];
  if (!bp.privacy.required) return { required: false, values, providers: [], liveBlockers: [] };
  for (const v of bp.privacy.values) {
    const { caps, contradiction } = requiredCapabilities(v);
    if (contradiction) {
      values.push({ valueId: v.id, chain: null, requiredCapabilities: [], selected: [], status: "UNSATISFIABLE", reasons: [contradiction], trust: [], plaintextBoundary: v.plaintextBoundary, allowedDisclosure: v.allowedDisclosure });
      continue;
    }
    if (caps.length === 0) {
      values.push({ valueId: v.id, chain: null, requiredCapabilities: [], selected: [], status: "SATISFIED", reasons: ["no provider needed: the value never leaves its boundary"], trust: [], plaintextBoundary: v.plaintextBoundary, allowedDisclosure: v.allowedDisclosure });
      continue;
    }
    const chains: (ChainId | null)[] = caps.length === 1 && caps[0] === "SECRET_STORAGE" ? [null] : bp.chains;
    if (bp.chains.length === 0) {
      values.push({ valueId: v.id, chain: null, requiredCapabilities: caps, selected: [], status: "UNSATISFIABLE", reasons: ["no chain chosen yet"], trust: [], plaintextBoundary: v.plaintextBoundary, allowedDisclosure: v.allowedDisclosure });
      continue;
    }
    for (const chain of chains) {
      const c = chain ?? bp.chains[0]!;
      const live = reg.select({ kind: "privacy", chain: c, capabilities: caps, acceptStatus: ["VERIFIED_LIVE"], hiddenFrom: v.hiddenFrom });
      const provenLive = live.uncovered.length === 0 && live.selected.every((p) => caps.every((cap) => !p.capabilities.includes(cap) || reg.implementationComplete(p.providerId, cap)));
      const plan = provenLive ? live : reg.select({ kind: "privacy", chain: c, capabilities: caps, acceptStatus: PLANNING, hiddenFrom: v.hiddenFrom });
      const reasons = plan.rejected.map((r) => `${r.providerId}: ${r.reason}`);
      let status: ValueStatus;
      if (plan.uncovered.length > 0) {
        status = "UNSATISFIABLE";
        reasons.unshift(`no provider on ${c} offers ${plan.uncovered.join(", ")}`);
      } else if (!provenLive) {
        status = "SATISFIED_PLANNING_ONLY";
        for (const p of plan.selected) if (!reg.implementationComplete(p.providerId)) blockers.push(`${v.id} on ${c}: ${p.providerId} ${p.implementation.status}${p.implementation.blocker ? ` — ${p.implementation.blocker.type}: ${p.implementation.blocker.actionRequired} (${p.implementation.blocker.evidence})` : ""}`);
      } else status = "SATISFIED";
      values.push({ valueId: v.id, chain, requiredCapabilities: caps, selected: plan.selected.map((p) => p.providerId), status, reasons, trust: plan.selected.map((p) => p.trust), plaintextBoundary: v.plaintextBoundary, allowedDisclosure: v.allowedDisclosure });
    }
  }
  const byProvider = new Map<string, { providerId: string; chain: ChainId | null; capabilities: string[]; satisfies: string[] }>();
  for (const cv of values) {
    if (cv.status === "UNSATISFIABLE") continue;
    for (const pid of cv.selected) {
      const key = `${pid}@${cv.chain ?? "*"}`;
      const e = byProvider.get(key) ?? { providerId: pid, chain: cv.chain, capabilities: reg.get(pid)?.capabilities ?? [], satisfies: [] };
      if (!e.satisfies.includes(cv.valueId)) e.satisfies.push(cv.valueId);
      byProvider.set(key, e);
    }
  }
  return { required: true, values, providers: [...byProvider.values()], liveBlockers: blockers };
}

/** Writes the compiled provider bindings into a new blueprint revision; unsatisfiable values become blocking requirements. */
export function applyPrivacyPlan(bp: KidoAgentBlueprint, plan: PrivacyPlan): KidoAgentBlueprint {
  const unsat = plan.values.filter((v) => v.status === "UNSATISFIABLE");
  const reqs = bp.requirements.filter((r) => !r.key.startsWith("privacy.value."));
  for (const u of unsat) {
    reqs.push({ key: `privacy.value.${u.valueId}`, topic: "PRIVACY", class: "USER_REQUIRED", critical: true, status: "UNSATISFIABLE", value: u.reasons[0], confirmed: false });
  }
  return nextRevision(bp, { privacy: { ...bp.privacy, providers: plan.providers }, requirements: reqs.sort((a, b) => a.key.localeCompare(b.key)) });
}
