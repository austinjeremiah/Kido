import type { Ctx } from "./catalog.js";

/** Credential shapes a user might paste into the interview. Such text is never stored or sent to a model. */
const SECRET_LIKE: RegExp[] = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bsuiprivkey1[0-9a-z]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:private|secret|signing|deployer)[ _-]?key\b\W{0,5}(?:0x)?[0-9a-fA-F]{64}\b/gi,
  /\b(?:api[ _-]?key|token|password|secret|credential)s?\b\s*(?:is|=|:)\s*[`'"]?[A-Za-z0-9_\-./+=]{12,}/gi,
];

export function redactSecrets(text: string): { text: string; found: boolean } {
  let found = false;
  let out = text;
  for (const re of SECRET_LIKE) out = out.replace(re, () => ((found = true), "[redacted credential]"));
  return { text: out, found };
}

/** A declared private threshold means the number itself must never enter Kido or a model. */
export function privateThresholdDeclared(ctx: Ctx): boolean {
  return ctx["privacy.required"] === true && ((ctx["privacy.values"] as { kind: string }[] | undefined) ?? []).some((v) => v.kind === "PRIVATE_POLICY");
}

/** Removes numeric values (the private level) while keeping the rest of the sentence readable. */
export function redactNumbers(text: string): string {
  return text.replace(/\d+(?:[.,]\d+)?\s*%?/g, "[private]");
}
