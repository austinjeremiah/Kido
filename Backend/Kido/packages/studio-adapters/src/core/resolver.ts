import { z } from "zod";
import type { AdapterRegistry } from "./registry.js";
import { adapterRef, type ContextLockAdapterManifest } from "./manifest.js";
import { DataTrustClassSchema, satisfiesTrust, trustRank, type DataTrustClass } from "./trust.js";
import { fenceWrite } from "@contextlock/studio-network";

/**
 * Deterministic adapter selection.
 *
 * Luna may propose an adapter and may explain a choice. It cannot make one. Everything here is
 * ordinary code operating on manifests, and a suggestion that fails these rules is rejected with a
 * reason rather than deferred to.
 *
 * The rule that matters most is the negative one: when nothing satisfies a requirement, the answer
 * is NO_COMPATIBLE_ADAPTER. It is never "the closest available thing". A price requirement that
 * quietly falls back to an indexer is the failure this whole layer exists to prevent, and it is
 * far more dangerous than an error, because the number that comes back looks completely normal.
 */

export const DataRequirementSchema = z.object({
  /** Blueprint-local name, e.g. "ethUsd". */
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  kind: z.string().min(1),
  subject: z.string().optional(),
  chainId: z.number().int().positive(),
  unit: z.string().optional(),
  minimumTrustClass: DataTrustClassSchema,
  maxAgeMs: z.number().int().positive(),
  confidential: z.boolean().default(false),
  historical: z.boolean().default(false),
  /**
   * Fallbacks must be declared, pinned and trust-bounded.
   *
   * An undeclared fallback is a silent downgrade. A declared one is a decision the user made and
   * can be shown in the UI.
   */
  fallback: z
    .object({
      adapterId: z.string(),
      adapterVersion: z.string(),
      allowedTrust: DataTrustClassSchema,
      maxAgeMs: z.number().int().positive(),
    })
    .optional(),
});
export type DataRequirement = z.infer<typeof DataRequirementSchema>;

export interface AdapterSelection {
  key: string;
  adapterId: string;
  adapterVersion: string;
  trustClass: DataTrustClass;
  /** Human-readable, deterministic. Shown in the UI so a choice can be argued with. */
  rationale: string;
  fallback?: { adapterId: string; adapterVersion: string; allowedTrust: DataTrustClass; maxAgeMs: number };
}

export interface RejectedCandidate {
  ref: string;
  reason: string;
}

export type ResolutionOutcome =
  | { ok: true; selection: AdapterSelection; rejected: RejectedCandidate[] }
  | { ok: false; code: "NO_COMPATIBLE_ADAPTER"; requirement: DataRequirement; rejected: RejectedCandidate[] };

/**
 * Rank compatible candidates.
 *
 * Deliberately stable and explainable rather than clever:
 *  1. higher trust first — a stronger source is never a worse answer;
 *  2. then lower typical staleness;
 *  3. then adapter ref alphabetically, so ties never depend on registration order.
 *
 * Cost is not a factor here. Ranking a cheaper, weaker source above a stronger one would reintroduce
 * exactly the substitution the trust model forbids.
 */
function rank(a: ContextLockAdapterManifest, b: ContextLockAdapterManifest, dataKind: string): number {
  const trustOf = (m: ContextLockAdapterManifest) =>
    trustRank(m.capabilities.find((c) => c.dataKind === dataKind)?.trustClass ?? m.trustClass);
  const t = trustOf(b) - trustOf(a);
  if (t !== 0) return t;
  const s = (a.freshnessSemantics.typicalStalenessMs ?? Number.MAX_SAFE_INTEGER) -
    (b.freshnessSemantics.typicalStalenessMs ?? Number.MAX_SAFE_INTEGER);
  if (s !== 0) return s;
  return adapterRef(a).localeCompare(adapterRef(b));
}

/**
 * The adapter write fence.
 *
 * An adapter that PREPARES a transaction names the chain it would execute on. A data adapter does
 * not, and must not be fenced — reading a mainnet subgraph is the whole point of the reality
 * engine. So the fence applies to the prepare path only, and the distinction is the adapter's
 * declared capability rather than a guess about its name.
 */
export function fenceAdapterExecution(adapterId: string, chainId: number | undefined, capability: "READ" | "PREPARE_WRITE"): void {
  if (capability !== "PREPARE_WRITE" || typeof chainId !== "number") return;
  fenceWrite("ADAPTER_RESOLVER", { chainId, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null }, "PUBLIC_WRITE");
}

