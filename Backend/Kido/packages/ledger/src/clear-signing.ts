import { readFileSync } from "node:fs";

/**
 * ERC-7730 Clear Signing descriptor handling.
 *
 * IMPORTANT SCOPE NOTE, because this is the single easiest thing in the project to overclaim:
 * writing a descriptor and validating it is NOT the same as a physical Ledger rendering it.
 * This module does the first two. Whether the third is possible is determined empirically and
 * reported honestly — see `CLEAR_SIGNING_STATUS` in reports/phase-07/.
 */

export type Erc7730Descriptor = {
  $schema?: string;
  context: {
    $id: string;
    contract?: { abi: unknown[]; deployments: Array<{ chainId: number; address: string }> };
    eip712?: { domain: Record<string, string>; schemas: Array<{ primaryType: string; types: Record<string, unknown> }> };
  };
  metadata: { owner: string; info?: Record<string, string> };
  display: {
    formats: Record<string, {
      intent: string;
      fields: Array<{ path: string; label: string; format: string; params?: Record<string, unknown> }>;
      required: string[];
      excluded: string[];
    }>;
  };
};

export type ValidationResult = { valid: boolean; errors: string[]; warnings: string[] };

const ALLOWED_FORMATS = new Set([
  "raw", "addressName", "date", "amount", "tokenAmount", "nftName",
  "duration", "unit", "enum", "calldata",
]);

/**
 * Static validation of a descriptor.
 *
 * The check that actually matters for security is the LAST one: every field in the signed EIP-712
 * struct must appear in the display formats. A descriptor that silently omits a material field
 * would show the human a partial transaction, which is worse than showing them opaque hex —
 * they would believe they had seen the whole thing.
 */
export function validateDescriptor(d: Erc7730Descriptor): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!d.context?.$id) errors.push("context.$id is required");
  if (!d.metadata?.owner) errors.push("metadata.owner is required");
  if (!d.display?.formats || Object.keys(d.display.formats).length === 0) {
    errors.push("display.formats must define at least one format");
  }

  const eip712 = d.context?.eip712;
  if (!eip712) {
    warnings.push("no eip712 context: descriptor covers calldata only");
  }

  for (const [name, fmt] of Object.entries(d.display?.formats ?? {})) {
    if (!fmt.intent) errors.push(`format ${name}: intent is required`);
    for (const f of fmt.fields ?? []) {
      if (!f.path) errors.push(`format ${name}: a field is missing path`);
      if (!f.label) errors.push(`format ${name}: field ${f.path} is missing label`);
      if (!ALLOWED_FORMATS.has(f.format)) {
        errors.push(`format ${name}: field ${f.path} uses unknown format "${f.format}"`);
      }
    }

    // Completeness: no material field of the signed struct may be missing from the display.
    const schema = eip712?.schemas?.find((s) => s.primaryType === name);
    if (schema) {
      const structFields = ((schema.types as Record<string, Array<{ name: string }>>)[name] ?? [])
        .map((t) => t.name);
      const shown = new Set((fmt.fields ?? []).map((f) => f.path));
      const missing = structFields.filter((n) => !shown.has(n) && !(fmt.excluded ?? []).includes(n));
      if (missing.length > 0) {
        errors.push(
          `format ${name}: signed fields not displayed: ${missing.join(", ")} — ` +
            `omitting a material field would show the human a partial transaction`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function loadDescriptor(path: string): Erc7730Descriptor {
  return JSON.parse(readFileSync(path, "utf8")) as Erc7730Descriptor;
}

/**
 * The human-readable summary ContextLock expects a Ledger to display.
 *
 * Derived from the SAME values that produce the capability digest, so the display cannot describe
 * one transaction while the signature covers another (LED-007's requirement, carried forward).
 */
export type ApprovalSummary = {
  protocol: string;
  agent: string;
  action: string;
  spend: string;
  destination: string;
  target: string;
  policy: string;
  expiry: string;
  capabilityDigest: string;
};

export function buildApprovalSummary(input: {
  ensName: string;
  actionKind: string;
  amount: bigint;
  tokenSymbol: string;
  tokenDecimals: number;
  recipient: string;
  target: string;
  policyId: string;
  policyVersion: number;
  expiresAt: bigint;
  capabilityDigest: string;
}): ApprovalSummary {
  const whole = input.amount / 10n ** BigInt(input.tokenDecimals);
  const frac = input.amount % 10n ** BigInt(input.tokenDecimals);
  const amountStr = frac === 0n
    ? `${whole} ${input.tokenSymbol}`
    : `${whole}.${frac.toString().padStart(input.tokenDecimals, "0").replace(/0+$/, "")} ${input.tokenSymbol}`;

  return {
    protocol: "ContextLock",
    agent: input.ensName,
    action: input.actionKind,
    spend: amountStr,
    destination: input.recipient,
    target: input.target,
    policy: `${input.policyId.slice(0, 10)}… v${input.policyVersion}`,
    expiry: new Date(Number(input.expiresAt) * 1000).toISOString(),
    capabilityDigest: input.capabilityDigest,
  };
}
