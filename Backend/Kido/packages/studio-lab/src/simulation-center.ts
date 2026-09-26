import { z } from "zod";

/**
 * The Simulation Center.
 *
 * §P28.12 asks for the simulation layers to be unified into one screen and then, in the same
 * breath, for their meanings to be kept distinct. Those pull against each other, and the second is
 * the one that matters: four green ticks in a row invite the reading "everything was simulated",
 * which is false in a specific and dangerous way. The CRE simulator runs the real workflow binary
 * and knows nothing about mainnet liquidity; the reality test reads real mainnet state and
 * evaluates no workflow. Neither substitutes for the other.
 *
 * So each layer carries what it proves AND what it does not, and a layer with no `doesNotProve` is
 * a type error rather than an omission.
 */

export const SIMULATION_LAYERS = ["SECURITY_SIMULATION", "CRE_WORKFLOW_SIMULATION", "REALITY_TEST", "FORK_EXECUTION"] as const;
export const SimulationLayerSchema = z.enum(SIMULATION_LAYERS);
export type SimulationLayerKey = z.infer<typeof SimulationLayerSchema>;

export const SIMULATION_STATUSES = ["PASS", "FAIL", "NOT_RUN", "BLOCKED"] as const;
export const SimulationStatusSchema = z.enum(SIMULATION_STATUSES);
export type SimulationStatus = z.infer<typeof SimulationStatusSchema>;

export const SimulationLayerViewSchema = z.object({
  key: SimulationLayerSchema,
  title: z.string().min(1),
  /** What actually ran. A name a reader could go and run themselves. */
  engine: z.string().min(1),
  status: SimulationStatusSchema,
  /** The count, where the layer has one. `null` where a count would be invented. */
  passed: z.number().int().nonnegative().nullable(),
  total: z.number().int().nonnegative().nullable(),
  detail: z.string().min(1),
  proves: z.string().min(1),
  /** The half a row of ticks hides. Required, so it cannot be forgotten on a new layer. */
  doesNotProve: z.string().min(1),
  /** Set when the layer is optional and unavailable, never when it merely failed. */
  blocker: z.string().nullable(),
  optional: z.boolean(),
});
export type SimulationLayerView = z.infer<typeof SimulationLayerViewSchema>;

export const SIMULATION_REASONS = {
  MEANINGS_COLLAPSED: "SIMULATION_LAYER_MEANINGS_COLLAPSED",
  UNRUN_REPORTED_PASS: "SIMULATION_LAYER_NOT_RUN_REPORTED_AS_PASS",
} as const;

export class SimulationCenterError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "SimulationCenterError";
  }
}

export interface SimulationCenterInputs {
  deterministic: { passed: number; total: number } | null;
  cre: { ran: boolean; passed: boolean; productionLimits: boolean; binaryHash: string | null };
  reality: { ran: boolean; passed: boolean; mode: string; anchorBlock: string | null };
  /** Optional by design. A fork run is extra evidence, never a gate. */
  fork: { available: boolean; ran: boolean; passed: boolean; forkBlock: string | null; blocker: string | null };
}

export interface SimulationCenterView {
  layers: SimulationLayerView[];
  /** Whether every REQUIRED layer passed. The optional fork layer is excluded on purpose. */
  requiredPassed: boolean;
  /** Every required layer that is not passing, named. */
  outstanding: string[];
}

/**
 * The four layers, from the four underlying states.
 *
 * `NOT_RUN` is a status of its own rather than a failure, because the two lead somewhere different:
 * a failure means fix the agent, and a not-run means run the thing. Collapsing them into a red tick
 * sends people to debug a strategy that was never evaluated.
 */
