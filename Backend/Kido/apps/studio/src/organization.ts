import {
  ORGANIZATION_SCHEMA_VERSION,
  buildEnsName,
  validateOrganization,
  generateOrgScenarios,
  computeBlastRadius,
  type Organization,
  type OrgAgent,
  type OrgIssue,
  type OrgScenario,
  type BlastRadius,
} from "@contextlock/studio-org";
import type { OrganizationProposal } from "./agents/roles.js";

/**
 * Proposal → Organization.
 *
 * This is pure translation. It reshapes what the model proposed and derives the fields that are
 * mechanically derivable — an ENS name from a label, a policy id and an execution domain from the
 * organization and agent ids. It supplies no financial value of any kind.
 *
 * The distinction matters more than it looks. A derived policy id is a name; a supplied spending
 * limit is a decision the user never made. Where a limit is missing the translation FAILS with a
 * problem code rather than choosing something reasonable, because a reasonable-looking ceiling
 * written into an artifact is indistinguishable from one the user actually chose.
 */

export const ORG_TRANSLATION_PROBLEMS = {
  UNKNOWN_AGGREGATE: "ORG-T-UNKNOWN-AGGREGATE",
  NO_AGENTS: "ORG-T-NO-AGENTS",
  DUP_ID: "ORG-T-DUP-ID",
  MISSING_ROOT: "ORG-T-MISSING-ROOT",
  BAD_ROOT: "ORG-T-BAD-ROOT",
  UNKNOWN_RESOURCE_AGENT: "ORG-T-UNKNOWN-RESOURCE-AGENT",
} as const;

export interface OrgTranslationProblem {
  code: string;
  path: string;
  message: string;
}

export type OrgTranslation =
  | { ok: true; org: Organization }
  | { ok: false; problems: OrgTranslationProblem[] };

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

/**
 * The organization's ENS root.
 *
 * This is the one field the model must never supply from imagination. Every other omission here is
 * a number the user forgot; this one is a NAME, and a plausible-looking guess like `acme.eth` is
 * very likely registered to a stranger. An organization built under someone else's namespace is
 * not a smaller mistake than an invented spending limit — it is a different kind of wrong that
 * looks completely correct in the artifact.
 *
 * So it comes from the user, or the build stops and asks.
 */
export function resolveRootEns(fromUser: string | undefined, fromProposal: string): string {
  return (fromUser ?? "").trim() || fromProposal.trim();
}

