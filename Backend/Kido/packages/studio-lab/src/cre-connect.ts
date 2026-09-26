import { z } from "zod";
import { NEVER_REQUESTED, CreLabError, CRE_LAB_REASONS, type CreConnectionInfo } from "./cre-lab.js";

/**
 * Connecting a Chainlink CRE account, and proving a promoted workflow decides the same way.
 *
 * §P28.15 describes a flow whose security property is an absence: ContextLock never sees the
 * credential. The way to make an absence legible is to name the steps and say, at each one, what
 * moves — so the screen shows a path with no step on which a password could be typed into
 * ContextLock, rather than a reassuring sentence claiming the same thing.
 */

/* ─────────────────────────── the connect flow ─────────────────────────── */

export const CONNECT_STEP_KINDS = ["CONTEXTLOCK", "LOCAL_BRIDGE", "CRE_CLI", "CHAINLINK_BROWSER"] as const;
export const ConnectStepKindSchema = z.enum(CONNECT_STEP_KINDS);
export type ConnectStepKind = z.infer<typeof ConnectStepKindSchema>;

export const ConnectStepSchema = z.object({
  kind: ConnectStepKindSchema,
  label: z.string().min(1),
  /** What this step does. Plain, and specific enough to be checkable. */
  detail: z.string().min(1),
  /** What crosses the boundary at this step, or the fact that nothing does. */
  carries: z.string().min(1),
  /** The bridge operation, where there is one. Named so a reader can find it in the vocabulary. */
  bridgeOperation: z.string().nullable(),
});
export type ConnectStep = z.infer<typeof ConnectStepSchema>;

export interface ConnectFlow {
  steps: ConnectStep[];
  /** Things ContextLock never asks for. Rendered, not implied. */
  neverRequested: ReadonlyArray<string>;
  /** Where the credential lives at the end of the flow. */
  credentialLocation: "local user CRE directory";
  /** The whole point, stated once. */
  claim: string;
}

/**
 * The steps, for an account that is already authenticated or one that is not.
 *
 * The unauthenticated path is longer by two steps and both of them happen off ContextLock: the CLI
 * opens Chainlink's own browser login and writes the session to the user's own machine. That is why
 * `cre login` appears here as a step someone else performs rather than a form this product renders.
 */
export function connectFlow(authenticated: boolean): ConnectFlow {
  const steps: ConnectStep[] = [
    {
      kind: "CONTEXTLOCK",
      label: "ContextLock asks for CRE status",
      detail: "The hosted side sends one named request. There is no operation in the bridge vocabulary that returns a credential, so this cannot ask for one.",
      carries: "a request id and the operation name — nothing else leaves ContextLock",
      bridgeOperation: "cre.status",
    },
    {
      kind: "LOCAL_BRIDGE",
      label: "The Local Bridge runs it on your machine",
      detail: "The bridge runs on the machine that holds the CRE session and executes only operations from a closed list.",
      carries: "nothing inbound; the bridge holds the session and does not forward it",
      bridgeOperation: "cre.status",
    },
    {
      kind: "CRE_CLI",
      label: "cre whoami",
      detail: "The official CLI answers from the local session file. ContextLock never reads that file and never receives its contents.",
      carries: "organization, registries, CLI version, deploy access — status fields, never the session",
      bridgeOperation: null,
    },
  ];

  if (!authenticated) {
    steps.splice(2, 0,
      {
        kind: "CRE_CLI",
        label: "cre login",
        detail: "The CLI opens Chainlink's own browser login. ContextLock is not in this exchange and cannot be.",
        carries: "your credentials, from your browser to Chainlink — not through ContextLock",
        bridgeOperation: null,
      },
      {
        kind: "CHAINLINK_BROWSER",
        label: "Chainlink stores the session locally",
        detail: "The CLI writes the session under your own CRE directory. It stays there for the life of the connection.",
        carries: "a session file, written to your machine and read only by the CLI",
        bridgeOperation: null,
      },
    );
  }

  return {
    steps,
    neverRequested: NEVER_REQUESTED,
    credentialLocation: "local user CRE directory",
    claim: "ContextLock learns whether you have a CRE account and what it is allowed to do. It never learns how to be you.",
  };
}

/**
 * The CRE account panel, §P28.17.
 *
 * Every field comes from the connection payload rather than from a stored profile, and
 * `deployAccess: null` renders as UNKNOWN rather than as NOT ENABLED — an unread field and a read
 * field that said no are different facts, and only one of them is worth acting on.
 */
