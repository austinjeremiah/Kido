import { keccak256, toHex } from "viem";
import type { KidoAgentBlueprint } from "./schema.js";

/** Deterministic serialization: keys sorted at every level, bigint rejected (use decimal strings). */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("BLUEPRINT-NONFINITE");
      return v;
    }
    if (typeof v === "bigint") throw new Error("BLUEPRINT-BIGINT: encode integers as decimal strings");
    if (v === undefined) return undefined;
    if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : walk(x)));
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const w = walk((v as Record<string, unknown>)[k]);
        if (w !== undefined) out[k] = w;
      }
      return out;
    }
    throw new Error(`BLUEPRINT-UNSERIALIZABLE: ${typeof v}`);
  };
  return JSON.stringify(walk(value));
}

export function blueprintHash(bp: KidoAgentBlueprint): `0x${string}` {
  return keccak256(toHex(canonicalJson(bp)));
}