export function proposalToOrganization(
  p: OrganizationProposal,
  orgId: string,
  revision = 1,
  rootEnsOverride?: string,
): OrgTranslation {
  const problems: OrgTranslationProblem[] = [];
  const rootEns = resolveRootEns(rootEnsOverride, p.rootEns);

  if (p.agents.length === 0) {
    problems.push({
      code: ORG_TRANSLATION_PROBLEMS.NO_AGENTS,
      path: "agents",
      message: "The proposal contains no agents.",
    });
  }
  if (rootEns === "") {
    // Distinguished from a malformed name on purpose: the two need different things from the user,
    // and "not a usable .eth name" is a confusing thing to say about a name nobody supplied.
    problems.push({
      code: ORG_TRANSLATION_PROBLEMS.MISSING_ROOT,
      path: "rootEns",
      message:
        "No ENS root was given for this organization. Supply the name you already control, e.g. " +
        "\"acme.eth\" — it is not inferred, because a guessed name almost certainly belongs to someone else.",
    });
  } else if (!/^([a-z0-9-]+\.)+eth$/.test(rootEns)) {
    // A subname the user controls (`ops.acme.eth`) is as good a root as `acme.eth`: agents are
    // named beneath it either way, and a department often lives under a company's name.
    problems.push({
      code: ORG_TRANSLATION_PROBLEMS.BAD_ROOT,
      path: "rootEns",
      message: `"${rootEns}" is not a usable .eth name. Expected one or more lowercase labels followed by .eth, e.g. "acme.eth" or "ops.acme.eth".`,
    });
  }

  const seen = new Set<string>();
  for (const a of p.agents) {
    const id = slug(a.id);
    if (seen.has(id)) {
      problems.push({
        code: ORG_TRANSLATION_PROBLEMS.DUP_ID,
        path: `agents.${a.id}`,
        message: `Agent id ${id} appears more than once after normalisation.`,
      });
    }
    seen.add(id);
  }

  // A missing aggregate is not defaulted. The organization-wide ceiling is the only limit an
  // attacker cannot route around by spreading spend across agents, so guessing it is the worst
  // available option.
  for (const [i, lim] of p.aggregateLimits.entries()) {
    if (lim.maxUsdCents === null) {
      problems.push({
        code: ORG_TRANSLATION_PROBLEMS.UNKNOWN_AGGREGATE,
        path: `aggregateLimits[${i}].maxUsdCents`,
        message: `Aggregate limit ${lim.id} has no stated ceiling. It is not inferred.`,
      });
    }
  }

  for (const [i, r] of p.sharedResources.entries()) {
    for (const id of r.agentIds) {
      if (!seen.has(slug(id))) {
        problems.push({
          code: ORG_TRANSLATION_PROBLEMS.UNKNOWN_RESOURCE_AGENT,
          path: `sharedResources[${i}].agentIds`,
          message: `Shared resource ${r.id} names agent ${id}, which the proposal does not define.`,
        });
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  const agentNamespace = `agents.${rootEns}`;
  const agents: OrgAgent[] = p.agents.map((a) => {
    const id = slug(a.id);
    const label = slug(a.ensLabel || a.id);
    return {
      id,
      displayName: a.displayName,
      ensLabel: label,
      ensName: buildEnsName(label, agentNamespace),
      executionClass: a.executionClass,
      executionCapabilities: [...a.executionCapabilities],
      dataCapabilities: [...a.dataCapabilities],
      autonomousMaxUsdCents: a.autonomousMaxUsdCents,
      escalationMaxUsdCents: a.escalationMaxUsdCents,
      dailyMaxUsdCents: a.dailyMaxUsdCents,
      deniedActions: [...a.deniedActions],
      // Derived, not chosen: one nonce domain per agent, so a capability issued to one is not
      // replayable as another.
      executionDomain: `contextlock:org:${orgId}:agent:${id}`,
      policyId: `${orgId}-${id}`,
    };
  });

  return {
    ok: true,
    org: {
      schemaVersion: ORGANIZATION_SCHEMA_VERSION,
      orgId,
      revision,
      rootEns,
      agentNamespace,
      agents,
      sharedResources: p.sharedResources.map((r) => ({
        id: r.id,
        kind: r.kind,
        description: r.description,
        agentIds: r.agentIds.map(slug),
      })),
      aggregateLimits: p.aggregateLimits.map((l) => ({
        id: l.id,
        maxUsdCents: l.maxUsdCents as number, // null was rejected above
        windowMs: l.windowMs,
        description: l.description,
      })),
      communicationRules: p.communicationRules.map((c) => ({
        from: slug(c.from),
        to: slug(c.to),
        messageKinds: c.messageKinds,
      })),
      delegationEnabled: false,
    },
  };
}

/**
 * Reconcile the model's unknowns against what translation actually resolved.
 *
 * The model records an unknown from its own vantage point, before translation runs. Some of those
 * are then genuinely answered — the user supplied the ENS root, and agent labels are derived
 * mechanically from ids. Returning the list verbatim beside `buildable: true` tells the user that
 * something still blocks the build when nothing does, and a list that cries wolf about resolved
 * fields is how a real outstanding one gets skimmed past.
 *
 * Resolved entries are kept and marked rather than deleted: the user should be able to see that the
 * model noticed the gap, and what closed it.
 */
export interface ReconciledUnknown {
  field: string;
  reason: string;
  requiredBefore: "BUILD" | "DEPLOY";
  resolved: boolean;
  resolvedBy?: string;
}

export function reconcileUnknowns(
  unknowns: OrganizationProposal["unknowns"],
  org: Organization,
  rootFromUser: boolean,
): ReconciledUnknown[] {
  const labelFields = new Set(org.agents.map((a) => `${a.id}.ensLabel`));
  return unknowns.map((u) => {
    if (u.field === "rootEns" && rootFromUser) {
      return { ...u, resolved: true, resolvedBy: `supplied by the user: ${org.rootEns}` };
    }
    if (labelFields.has(u.field)) {
      const id = u.field.split(".")[0]!;
      const agent = org.agents.find((a) => a.id === id)!;
      return { ...u, resolved: true, resolvedBy: `derived from the agent id: ${agent.ensName}` };
    }
    return { ...u, resolved: false };
  });
}

export interface OrganizationArtifacts {
  org: Organization;
  issues: OrgIssue[];
  buildable: boolean;
  scenarios: OrgScenario[];
  blastRadii: BlastRadius[];
}

/** Compile an organization into everything the three views need. One model, three projections. */
export function compileOrganization(org: Organization): OrganizationArtifacts {
  const v = validateOrganization(org);
  return {
    org,
    issues: v.issues,
    buildable: v.buildable,
    scenarios: generateOrgScenarios(org),
    // Computed for every agent, because "which one is the dangerous one" is exactly the question
    // a user cannot answer by looking at the diagram.
    blastRadii: org.agents.map((a) => computeBlastRadius(org, a.id)),
  };
}


/**
 * The prompt a member of an organization is built from.
 *
 * An organization is a design: separate principals, each with its own limits and its own name
 * under the root. Building one of them is an ordinary single-agent build, and this is the prompt
 * that build starts from — the member's role in the user's own terms, its limits stated as
 * numbers, and the organization's original description as context so the requirements stage
 * knows which protocol the user meant. Nothing here is inferred: a member whose limit is unknown
 * says "not stated", and the requirements stage records that as UNKNOWN, as it would for any prompt.
 */
export function memberPrompt(org: Organization, agent: OrgAgent, orgPrompt: string): string {
  const usd = (cents: number | null) => (cents === null ? null : `$${(cents / 100).toLocaleString("en-US")}`);
  const auto = usd(agent.autonomousMaxUsdCents);
  const esc = usd(agent.escalationMaxUsdCents);
  const daily = usd(agent.dailyMaxUsdCents);
  const lines = [
    `Build the "${agent.displayName}" agent of my ${org.rootEns} organization, named ${agent.ensName}.`,
    agent.executionCapabilities.length > 0
      ? `It may: ${agent.executionCapabilities.join("; ")}.`
      : "It may not execute anything: it only reads and reports.",
    agent.dataCapabilities.length > 0 ? `It reads: ${agent.dataCapabilities.join("; ")}.` : "",
    agent.executionCapabilities.length > 0
      ? [
          auto ? `Any single action up to ${auto} runs automatically.` : "The autonomous per-action limit was not stated.",
          esc ? `${auto ?? "Above the autonomous limit"} to ${esc} needs my Ledger signature; never exceed ${esc} in one action.` : "The escalation ceiling was not stated.",
          daily ? `At most ${daily} in any rolling day.` : "",
        ].join(" ")
      : "",
    agent.deniedActions.length > 0 ? `Never: ${agent.deniedActions.join("; ")}.` : "",
    `Context — the organization this agent belongs to was described as: "${orgPrompt.trim()}"`,
  ];
  return lines.filter((l) => l.trim().length > 0).join(" ");
}
