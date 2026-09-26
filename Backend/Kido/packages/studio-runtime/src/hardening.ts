import { z } from "zod";

/**
 * The container hardening specification.
 *
 * Every control in §1.9 and §24.7, expressed once, as data — so that the Docker provider, the ECS
 * reference and the tests are all reading the same list rather than three copies that drift.
 *
 * The distinction that matters: a Dockerfile can make an image non-root and can leave no shell-
 * accessible toolchain in it. It cannot make the root filesystem read-only, drop capabilities, set
 * `no-new-privileges`, or bound CPU and memory. Those are properties of how a container is RUN, so
 * they live here and are applied by the provider — and a provider that cannot apply one says so in
 * its capabilities rather than being trusted to have done it.
 */

export const HardeningSpecSchema = z.object({
  /** Never root. The image declares a uid; the run asserts it. */
  user: z.string().regex(/^\d+:\d+$/, "numeric uid:gid — a name would be resolved inside the container"),
  readOnlyRootFilesystem: z.literal(true),
  noNewPrivileges: z.literal(true),
  /** Everything dropped. The runtime binds no privileged port and opens no raw socket. */
  capDrop: z.array(z.string()).min(1),
  capAdd: z.array(z.string()).max(0),
  privileged: z.literal(false),
  /** The only writable path, and it is memory-backed and lost on restart, which is the point. */
  tmpfs: z.array(z.object({ path: z.string(), sizeMb: z.number().int().positive(), noexec: z.literal(true), nosuid: z.literal(true) })).min(1),
  /** No bind mounts at all. Not "no sensitive ones" — none. */
  bindMounts: z.array(z.never()).max(0),
  dockerSocket: z.literal(false),
  cpus: z.string(),
  memoryMb: z.number().int().positive(),
  pidsLimit: z.number().int().positive(),
  healthcheck: z.literal(true),
  restartPolicy: z.string(),
  /** Host networking would put the container on the host's stack and undo the rest of this. */
  hostNetwork: z.literal(false),
  hostPid: z.literal(false),
  hostIpc: z.literal(false),
});
export type HardeningSpec = z.infer<typeof HardeningSpecSchema>;

export const DEFAULT_HARDENING: HardeningSpec = {
  user: "10001:10001",
  readOnlyRootFilesystem: true,
  noNewPrivileges: true,
  capDrop: ["ALL"],
  capAdd: [],
  privileged: false,
  tmpfs: [{ path: "/tmp/contextlock", sizeMb: 64, noexec: true, nosuid: true }],
  bindMounts: [],
  dockerSocket: false,
  cpus: "0.5",
  memoryMb: 512,
  pidsLimit: 128,
  healthcheck: true,
  restartPolicy: "on-failure:3",
  hostNetwork: false,
  hostPid: false,
  hostIpc: false,
};

export const HARDENING_REASONS = {
  PRIVILEGED: "HARDEN-PRIVILEGED-REFUSED",
  ROOT_USER: "HARDEN-ROOT-USER-REFUSED",
  WRITABLE_ROOT: "HARDEN-WRITABLE-ROOT-REFUSED",
  DOCKER_SOCKET: "HARDEN-DOCKER-SOCKET-REFUSED",
  BIND_MOUNT: "HARDEN-BIND-MOUNT-REFUSED",
  CAPABILITY_ADDED: "HARDEN-CAPABILITY-ADDED-REFUSED",
  HOST_NAMESPACE: "HARDEN-HOST-NAMESPACE-REFUSED",
  NO_LIMITS: "HARDEN-RESOURCE-LIMITS-MISSING",
} as const;
export type HardeningReason = (typeof HARDENING_REASONS)[keyof typeof HARDENING_REASONS];

export class HardeningError extends Error {
  constructor(readonly reason: HardeningReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "HardeningError";
  }
}

/**
 * Refuse a specification that has been weakened.
 *
 * The schema makes most of these unrepresentable, but a spec can arrive from configuration as
 * untyped JSON, and "unrepresentable in TypeScript" stops being a guarantee at the process
 * boundary. So it is checked, and each weakening is refused by its own name.
 */
