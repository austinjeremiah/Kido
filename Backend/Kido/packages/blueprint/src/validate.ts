import type { KidoAgentBlueprint } from "./schema.js";

export interface Blocker {
  code: string;
  detail: string;
}

const FINANCIAL = new Set(["BOUNDED_AUTONOMOUS_FINANCE", "APPROVAL_REQUIRED"]);

/**
 * Buildability gate (bible §3, §10.3). Pure: it never fills a gap, it only lists what blocks.
 * Unknown critical financial permission blocks; unsatisfiable requirements block; the compiler's
 * own restrictive defaults (no BORROW/WITHDRAW) must still be present.
 */
export function buildBlockers(bp: KidoAgentBlueprint): Blocker[] {
  const out: Blocker[] = [];
  for (const r of bp.requirements) {
    if (r.status === "UNKNOWN" && r.class === "USER_REQUIRED" && r.critical) out.push({ code: "KIDO_BLUEPRINT_UNRESOLVED", detail: r.key });
    if (r.status === "UNSATISFIABLE") out.push({ code: "KIDO_BLUEPRINT_UNSATISFIABLE", detail: r.key });
  }
  const a = bp.authority;
  if (a.mode === null) out.push({ code: "KIDO_BLUEPRINT_NO_AUTHORITY_MODE", detail: "authority.mode" });
  if (bp.chains.length === 0) out.push({ code: "KIDO_BLUEPRINT_NO_CHAIN", detail: "chains" });
  if (a.mode && FINANCIAL.has(a.mode)) {
    if (a.allowedActions.length === 0) out.push({ code: "KIDO_BLUEPRINT_NO_ACTIONS", detail: "authority.allowedActions" });
    for (const act of a.allowedActions) if (a.forbiddenActions.includes(act)) out.push({ code: "KIDO_BLUEPRINT_ACTION_CONFLICT", detail: act });
  }
  if (a.mode === "BOUNDED_AUTONOMOUS_FINANCE") {
    if (a.provider !== "AMANE") out.push({ code: "KIDO_BLUEPRINT_NO_AUTHORITY_PROVIDER", detail: "BOUNDED_AUTONOMOUS_FINANCE requires Amane" });
    for (const c of bp.chains) {
      if (!a.limits.some((l) => l.chain === c)) out.push({ code: "KIDO_BLUEPRINT_NO_LIMITS", detail: c });
    }
    for (const l of a.limits) {
      if (BigInt(l.perAction) > BigInt(l.perWindow) || BigInt(l.perWindow) > BigInt(l.total)) out.push({ code: "KIDO_BLUEPRINT_LIMIT_ORDER", detail: `${l.chain}:${l.asset}` });
      if (BigInt(l.total) === 0n) out.push({ code: "KIDO_BLUEPRINT_ZERO_LIMIT", detail: `${l.chain}:${l.asset}` });
    }
    if (a.allowedActions.includes("PAY") && a.payees.length === 0) out.push({ code: "KIDO_BLUEPRINT_NO_PAYEES", detail: "PAY needs pinned payees" });
    if (a.allowedActions.includes("REPAY") && a.beneficiaries.length === 0) out.push({ code: "KIDO_BLUEPRINT_NO_BENEFICIARY", detail: "REPAY needs a pinned beneficiary" });
    if (bp.chains.length > 1 && a.bridgeAllowed === null) out.push({ code: "KIDO_BLUEPRINT_BRIDGE_UNDECIDED", detail: "authority.bridgeAllowed" });
    if (bp.recovery.onPartialExecution === null) out.push({ code: "KIDO_BLUEPRINT_RECOVERY_UNDECIDED", detail: "recovery.onPartialExecution" });
  }
  if (!a.forbiddenActions.includes("BORROW") && !a.allowedActions.includes("BORROW")) out.push({ code: "KIDO_BLUEPRINT_DEFAULT_REMOVED", detail: "BORROW must be explicitly allowed or forbidden" });
  if (a.bridgeAllowed && !bp.crossChain?.allowed) out.push({ code: "KIDO_BLUEPRINT_CROSS_CHAIN_POLICY", detail: "bridging allowed without a cross-chain policy" });
  if (bp.privacy.required === null) out.push({ code: "KIDO_BLUEPRINT_PRIVACY_UNDECIDED", detail: "privacy.required" });
  if (bp.privacy.required) {
    for (const v of bp.privacy.values) {
      if (!bp.privacy.providers.some((p) => p.satisfies.includes(v.id)) && v.plaintextBoundary !== "KIDO_SECRET_STORE" && v.plaintextBoundary !== "USER_DEVICE") {
        out.push({ code: "KIDO_BLUEPRINT_PRIVACY_UNSATISFIED", detail: v.id });
      }
    }
  }
  if (bp.identity.public === true && bp.identity.bindings.length === 0) out.push({ code: "KIDO_BLUEPRINT_NO_IDENTITY_BINDING", detail: "public identity requested" });
  return out;
}

export const isBuildable = (bp: KidoAgentBlueprint) => buildBlockers(bp).length === 0;
