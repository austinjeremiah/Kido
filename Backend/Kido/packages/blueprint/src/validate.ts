import type { KidoAgentBlueprint } from "./schema.js";

export interface Blocker {
  code: string;
  detail: string;
}

/** Provider id the compiler records for an allowed action no selected provider can execute. */
export const UNSERVED_PROVIDER = "none";

const FINANCIAL = new Set(["BOUNDED_AUTONOMOUS_FINANCE", "APPROVAL_REQUIRED"]);

/**
 * Buildability gate (bible §3, §10.3). Pure: it never fills a gap, it only lists what blocks.
 * Unknown critical financial permission blocks; unsatisfiable requirements block; the compiler's
 * own restrictive defaults (no BORROW/WITHDRAW) must still be present.
 */
export function buildBlockers(bp: KidoAgentBlueprint, facts: GateFacts = NO_FACTS): Blocker[] {
  const out: Blocker[] = [];
  for (const r of bp.requirements) {
    if (r.status === "UNKNOWN" && r.class === "USER_REQUIRED" && r.critical) out.push({ code: "KIDO_BLUEPRINT_UNRESOLVED", detail: r.key });
    // A critical user decision counts only when the user actually made it (BREAK F-0515).
    if (r.status === "RESOLVED" && r.class === "USER_REQUIRED" && r.critical && r.provenance?.kind !== "USER_ANSWER" && r.provenance?.kind !== "TEMPLATE") out.push({ code: "KIDO_BLUEPRINT_UNRESOLVED", detail: `${r.key} (not answered by the user)` });
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
    if (a.allowedActions.includes("SWAP") && a.swapFloors.length === 0) out.push({ code: "KIDO_BLUEPRINT_NO_SWAP_FLOOR", detail: "SWAP needs an owner price floor" });
    if (a.allowedActions.includes("REPAY") && a.beneficiaries.length === 0) out.push({ code: "KIDO_BLUEPRINT_NO_BENEFICIARY", detail: "REPAY needs a pinned beneficiary" });
    if (bp.chains.length > 1 && a.bridgeAllowed === null) out.push({ code: "KIDO_BLUEPRINT_BRIDGE_UNDECIDED", detail: "authority.bridgeAllowed" });
    if (bp.recovery.onPartialExecution === null) out.push({ code: "KIDO_BLUEPRINT_RECOVERY_UNDECIDED", detail: "recovery.onPartialExecution" });
  }
  if (!a.forbiddenActions.includes("BORROW") && !a.allowedActions.includes("BORROW")) out.push({ code: "KIDO_BLUEPRINT_DEFAULT_REMOVED", detail: "BORROW must be explicitly allowed or forbidden" });
  if (a.bridgeAllowed && !bp.crossChain?.allowed) out.push({ code: "KIDO_BLUEPRINT_CROSS_CHAIN_POLICY", detail: "bridging allowed without a cross-chain policy" });
  if (bp.privacy.required === null) out.push({ code: "KIDO_BLUEPRINT_PRIVACY_UNDECIDED", detail: "privacy.required" });
  if (bp.privacy.required) {
    for (const v of bp.privacy.values) {
      const provided = bp.privacy.providers.some((p) => {
        const m = facts.provider(p.providerId);
        return p.satisfies.includes(v.id) && m?.kind === "privacy" && (p.chain === null || m.chains.includes(p.chain)) && !exposes(m.plaintextVisibleTo, v.hiddenFrom);
      });
      const store = facts.secretStoreId ? facts.provider(facts.secretStoreId) : undefined;
      const storeOk = v.plaintextBoundary === "USER_DEVICE" || (v.plaintextBoundary === "KIDO_SECRET_STORE" && store !== undefined && !exposes(store.plaintextVisibleTo, v.hiddenFrom));
      if (!provided && !storeOk) {
        out.push({ code: "KIDO_BLUEPRINT_PRIVACY_UNSATISFIED", detail: v.id });
      }
    }
  }
  out.push(...structuralBlockers(bp, facts));
  if (bp.identity.public === true && bp.identity.bindings.length === 0) out.push({ code: "KIDO_BLUEPRINT_NO_IDENTITY_BINDING", detail: "public identity requested" });
  return out;
}

/**
 * External facts the gate checks the blueprint against. They come from the provider registry
 * (`gateFacts(registry)`); the blueprint package holds no provider, chain or address tables itself.
 * Without facts every check that needs one fails closed.
 */
export interface GateFacts {
  provider(providerId: string): { kind: string; chains: string[]; plaintextVisibleTo?: string[] | undefined } | undefined;
  /** The provider holding values whose boundary is KIDO_SECRET_STORE. */
  secretStoreId: string | undefined;
  /** Asset symbols a provider's actions can spend on a chain. */
  assetsFor(providerId: string, chain: string): string[] | undefined;
  /** true/false when the chain's address format is known, undefined when it is not. */
  isAddress(chain: string, address: string): boolean | undefined;
}

export const NO_FACTS: GateFacts = { provider: () => undefined, secretStoreId: undefined, assetsFor: () => undefined, isAddress: () => undefined };

/** Plaintext may reach these audiences at this provider; a value hidden from any of them is not protected there. */
function exposes(visibleTo: string[] | undefined, hiddenFrom: readonly string[]): boolean {
  if (!visibleTo) return true;
  if (hiddenFrom.includes("EVERYONE_EXCEPT_APPROVED_ENCLAVE") && visibleTo.length > 0) return true;
  return visibleTo.some((a) => hiddenFrom.includes(a));
}

