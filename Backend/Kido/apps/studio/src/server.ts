import { buildServer } from "./api.js";
import { SERVER, STUDIO_MODEL, SANDBOX } from "./config.js";
import { devLabDeps, DEMO_PROJECT_ID, type DevLabDeps } from "./lab/dev-wiring.js";
import { reconcileOrphanedLabRuns } from "./lab/cre-sim.js";
import { ForkLabService } from "./fork/service.js";
import { DEFAULT_UPSTREAM_PROVIDER_ID, DEFAULT_UPSTREAM_RPC } from "./fork/chain.js";

/*
 * The Testnet Lab routes are attached with readers that read real things: the pipeline's own
 * tables, the committed P28 evidence, and a live probe of this machine's capabilities. Where a
 * state cannot be read they report absence rather than a plausible default.
 *
 * The fork lab is attached on top: deployments to a local Anvil fork of mainnet, with the P25
 * control plane reading the fork this process runs. The Lab's readers see those deployments, so
 * a locally-built project's lifecycle moves the same way the demo's recorded one does.
 */
let labDeps: DevLabDeps | null = null;
const { app, db, pipeline, fork } = buildServer({
  lab: (db) => (labDeps = devLabDeps(db)),
  fork: (db, lab) => {
    const service = new ForkLabService({
      db,
      readBlueprint: lab.readBlueprint,
      upstreamRpcUrl: process.env.MAINNET_RPC_URL ?? DEFAULT_UPSTREAM_RPC,
      upstreamProviderId: process.env.MAINNET_RPC_URL ? "mainnet-rpc-url" : DEFAULT_UPSTREAM_PROVIDER_ID,
      // One Anvil process per fork. Raise it for a swarm (one fork per member) on a machine that can carry them.
      ...(process.env.STUDIO_MAX_FORKS ? { maxConcurrentForks: Number(process.env.STUDIO_MAX_FORKS) } : {}),
    });
    labDeps?.attachFork(service);
    return service;
  },
});

/*
 * Release concurrency slots held by builds that died with a previous process.
 *
 * Done here rather than inside `buildServer` on purpose: this is the real process boundary. A test
 * that constructs a server and seeds a RUNNING build should get the build it seeded, not one this
 * reconciled out from under it.
 */
const orphaned = pipeline.reconcileOrphanedBuilds();
const orphanedRuns = reconcileOrphanedLabRuns(db);
const orphanedForks = fork?.reconcileOrphaned() ?? [];

/* A fork is a child process. It goes when this one does, and the row is told so on the way out. */
const shutdown = (signal: string) => {
  console.log(`\n${signal}: stopping fork deployments`);
  const stop = fork ? fork.stopAll(`the Studio server received ${signal}`) : Promise.resolve();
  void stop.finally(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

app
  .listen({ port: SERVER.port, host: SERVER.host })
  .then(() => {
    console.log(`ContextLock Studio API  →  http://${SERVER.host}:${SERVER.port}`);
    console.log(`  model    ${STUDIO_MODEL}`);
    console.log(`  sandbox  ${SANDBOX.provider} (${SANDBOX.image}, network=${SANDBOX.networkMode})`);
    console.log(`  lab      attached — demo project ${DEMO_PROJECT_ID}`);
    console.log(`  fork     attached — upstream ${process.env.MAINNET_RPC_URL ? "MAINNET_RPC_URL" : DEFAULT_UPSTREAM_PROVIDER_ID}, anvil ${fork?.anvilAvailable() ? "available" : "NOT FOUND"}`);
    if (orphaned.length > 0) {
      console.log(`  builds   released ${orphaned.length} slot(s) held by builds that died with a previous process: ${orphaned.join(", ")}`);
    }
    if (orphanedRuns.length > 0) console.log(`  runs     marked ${orphanedRuns.length} lab run(s) that died with a previous process as FAILED`);
    if (orphanedForks.length > 0) console.log(`  forks    marked ${orphanedForks.length} fork deployment(s) that died with a previous process as STOPPED: ${orphanedForks.join(", ")}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