export function resolveDataRequirement(
  registry: AdapterRegistry,
  requirement: DataRequirement,
): ResolutionOutcome {
  const rejected: RejectedCandidate[] = [];
  const all = registry.list();

  const compatible = all.filter((m) => {
    const ref = adapterRef(m);
    if (m.adapterType === "EXECUTION" || m.adapterType === "TRIGGER" || m.adapterType === "CROSS_CHAIN") {
      return false; // not data sources; silently out of scope rather than "rejected"
    }
    if (!m.supportedChains.includes(requirement.chainId)) {
      rejected.push({ ref, reason: `does not support chain ${requirement.chainId}` });
      return false;
    }
    const cap = m.capabilities.find((c) => c.dataKind === requirement.kind);
    if (!cap) {
      return false; // does not claim this data kind at all
    }
    const offered = cap.trustClass ?? m.trustClass;
    if (!satisfiesTrust(offered, requirement.minimumTrustClass)) {
      rejected.push({
        ref,
        reason: `offers ${offered}, requirement is ${requirement.minimumTrustClass} — a weaker source may not stand in`,
      });
      return false;
    }
    if (m.freshnessSemantics.kind === "unknown") {
      rejected.push({ ref, reason: `cannot report freshness, so it cannot satisfy maxAgeMs=${requirement.maxAgeMs}` });
      return false;
    }
    const typical = m.freshnessSemantics.typicalStalenessMs;
    if (typical !== undefined && typical > requirement.maxAgeMs) {
      rejected.push({ ref, reason: `typical staleness ${typical}ms exceeds maxAgeMs=${requirement.maxAgeMs}` });
      return false;
    }
    if (requirement.confidential && m.executionPlacement !== "cre-confidential") {
      rejected.push({ ref, reason: `requirement is confidential but the adapter runs at ${m.executionPlacement}` });
      return false;
    }
    return true;
  });

  if (compatible.length === 0) {
    return { ok: false, code: "NO_COMPATIBLE_ADAPTER", requirement, rejected };
  }

  const sorted = [...compatible].sort((a, b) => rank(a, b, requirement.kind));
  const chosen = sorted[0]!;
  const cap = chosen.capabilities.find((c) => c.dataKind === requirement.kind);
  const trustClass = cap?.trustClass ?? chosen.trustClass;

  /* A declared fallback is validated now, not at runtime when it is needed and it is too late. */
  let fallback: AdapterSelection["fallback"];
  if (requirement.fallback) {
    const f = requirement.fallback;
    if (!registry.has(f.adapterId, f.adapterVersion)) {
      rejected.push({ ref: `${f.adapterId}@${f.adapterVersion}`, reason: "declared fallback is not registered" });
    } else {
      const fm = registry.resolve(f.adapterId, f.adapterVersion).manifest;
      const fcap = fm.capabilities.find((c) => c.dataKind === requirement.kind);
      const foffered = fcap?.trustClass ?? fm.trustClass;
      if (!satisfiesTrust(foffered, f.allowedTrust)) {
        rejected.push({
          ref: adapterRef(fm),
          reason: `declared fallback offers ${foffered} but the fallback allows only ${f.allowedTrust}`,
        });
      } else {
        fallback = { ...f };
      }
    }
  }

  const rationale =
    `${adapterRef(chosen)} offers ${trustClass} for "${requirement.kind}" on chain ${requirement.chainId}, ` +
    `meeting the required ${requirement.minimumTrustClass} within ${requirement.maxAgeMs}ms` +
    (sorted.length > 1 ? `; ${sorted.length - 1} other compatible candidate(s) ranked lower` : "") +
    (rejected.length > 0 ? `; ${rejected.length} candidate(s) rejected` : "");

  return {
    ok: true,
    selection: {
      key: requirement.key,
      adapterId: chosen.id,
      adapterVersion: chosen.version,
      trustClass,
      rationale,
      ...(fallback ? { fallback } : {}),
    },
    rejected,
  };
}

export class ModelOverrideRejectedError extends Error {
  constructor(readonly suggested: string, readonly reason: string) {
    super(`suggested adapter "${suggested}" was rejected by deterministic resolution: ${reason}`);
    this.name = "ModelOverrideRejectedError";
  }
}

