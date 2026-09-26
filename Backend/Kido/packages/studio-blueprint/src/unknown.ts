import { z } from "zod";

/**
 * The single most important type in the Studio.
 *
 * A financial parameter is either KNOWN with a value and a stated source, or it is explicitly
 * UNKNOWN. There is no third state, and in particular there is no "absent" state that a reader
 * could mistake for a default.
 *
 * This exists because the model is asked to extract financial permissions from prose, and the
 * failure mode that actually costs money is not a wrong number — it is an *invented* number that
 * looks like it came from the user. A missing spending limit that silently becomes `0` reads as
 * "deny everything" and is merely broken; one that silently becomes `Infinity`, or that inherits a
 * template default, is a compromised agent with a plausible-looking blueprint.
 *
 * Forcing the model to emit `{ known: false }` makes the omission a first-class value the
 * deterministic validator can refuse to build on. The model can still lie — it can claim `known:
 * true` for something the user never said — but it can no longer omit its way into an invented
 * permission, and `sourceQuote` makes the lie checkable against the original prompt.
 */
export const KnownValueSchema = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({
    known: z.literal(true),
    value: inner,
    /**
     * The span of the user's own prompt this value came from. Not decorative: the Studio shows it
     * next to the number in the review UI so a human can see whether they actually said it.
     */
    sourceQuote: z.string().min(1).max(500),
  });

export const UnknownValueSchema = z.object({
  known: z.literal(false),
  /** Why it is unknown, in words a user can act on. */
  reason: z.string().min(1).max(500),
  /**
   * When this must be resolved. BUILD-required unknowns block code generation entirely;
   * DEPLOY-required ones may be built around and resolved before the agent touches money.
   */
  requiredBefore: z.enum(["BUILD", "DEPLOY"]),
});

export const MaybeUnknown = <T extends z.ZodTypeAny>(inner: T) =>
  z.discriminatedUnion("known", [KnownValueSchema(inner), UnknownValueSchema]);

export type Known<T> = { known: true; value: T; sourceQuote: string };
export type UnknownValue = { known: false; reason: string; requiredBefore: "BUILD" | "DEPLOY" };
export type Maybe<T> = Known<T> | UnknownValue;

export function isKnown<T>(m: Maybe<T>): m is Known<T> {
  return m.known === true;
}

/** Reads a value, or throws. Callers that must not proceed on an unknown use this deliberately. */
export function requireKnown<T>(m: Maybe<T>, field: string): T {
  if (!isKnown(m)) {
    throw new Error(`blueprint field "${field}" is UNKNOWN and must be resolved: ${m.reason}`);
  }
  return m.value;
}

/** Every UNKNOWN that blocks a build, with its path. */
export function collectBuildBlockingUnknowns(
  value: unknown,
  path: string[] = [],
): Array<{ path: string; reason: string }> {
  const out: Array<{ path: string; reason: string }> = [];
  const walk = (node: unknown, p: string[]): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, [...p, String(i)]));
      return;
    }
    const rec = node as Record<string, unknown>;
    if (rec.known === false && typeof rec.reason === "string") {
      if (rec.requiredBefore === "BUILD") out.push({ path: p.join("."), reason: rec.reason });
      return;
    }
    for (const [k, v] of Object.entries(rec)) walk(v, [...p, k]);
  };
  walk(value, path);
  return out;
}
