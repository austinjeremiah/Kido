import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { loadConfig, RuntimeStartupError, type RuntimeConfig } from "./config.js";
import { evaluateHealth, HEALTH_NOTE, type HealthInputs } from "./health.js";

/**
 * The agent runtime entrypoint.
 *
 * Startup order matters, and the first thing it does is the security check:
 *
 *   1. refuse to start if any privileged credential is present
 *   2. load the scoped runtime token from its file
 *   3. serve health
 *   4. restore the event cursor from the control plane
 *   5. run the approved Strategy, calling only the four gateways
 *
 * Step 1 is first because a runtime that has already started with a wallet key in its environment
 * has already had the opportunity to use it. Failing at step 5 would be too late.
 *
 * This process has no general-purpose shell, no build tools, and no way to reach anything but the
 * gateways. It is the data plane, and it is designed on the assumption that one day it will be the
 * compromised part.
 */

const startedAtMs = Date.now();

function readRuntimeToken(config: RuntimeConfig): string {
  try {
    return readFileSync(config.runtimeTokenPath, "utf8").trim();
  } catch (e) {
    throw new RuntimeStartupError(
      "RUNTIME-TOKEN-UNREADABLE",
      `no scoped runtime credential at ${config.runtimeTokenPath}. The runtime authenticates to the gateways with a short-lived token issued by the control plane; without it there is nothing this process is entitled to do. (${(e as Error).message})`,
    );
  }
}

function main(): void {
  let config: RuntimeConfig;
  try {
    config = loadConfig();
  } catch (e) {
    // Loud, and on stderr, and non-zero. A container that fails this check must not restart into a
    // half-configured state that looks like it is working.
    console.error(`[contextlock-runtime] STARTUP REFUSED — ${(e as Error).message}`);
    process.exit(78); // EX_CONFIG
    return;
  }

  const state = {
    lastHeartbeatMs: null as number | null,
    paused: process.env.CONTEXTLOCK_START_PAUSED === "1",
    stopping: false,
    controlPlaneReachable: false,
    modelGatewayReachable: false,
    adapterBrokerReachable: false,
    contextlockBrokerReachable: false,
    eventCursorAgeMs: null as number | null,
    recentRestarts: Number(process.env.CONTEXTLOCK_RECENT_RESTARTS ?? 0),
  };

  // The token is read but never logged, never echoed on the health endpoint, and never sent
  // anywhere but the four gateway audiences it names.
  const token = readRuntimeToken(config);
  if (token.length === 0) {
    console.error("[contextlock-runtime] STARTUP REFUSED — the runtime token file is empty");
    process.exit(78);
    return;
  }

  const server = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/healthz") {
      const inputs: HealthInputs = { ...state, processStartedAtMs: startedAtMs, nowMs: Date.now() };
      const verdict = evaluateHealth(inputs);
      const body = {
        state: verdict.state,
        agentId: config.agentId,
        deploymentId: config.deploymentId,
        imageDigest: config.imageDigest,
        uptimeMs: Date.now() - startedAtMs,
        reasons: verdict.reasons,
        note: HEALTH_NOTE,
      };
      res.writeHead(verdict.state === "HEALTHY" ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    // There is no other route. No /env, no /config, no /debug, no /metrics that echoes settings.
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(config.healthPort, "0.0.0.0", () => {
    console.log(`[contextlock-runtime] agent=${config.agentId} deployment=${config.deploymentId} digest=${config.imageDigest} health=:${config.healthPort} paused=${state.paused}`);
    console.log("[contextlock-runtime] no wallet key, no issuer key, no CRE credential, no provider master key is present in this process");
  });

  const shutdown = (signal: string) => {
    state.stopping = true;
    console.log(`[contextlock-runtime] ${signal} received; stopping. Note: stopping this runtime does NOT disable the ContextLock policy.`);
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // The strategy loop is driven by the control plane in P25. Until then the runtime serves health
  // and holds its scoped identity — which is exactly the state a deployment leaves it in: INACTIVE.
  state.lastHeartbeatMs = Date.now();
  setInterval(() => { state.lastHeartbeatMs = Date.now(); }, 10_000).unref?.();
}

main();
