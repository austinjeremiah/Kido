import {
  ContextLockAgentBlueprintSchema,
  type ContextLockAgentBlueprint,
  BASELINE_SCENARIOS,
} from "./schema.js";
import { collectBuildBlockingUnknowns, isKnown } from "./unknown.js";
import { fenceWrite, type NetworkRef } from "@contextlock/studio-network";

/**
 * Deterministic Blueprint validation.
 *
 * Every check here is ordinary code. None of it asks the model whether the model's own architecture
 * is safe — a question that has never once been answered "no" by any language model under
 * deployment pressure, and which is structurally the wrong party to ask.
 *
 * The rules are drawn from the ContextLock security invariants that already hold at runtime. The
 * Studio's job is to refuse to *generate* an agent that would violate them, so that a violation is
 * caught at design time rather than discovered by the executor at execution time with money on the
 * table.
 */

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export interface ValidationIssue {
  code: string;
  severity: Severity;
  path: string;
  message: string;
  /** What the user or the Architecture Agent should change. */
  remediation: string;
}

export interface ValidationResult {
  ok: boolean;
  /** True only when nothing CRITICAL or HIGH is outstanding and no BUILD-blocking unknown remains. */
  buildable: boolean;
  issues: ValidationIssue[];
  unknowns: Array<{ path: string; reason: string }>;
}