export interface CreAccountView {
  connected: "YES" | "NO";
  organization: string;
  deployAccess: "ENABLED" | "NOT ENABLED" | "UNKNOWN";
  registries: string[];
  simulation: "AVAILABLE" | "UNAVAILABLE";
  cliVersion: string;
  credentialLocation: "local user CRE directory";
  /** Present when deploy access is absent — a complete state, not an error. §P28.18. */
  note: string | null;
}

export function creAccountView(connection: CreConnectionInfo): CreAccountView {
  const deployAccess = connection.deployAccess === null ? "UNKNOWN" : connection.deployAccess ? "ENABLED" : "NOT ENABLED";
  return {
    connected: connection.connected ? "YES" : "NO",
    organization: connection.organizationName ?? connection.organizationId ?? "—",
    deployAccess,
    registries: [...connection.registries],
    simulation: connection.connected ? "AVAILABLE" : "UNAVAILABLE",
    cliVersion: connection.cliVersion ?? "unknown",
    credentialLocation: connection.credentialLocation,
    note: deployAccess === "ENABLED"
      ? null
      : "Your agent is running with the official CRE simulator. Real DON deployment is optional and requires Chainlink CRE Deploy Access.",
  };
}

/**
 * Refuse any input field that would mean ContextLock asked for a credential.
 *
 * §P28.15's rule expressed where it can actually be enforced. `assertNoCreSession` covers payloads
 * leaving; this covers a form arriving, which is the other direction and the one a well-meaning
 * "let the user paste their token" feature would take.
 */
export function assertNotCredentialIntake(fieldNames: ReadonlyArray<string>, context: string): void {
  const bad = fieldNames.filter((f) =>
    /password|otp|mfa|seed|mnemonic|sessiontoken|session_token|apikey|api_key|cre\.?ya?ml/i.test(f),
  );
  if (bad.length > 0) {
    throw new CreLabError(
      CRE_LAB_REASONS.SESSION_EXPORTED,
      `${context}: a connect form with ${bad.map((b) => `"${b}"`).join(", ")} asks the user for a credential. ContextLock never requests ${NEVER_REQUESTED.join(", ")} — the CLI's own browser login does, on the user's machine.`,
    );
  }
}

/* ─────────────────────────── promotion parity ─────────────────────────── */

/**
 * The five P26 fixtures, reused rather than re-invented.
 *
 * §P28.24 names them, and the reason to reuse the deterministic set is that its expected verdicts
 * were established when the simulator was the only implementation. A parity suite whose expectations
 * were written after seeing the deployed workflow's output would agree with whatever it produced.
 */
export const PARITY_FIXTURES = [
  { id: "ALLOW_POLICY_MATCH", description: "A repayment inside the autonomous limit, fresh context", expectedVerdict: "ALLOW" as const, expectedReason: "ALLOW_POLICY_MATCH", expectedRisk: "LOW" },
  { id: "ESCALATE_AMOUNT", description: "A repayment above the autonomous limit and below the hard cap", expectedVerdict: "ESCALATE" as const, expectedReason: "ESCALATE_AMOUNT", expectedRisk: "MEDIUM" },
  { id: "DENY_AMOUNT_TOO_HIGH", description: "A repayment above the hard cap", expectedVerdict: "DENY" as const, expectedReason: "DENY_AMOUNT_TOO_HIGH", expectedRisk: "HIGH" },
  { id: "ESCALATE_RISK", description: "Inside the limit, but volatility is elevated", expectedVerdict: "ESCALATE" as const, expectedReason: "ESCALATE_RISK", expectedRisk: "HIGH" },
  { id: "DENY_SLIPPAGE", description: "A swap whose slippage exceeds the configured bound", expectedVerdict: "DENY" as const, expectedReason: "DENY_SLIPPAGE", expectedRisk: "HIGH" },
] as const;
export type ParityFixtureId = (typeof PARITY_FIXTURES)[number]["id"];

/** The four fields parity is about. §P28.24 — a semantic decision, not a byte comparison. */
export const PARITY_COMPARED_FIELDS = ["verdict", "reasonCode", "riskClass", "publicOutput"] as const;

/**
 * Fields deliberately NOT compared.
 *
 * §P28.24: "Do not require identical provider timestamps/internal metadata." Enumerated rather than
 * left implicit, so a future field is a decision someone makes rather than a difference that
 * silently starts failing every parity run.
 */
