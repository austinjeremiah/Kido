/**
 * The runtime's configuration, and the far more interesting question of what it must NOT have.
 *
 * This process is the data plane. It runs generated code, it talks to a language model, and it is
 * the thing an attacker would target first — so the architecture's whole answer to "what if the
 * agent is compromised?" rests on this file being right:
 *
 *     THE RUNTIME HOLDS NO PRIVILEGED CREDENTIAL. NOT ENCRYPTED, NOT SCOPED-DOWN, NOT AT ALL.
 *
 * It has one short-lived token that authenticates it to four narrow gateways, and that token cannot
 * authorize a blockchain transaction. Everything else — wallet keys, the capability issuer, the CRE
 * session, the OpenAI key, provider master keys, cloud credentials — lives on the other side of
 * those gateways and never crosses.
 *
 * `assertNoForbiddenEnvironment` is not defence in depth for its own sake. It runs at startup and
 * REFUSES TO START, because a runtime that boots with a wallet key present has already lost the
 * property this whole design is built on, and the failure would otherwise be silent.
 */

import { z } from "zod";

/**
 * Every credential this process must never see.
 *
 * A list rather than a pattern. A pattern would be cleverer and would miss the one nobody named;
 * this list is checked against the actual environment, and adding a provider means adding its key
 * here, which is a decision someone has to make on purpose.
 */
export const FORBIDDEN_ENV = [
  // wallets and signing
  "DEPLOYER_PRIVATE_KEY", "FUNDER_PRIVATE_KEY", "AGENT_PRIVATE_KEY", "RELAYER_PRIVATE_KEY",
  "CAPABILITY_ISSUER_PRIVATE_KEY", "APPROVER_STANDIN_PRIVATE_KEY", "CRE_ETH_PRIVATE_KEY",
  "PRIVATE_KEY", "MNEMONIC", "SEED_PHRASE", "KEYSTORE_PASSWORD", "WALLET_PASS",
  // ContextLock administration
  "CONTEXTLOCK_ADMIN_KEY", "CONTEXTLOCK_ISSUER_KEY", "POLICY_ADMIN_KEY",
  // CRE
  "CRE_API_KEY", "CRE_SESSION", "CRE_ACCESS_TOKEN", "CRE_REFRESH_TOKEN",
  // model and provider master credentials
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "THEGRAPH_API_KEY", "UNISWAP_API_KEY", "E2B_API_KEY",
  // cloud deployment
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "DOCKER_AUTH_CONFIG",
  "GOOGLE_APPLICATION_CREDENTIALS", "AZURE_CLIENT_SECRET",
  // hardware
  "LEDGER_PIN", "LEDGER_SEED",
] as const;

/** Filesystem paths whose presence inside the container is equally disqualifying. */
export const FORBIDDEN_PATHS = [
  "/root/.cre/cre.yaml",
  "/home/contextlock/.cre/cre.yaml",
  "/root/.aws/credentials",
  "/home/contextlock/.aws/credentials",
  "/var/run/docker.sock",
  "/run/docker.sock",
  "/app/.env",
] as const;

export class RuntimeStartupError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "RuntimeStartupError";
  }
}

/**
 * Refuse to start if a privileged credential is present.
 *
 * Deliberately fails LOUDLY and does not name the value — the error names the variable, which is
 * what an operator needs, and quoting the secret into a crash log would be its own leak.
 */
export function assertNoForbiddenEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const present = FORBIDDEN_ENV.filter((k) => typeof env[k] === "string" && env[k]!.length > 0);
  if (present.length > 0) {
    throw new RuntimeStartupError(
      "RUNTIME-FORBIDDEN-CREDENTIAL-PRESENT",
      `${present.join(", ")} ${present.length === 1 ? "is" : "are"} set in this runtime's environment. The agent runtime is the data plane: it authenticates to the Model Gateway, Adapter Broker, ContextLock Broker and Telemetry Gateway with a short-lived scoped token, and holds no privileged credential. Remove these from the task definition.`,
    );
  }
  // A key smuggled under an unrecognised name is caught by shape rather than by name.
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (/^0x[0-9a-fA-F]{64}$/.test(v)) {
      throw new RuntimeStartupError("RUNTIME-FORBIDDEN-CREDENTIAL-PRESENT", `${k} holds a 32-byte hex value, which is the shape of a private key`);
    }
    if (/^sk-(?:proj-)?[A-Za-z0-9_-]{20,}$/.test(v)) {
      throw new RuntimeStartupError("RUNTIME-FORBIDDEN-CREDENTIAL-PRESENT", `${k} holds an OpenAI-shaped API key`);
    }
    if (/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v)) {
      throw new RuntimeStartupError("RUNTIME-FORBIDDEN-CREDENTIAL-PRESENT", `${k} holds a PEM private key`);
    }
  }
}

/**
 * The configuration this runtime IS allowed.
 *
 * Identifiers, endpoints and hashes. Every field here is something an attacker who read it would
 * learn nothing useful from — which is the test for whether it belongs in this process at all.
 */
export const RuntimeConfigSchema = z.object({
  deploymentId: z.string().min(1),
  agentId: z.string().min(1),
  organizationId: z.string().nullable(),
  /** The digest this container was launched from. Bound into the runtime token. */
  imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  blueprintHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  strategyHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),

  /** The four gateways. Nothing else is reachable, and nothing else is configurable. */
  modelGatewayUrl: z.string().url(),
  adapterBrokerUrl: z.string().url(),
  contextlockBrokerUrl: z.string().url(),
  telemetryUrl: z.string().url(),

  /**
   * The short-lived scoped runtime credential.
   *
   * Read from a file rather than an environment variable so it can be rotated by replacing the file
   * without restarting, and so it does not appear in `docker inspect`, in a task definition, or in
   * a crash dump of the environment.
   */
  runtimeTokenPath: z.string().min(1),

  healthPort: z.number().int().positive(),
  /** Where the writable scratch tmpfs is mounted. Nothing durable is kept here. */
  scratchDir: z.string().min(1),
  logLevel: z.enum(["error", "warn", "info", "debug"]),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  assertNoForbiddenEnvironment(env);
  const parsed = RuntimeConfigSchema.safeParse({
    deploymentId: env.CONTEXTLOCK_DEPLOYMENT_ID,
    agentId: env.CONTEXTLOCK_AGENT_ID,
    organizationId: env.CONTEXTLOCK_ORGANIZATION_ID ?? null,
    imageDigest: env.CONTEXTLOCK_IMAGE_DIGEST,
    blueprintHash: env.CONTEXTLOCK_BLUEPRINT_HASH,
    strategyHash: env.CONTEXTLOCK_STRATEGY_HASH,
    modelGatewayUrl: env.CONTEXTLOCK_MODEL_GATEWAY_URL,
    adapterBrokerUrl: env.CONTEXTLOCK_ADAPTER_BROKER_URL,
    contextlockBrokerUrl: env.CONTEXTLOCK_BROKER_URL,
    telemetryUrl: env.CONTEXTLOCK_TELEMETRY_URL,
    runtimeTokenPath: env.CONTEXTLOCK_RUNTIME_TOKEN_PATH ?? "/run/contextlock/runtime-token",
    healthPort: Number(env.CONTEXTLOCK_HEALTH_PORT ?? 8080),
    scratchDir: env.CONTEXTLOCK_SCRATCH_DIR ?? "/tmp/contextlock",
    logLevel: (env.CONTEXTLOCK_LOG_LEVEL ?? "info") as RuntimeConfig["logLevel"],
  });
  if (!parsed.success) {
    throw new RuntimeStartupError("RUNTIME-CONFIG-INVALID", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}