const issue = (
  code: string,
  severity: Severity,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue => ({ code, severity, path, message, remediation });

/**
 * Every network the Blueprint would EXECUTE on.
 *
 * Deliberately not "every chainId in the document". A Blueprint may legitimately name mainnet as a
 * market-data source, and refusing that would break the whole reality engine — the boundary is
 * between reading a chain and writing to it, not between mentioning one and not.
 */
function blueprintExecutionNetworks(bp: { identity: { chainId: number }; execution: { chainId: number }; protocols: ReadonlyArray<{ id: string; chainId: number }> }): Array<{ path: string; network: NetworkRef }> {
  const ref = (chainId: number): NetworkRef => ({ chainId, role: "TESTNET_EXECUTION", forkedFrom: null, forkBlock: null });
  return [
    { path: "identity.chainId", network: ref(bp.identity.chainId) },
    { path: "execution.chainId", network: ref(bp.execution.chainId) },
    ...bp.protocols.map((pr) => ({ path: `protocols.${pr.id}.chainId`, network: ref(pr.chainId) })),
  ];
}

/** Words that indicate a permission moves value out of the user's control. */
const OUTFLOW_HINTS = ["withdraw", "transfer", "send", "approve", "borrow", "swap out"];

export function validateBlueprint(input: unknown): ValidationResult {
  const parsed = ContextLockAgentBlueprintSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      buildable: false,
      unknowns: [],
      issues: parsed.error.issues.map((e) =>
        issue(
          "BP-SCHEMA",
          "CRITICAL",
          e.path.join("."),
          e.message,
          "The Architecture Agent must emit a Blueprint matching contextlock.agent.blueprint/v1.",
        ),
      ),
    };
  }

  const bp = parsed.data;
  const issues: ValidationIssue[] = [];
  const push = (i: ValidationIssue) => issues.push(i);

  /*
   * ── Per-action limits may only tighten ────────────────────────────────────
   *
   * A per-action entry exists so one agent can hold two different limit sets — the canonical prompt
   * asks for exactly that. What it must never do is WIDEN: if an entry could exceed the global
   * limit, it would become a second place authority is granted, and the global pair would stop being
   * the ceiling a reviewer can rely on.
   *
   * So the global limits stay authoritative and an entry above them is CRITICAL. The worst a
   * mistaken or malicious entry can do is make an agent stricter than the user asked for, which
   * fails safe.
   */
  {
    const known = (v: unknown): number | null => {
      if (!v || typeof v !== "object" || !("known" in v)) return null;
      const w = v as { known: boolean; value?: unknown };
      return w.known && typeof w.value === "number" ? w.value : null;
    };

    const globalAuto = known(bp.autonomousPolicy.maxValueUsdCents);
    const globalCap = known(bp.escalationPolicy.maxValueUsdCents);
    const actionIds = new Set(bp.actions.map((a) => a.id));

    for (const limit of bp.perActionLimits) {
      if (!actionIds.has(limit.actionRef)) {
        push(issue("BP-PERACTION", "CRITICAL", `perActionLimits.${limit.actionRef}`,
          `per-action limit references "${limit.actionRef}", which is not an action in this Blueprint`,
          "Every per-action limit must name an action the agent actually has."));
        continue;
      }

      const auto = known(limit.autonomousMaxUsdCents);
      if (auto !== null && globalAuto !== null && auto > globalAuto) {
        push(issue("BP-PERACTION", "CRITICAL", `perActionLimits.${limit.actionRef}.autonomousMaxUsdCents`,
          `the per-action autonomous limit (${auto}) exceeds the global limit (${globalAuto})`,
          "A per-action limit may only tighten. Raise the global limit deliberately, or lower this one."));
      }

      const cap = known(limit.escalationMaxUsdCents);
      if (cap !== null && globalCap !== null && cap > globalCap) {
        push(issue("BP-PERACTION", "CRITICAL", `perActionLimits.${limit.actionRef}.escalationMaxUsdCents`,
          `the per-action hard cap (${cap}) exceeds the global hard cap (${globalCap})`,
          "A per-action limit may only tighten. The global cap is the ceiling."));
      }

      if (auto !== null && cap !== null && auto > cap) {
        push(issue("BP-PERACTION", "CRITICAL", `perActionLimits.${limit.actionRef}`,
          `the per-action autonomous limit (${auto}) exceeds its own hard cap (${cap})`,
          "An autonomous limit above the hard cap would let an action run unattended at a value the same policy denies."));
      }
    }
  }

  /*
   * ── The blueprint write fence ──────────────────────────────────────────────
   *
   * The schema already pins `chainId` to a literal, which makes a production chain unrepresentable
   * at parse time — the strongest form of this check and the reason it has never fired.
   *
   * The fence is here anyway, and the redundancy is the point. A literal is one edit away from
   * becoming a union the day someone adds a second testnet, and on that day this call is what keeps
   * the boundary. It also makes the Blueprint layer participate in the shared registry rather than
   * enforcing a private rule, so approving a network stays one decision in one place.
   */
  for (const ref of blueprintExecutionNetworks(bp)) {
    try {
      fenceWrite("BLUEPRINT_VALIDATOR", ref.network, "PUBLIC_WRITE");
    } catch (e) {
      push(issue(
        "BP-NETWORK",
        "CRITICAL",
        ref.path,
        (e as Error).message,
        "ContextLock executes on approved testnets only. Mainnet may be read as market data; it may never be an execution target.",
      ));
    }
  }

  /* ── BP-001 arbitrary target ─────────────────────────────────────────────── */
  for (const a of bp.actions) {
    if (a.targetPolicy.mode === "arbitrary") {
      // The schema already forces a >=40 char justification. Requiring one is not the same as it
      // being adequate, so this stays HIGH and always surfaces for human review.
      push(
        issue(
          "BP-001",
          "HIGH",
          `actions.${a.id}.targetPolicy`,
          `Action "${a.id}" may call an arbitrary target. Arbitrary target selection reintroduces the ambient authority ContextLock exists to remove.`,
          "Use fixed-allowlist or protocol-resolved targets, or have a human explicitly accept this exposure.",
        ),
      );
    }
    const tp = a.targetPolicy;
    if (tp.mode === "protocol-resolved") {
      const proto = bp.protocols.find((p) => p.id === tp.protocolRef);
      if (!proto) {
        push(
          issue(
            "BP-002",
            "CRITICAL",
            `actions.${a.id}.targetPolicy.protocolRef`,
            `Action "${a.id}" resolves its target through protocol "${tp.protocolRef}", which is not declared.`,
            "Declare the protocol, or point the action at one that exists.",
          ),
        );
      } else if (!proto.contracts.some((c) => c.role === tp.contractRole)) {
        push(
          issue(
            "BP-002",
            "CRITICAL",
            `actions.${a.id}.targetPolicy.contractRole`,
            `Protocol "${proto.id}" declares no contract with role "${tp.contractRole}".`,
            "Add the contract role to the protocol, or correct the action.",
          ),
        );
      }
    }
  }

  /* ── BP-003 arbitrary recipient ──────────────────────────────────────────── */
  for (const a of bp.actions) {
    if (a.recipientPolicy.mode === "arbitrary") {
      push(
        issue(
          "BP-003",
          "CRITICAL",
          `actions.${a.id}.recipientPolicy`,
          `Action "${a.id}" permits an arbitrary recipient. A compromised agent with an arbitrary recipient is a drain, regardless of every other control.`,
          "Use self-only, or a fixed allow-list of recipients the user named.",
        ),
      );
    }
  }

  /* ── BP-004 / BP-005 the agent must hold no privileged key ───────────────── */
  if (bp.execution.agentHoldsCapabilityIssuerKey !== false) {
    push(
      issue(
        "BP-004",
        "CRITICAL",
        "execution.agentHoldsCapabilityIssuerKey",
        "The agent would hold the capability issuer key, which lets it mint its own authority.",
        "The issuer key belongs to the broker. The agent receives capabilities; it never signs them.",
      ),
    );
  }
  if (bp.execution.agentHoldsProtocolAdminKey !== false) {
    push(
      issue(
        "BP-005",
        "CRITICAL",
        "execution.agentHoldsProtocolAdminKey",
        "The agent would hold a protocol owner/admin key, which lets it rewrite the policy that constrains it.",
        "Policy administration stays with the policy admin. The agent is a subject of the policy, not its author.",
      ),
    );
  }
  if (bp.execution.agentHoldsNoKey !== true) {
    push(
      issue(
        "BP-006",
        "CRITICAL",
        "execution.agentHoldsNoKey",
        "The Blueprint does not assert that the agent holds no key.",
        "ContextLock's premise is authority without keys. An agent with a key is outside the model.",
      ),
    );
  }

  /* ── BP-007..010 capability binding completeness ─────────────────────────── */
  const required = ["nonce", "expiry", "chainId", "target", "calldataHash"] as const;
  const bindingMessages: Record<(typeof required)[number], [string, string, string]> = {
    nonce: [
      "BP-007",
      "Capability does not bind a nonce, so a spent capability can be replayed.",
      "EIP-712 provides no replay protection by itself. Bind an on-chain nonce.",
    ],
    expiry: [
      "BP-008",
      "Capability does not bind an expiry, so authority never lapses.",
      "Bind an expiry. Authority that cannot expire cannot be withdrawn by waiting.",
    ],
    chainId: [
      "BP-009",
      "Capability does not bind a chain id, so it is replayable across chains.",
      "Bind chainId into the signed payload.",
    ],
    target: [
      "BP-010",
      "Capability does not bind the call target.",
      "Bind the target so a capability authorizes one contract, not a class of them.",
    ],
    calldataHash: [
      "BP-010",
      "Capability does not bind the calldata, so the authorized amount and recipient are mutable.",
      "Bind a calldata hash. Without it, 'approved to transfer' means 'approved to transfer anything'.",
    ],
  };
  for (const r of required) {
    if (!bp.capabilityPolicy.bindings.includes(r)) {
      const [code, message, remediation] = bindingMessages[r];
      push(issue(code, "CRITICAL", `capabilityPolicy.bindings.${r}`, message, remediation));
    }
  }

  /* ── BP-011 DENY must stay terminal ──────────────────────────────────────── */
  if (bp.escalationPolicy.denyIsTerminal !== true) {
    push(
      issue(
        "BP-011",
        "CRITICAL",
        "escalationPolicy.denyIsTerminal",
        "DENY could be upgraded to ALLOW through ordinary human escalation.",
        "Human approval escalates autonomy; it must not override policy. Keep DENY structurally terminal.",
      ),
    );
  }
  // A DENY that is merely "the escalation ceiling" is not terminal either: if the escalation range
  // has no upper bound, every amount is escalatable and DENY is unreachable by value.
  if (
    isKnown(bp.escalationPolicy.maxValueUsdCents) &&
    isKnown(bp.autonomousPolicy.maxValueUsdCents) &&
    bp.escalationPolicy.maxValueUsdCents.value <= bp.autonomousPolicy.maxValueUsdCents.value
  ) {
    push(
      issue(
        "BP-012",
        "HIGH",
        "escalationPolicy.maxValueUsdCents",
        "The escalation ceiling is at or below the autonomous limit, so the escalation band is empty or inverted.",
        "Set the escalation ceiling above the autonomous limit, or remove escalation entirely.",
      ),
    );
  }
  if (
    isKnown(bp.escalationPolicy.minValueUsdCents) &&
    isKnown(bp.autonomousPolicy.maxValueUsdCents) &&
    bp.escalationPolicy.minValueUsdCents.value < bp.autonomousPolicy.maxValueUsdCents.value
  ) {
    push(
      issue(
        "BP-013",
        "HIGH",
        "escalationPolicy.minValueUsdCents",
        "The escalation band starts below the autonomous limit, leaving an overlap where two policies both apply.",
        "Make the escalation floor equal to the autonomous ceiling so exactly one policy governs each amount.",
      ),
    );
  }

  /* ── BP-014 confidential values must not be in the Blueprint ─────────────── */
  if (bp.confidentialPolicy.required && bp.confidentialPolicy.placement === "none") {
    push(
      issue(
        "BP-014",
        "HIGH",
        "confidentialPolicy.placement",
        "Confidential policy is required but has no confidential placement, so the values would be evaluated in the clear.",
        "Place confidential evaluation in the CRE confidential handler.",
      ),
    );
  }
  for (const t of bp.triggers) {
    if (t.thresholdIsConfidential && t.publicThreshold && t.publicThreshold.known) {
      push(
        issue(
          "BP-015",
          "CRITICAL",
          `triggers.${t.id}.publicThreshold`,
          `Trigger "${t.id}" is declared confidential but carries a public threshold value in the Blueprint, which is exported, rendered and reported.`,
          "Remove the value. Keep only the parameter name; the value belongs in the confidential store.",
        ),
      );
    }
  }

  /* ── BP-016 financial permission must not be an ENS role ─────────────────── */
  if (bp.ens.financialPermissionsInEns !== false) {
    push(
      issue(
        "BP-016",
        "CRITICAL",
        "ens.financialPermissionsInEns",
        "A financial permission is represented as an ENS registry role. Stock ENSv2 roles are not financial, and treating one as a spending permission means the limit is not actually enforced anywhere.",
        "Keep financial permissions in the ContextLock policy layer. ENS answers who, never how much.",
      ),
    );
  }
  if (bp.ens.identityReadAt !== "execution-time") {
    push(
      issue(
        "BP-017",
        "HIGH",
        "ens.identityReadAt",
        "Identity is not read at execution time, so a revoked agent keeps working until the cache expires.",
        "Read ENS identity live at execution. A cached identity cannot be revoked.",
      ),
    );
  }

  /* ── BP-018 denials must name the dangerous verbs ────────────────────────── */
  const deniedText = bp.permissions.denied.map((d) => d.statement.toLowerCase()).join(" | ");
  const allowedText = bp.permissions.allowed.map((d) => d.statement.toLowerCase()).join(" | ");
  for (const hint of ["withdraw", "arbitrary transfer", "arbitrary token approval"]) {
    if (!deniedText.includes(hint) && !allowedText.includes(hint)) {
      push(
        issue(
          "BP-018",
          "MEDIUM",
          "permissions.denied",
          `Neither the allow list nor the deny list mentions "${hint}". Silence here is ambiguous: it reads the same whether the user forbade it or nobody thought about it.`,
          `State explicitly whether "${hint}" is permitted.`,
        ),
      );
    }
  }

  /* ── BP-019 autonomous actions must be permitted actions ─────────────────── */
  const actionIds = new Set(bp.actions.map((a) => a.id));
  for (const ref of bp.autonomousPolicy.allowedActionRefs) {
    if (!actionIds.has(ref)) {
      push(
        issue(
          "BP-019",
          "CRITICAL",
          "autonomousPolicy.allowedActionRefs",
          `Autonomous policy permits action "${ref}", which is not a declared action.`,
          "Remove the reference, or declare the action so its target and recipient policies are checked.",
        ),
      );
    }
  }
  // An action that moves value out of the user's control should not be autonomous by accident.
  for (const ref of bp.autonomousPolicy.allowedActionRefs) {
    const a = bp.actions.find((x) => x.id === ref);
    if (!a) continue;
    if (a.recipientPolicy.mode !== "self-only" && OUTFLOW_HINTS.some((h) => a.displayName.toLowerCase().includes(h))) {
      push(
        issue(
          "BP-020",
          "HIGH",
          `autonomousPolicy.allowedActionRefs.${ref}`,
          `Action "${ref}" moves value to a non-self recipient and is permitted autonomously.`,
          "Route value-outflow actions through escalation, or restrict the recipient to self-only.",
        ),
      );
    }
  }

  /*
   * BP-028 — an action may not require a permission the deny list forbids.
   *
   * Found by the Security Architect on the first real run, and it is a genuine contradiction rather
   * than a stylistic one: a Blueprint that denies token approvals while declaring two actions that
   * each need a USDC approval describes an agent that cannot function, or — worse — one whose deny
   * list is decorative because the approval happens anyway.
   *
   * The model caught it and this validator did not, which is exactly the division of labour the
   * advisory review exists for. It is now deterministic, so the next Blueprint with this shape is
   * caught whether or not a model happens to notice.
   */
  const deniesApprovals = bp.permissions.denied.some((d) => {
    const t = d.statement.toLowerCase();
    if (!/approval|approve/.test(t)) return false;
    // "UNRESOLVED: ..." records an open question, not a prohibition.
    if (t.startsWith("unresolved:")) return false;
    /*
     * Only a BLANKET denial contradicts a bounded approval.
     *
     * "no arbitrary token approval" and "no unlimited approvals" are scoped: they forbid the
     * dangerous shape, not the mechanism. An exact-amount approval to a named protocol contract is
     * precisely what the scoped denial is asking for, and flagging it would make the correct design
     * unbuildable — which is how a check gets deleted rather than satisfied.
     */
    return !/\b(arbitrary|unlimited|unbounded|infinite|blanket|open-ended)\b/.test(t);
  });
  if (deniesApprovals) {
    for (const a of bp.actions) {
      if (a.approvals.length > 0) {
        push(
          issue(
            "BP-028",
            "CRITICAL",
            `actions.${a.id}.approvals`,
            `Action "${a.id}" requires a token approval, but the permissions explicitly deny token approval rights. The Blueprint contradicts itself, and the deny list is the half that will not be enforced.`,
            "Either scope the denial to *arbitrary/unlimited* approvals and say so, or remove the approval this action needs.",
          ),
        );
      }
    }
  }

  /*
   * BP-029 — an autonomous action must be covered by a stated allowed permission.
   *
   * Also raised by the review: `add-collateral` was permitted autonomously while the stated
   * permissions only described protecting the position. Silence in the allow list is not consent.
   */
  const allowedText029 = bp.permissions.allowed.map((p) => p.statement.toLowerCase()).join(" | ");
  for (const ref of bp.autonomousPolicy.allowedActionRefs) {
    const a = bp.actions.find((x) => x.id === ref);
    if (!a) continue;
    const covered =
      bp.permissions.allowed.some((p) => p.actionRef === ref) ||
      allowedText029.includes(a.displayName.toLowerCase()) ||
      a.displayName
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 4)
        .some((w) => allowedText029.includes(w));
    if (!covered) {
      push(
        issue(
          "BP-029",
          "HIGH",
          `autonomousPolicy.allowedActionRefs.${ref}`,
          `Action "${ref}" (${a.displayName}) runs autonomously but no stated permission covers it.`,
          "State the permission explicitly, or remove the action from autonomous execution.",
        ),
      );
    }
  }

  /* ── BP-021 unlimited approvals ──────────────────────────────────────────── */
  for (const a of bp.actions) {
    for (const ap of a.approvals) {
      if (ap.maxAmountPolicy === "declared-cap" && !isKnown(bp.autonomousPolicy.maxValueUsdCents)) {
        push(
          issue(
            "BP-021",
            "HIGH",
            `actions.${a.id}.approvals`,
            `Action "${a.id}" approves up to a declared cap, but no cap is known.`,
            "Resolve the autonomous limit, or approve only the exact action amount.",
          ),
        );
      }
    }
  }

  /* ── BP-022 baseline scenario coverage ───────────────────────────────────── */
  const covered = new Set(bp.simulationScenarios.map((s) => s.scenarioId));
  const missing = BASELINE_SCENARIOS.filter((s) => !covered.has(s));
  if (missing.length > 0) {
    push(
      issue(
        "BP-022",
        "MEDIUM",
        "simulationScenarios",
        `Baseline attack scenarios not covered: ${missing.join(", ")}.`,
        "Every generated agent carries the full baseline set. An uncovered attack is an untested one.",
      ),
    );
  }

  /* ── BP-023 CRE load-bearing where configured ────────────────────────────── */
  if (bp.cre.required && bp.cre.verdicts.length < 3) {
    push(
      issue(
        "BP-023",
        "HIGH",
        "cre.verdicts",
        "CRE is required but does not produce all three verdicts, collapsing the design back to binary authorization.",
        "Emit ALLOW, ESCALATE and DENY. Binary authorization forces every threshold to be a cliff.",
      ),
    );
  }

  /* ── BP-024 Ledger honesty ───────────────────────────────────────────────── */
  if (bp.escalationPolicy.mechanism === "ledger-device" && bp.ledger.physicalDeviceEvidence !== false) {
    push(
      issue(
        "BP-024",
        "CRITICAL",
        "ledger.physicalDeviceEvidence",
        "The Blueprint claims physical Ledger evidence. The Studio cannot produce hardware evidence and must never assert it.",
        "Leave physicalDeviceEvidence false and reference the open hardware blocker.",
      ),
    );
  }
  if (bp.escalationPolicy.mechanism === "approval-registry-standin" && !bp.ledger.blockerRef) {
    push(
      issue(
        "BP-025",
        "MEDIUM",
        "ledger.blockerRef",
        "A stand-in approver is used but no blocker is referenced, so the substitution is undocumented.",
        "Reference the open hardware blocker so the stand-in is visible wherever the Blueprint is read.",
      ),
    );
  }

  /* ── BP-026 core reuse ───────────────────────────────────────────────────── */
  const core = bp.generatedModules.find((m) => m.kind === "contextlock-core");
  if (!core) {
    push(
      issue(
        "BP-026",
        "HIGH",
        "generatedModules",
        "No contextlock-core module. The generated agent would carry its own security implementation.",
        "Compose the audited ContextLock core. Do not regenerate the reference monitor.",
      ),
    );
  } else if (!core.reusesContextLockCore) {
    push(
      issue(
        "BP-027",
        "CRITICAL",
        "generatedModules.contextlock-core.reusesContextLockCore",
        "The Blueprint would have the model regenerate ContextLock's core security implementation from scratch.",
        "Reuse the tested implementation. A freshly written reference monitor has no test history behind it.",
      ),
    );
  }

  /*
   * BP-030..033 — adapter bindings (P12).
   *
   * The Blueprint is the contract between design and code, so an adapter reference that points
   * nowhere, or a data requirement nothing satisfies, has to fail here rather than at runtime when
   * a policy is waiting on a value that will never arrive.
   */
  const requirementKeys = new Set(bp.dataRequirements.map((r) => r.key));
  for (const b of bp.adapters) {
    if (b.role !== "EXECUTION" && !requirementKeys.has(b.configRef)) {
      push(
        issue(
          "BP-030",
          "HIGH",
          `adapters.${b.adapterId}.configRef`,
          `Adapter "${b.adapterId}" is bound to "${b.configRef}", which is not a declared data requirement.`,
          "Declare the requirement, or remove the binding. A binding with no requirement serves nothing.",
        ),
      );
    }
    if (!/^\d+\.\d+\.\d+$/.test(b.adapterVersion)) {
      push(
        issue(
          "BP-031",
          "CRITICAL",
          `adapters.${b.adapterId}.adapterVersion`,
          `Adapter "${b.adapterId}" is not pinned to an exact version ("${b.adapterVersion}").`,
          "Pin an exact version. A range lets a registry update silently change what this build runs.",
        ),
      );
    }
  }

  for (const r of bp.dataRequirements) {
    const bound = bp.adapters.some((b) => b.configRef === r.key);
    if (!bound) {
      push(
        issue(
          "BP-032",
          "CRITICAL",
          `dataRequirements.${r.key}`,
          `Data requirement "${r.key}" (${r.kind}, ${r.minimumTrustClass}) has no adapter bound to it.`,
          "Resolve an adapter for it, or remove the requirement. A policy waiting on an unsourced value fails closed at runtime, which is late.",
        ),
      );
    }
    if (r.fallback) {
      // A fallback that may be weaker than the primary requirement is a declared downgrade. That is
      // allowed — it is the user's decision — but it must be visible, never inferred.
      if (r.fallback.maxAgeMs > r.maxAgeMs * 10) {
        push(
          issue(
            "BP-033",
            "MEDIUM",
            `dataRequirements.${r.key}.fallback.maxAgeMs`,
            `Fallback for "${r.key}" tolerates ${r.fallback.maxAgeMs}ms, more than ten times the primary bound of ${r.maxAgeMs}ms.`,
            "Tighten the fallback, or confirm that data this old is genuinely acceptable for this decision.",
          ),
        );
      }
    }
  }

  /* ── unknowns ────────────────────────────────────────────────────────────── */
  const unknowns = collectBuildBlockingUnknowns(bp);

  const hasBlocking = issues.some((i) => i.severity === "CRITICAL" || i.severity === "HIGH");
  return {
    ok: issues.filter((i) => i.severity === "CRITICAL").length === 0,
    buildable: !hasBlocking && unknowns.length === 0,
    issues,
    unknowns,
  };
}