export function assertHardened(spec: unknown): asserts spec is HardeningSpec {
  const s = spec as Record<string, unknown>;
  if (s.privileged === true) throw new HardeningError(HARDENING_REASONS.PRIVILEGED, "--privileged gives the container the host; there is no configuration in which the agent runtime needs it");
  if (typeof s.user !== "string" || s.user === "0:0" || s.user === "root" || s.user === "") {
    throw new HardeningError(HARDENING_REASONS.ROOT_USER, `the runtime must not run as root (user=${JSON.stringify(s.user)})`);
  }
  if (s.readOnlyRootFilesystem !== true) throw new HardeningError(HARDENING_REASONS.WRITABLE_ROOT, "the root filesystem must be read-only; scratch space is an explicit tmpfs");
  if (s.dockerSocket === true) throw new HardeningError(HARDENING_REASONS.DOCKER_SOCKET, "the Docker socket is root on the host with extra steps");
  if (Array.isArray(s.bindMounts) && s.bindMounts.length > 0) throw new HardeningError(HARDENING_REASONS.BIND_MOUNT, `no host path is mounted into the runtime (${(s.bindMounts as unknown[]).length} requested)`);
  if (Array.isArray(s.capAdd) && s.capAdd.length > 0) throw new HardeningError(HARDENING_REASONS.CAPABILITY_ADDED, `capabilities added: ${(s.capAdd as string[]).join(", ")}`);
  if (!Array.isArray(s.capDrop) || !(s.capDrop as string[]).includes("ALL")) throw new HardeningError(HARDENING_REASONS.CAPABILITY_ADDED, "all Linux capabilities must be dropped");
  if (s.noNewPrivileges !== true) throw new HardeningError(HARDENING_REASONS.CAPABILITY_ADDED, "no-new-privileges must be set, or a setuid binary in the image can regain what cap-drop removed");
  if (s.hostNetwork === true || s.hostPid === true || s.hostIpc === true) {
    throw new HardeningError(HARDENING_REASONS.HOST_NAMESPACE, "sharing a host namespace undoes the isolation the rest of this specification buys");
  }
  if (!s.memoryMb || !s.cpus || !s.pidsLimit) {
    throw new HardeningError(HARDENING_REASONS.NO_LIMITS, "CPU, memory and PID limits are required; an unbounded runtime is a denial-of-service against everything else on the host");
  }
}

/** The `docker run` arguments this specification produces. Built once, so tests read the real list. */
export function dockerArgs(spec: HardeningSpec): string[] {
  assertHardened(spec);
  const args: string[] = [
    "--user", spec.user,
    "--read-only",
    "--security-opt", "no-new-privileges:true",
    "--cpus", spec.cpus,
    "--memory", `${spec.memoryMb}m`,
    "--pids-limit", String(spec.pidsLimit),
    "--restart", spec.restartPolicy,
  ];
  for (const c of spec.capDrop) args.push("--cap-drop", c);
  for (const t of spec.tmpfs) {
    /*
     * `mode=1777` is not decoration.
     *
     * Docker mounts a tmpfs owned by root with a restrictive default mode, so a container running
     * as uid 10001 — which this one does — cannot write to its own scratch directory. The live
     * hardening check caught it: "the explicit tmpfs IS writable" failed while every other control
     * passed, which is the failure mode where hardening quietly breaks the application.
     *
     * 1777 is world-writable with the sticky bit, exactly like /tmp. The mount is still noexec and
     * nosuid, and it is the only writable path in the container.
     */
    args.push("--tmpfs", `${t.path}:rw,noexec,nosuid,mode=1777,size=${t.sizeMb}m`);
  }
  return args;
}

/**
 * Environment variables the runtime is allowed to receive.
 *
 * A whitelist by prefix, then an explicit denial pass. Both, because the prefix rule alone would
 * pass `CONTEXTLOCK_ADMIN_KEY`, and the denial list alone would pass anything nobody thought of.
 */
export const ALLOWED_ENV_PREFIX = "CONTEXTLOCK_";

export const DENIED_ENV_EXACT = new Set([
  "CONTEXTLOCK_ADMIN_KEY",
  "CONTEXTLOCK_ISSUER_KEY",
  "CONTEXTLOCK_CAPABILITY_ISSUER_PRIVATE_KEY",
  "CONTEXTLOCK_PRIVATE_KEY",
  "CONTEXTLOCK_WALLET_KEY",
  "CONTEXTLOCK_CRE_API_KEY",
  "CONTEXTLOCK_OPENAI_API_KEY",
  "CONTEXTLOCK_RUNTIME_TOKEN",
]);

export function assertEnvironmentSafe(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) {
    if (DENIED_ENV_EXACT.has(k)) {
      throw new HardeningError(HARDENING_REASONS.NO_LIMITS, `"${k}" must not be passed to a runtime container`);
    }
    if (!k.startsWith(ALLOWED_ENV_PREFIX)) {
      throw new HardeningError(HARDENING_REASONS.NO_LIMITS, `"${k}" is outside the ${ALLOWED_ENV_PREFIX}* namespace the runtime is configured through`);
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(v) && !/HASH|DIGEST|NODE$/i.test(k)) {
      throw new HardeningError(HARDENING_REASONS.NO_LIMITS, `"${k}" holds a 32-byte hex value under a name that is not a hash`);
    }
    if (/^sk-(?:proj-)?[A-Za-z0-9_-]{20,}$/.test(v) || /^eyJ[A-Za-z0-9_-]{8,}\./.test(v)) {
      throw new HardeningError(HARDENING_REASONS.NO_LIMITS, `"${k}" holds credential-shaped material`);
    }
  }
}
