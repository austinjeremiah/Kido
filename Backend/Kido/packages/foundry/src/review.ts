import { bindTo, buildBlockers, type KidoAgentBlueprint, type RevisionBound } from "@kido/blueprint";
import type { PlannedBinding } from "@kido/identity";
import { assertPublicSafe } from "@kido/identity";
import type { DriftIssue } from "@kido/knowledge";
import type { PrivacyPlan } from "@kido/privacy";
import type { ProviderRegistry } from "@kido/registry";
import type { AuthorityResult } from "@kido/runtime";
import { KIDO_DEFAULTS } from "@kido/design-interview";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export interface SecurityFinding {
  id: string;
  class: string;
  severity: Severity;
  evidence: string;
  blocking: boolean;
}

export interface SecurityReport extends RevisionBound {
  kind: "security-review";
  findings: SecurityFinding[];
  blocking: boolean;
  generatedAt: number;
}

export interface ReviewInputs {
  authority: AuthorityResult | null;
  identityPlan: PlannedBinding[];
  privacyPlan: PrivacyPlan;
  drift: DriftIssue[];
  registry: ProviderRegistry;
}

const f = (id: string, cls: string, severity: Severity, evidence: string, blocking = severity === "CRITICAL"): SecurityFinding => ({ id, class: cls, severity, evidence, blocking });

/**
 * Deterministic security review (bible §21). Rules run over the blueprint and every compiled plan;
 * a model reviewer may add advisory findings elsewhere but can never clear one of these.
 */
export function securityReview(bp: KidoAgentBlueprint, i: ReviewInputs): SecurityReport {
  const out: SecurityFinding[] = [];
  const a = bp.authority;

  for (const b of buildBlockers(bp, i.registry.gateFacts())) out.push(f(`blocker.${b.code}.${b.detail}`, "unknown-or-invalid-requirement", "CRITICAL", `${b.code}: ${b.detail}`));

  for (const p of a.payees) if (/^0x0+$/.test(p.address) || p.address === "*") out.push(f(`recipient.${p.label}`, "arbitrary-recipient", "CRITICAL", `payee ${p.label} is not a concrete address`));
  const huge = 1n << 128n;
  for (const l of a.limits) if (BigInt(l.total) >= huge || BigInt(l.perWindow) >= huge) out.push(f(`limit.${l.chain}.${l.asset}`, "unbounded-approval", "CRITICAL", `limit on ${l.chain} ${l.asset} is effectively unbounded`));
  for (const act of bp.recovery.allowedRecoveryActions) if (!a.allowedActions.includes(act)) out.push(f(`recovery.${act}`, "recovery-authority-expansion", "CRITICAL", `recovery may use ${act}, which normal operation may not`));
  for (const ag of bp.agents) for (const act of [...ag.owns, ...ag.mayRequest]) if (!a.allowedActions.includes(act) && !(act === "BRIDGE" && a.bridgeAllowed)) out.push(f(`agent.${ag.role}.${act}`, "authority-expansion", "HIGH", `${ag.role} may act on ${act}, which the authority does not allow`));
  if (a.bridgeAllowed && !bp.crossChain?.allowed) out.push(f("bridge.policy", "arbitrary-bridge-payload", "CRITICAL", "bridging allowed without a bound cross-chain policy"));
  if (a.bridgeAllowed) out.push(f("bridge.reservation", "reserved-asset-theft", "HIGH", "arrivals are not yet reserved on-chain by the destination endpoint; reservation is enforced by Kido's plan engine only", false));

  if (i.authority && !i.authority.ok) for (const b of i.authority.blockers) out.push(f(`authority.${b}`, "authority-compile", "CRITICAL", b));
  if (i.authority?.ok) for (const x of i.authority.excludedActions) out.push(f(`adapter.${x.chain}.${x.action}`, "missing-execution-adapter", "HIGH", x.reason));

  for (const adv of bp.identity.advertisedCapabilities) {
    const act = adv.replace(/^kido:/, "").toUpperCase();
    if (!a.allowedActions.includes(act as never)) out.push(f(`identity.${adv}`, "identity-confusion", "MEDIUM", `identity advertises ${adv} but the agent is not authorized for it`, false));
  }
  for (const b of i.identityPlan) {
    try {
      assertPublicSafe(b.records, bp);
    } catch (err) {
      out.push(f(`identity.records.${b.providerId}`, "privacy-leakage", "CRITICAL", (err as Error).message));
    }
    for (const bl of b.blockers) out.push(f(`identity.live.${b.providerId}`, "provider-trust-mismatch", "MEDIUM", bl, false));
  }

  for (const m of bp.monitors) {
    const priv = bp.privacy.values.find((v) => v.id === m.thresholdPrivateRef);
    if (m.thresholdPrivateRef && m.threshold !== null) out.push(f(`privacy.threshold.${m.id}`, "privacy-leakage", "CRITICAL", `private threshold ${m.thresholdPrivateRef} also stored in plaintext`));
    if (m.thresholdPrivateRef && !priv) out.push(f(`privacy.ref.${m.id}`, "privacy-leakage", "CRITICAL", `monitor references unknown private value ${m.thresholdPrivateRef}`));
    const src = bp.dataSources.find((d) => d.id === m.dataSource);
    if (m.response === "DETERMINISTIC_ACTION" && src && src.maxAgeMs > KIDO_DEFAULTS.reviewMaxDataAgeMs) out.push(f(`data.stale.${m.id}`, "stale-data", "MEDIUM", `${src.id} may be ${src.maxAgeMs} ms old when acting`, false));
    if (m.response === "DETERMINISTIC_ACTION" && src && src.onUnavailable !== "FAIL_CLOSED") out.push(f(`data.fallback.${m.id}`, "stale-data", "HIGH", `${src.id} does not fail closed`));
  }
  for (const v of i.privacyPlan.values) {
    if (v.status === "UNSATISFIABLE") out.push(f(`privacy.${v.valueId}`, "privacy-leakage", "CRITICAL", v.reasons[0] ?? "unsatisfiable"));
    if (v.status === "SATISFIED_PLANNING_ONLY") out.push(f(`privacy.live.${v.valueId}.${v.chain}`, "provider-trust-mismatch", "HIGH", `selected privacy provider is not live: ${v.selected.join(", ")}`, false));
  }
  for (const d of i.drift) out.push(f(`drift.${d.pack}`, "protocol-version-drift", d.securityRelevant ? "CRITICAL" : "MEDIUM", `${d.pack}: expected ${d.expected}, found ${d.found}`));
  for (const p of bp.protocols) {
    const m = i.registry.get(p.providerId);
    if (!m) out.push(f(`protocol.${p.providerId}`, "provider-trust-mismatch", "CRITICAL", `unknown provider ${p.providerId}`));
    else if (m.version !== p.version) out.push(f(`protocol.version.${p.providerId}`, "protocol-version-drift", "CRITICAL", `blueprint pins ${p.version}, registry has ${m.version}`));
    for (const e of m?.execution ?? []) if (/generic|arbitrary|call/.test(e.adapter)) out.push(f(`adapter.generic.${e.adapter}`, "arbitrary-target", "CRITICAL", e.adapter));
  }
  const findings = dedupe(out);
  return { ...bindTo(bp), kind: "security-review", findings, blocking: findings.some((x) => x.blocking), generatedAt: Date.now() };
}

function dedupe(xs: SecurityFinding[]): SecurityFinding[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}
