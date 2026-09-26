import { OrganizationSchema, type Organization, type OrgAgent, buildEnsName } from "./schema.js";

/**
 * Deterministic organization validation.
 *
 * The failure mode this exists to prevent is subtle and common: an "organization" that is really
 * one principal wearing several names. Shared policies, a shared execution domain, a shared
 * credential, or an aggregate limit larger than the sum of its parts all collapse the separation
 * back into a single blast radius while leaving the diagram looking like a hierarchy.
 *
 * Every check below is ordinary code with an exact reason code, because a negative test that
 * cannot name why it failed is not evidence of anything.
 */

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export interface OrgIssue {
  code: string;
  severity: Severity;
  path: string;
  message: string;
  remediation: string;
}

export interface OrgValidationResult {
  ok: boolean;
  /** True only when nothing CRITICAL or HIGH remains. */
  buildable: boolean;
  issues: OrgIssue[];
}

const issue = (
  code: string,
  severity: Severity,
  path: string,
  message: string,
  remediation: string,
): OrgIssue => ({ code, severity, path, message, remediation });

/** Capabilities that move value. An agent holding one is an executing principal, whatever it is called. */
const VALUE_MOVING = /withdraw|borrow|transfer|send|swap|approve|repay|supply|execute/i;

export function validateOrganization(input: unknown): OrgValidationResult {
  const parsed = OrganizationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      buildable: false,
      issues: parsed.error.issues.map((e) =>
        issue(
          "ORG-SCHEMA",
          "CRITICAL",
          e.path.join("."),
          e.message,
          "Correct the organization document to match contextlock.organization/v1.",
        ),
      ),
    };
  }
  const org: Organization = parsed.data;
  const issues: OrgIssue[] = [];
  const ids = new Set(org.agents.map((a) => a.id));

  /* ── namespace and identity ──────────────────────────────────────────────
   * ENS here carries identity, namespace, lifecycle and revocation. It carries no financial
   * authority — that stays in the ContextLock policy each agent points at. */

  if (!org.agentNamespace.endsWith(`.${org.rootEns}`)) {
    issues.push(
      issue(
        "ORG-V-NAMESPACE-ROOT",
        "HIGH",
        "agentNamespace",
        `Agent namespace ${org.agentNamespace} is not under the organization root ${org.rootEns}.`,
        `Use a subname of ${org.rootEns}, e.g. agents.${org.rootEns}.`,
      ),
    );
  }

  const seenId = new Map<string, number>();
  const seenEns = new Map<string, number>();
  const seenDomain = new Map<string, number>();
  const seenPolicy = new Map<string, number>();

  org.agents.forEach((a, i) => {
    const p = `agents[${i}]`;

    if (seenId.has(a.id)) {
      issues.push(
        issue(
          "ORG-V-DUP-AGENT-ID",
          "CRITICAL",
          `${p}.id`,
          `Agent id ${a.id} is used more than once (also agents[${seenId.get(a.id)}]).`,
          "Give every agent a distinct id; ids key attribution and revocation.",
        ),
      );
    } else seenId.set(a.id, i);

    const expected = buildEnsName(a.ensLabel, org.agentNamespace);
    if (a.ensName !== expected) {
      issues.push(
        issue(
          "ORG-V-ENS-MISMATCH",
          "HIGH",
          `${p}.ensName`,
          `Declared ENS name ${a.ensName} does not match ${expected} derived from the label and namespace.`,
          `Set ensName to ${expected}, or change the label.`,
        ),
      );
    }
    if (a.ensName === org.rootEns || a.ensName === org.agentNamespace) {
      issues.push(
        issue(
          "ORG-V-ROOT-IDENTITY",
          "CRITICAL",
          `${p}.ensName`,
          `Agent ${a.id} holds the organization name ${a.ensName} as its own identity.`,
          "The root and the agent namespace are the organization, not a principal. Give the agent a subname.",
        ),
      );
    }
    if (seenEns.has(a.ensName)) {
      issues.push(
        issue(
          "ORG-V-DUP-ENS",
          "CRITICAL",
          `${p}.ensName`,
          `ENS identity ${a.ensName} is shared with agents[${seenEns.get(a.ensName)}].`,
          "Two agents sharing one identity cannot be revoked or attributed separately.",
        ),
      );
    } else seenEns.set(a.ensName, i);

    /* ── separation of principals ──────────────────────────────────────────
     * A shared policy or a shared execution domain is the whole compromise: one capability then
     * works as another agent, and revoking one revokes or spares both. */

    if (seenPolicy.has(a.policyId)) {
      issues.push(
        issue(
          "ORG-V-SHARED-POLICY",
          "CRITICAL",
          `${p}.policyId`,
          `Agent ${a.id} shares policy ${a.policyId} with agents[${seenPolicy.get(a.policyId)}].`,
          "Give each agent its own policy. A shared policy makes them one principal with two names.",
        ),
      );
    } else seenPolicy.set(a.policyId, i);

    if (seenDomain.has(a.executionDomain)) {
      issues.push(
        issue(
          "ORG-V-SHARED-DOMAIN",
          "CRITICAL",
          `${p}.executionDomain`,
          `Agent ${a.id} shares execution domain ${a.executionDomain} with agents[${seenDomain.get(a.executionDomain)}].`,
          "Distinct domains keep a capability issued to one agent unusable as another.",
        ),
      );
    } else seenDomain.set(a.executionDomain, i);

    /* ── execution class ───────────────────────────────────────────────────
     * A reporting agent must be unable to transact, not merely unlikely to. */

    if (a.executionClass !== "EXECUTE" && a.executionCapabilities.length > 0) {
      issues.push(
        issue(
          "ORG-V-NONEXEC-HAS-EXECUTION",
          "CRITICAL",
          `${p}.executionCapabilities`,
          `Agent ${a.id} is ${a.executionClass} but holds execution capabilities: ${a.executionCapabilities.join(", ")}.`,
          "Remove the capabilities, or declare the agent EXECUTE and give it explicit limits.",
        ),
      );
    }
    const valueMoving = a.dataCapabilities.filter((c) => VALUE_MOVING.test(c));
    if (a.executionClass !== "EXECUTE" && valueMoving.length > 0) {
      issues.push(
        issue(
          "ORG-V-VALUE-CAP-MISCLASSED",
          "HIGH",
          `${p}.dataCapabilities`,
          `Agent ${a.id} lists value-moving capability ${valueMoving.join(", ")} among its DATA capabilities.`,
          "Value-moving capabilities are execution capabilities and require executionClass EXECUTE.",
        ),
      );
    }

    /* ── limits ────────────────────────────────────────────────────────────
     * An unspecified financial boundary stays UNKNOWN. It is never filled in with something
     * reasonable-looking, because a plausible invented ceiling is indistinguishable from a real
     * one once it is written down. */

    if (a.executionClass === "EXECUTE") {
      for (const [field, v] of [
        ["autonomousMaxUsdCents", a.autonomousMaxUsdCents],
        ["escalationMaxUsdCents", a.escalationMaxUsdCents],
        ["dailyMaxUsdCents", a.dailyMaxUsdCents],
      ] as const) {
        if (v === null) {
          issues.push(
            issue(
              "ORG-V-UNKNOWN-LIMIT",
              "HIGH",
              `${p}.${field}`,
              `Agent ${a.id} may execute but ${field} is unknown.`,
              "State the limit explicitly. It is not inferred and it does not default to unlimited.",
            ),
          );
        }
      }
      if (
        a.autonomousMaxUsdCents !== null &&
        a.escalationMaxUsdCents !== null &&
        a.escalationMaxUsdCents < a.autonomousMaxUsdCents
      ) {
        issues.push(
          issue(
            "ORG-V-BAND-INVERTED",
            "HIGH",
            `${p}.escalationMaxUsdCents`,
            `Agent ${a.id} has an escalation ceiling (${a.escalationMaxUsdCents}) below its autonomous limit (${a.autonomousMaxUsdCents}).`,
            "The escalation ceiling is the outer bound; it must be at or above the autonomous limit.",
          ),
        );
      }
      if (
        a.dailyMaxUsdCents !== null &&
        a.autonomousMaxUsdCents !== null &&
        a.dailyMaxUsdCents < a.autonomousMaxUsdCents
      ) {
        issues.push(
          issue(
            "ORG-V-DAILY-BELOW-SINGLE",
            "MEDIUM",
            `${p}.dailyMaxUsdCents`,
            `Agent ${a.id} has a daily cap (${a.dailyMaxUsdCents}) below a single autonomous action (${a.autonomousMaxUsdCents}).`,
            "Either raise the daily cap or lower the per-action limit; as written the per-action limit is unreachable.",
          ),
        );
      }
    }
  });

  /* ── shared resources ────────────────────────────────────────────────── */

  org.sharedResources.forEach((r, i) => {
    r.agentIds.forEach((id) => {
      if (!ids.has(id)) {
        issues.push(
          issue(
            "ORG-V-RESOURCE-UNKNOWN-AGENT",
            "HIGH",
            `sharedResources[${i}].agentIds`,
            `Shared resource ${r.id} references unknown agent ${id}.`,
            "Reference an agent declared in this organization.",
          ),
        );
      }
    });
    if (r.kind === "credential" && r.agentIds.length > 1) {
      issues.push(
        issue(
          "ORG-V-SHARED-CREDENTIAL",
          "CRITICAL",
          `sharedResources[${i}]`,
          `Credential ${r.id} is shared by ${r.agentIds.length} agents.`,
          "A shared credential is a shared principal. Issue one per agent, or broker it so no agent holds it.",
        ),
      );
    }
  });

  /* ── aggregate limits ─────────────────────────────────────────────────── */

  const treasuries = org.sharedResources.filter((r) => r.kind === "treasury");
  const executors = org.agents.filter((a) => a.executionClass === "EXECUTE");

  if (treasuries.length > 0 && org.aggregateLimits.length === 0 && executors.length > 1) {
    issues.push(
      issue(
        "ORG-V-AGGREGATE-MISSING",
        "CRITICAL",
        "aggregateLimits",
        `${executors.length} executing agents draw on a shared treasury with no aggregate limit.`,
        "Add an organization-wide cap. Without one the exposure is the sum of every agent's limit.",
      ),
    );
  }

  const dailyCaps = executors.map((a) => a.dailyMaxUsdCents);
  if (dailyCaps.every((v): v is number => v !== null)) {
    const sum = dailyCaps.reduce((a, b) => a + b, 0);
    for (const [i, lim] of org.aggregateLimits.entries()) {
      if (lim.maxUsdCents >= sum && executors.length > 1) {
        // Not an error in the abstract, but this aggregate binds nothing: every agent could spend
        // its own maximum and never reach it, which is exactly what the user believes it prevents.
        issues.push(
          issue(
            "ORG-V-AGGREGATE-VACUOUS",
            "MEDIUM",
            `aggregateLimits[${i}].maxUsdCents`,
            `Aggregate cap ${lim.maxUsdCents} is at or above the sum of per-agent daily caps (${sum}), so it can never bind.`,
            "Set the aggregate below the sum, or state plainly that per-agent limits are the only real bound.",
          ),
        );
      }
    }
  }

  /* ── communication ────────────────────────────────────────────────────── */

  org.communicationRules.forEach((c, i) => {
    for (const [field, id] of [["from", c.from], ["to", c.to]] as const) {
      if (!ids.has(id)) {
        issues.push(
          issue(
            "ORG-V-COMM-UNKNOWN-AGENT",
            "HIGH",
            `communicationRules[${i}].${field}`,
            `Communication rule references unknown agent ${id}.`,
            "Reference an agent declared in this organization.",
          ),
        );
      }
    }
    if (c.from === c.to) {
      issues.push(
        issue(
          "ORG-V-COMM-SELF",
          "LOW",
          `communicationRules[${i}]`,
          `Agent ${c.from} has a communication rule to itself.`,
          "Remove it; it describes nothing.",
        ),
      );
    }
  });

  const critical = issues.some((i) => i.severity === "CRITICAL");
  const high = issues.some((i) => i.severity === "HIGH");
  return { ok: issues.length === 0, buildable: !critical && !high, issues };
}

/** Agents that may move value. Used by the blast-radius model and the budget ledger. */
export const executingAgents = (org: Organization): OrgAgent[] =>
  org.agents.filter((a) => a.executionClass === "EXECUTE");