/** Cross-field consistency: every grant, limit, recipient and binding must refer to something the blueprint actually has. */
function structuralBlockers(bp: KidoAgentBlueprint, facts: GateFacts): Blocker[] {
  const out: Blocker[] = [];
  const a = bp.authority;
  const push = (code: string, detail: string) => out.push({ code, detail });
  for (const x of ["BORROW", "WITHDRAW"] as const) {
    if (a.allowedActions.includes(x)) push("KIDO_BLUEPRINT_FORBIDDEN_GRANT", `${x} is never agent authority`);
    if (!a.forbiddenActions.includes(x)) push("KIDO_BLUEPRINT_DEFAULT_REMOVED", `${x} must be forbidden`);
  }
  if (a.allowedActions.includes("BRIDGE") && a.bridgeAllowed !== true) push("KIDO_BLUEPRINT_BRIDGE_CONFLICT", "BRIDGE granted while bridging is not allowed");
  if (a.bridgeAllowed && bp.crossChain && (bp.crossChain.transports.length === 0 || bp.crossChain.maxAmountPerIntent.length === 0)) push("KIDO_BLUEPRINT_CROSS_CHAIN_POLICY", "cross-chain policy has no transport or amount cap");
  for (const t of bp.crossChain?.transports ?? []) {
    const m = facts.provider(t);
    if (m?.kind !== "transport" || !bp.chains.every((c) => m.chains.includes(c))) push("KIDO_BLUEPRINT_CROSS_CHAIN_POLICY", `transport ${t} is unknown or does not span the agent's chains`);
  }
  const financial = a.mode !== null && FINANCIAL.has(a.mode);
  if (!financial) {
    if (a.provider !== null) push("KIDO_BLUEPRINT_MODE_CONFLICT", `${a.mode} carries authority provider ${a.provider}`);
    if (a.limits.length || a.payees.length || a.beneficiaries.length) push("KIDO_BLUEPRINT_MODE_CONFLICT", `${a.mode} carries limits or recipients`);
    if (bp.amane) push("KIDO_BLUEPRINT_MODE_CONFLICT", `${a.mode} carries an Amane binding`);
    if (a.mode === "READ_ONLY" && a.allowedActions.length) push("KIDO_BLUEPRINT_MODE_CONFLICT", "READ_ONLY allows actions");
  }
  const seen = new Set<string>();
  for (const l of a.limits) {
    const k = `${l.chain}:${l.asset}`;
    if (seen.has(k)) push("KIDO_BLUEPRINT_LIMIT_DUPLICATE", k);
    seen.add(k);
    if (!bp.chains.includes(l.chain)) push("KIDO_BLUEPRINT_LIMIT_FOREIGN_CHAIN", k);
    if (!bp.assets.some((x) => x.chain === l.chain && x.symbol === l.asset)) push("KIDO_BLUEPRINT_LIMIT_UNKNOWN_ASSET", k);
  }
  for (const b of a.beneficiaries) {
    if (!bp.chains.includes(b.chain)) push("KIDO_BLUEPRINT_RECIPIENT_FOREIGN_CHAIN", `beneficiary ${b.label}`);
    if (b.address !== "SELF" && facts.isAddress(b.chain, b.address) !== true) push("KIDO_BLUEPRINT_RECIPIENT_MALFORMED", `beneficiary ${b.label}`);
  }
  for (const p of a.payees) {
    if (!bp.chains.includes(p.chain)) push("KIDO_BLUEPRINT_RECIPIENT_FOREIGN_CHAIN", `payee ${p.label}`);
    if (facts.isAddress(p.chain, p.address) !== true) push("KIDO_BLUEPRINT_RECIPIENT_MALFORMED", `payee ${p.label}`);
  }
  if (a.allowedActions.includes("PAY")) for (const c of new Set(a.limits.map((l) => l.chain))) if (!a.payees.some((p) => p.chain === c)) push("KIDO_BLUEPRINT_NO_PAYEES", `PAY on ${c} has no pinned payee`);
  for (const b of bp.identity.bindings) {
    const m = facts.provider(b.provider);
    if (m?.kind !== "identity" || !m.chains.includes(b.chain)) push("KIDO_BLUEPRINT_IDENTITY_MISMATCH", `${b.provider} on ${b.chain}`);
  }
  if (bp.privacy.required) for (const p of bp.privacy.providers) {
    const m = facts.provider(p.providerId);
    if (m?.kind !== "privacy") push("KIDO_BLUEPRINT_PRIVACY_UNSATISFIED", `unknown privacy provider ${p.providerId}`);
    else if (p.chain !== null && !m.chains.includes(p.chain)) push("KIDO_BLUEPRINT_PRIVACY_UNSATISFIED", `${p.providerId} does not run on ${p.chain}`);
  }
  for (const x of bp.actions) {
    if (x.providerId === UNSERVED_PROVIDER) {
      push("KIDO_BLUEPRINT_ACTION_UNSERVED", `${x.action}: no selected protocol can perform it on a selected chain`);
      continue;
    }
    // Every bounded action needs a budget in an asset its provider can actually spend on that chain.
    if (a.mode === "BOUNDED_AUTONOMOUS_FINANCE") {
      const usable = facts.assetsFor(x.providerId, x.chain);
      if (!a.limits.some((l) => l.chain === x.chain && usable?.includes(l.asset))) push("KIDO_BLUEPRINT_ACTION_NO_BUDGET", `${x.action} via ${x.providerId} on ${x.chain} has no budget in an asset it accepts`);
    }
  }
  return out;
}

export const isBuildable = (bp: KidoAgentBlueprint) => buildBlockers(bp).length === 0;
