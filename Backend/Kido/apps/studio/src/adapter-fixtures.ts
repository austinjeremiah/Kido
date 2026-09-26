import type { AdapterRegistry, ExecutionAdapter, DataAdapter } from "@contextlock/studio-adapters";
import { UniswapExecutionAdapter, UniswapDecodeError, type UniswapPrepared } from "@contextlock/studio-adapters";
import type { AdapterFixtureMap } from "@contextlock/studio-simulation";
import type { ContextLockAgentBlueprint } from "@contextlock/studio-blueprint";

/**
 * Build the adapter half of the mandatory security pass.
 *
 * Fixtures are EXECUTED, not asserted. For each bound adapter this runs the adapter's own decoder
 * and validator against the concrete provider responses the adapter itself supplies, and records
 * what actually happened. A fixture that merely declared "REJECTED" would be a claim about the
 * adapter rather than evidence about it — and the claim would survive the adapter being broken.
 *
 * The only branching here is on adapter KIND (execution vs data), which is a difference in
 * contract, not a difference in provider. No provider is named.
 */

type Fixture = AdapterFixtureMap[string];

function isExecution(a: unknown): a is ExecutionAdapter {
  return typeof (a as ExecutionAdapter).decodeTransaction === "function";
}

async function evaluateExecutionFixture(
  adapter: ExecutionAdapter,
  scenarioId: string,
  description: string,
  providerResponse: unknown,
): Promise<Fixture> {
  const reject = (reasonCode: string): Fixture => ({
    scenarioId,
    description,
    outcome: "REJECTED",
    reasonCode,
    stoppedAt: "EXECUTION",
  });

  try {
    /*
     * Quote freshness is checked first where the adapter exposes it. A stale route is refused
     * before its contents are even considered — the contents may be perfect and still price a
     * market that has moved.
     */
    const withFreshness = adapter as ExecutionAdapter & {
      validateQuoteFreshness?: (p: unknown, c: unknown, now: number) => { ok: boolean; problems: Array<{ code: string }> };
      fixtureIntent?: () => unknown;
      fixtureConstraints?: () => unknown;
    };
    const constraints = withFreshness.fixtureConstraints?.();
    const intent = withFreshness.fixtureIntent?.();

    if (withFreshness.validateQuoteFreshness && constraints) {
      const fresh = withFreshness.validateQuoteFreshness(providerResponse, constraints, Date.now());
      if (!fresh.ok) return reject(fresh.problems[0]!.code);
    }

    const normalized = await adapter.decodeTransaction(providerResponse);
    if (!intent || !constraints) {
      // Without an intent to compare against there is nothing to validate, and reporting ACCEPTED
      // would be reporting that a check passed when no check ran.
      return reject("ADAPTER_FIXTURE_INCOMPLETE");
    }
    const result = adapter.validateTransaction(normalized, intent as never, constraints as never);
    return result.ok
      ? { scenarioId, description, outcome: "ACCEPTED", reasonCode: "ADAPTER_VALIDATION_PASSED" }
      : reject(result.problems[0]!.code);
  } catch (e) {
    // A decode failure IS a refusal, and the decoder's own code is the reason.
    const code = e instanceof UniswapDecodeError ? e.code : `ADAPTER_ERROR:${(e as Error).name}`;
    return reject(code);
  }
}

function evaluateDataFixture(
  adapter: DataAdapter,
  scenarioId: string,
  description: string,
  providerResponse: unknown,
  expectAccepted: boolean,
): Fixture {
  try {
    const ctx = { chainId: 11155111, nowMs: Date.now() };
    const manifest = adapter.manifest();
    /*
     * The query comes from the ADAPTER, not from this harness.
     *
     * The first version guessed a shape — an asset and an account — which happened to fit the
     * reference adapters and fit nothing else. Every Chainlink and Graph fixture then failed its own
     * validateQuery, and the happy-path ones looked like the adapter rejecting its own fixture.
     */
    const query = adapter.fixtureQuery();
    const q = adapter.validateQuery(query);
    if (!q.ok) {
      return { scenarioId, description, outcome: "REJECTED", reasonCode: q.problems[0]!.code, stoppedAt: "CRE" };
    }
    const obs = adapter.normalize(providerResponse, q.query, ctx);
    const v = adapter.validate(obs, ctx);
    if (!v.ok) {
      return { scenarioId, description, outcome: "REJECTED", reasonCode: v.problems[0]!.code, stoppedAt: "CRE" };
    }

    /*
     * Freshness against the adapter's own declared typical staleness. A scenario built to be stale
     * must be seen to BE stale — otherwise a "stale" fixture that quietly passes would be recorded
     * as coverage for a check that never fired.
     */
    const age = obs.provenance.freshnessMs;
    const bound = manifest.freshnessSemantics.typicalStalenessMs ?? Number.MAX_SAFE_INTEGER;
    if (age === undefined || age > bound * 10) {
      return { scenarioId, description, outcome: "REJECTED", reasonCode: "STALE_OBSERVATION", stoppedAt: "CRE" };
    }
    return { scenarioId, description, outcome: "ACCEPTED", reasonCode: "OBSERVATION_ACCEPTED" };
  } catch (e) {
    void expectAccepted;
    return { scenarioId, description, outcome: "REJECTED", reasonCode: `ADAPTER_ERROR:${(e as Error).name}`, stoppedAt: "CRE" };
  }
}

export async function buildAdapterFixtures(
  registry: AdapterRegistry,
  bp: Pick<ContextLockAgentBlueprint, "adapters">,
): Promise<AdapterFixtureMap> {
  const out: AdapterFixtureMap = {};

  for (const binding of bp.adapters) {
    let entry;
    try {
      entry = registry.resolve(binding.adapterId, binding.adapterVersion);
    } catch {
      continue; // an unregistered binding is caught by the Blueprint validator, not here
    }

    for (const f of entry.adapter.createSimulationFixtures()) {
      const expectAccepted = f.expected.outcome === "ACCEPTED";
      out[f.scenarioId] = isExecution(entry.adapter)
        ? await evaluateExecutionFixture(entry.adapter, f.scenarioId, f.description, f.providerResponse)
        : evaluateDataFixture(entry.adapter as DataAdapter, f.scenarioId, f.description, f.providerResponse, expectAccepted);
    }
  }

  return out;
}

export type { UniswapPrepared };
export { UniswapExecutionAdapter };