export function simulationCenter(input: SimulationCenterInputs): SimulationCenterView {
  const layers: SimulationLayerView[] = [];

  const det = input.deterministic;
  layers.push({
    key: "SECURITY_SIMULATION",
    title: "Security simulation",
    engine: "ContextLock deterministic tests",
    status: det === null ? "NOT_RUN" : det.passed === det.total ? "PASS" : "FAIL",
    passed: det?.passed ?? null,
    total: det?.total ?? null,
    detail: det === null ? "The deterministic suite has not been run for this revision" : `${det.passed} / ${det.total} scenarios`,
    proves: "The generated agent refuses the attacks the Blueprint's permissions forbid, deterministically and without a model.",
    doesNotProve: "Nothing about real market conditions, and nothing about the CRE workflow — these are fixtures.",
    blocker: null,
    optional: false,
  });

  layers.push({
    key: "CRE_WORKFLOW_SIMULATION",
    title: "CRE workflow simulation",
    engine: "Official Chainlink CRE CLI",
    status: !input.cre.ran ? "NOT_RUN" : input.cre.passed ? "PASS" : "FAIL",
    passed: null,
    total: null,
    detail: !input.cre.ran
      ? "The official CRE simulator has not been run for this artifact"
      : `${input.cre.binaryHash ? `binary ${input.cre.binaryHash.slice(0, 12)}… ` : ""}under production limits ${input.cre.productionLimits ? "ENABLED" : "DISABLED"}`,
    proves: "The real workflow binary evaluates the policy the way it will when deployed, under the CLI's production limits.",
    doesNotProve: "That it ran on a DON, in a TEE, or against live mainnet liquidity. This is the simulator.",
    blocker: null,
    optional: false,
  });

  layers.push({
    key: "REALITY_TEST",
    title: "Reality test",
    engine: `Reality Engine — ${input.reality.mode}`,
    status: !input.reality.ran ? "NOT_RUN" : input.reality.passed ? "PASS" : "FAIL",
    passed: null,
    total: null,
    detail: !input.reality.ran
      ? "No market snapshot has been taken for this revision"
      : `sealed snapshot at mainnet block ${input.reality.anchorBlock ?? "unknown"}`,
    proves: "The strategy was evaluated against real, sealed mainnet state read at a named block.",
    doesNotProve: "That any transaction happened. Mainnet is read-only here and nothing was submitted anywhere.",
    blocker: null,
    optional: false,
  });

  layers.push({
    key: "FORK_EXECUTION",
    title: "Fork execution",
    engine: "Anvil — pinned mainnet fork",
    status: !input.fork.available ? "BLOCKED" : !input.fork.ran ? "NOT_RUN" : input.fork.passed ? "PASS" : "FAIL",
    passed: null,
    total: null,
    detail: !input.fork.available
      ? "No local fork provider is available on this machine"
      : !input.fork.ran
        ? "No fork execution has been run for this revision"
        : `executed against forked mainnet state at block ${input.fork.forkBlock ?? "unknown"}`,
    proves: "The action executes against real mainnet protocol state, in a local fork, with a real protocol response.",
    doesNotProve: "That anything happened on a public chain. A fork transaction exists only on this machine and has no explorer.",
    blocker: input.fork.available ? null : input.fork.blocker,
    optional: true,
  });

  assertLayerMeaningsDistinct(layers);

  const outstanding = layers.filter((l) => !l.optional && l.status !== "PASS").map((l) => l.title);
  return { layers, requiredPassed: outstanding.length === 0, outstanding };
}

/**
 * Refuse a layer set whose meanings have collapsed into each other.
 *
 * The failure this guards against is editorial, not computational: someone shortens four
 * explanations into four copies of "the agent was simulated and it passed", and the screen stops
 * distinguishing a fixture from a fork. Identical text is the visible form of that.
 */
export function assertLayerMeaningsDistinct(layers: ReadonlyArray<SimulationLayerView>): void {
  const seen = new Map<string, string>();
  for (const l of layers) {
    for (const [field, text] of [["proves", l.proves], ["doesNotProve", l.doesNotProve], ["engine", l.engine]] as const) {
      const key = `${field}:${text.toLowerCase()}`;
      const prior = seen.get(key);
      if (prior !== undefined) {
        throw new SimulationCenterError(
          SIMULATION_REASONS.MEANINGS_COLLAPSED,
          `"${l.title}" and "${prior}" give the same ${field}. Four layers that say the same thing are one layer shown four times, and a reader would take a row of ticks to mean more was covered than was.`,
        );
      }
      seen.set(key, l.title);
    }
  }
}

/**
 * Refuse to summarise a not-run layer as a pass.
 *
 * Separate from the projection because the projection is not the only thing that produces these —
 * a report, an export or a badge can each be handed a layer view, and this is the check each of
 * them should make before rendering a tick.
 */
export function assertNoUnrunPass(layer: SimulationLayerView, context: string): void {
  if (layer.status === "PASS" && layer.detail.toLowerCase().includes("has not been run")) {
    throw new SimulationCenterError(
      SIMULATION_REASONS.UNRUN_REPORTED_PASS,
      `${context}: "${layer.title}" is reported PASS and its own detail says it never ran.`,
    );
  }
}
