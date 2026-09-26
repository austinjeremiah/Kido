/**
 * Reading a simulation result: which layer produced its verdict and why.
 *
 * The codes come from the Kido simulation engine (packages/foundry simulate.ts), which runs the same
 * compiler and Amane subset rules the chain enforces. A compiler preflight refusal is wrapped as
 * `KIDO_PLAN_OUT_OF_POLICY:<AMANE_RULE>`; an unwrapped `AMANE_*` / `E_*` is chain state; `KIDO_REASON_*`
 * is the proposal validator; other `KIDO_*` codes are the compiler. Only the prefix convention is
 * encoded here; the rule itself is read from the code.
 */
import type { LabLayer, ScenarioResult } from '@/lib/kido/types';

export interface LayerStep { layer: string; outcome: 'PASSED' | 'REFUSED' | 'NOT_REACHED' | 'OBSERVED'; detail: string; code?: string }
export interface Decoded { layer: LabLayer | 'MONITOR' | 'RECOVERY' | 'NOT_RUN'; layerLabel: string; steps: LayerStep[]; rule: string | null }

/** "AMANE_ACTION_RECIPIENT_NOT_ALLOWED" -> "action recipient not allowed". */
export const ruleText = (code: string) => code.replace(/^(AMANE|KIDO|E)_/, '').replace(/^(PLAN|REASON)_/, '').toLowerCase().replace(/_/g, ' ');

export const LAYER_LABEL: Record<Decoded['layer'], string> = {
  KIDO_VALIDATOR: 'Kido validator',
  KIDO_COMPILER: 'Kido compiler',
  AMANE_RULES: 'Amane rules (enforced on-chain)',
  NONE: 'No refusal',
  MONITOR: 'Monitor engine',
  RECOVERY: 'Recovery policy',
  NOT_RUN: 'Not run',
};

export const VERDICT_MEANING: Record<string, string> = {
  ALLOW: 'the action compiles and passes every rule the chain enforces',
  REJECT: 'the action is refused before it can move value',
  NO_ACTION: 'the agent takes no action (no event is emitted)',
  RECOVERY_REQUIRED: 'the plan halts and the recovery policy takes over',
  SKIPPED: 'the scenario could not run for this blueprint',
};

export function decode(r: ScenarioResult): Decoded {
  const code = r.code;
  if (r.actual === 'SKIPPED') return { layer: 'NOT_RUN', layerLabel: LAYER_LABEL.NOT_RUN, rule: null, steps: [{ layer: 'Simulation engine', outcome: 'NOT_REACHED', detail: code ? `skipped: ${code}` : r.note }] };
  if (!code) {
    if (r.actual === 'NO_ACTION') return { layer: 'MONITOR', layerLabel: LAYER_LABEL.MONITOR, rule: null, steps: [{ layer: 'Monitor engine', outcome: 'OBSERVED', detail: r.note }] };
    if (r.actual === 'RECOVERY_REQUIRED') return { layer: 'RECOVERY', layerLabel: LAYER_LABEL.RECOVERY, rule: null, steps: [{ layer: 'Plan engine', outcome: 'REFUSED', detail: 'a step failed; the rest of the plan does not run' }, { layer: 'Recovery policy', outcome: 'OBSERVED', detail: r.note }] };
    return {
      layer: 'NONE',
      layerLabel: LAYER_LABEL.NONE,
      rule: null,
      steps: [
        { layer: 'Kido compiler', outcome: 'PASSED', detail: 'the step compiles to a bounded intent' },
        { layer: 'Amane rules', outcome: 'PASSED', detail: r.note },
      ],
    };
  }
  const [outer, inner] = code.split(':');
  if (outer === 'KIDO_PLAN_OUT_OF_POLICY' && inner) {
    return {
      layer: 'AMANE_RULES',
      layerLabel: LAYER_LABEL.AMANE_RULES,
      rule: inner,
      steps: [
        { layer: 'Kido compiler', outcome: 'PASSED', detail: 'the step is well formed and compiles' },
        { layer: 'Amane rules (compiler preflight)', outcome: 'REFUSED', detail: `${ruleText(inner)}: the same subset rule the chain enforces refused the intent before any relay`, code: inner },
        { layer: 'Chain', outcome: 'NOT_REACHED', detail: 'never submitted; Amane would reject it on-chain with the same rule' },
      ],
    };
  }
  if (/^(AMANE|E)_/.test(outer!)) {
    return {
      layer: 'AMANE_RULES',
      layerLabel: LAYER_LABEL.AMANE_RULES,
      rule: outer!,
      steps: [{ layer: 'Amane (on-chain)', outcome: 'REFUSED', detail: `${ruleText(outer!)}: enforced by chain state, not by the runtime`, code: outer }],
    };
  }
  if (/^KIDO_REASON_/.test(outer!)) {
    return {
      layer: 'KIDO_VALIDATOR',
      layerLabel: LAYER_LABEL.KIDO_VALIDATOR,
      rule: outer!,
      steps: [
        { layer: 'Kido validator', outcome: 'REFUSED', detail: `${ruleText(outer!)}: the specialist's proposal is outside its contract`, code: outer },
        { layer: 'Kido compiler', outcome: 'NOT_REACHED', detail: 'the proposal never reaches the compiler or the chain' },
      ],
    };
  }
  if (/^KIDO_/.test(outer!)) {
    return {
      layer: 'KIDO_COMPILER',
      layerLabel: LAYER_LABEL.KIDO_COMPILER,
      rule: outer!,
      steps: [
        { layer: 'Kido compiler', outcome: 'REFUSED', detail: `${ruleText(outer!)}${inner ? ` (${inner})` : ''}`, code: outer },
        { layer: 'Chain', outcome: 'NOT_REACHED', detail: 'never submitted' },
      ],
    };
  }
  return { layer: 'NONE', layerLabel: 'Unrecognised code', rule: code, steps: [{ layer: 'Simulation engine', outcome: r.actual === 'REJECT' ? 'REFUSED' : 'OBSERVED', detail: code }] };
}
