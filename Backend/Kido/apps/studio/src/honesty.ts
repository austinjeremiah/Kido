import type { ContextLockAgentBlueprint } from "@contextlock/studio-blueprint";
import { SIM_PRIVATE_POLICY } from "@contextlock/studio-simulation";
import type { TemplateFile } from "@contextlock/studio-templates";

/**
 * Deterministic honesty scan.
 *
 * ContextLock's whole position is that a correct system described inaccurately is worth less than
 * an honest one with known gaps — a reader who catches one overstated claim discounts every other
 * claim, including the true ones. So the last gate before a build is called ready checks the
 * artifacts against four things that did not happen.
 *
 * It is deliberately narrow. Each flag looks for a specific *assertion*, not for a topic: a file
 * that says "no physical device evidence exists" must pass, and a file that says
 * `PHYSICAL_DEVICE_EVIDENCE = true` must not. A scanner that fires on the word "Ledger" would be
 * unusable within a day.
 */

export interface HonestyFlags {
  claimsHardwareEvidence: boolean;
  claimsLiveCreDeployment: boolean;
  claimsTeeExecution: boolean;
  exposesConfidentialValues: boolean;
}

/**
 * Words that turn a claim into a denial.
 *
 * "nothing runs in a real TEE" and "runs in a real TEE" differ by one word and mean opposite
 * things. Every prose pattern below is checked against the text immediately preceding the match, so
 * a denial does not read as an assertion. This is the fifth time in this project a scanner has had
 * to learn to distinguish the two — see FND-V2-004.
 */
const NEGATORS =
  /\b(?:no|not|never|nothing|none|without|cannot|can't|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|non-|lacks?|absent|missing|unavailable|pending|blocked|would|must not|may not|do not|does not)\b/i;

/** How far back to look for a negator. One clause, not one paragraph. */
const NEGATION_WINDOW = 60;

function assertsNotDenies(text: string, re: RegExp): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index);
    // Only the tail of the window matters: a negator three clauses back is about something else.
    const clause = before.split(/[.;\n]/).pop() ?? before;
    if (!NEGATORS.test(clause)) return true;
    if (g.lastIndex === m.index) g.lastIndex++;
  }
  return false;
}

/** Assertions of hardware evidence. Negations and false-valued constants must NOT match. */
const HARDWARE_CLAIM = [
  /PHYSICAL_DEVICE_EVIDENCE\s*[=:]\s*true/i,
  /physicalDeviceEvidence"?\s*:\s*true/i,
  /\b(?:approved|signed|rendered|confirmed)\s+on\s+(?:a\s+)?(?:real\s+|physical\s+)?ledger\s+device\b/i,
  /\bhardware\s+(?:approval|evidence)\s+(?:obtained|complete|verified|captured)\b/i,
];

const LIVE_CRE_CLAIM = [
  /LIVE_CRE_DEPLOYMENT\s*[=:]\s*true/i,
  /liveCreDeployment"?\s*:\s*true/i,
  /\bdeployed\s+to\s+(?:the\s+)?(?:live\s+)?(?:CRE|DON)\b/i,
  /\bDON[- ]signed\s+report\b/i,
];

const TEE_CLAIM = [
  /REAL_TEE_EXECUTION\s*[=:]\s*true/i,
  /realTeeExecution"?\s*:\s*true/i,
  /\b(?:ran|runs|executed|executing)\s+in\s+(?:a\s+)?(?:real\s+)?(?:TEE|enclave|Nitro)\b/i,
];

/**
 * Confidential VALUES that must never appear in an artifact.
 *
 * The thresholds live in the simulation fixture and in confidential storage. The Blueprint carries
 * parameter NAMES only, so any of these numbers turning up in a rendered file means a value escaped
 * the boundary it was supposed to stay behind.
 *
 * Values small enough to collide with ordinary numbers (single digits, common port-like numbers)
 * are excluded — a scanner that fires on "50" would be noise, and noise is how a real leak gets
 * scrolled past.
 */
function confidentialValueNeedles(): string[] {
  const raw = [
    SIM_PRIVATE_POLICY.canary,
    SIM_PRIVATE_POLICY.autoLimit.toString(),
    SIM_PRIVATE_POLICY.escalationLimit.toString(),
    SIM_PRIVATE_POLICY.minLiquidity.toString(),
    String(SIM_PRIVATE_POLICY.maxVolatilityBps),
    String(SIM_PRIVATE_POLICY.minHealthFactorBps),
    String(SIM_PRIVATE_POLICY.targetHealthFactorBps),
    String(SIM_PRIVATE_POLICY.proprietaryRiskThreshold),
  ];
  return raw.filter((v) => v.length >= 4);
}

/**
 * A confidential parameter name sitting next to a number is a leak even if the number is not one we
 * know: `healthFactorFloorBps: 16000` discloses the threshold whatever its value.
 */
function parameterAdjacentValue(text: string, names: string[]): boolean {
  for (const n of names) {
    const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b\\s*[=:]\\s*["']?\\d`, "i");
    if (re.test(text)) return true;
  }
  return false;
}

export function scanArtifactHonesty(
  files: Array<TemplateFile | { path: string; content: string }>,
  blueprint: ContextLockAgentBlueprint,
): HonestyFlags {
  // Strip comments before matching. Every previous scanner in this project fired on its own prose
  // at least once; the fix each time was to match code shapes rather than sentences.
  const strip = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
      .replace(/^\s*[*#>].*$/gm, " ");

  const code = files.map((f) => strip(f.content)).join("\n");
  const blueprintJson = JSON.stringify(blueprint);
  const haystack = `${code}\n${blueprintJson}`;

  const needles = confidentialValueNeedles();
  const exposes =
    needles.some((n) => haystack.includes(n)) ||
    parameterAdjacentValue(haystack, blueprint.confidentialPolicy.parameterNames);

  return {
    claimsHardwareEvidence: HARDWARE_CLAIM.some((r) => assertsNotDenies(haystack, r)),
    claimsLiveCreDeployment: LIVE_CRE_CLAIM.some((r) => assertsNotDenies(haystack, r)),
    claimsTeeExecution: TEE_CLAIM.some((r) => assertsNotDenies(haystack, r)),
    exposesConfidentialValues: exposes,
  };
}