export const PARITY_IGNORED_FIELDS = ["timestamp", "observedAtMs", "requestId", "executionId", "donId", "nodeId", "latencyMs", "providerTimestamp"] as const;

export const ParityOutcomeSchema = z.object({
  verdict: z.enum(["ALLOW", "ESCALATE", "DENY"]),
  reasonCode: z.string().min(1),
  riskClass: z.string().min(1),
  publicOutput: z.string(),
});
export type ParityOutcome = z.infer<typeof ParityOutcomeSchema>;

export interface ParityRow {
  fixture: string;
  description: string;
  simulator: ParityOutcome | null;
  deployed: ParityOutcome | null;
  /** Every field that differs, named. A row reporting only the first sends someone round twice. */
  differences: string[];
  match: boolean;
  /** Set when one side did not run. Distinct from a mismatch, and it must not read as a pass. */
  notRun: "SIMULATOR" | "DEPLOYED" | "BOTH" | null;
}

export interface ParityResult {
  rows: ParityRow[];
  matched: number;
  total: number;
  /** True only when every fixture ran on both sides and agreed. */
  semanticParity: boolean;
  comparedFields: ReadonlyArray<string>;
  ignoredFields: ReadonlyArray<string>;
}

export const PARITY_REASONS = {
  MISMATCH: "CRE_PROMOTION_PARITY_MISMATCH",
  INCOMPLETE: "CRE_PROMOTION_PARITY_INCOMPLETE",
} as const;

/**
 * Parity failures get their own error type.
 *
 * Not a `CreLabError` with a new reason bolted into that union: a parity mismatch is a statement
 * about two implementations disagreeing, and widening the CRE reason enum to fit it would let a
 * `catch` written for connection failures swallow it.
 */
export class ParityError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "ParityError";
  }
}

/**
 * Compare the simulator against the deployed workflow, fixture by fixture.
 *
 * A fixture that ran on only one side is `notRun`, never a match. Treating a missing deployed
 * result as agreement is exactly how a parity suite comes to certify a workflow that was never
 * invoked.
 */
export function parityRun(
  simulator: Partial<Record<string, ParityOutcome>>,
  deployed: Partial<Record<string, ParityOutcome>>,
): ParityResult {
  const rows: ParityRow[] = PARITY_FIXTURES.map((f) => {
    const s = simulator[f.id] ?? null;
    const d = deployed[f.id] ?? null;
    const notRun = s === null && d === null ? "BOTH" : s === null ? "SIMULATOR" : d === null ? "DEPLOYED" : null;
    const differences: string[] = [];
    if (s !== null && d !== null) {
      for (const field of PARITY_COMPARED_FIELDS) {
        if (s[field] !== d[field]) differences.push(`${field}: simulator ${JSON.stringify(s[field])}, deployed ${JSON.stringify(d[field])}`);
      }
    }
    return {
      fixture: f.id,
      description: f.description,
      simulator: s,
      deployed: d,
      differences,
      match: notRun === null && differences.length === 0,
      notRun,
    };
  });

  const matched = rows.filter((r) => r.match).length;
  return {
    rows,
    matched,
    total: rows.length,
    semanticParity: matched === rows.length,
    comparedFields: PARITY_COMPARED_FIELDS,
    ignoredFields: PARITY_IGNORED_FIELDS,
  };
}

/**
 * The gate §P28.24 describes: parity before DEPLOYED_USER becomes authoritative.
 *
 * Called before a mode switch rather than after it, because a workflow that is already
 * authoritative is one that is already deciding.
 */
export function assertParityBeforeAuthoritative(result: ParityResult, context: string): void {
  const incomplete = result.rows.filter((r) => r.notRun !== null);
  if (incomplete.length > 0) {
    throw new ParityError(
      PARITY_REASONS.INCOMPLETE,
      `${context}: ${incomplete.length} of ${result.total} parity fixtures did not run on both sides (${incomplete.map((r) => `${r.fixture}:${r.notRun}`).join(", ")}). A fixture that ran on one side is not agreement.`,
    );
  }
  const mismatched = result.rows.filter((r) => !r.match);
  if (mismatched.length > 0) {
    throw new ParityError(
      PARITY_REASONS.MISMATCH,
      `${context}: the deployed workflow decides differently from the simulator on ${mismatched.map((r) => r.fixture).join(", ")}. ${mismatched.flatMap((r) => r.differences).join("; ")}`,
    );
  }
}