/**
 * Apply a model's suggestion, if and only if it is one the resolver would have accepted anyway.
 *
 * A suggestion is a preference between equals, never permission to break a rule. This is the seam
 * where "Luna may suggest adapters" is implemented, and it is written so that the suggestion cannot
 * widen anything: an incompatible suggestion throws, and a compatible one only reorders a choice
 * that was already legal.
 */
export function resolveWithSuggestion(
  registry: AdapterRegistry,
  requirement: DataRequirement,
  suggested: { adapterId: string; adapterVersion: string } | undefined,
): ResolutionOutcome {
  if (!suggested) return resolveDataRequirement(registry, requirement);

  /*
   * The suggestion is validated BEFORE base resolution, deliberately.
   *
   * The first version checked base resolution first and returned early when nothing was compatible
   * — which meant that in exactly the case where a model is most likely to force a choice (nothing
   * legitimately satisfies the requirement), the suggestion was never examined and the caller saw a
   * bland NO_COMPATIBLE_ADAPTER. Both outcomes are safe, but only one of them says that a specific
   * incompatible adapter was proposed, and that is worth knowing.
   */
  const ref = `${suggested.adapterId}@${suggested.adapterVersion}`;
  if (!registry.has(suggested.adapterId, suggested.adapterVersion)) {
    throw new ModelOverrideRejectedError(ref, "not registered");
  }
  const m = registry.resolve(suggested.adapterId, suggested.adapterVersion).manifest;
  const cap = m.capabilities.find((c) => c.dataKind === requirement.kind);
  const offered = cap?.trustClass ?? m.trustClass;

  if (!cap) throw new ModelOverrideRejectedError(ref, `does not provide "${requirement.kind}"`);
  if (!m.supportedChains.includes(requirement.chainId)) {
    throw new ModelOverrideRejectedError(ref, `does not support chain ${requirement.chainId}`);
  }
  if (!satisfiesTrust(offered, requirement.minimumTrustClass)) {
    throw new ModelOverrideRejectedError(
      ref,
      `offers ${offered} but the requirement is ${requirement.minimumTrustClass}`,
    );
  }
  if (m.freshnessSemantics.kind === "unknown") {
    throw new ModelOverrideRejectedError(ref, "cannot report freshness");
  }
  const typical = m.freshnessSemantics.typicalStalenessMs;
  if (typical !== undefined && typical > requirement.maxAgeMs) {
    throw new ModelOverrideRejectedError(ref, `typical staleness ${typical}ms exceeds maxAgeMs=${requirement.maxAgeMs}`);
  }

  const outcome = resolveDataRequirement(registry, requirement);
  if (!outcome.ok) {
    // The suggestion itself is legal, so a base resolution failure here means the requirement is
    // unsatisfiable for another reason. Report that rather than the suggestion.
    return outcome;
  }

  return {
    ok: true,
    selection: {
      ...outcome.selection,
      adapterId: m.id,
      adapterVersion: m.version,
      trustClass: offered,
      rationale: `${adapterRef(m)} selected on the model's suggestion; it independently satisfies ${requirement.minimumTrustClass} within ${requirement.maxAgeMs}ms`,
    },
    rejected: outcome.rejected,
  };
}

/**
 * Enforce a requirement against an observation at USE time.
 *
 * Selection happens at design time; the world changes by runtime. A correctly-selected
 * VERIFIED_ORACLE adapter can still hand back a value from an hour ago, and this is the check that
 * refuses it.
 */
export function enforceRequirement(
  requirement: DataRequirement,
  obs: { provenance: { trustClass: DataTrustClass; freshnessMs?: number | undefined } },
  usedFallback = false,
): { ok: true } | { ok: false; code: "TRUST" | "STALE"; detail: string } {
  const allowedTrust = usedFallback && requirement.fallback ? requirement.fallback.allowedTrust : requirement.minimumTrustClass;
  const maxAge = usedFallback && requirement.fallback ? requirement.fallback.maxAgeMs : requirement.maxAgeMs;

  if (!satisfiesTrust(obs.provenance.trustClass, allowedTrust)) {
    return { ok: false, code: "TRUST", detail: `${obs.provenance.trustClass} does not satisfy ${allowedTrust}` };
  }
  const age = obs.provenance.freshnessMs;
  if (age === undefined) {
    return { ok: false, code: "STALE", detail: `no freshness information; maxAgeMs=${maxAge} cannot be checked` };
  }
  if (age > maxAge) {
    return { ok: false, code: "STALE", detail: `${age}ms old, limit ${maxAge}ms` };
  }
  return { ok: true };
}