/**
 * Checks that what was generated matches what the Blueprint promised.
 *
 * The Blueprint is only the source of truth if something enforces the correspondence. Without this,
 * a Blueprint node saying "Chainlink CRE" and a generated project with no workflow would both be
 * reported as success, and the graph would be decoration.
 */
export function validateBlueprintArtifacts(
  bp: ContextLockAgentBlueprint,
  generatedPaths: string[],
): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const present = new Set(generatedPaths.map((p) => p.replace(/^\.?\//, "")));
  const hasPath = (p: string) => {
    const norm = p.replace(/^\.?\//, "");
    return present.has(norm) || [...present].some((x) => x.startsWith(`${norm}/`));
  };

  for (const m of bp.generatedModules) {
    if (!hasPath(m.path)) {
      out.push(
        issue(
          "BPA-001",
          "CRITICAL",
          `generatedModules.${m.moduleId}`,
          `Blueprint requires module "${m.moduleId}" (${m.kind}) at "${m.path}", but no such file was generated.`,
          "Generate the module, or remove it from the Blueprint. The graph must not show a component the code does not have.",
        ),
      );
    }
  }

  if (bp.cre.required && !bp.generatedModules.some((m) => m.kind === "cre-confidential-policy")) {
    out.push(
      issue(
        "BPA-002",
        "CRITICAL",
        "cre",
        "Blueprint requires CRE but declares no CRE module.",
        "Add the confidential policy module.",
      ),
    );
  }
  if (bp.ens.required && !bp.generatedModules.some((m) => m.kind === "ens-identity")) {
    out.push(
      issue(
        "BPA-003",
        "CRITICAL",
        "ens",
        "Blueprint requires ENS identity but declares no identity module.",
        "Add the ENS identity module.",
      ),
    );
  }
  /*
   * Adapter correspondence, checked BOTH ways.
   *
   * Missing is the obvious failure: the graph shows Uniswap, the code has none. The reverse matters
   * just as much — an execution adapter present in the generated tree but absent from the Blueprint
   * is a capability nobody reviewed and nobody approved, which is how an agent ends up able to do
   * something its own architecture diagram says it cannot.
   */
  for (const b of bp.adapters) {
    const expectedDir = `src/adapters/${b.adapterId}`;
    if (!hasPath(expectedDir) && !bp.generatedModules.some((m) => m.path.includes(b.adapterId))) {
      out.push(
        issue(
          "BPA-005",
          "CRITICAL",
          `adapters.${b.adapterId}`,
          `Blueprint binds adapter "${b.adapterId}@${b.adapterVersion}" but the generated project contains no module for it.`,
          "Generate the adapter module, or remove the binding. The graph must not show a component the code lacks.",
        ),
      );
    }
  }

  const declaredAdapterIds = new Set(bp.adapters.map((b) => b.adapterId));
  for (const p of generatedPaths) {
    const m = /^src\/adapters\/([a-z][a-z0-9-]{2,63})\//.exec(p.replace(/^\.?\//, ""));
    if (m && !declaredAdapterIds.has(m[1]!)) {
      out.push(
        issue(
          "BPA-006",
          "CRITICAL",
          p,
          `The generated project contains adapter "${m[1]}" which the Blueprint does not declare.`,
          "Declare it in the Blueprint so it is reviewed and version-pinned, or remove it. Undeclared runtime capability is capability nobody approved.",
        ),
      );
    }
  }

  if (
    bp.ledger.humanApprovalRequired &&
    !bp.generatedModules.some((m) => m.kind === "ledger-escalation")
  ) {
    out.push(
      issue(
        "BPA-004",
        "CRITICAL",
        "ledger",
        "Blueprint requires human escalation but declares no escalation module.",
        "Add the escalation module, or remove the escalation requirement.",
      ),
    );
  }
  return out;
}
