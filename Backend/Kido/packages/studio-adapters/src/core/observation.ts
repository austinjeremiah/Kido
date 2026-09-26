import { z } from "zod";
import { DataTrustClassSchema, type DataTrustClass } from "./trust.js";

/**
 * The only shape in which data may enter a policy decision.
 *
 * Provenance is not metadata attached for tidiness. A bare number cannot be checked against a
 * requirement: "is this fresh enough" and "is this trusted enough" are unanswerable without knowing
 * where it came from and when. Making provenance mandatory means an adapter that cannot say where a
 * value came from cannot return one — the alternative is a value that silently satisfies a
 * requirement it was never checked against.
 */
export const ProvenanceSchema = z.object({
  provider: z.string().min(1),
  adapterId: z.string().min(1),
  adapterVersion: z.string().min(1),
  trustClass: DataTrustClassSchema,
  /** When the SOURCE says the value was true — not when we asked. */
  sourceTimestamp: z.string().optional(),
  /** ms between the source timestamp and observation. Absent when the source gives no timestamp. */
  freshnessMs: z.number().int().nonnegative().optional(),
  chainId: z.number().int().positive().optional(),
  blockNumber: z.string().optional(),
  /** Indexer's block vs chain head, when the adapter can measure both. */
  indexedBlock: z.string().optional(),
  chainHeadBlock: z.string().optional(),
  blockLag: z.number().int().nonnegative().optional(),
  feedId: z.string().optional(),
  subgraphId: z.string().optional(),
  requestId: z.string().optional(),
  /** Hash of the raw response, so a normalized value can be tied back to what was received. */
  rawCommitment: z.string().optional(),
  verification: z.object({
    verified: z.boolean(),
    mechanism: z.string().optional(),
  }),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const DataObservationSchema = z.object({
  observationId: z.string().min(1),
  dataKind: z.string().min(1),
  subject: z.string().optional(),
  /** Integer base units as a string. Never a float — a price is not a JS number. */
  value: z.string(),
  unit: z.string(),
  decimals: z.number().int().min(0).max(36),
  observedAt: z.string(),
  provenance: ProvenanceSchema,
});
export type DataObservation = z.infer<typeof DataObservationSchema>;

/**
 * The set of observations a decision was made over, committed as one unit.
 *
 * Individually-fresh values can still be mutually inconsistent — a price from one block and a
 * position from another describe a world that never existed. The bundle hash is what a capability
 * binds so the decision can be tied to exactly the inputs it saw.
 */
export interface ContextBundle {
  bundleId: string;
  observations: DataObservation[];
  normalizedHash: string;
  createdAt: string;
}

/** FNV-1a over a canonical form. Deterministic, dependency-free, order-independent. */
export function commitObservations(observations: DataObservation[]): string {
  const canon = observations
    .map((o) =>
      JSON.stringify({
        k: o.dataKind,
        s: o.subject ?? "",
        v: o.value,
        u: o.unit,
        d: o.decimals,
        t: o.provenance.sourceTimestamp ?? o.observedAt,
        a: `${o.provenance.adapterId}@${o.provenance.adapterVersion}`,
        c: o.provenance.trustClass,
      }),
    )
    .sort()
    .join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) {
    h ^= canon.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `0x${h.toString(16).padStart(8, "0")}`;
}

export function makeBundle(observations: DataObservation[], createdAt = new Date().toISOString()): ContextBundle {
  return {
    bundleId: `ctx_${commitObservations(observations).slice(2)}`,
    observations,
    normalizedHash: commitObservations(observations),
    createdAt,
  };
}

export class MissingProvenanceError extends Error {
  constructor(readonly adapterId: string, detail: string) {
    super(`adapter "${adapterId}" returned a value without usable provenance: ${detail}`);
    this.name = "MissingProvenanceError";
  }
}

/**
 * Gate every observation before it reaches a policy.
 *
 * Fails closed on a malformed observation rather than passing a partially-valid one through. An
 * adapter is code that talks to a third party; the third party is not trusted, and neither is the
 * adapter's marshalling of it.
 */
export function assertUsableObservation(o: unknown, adapterId: string): DataObservation {
  const parsed = DataObservationSchema.safeParse(o);
  if (!parsed.success) {
    throw new MissingProvenanceError(adapterId, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const obs = parsed.data;
  if (obs.provenance.adapterId !== adapterId) {
    // An observation claiming a different adapter's identity would let a weak source inherit a
    // strong source's trust class downstream.
    throw new MissingProvenanceError(
      adapterId,
      `provenance claims adapterId "${obs.provenance.adapterId}"`,
    );
  }
  return obs;
}

export class StaleObservationError extends Error {
  constructor(readonly ageMs: number | undefined, readonly maxAgeMs: number, readonly dataKind: string) {
    super(
      ageMs === undefined
        ? `observation "${dataKind}" carries no freshness information and cannot satisfy maxAgeMs=${maxAgeMs}`
        : `observation "${dataKind}" is ${ageMs}ms old, limit is ${maxAgeMs}ms`,
    );
    this.name = "StaleObservationError";
  }
}

export class TrustDowngradeError extends Error {
  constructor(readonly offered: DataTrustClass, readonly required: DataTrustClass, readonly dataKind: string) {
    super(`"${dataKind}" requires ${required} but the value is ${offered}; a weaker source may not stand in`);
    this.name = "TrustDowngradeError";
  }
}
