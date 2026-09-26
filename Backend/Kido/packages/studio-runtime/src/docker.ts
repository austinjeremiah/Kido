import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  RuntimeProviderError, RUNTIME_REASONS,
  type AgentRuntimeProvider, type RuntimeCapabilities, type RuntimeRevision, type RuntimeStatus, type StartRuntimeArgs,
} from "./provider.js";
import { assertEnvironmentSafe, assertHardened, dockerArgs, DEFAULT_HARDENING, type HardeningSpec } from "./hardening.js";

const exec = promisify(execFile);

/**
 * The local Docker runtime provider.
 *
 * Runs one agent principal per container, hardened by the specification in `hardening.ts`, from an
 * image referenced by DIGEST.
 *
 * Two decisions worth stating.
 *
 * THE TOKEN IS A FILE, NOT AN ENVIRONMENT VARIABLE. Environment variables appear in `docker
 * inspect`, in `ps -e` output on some systems, in crash dumps, and in every log line that dumps the
 * environment. The scoped credential is written to a tmpfs-backed file, mounted read-only, and
 * deleted from the host as soon as the container has it.
 *
 * EGRESS IS DECLARED `OPEN`, NOT `NONE`. Docker CAN give a container no network — P11 relies on
 * exactly that for the build sandbox — but this runtime must reach four gateways, so it has a
 * network, and a network it has is a network it can use. Claiming `NONE` here because the sandbox
 * claims `NONE` would be the copied-claim mistake §24.8 names. Restricting egress to the gateways
 * needs a Docker network with an egress proxy, which this provider does not create, so it says so.
 */

export const DOCKER_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  providerId: "docker",
  locality: "local",
  // Honest. See the class comment: the runtime needs the gateways, so it has a network.
  networkEgress: "OPEN",
  readOnlyRootFilesystem: true,
  nonRootUser: true,
  noNewPrivileges: true,
  dropAllCapabilities: true,
  cpuLimit: true,
  memoryLimit: true,
  pidLimit: true,
  healthChecks: true,
  // The daemon restarts a failed container; it does not roll back to a previous image revision.
  // That is the control plane's job here, and saying otherwise would credit Docker with a feature
  // it does not have.
  automaticRollback: false,
  digestPinning: true,
  caveats: [
    "Egress is unrestricted. Restricting it to the four gateways requires a Docker network with an egress proxy, which this provider does not create; until it does, the runtime is treated as network-capable and holds no privileged credential.",
    "Docker restarts a failed container. It does not roll back to a previous image revision — the control plane does, by starting the previous digest.",
    "One container per agent principal. This provider refuses to start a second container for an agent that already has one.",
  ],
};

interface LiveContainer {
  revision: RuntimeRevision;
  containerName: string;
  spec: HardeningSpec;
  /** The read-only volume holding this revision's scoped credential. Removed when it stops. */
  tokenVolume: string;
}

export class DockerRuntimeProvider implements AgentRuntimeProvider {
  readonly id = "docker" as const;
  readonly capabilities = DOCKER_RUNTIME_CAPABILITIES;
  private readonly live = new Map<string, LiveContainer>();
  /** One principal per runtime. Enforced, not documented: see §24.1 and RUN-001. */
  private readonly byAgent = new Map<string, string>();

  constructor(private readonly hardening: HardeningSpec = DEFAULT_HARDENING) {
    assertHardened(hardening);
  }

  /** Feed input on stdin, so a secret is never a command-line argument. */
  private dockerWithStdin(args: string[], input: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile("docker", args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new RuntimeProviderError(RUNTIME_REASONS.UNAVAILABLE, `docker ${args[0]} failed: ${(stderr || err.message).trim()}`));
        else resolve(stdout.trim());
      });
      child.stdin?.end(input);
    });
  }

  private async docker(args: string[]): Promise<string> {
    try {
      const { stdout } = await exec("docker", args, { maxBuffer: 8 * 1024 * 1024 });
      return stdout.trim();
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      throw new RuntimeProviderError(RUNTIME_REASONS.UNAVAILABLE, `docker ${args[0]} failed: ${(err.stderr || err.message).trim()}`);
    }
  }

  async deploy(args: StartRuntimeArgs): Promise<RuntimeRevision> {
    assertEnvironmentSafe(args.environment);

    const existing = this.byAgent.get(args.revision.agentId);
    if (existing && this.live.has(existing)) {
      throw new RuntimeProviderError(
        RUNTIME_REASONS.MUTATION_ATTEMPTED,
        `agent "${args.revision.agentId}" already has runtime revision ${existing}. One security principal per runtime task: replace it with a new revision rather than adding a second container for the same principal.`,
      );
    }

    const containerName = `contextlock-agent-${args.revision.agentId}-${args.revision.revisionId}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");

    /*
     * The token, delivered through a READ-ONLY NAMED VOLUME.
     *
     * The obvious approach — `docker cp` the file into the container — does not work, and the live
     * hardening check is how that was discovered: the daemon refuses `cp` into a container whose
     * rootfs is marked read-only, whether the container is created or running, and whether or not
     * the destination is a writable mount. "container rootfs is marked read-only".
     *
     * A named volume, seeded by a throwaway container and then mounted `:ro`, avoids that and is
     * strictly better than what was intended:
     *
     *   - it is not a host path, so §24.7's "no host filesystem mounts" still holds;
     *   - the token never appears in `docker inspect`, because it is not an environment variable;
     *   - the runtime can READ its credential and cannot OVERWRITE it, so a compromised process
     *     cannot substitute a token of its own choosing;
     *   - the volume is removed with the runtime, so the credential does not outlive it.
     */
    const tokenVolume = `contextlock-rt-${args.revision.revisionId}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
    const tokenDir = args.runtimeTokenPath.replace(/\/[^/]+$/, "");
    const tokenFile = args.runtimeTokenPath.slice(tokenDir.length + 1);
    try {
      await this.docker(["volume", "create", tokenVolume]);
      // Seeded by a throwaway container. The token reaches the volume through this container's
      // stdin, so it is never a command-line argument and never appears in a process listing.
      await this.dockerWithStdin(
        ["run", "--rm", "-i", "--user", "0:0", "-v", `${tokenVolume}:/seed`, "--entrypoint", "sh",
         args.revision.imageDigest, "-c", `cat > /seed/${tokenFile} && chown ${this.hardening.user.split(":")[0]}:${this.hardening.user.split(":")[1]} /seed/${tokenFile} && chmod 0400 /seed/${tokenFile}`],
        args.runtimeToken,
      );
      const env: string[] = [];
      for (const [k, v] of Object.entries(args.environment)) env.push("-e", `${k}=${v}`);
      env.push("-e", `CONTEXTLOCK_RUNTIME_TOKEN_PATH=${args.runtimeTokenPath}`);
      env.push("-e", `CONTEXTLOCK_HEALTH_PORT=${args.healthPort}`);
      env.push("-e", "CONTEXTLOCK_START_PAUSED=1");

      const spec: HardeningSpec = {
        ...this.hardening,
        cpus: args.cpu || this.hardening.cpus,
        memoryMb: args.memoryMb || this.hardening.memoryMb,
        pidsLimit: args.pidLimit || this.hardening.pidsLimit,
        /*
         * The token's directory is deliberately NOT a tmpfs.
         *
         * A tmpfs mount does not exist until the container starts, so a token copied in before
         * start lands nowhere — the live hardening check found exactly that. The image creates
         * `/run/contextlock` owned by the runtime user; `docker cp` writes into the container's own
         * layer at create time, and `--read-only` then makes it unwritable at run time. The token
         * is never in the image, and it goes with the container.
         */
        tmpfs: this.hardening.tmpfs,
      };

      // `create`, then `cp` the token in, then `start`. Copying into a running container would mean
      // the process could start before its credential exists; copying into a created-but-not-started
      // one means it is there the moment the entrypoint runs.
      await this.docker([
        "create", "--name", containerName,
        ...dockerArgs(spec),
        ...env,
        "--label", `com.contextlock.agent-id=${args.revision.agentId}`,
        "--label", `com.contextlock.deployment-id=${args.revision.deploymentId}`,
        "--label", `com.contextlock.revision-id=${args.revision.revisionId}`,
        "--label", `com.contextlock.image-digest=${args.revision.imageDigest}`,
        // The digest, not the tag. A tag here would start whatever it points at today.
        // Read-only. The runtime reads its credential; it cannot replace it.
        "--volume", `${tokenVolume}:${tokenDir}:ro`,
        args.revision.imageDigest.startsWith("sha256:") && args.environment.CONTEXTLOCK_IMAGE_REF
          ? args.environment.CONTEXTLOCK_IMAGE_REF
          : args.revision.imageDigest,
      ]);

      this.live.set(args.revision.revisionId, { revision: { ...args.revision, desiredState: "INACTIVE" }, containerName, spec, tokenVolume });
      this.byAgent.set(args.revision.agentId, args.revision.revisionId);
      // Created, not started. A deployment leaves the runtime INACTIVE.
      return { ...args.revision, desiredState: "INACTIVE" };
    } catch (e) {
      // A failed create must not leave a volume holding a live credential behind it.
      await this.docker(["volume", "rm", "--force", tokenVolume]).catch(() => undefined);
      throw e;
    }
  }

  async activate(revisionId: string): Promise<RuntimeStatus> {
    const c = this.mustFind(revisionId);
    await this.docker(["start", c.containerName]);
    c.revision.desiredState = "RUNNING";
    return this.inspect(revisionId);
  }

  async pause(revisionId: string): Promise<RuntimeStatus> {
    const c = this.mustFind(revisionId);
    await this.docker(["stop", "--timeout", "20", c.containerName]);
    c.revision.desiredState = "PAUSED";
    return this.inspect(revisionId);
  }

  async resume(revisionId: string): Promise<RuntimeStatus> {
    return this.activate(revisionId);
  }

  /**
   * An update is a NEW revision from a NEW digest.
   *
   * Never a change to a running container. `docker exec`, `docker cp` into a running runtime, and
   * anything else that edits code in place is absent from this provider — a running production
   * container that can be modified is a container whose running code no longer corresponds to any
   * reviewed artifact.
   */
  async update(args: StartRuntimeArgs): Promise<RuntimeRevision> {
    const previousId = this.byAgent.get(args.revision.agentId) ?? null;
    if (previousId) {
      const prev = this.live.get(previousId);
      if (prev && prev.revision.imageDigest === args.revision.imageDigest && previousId !== args.revision.revisionId) {
        throw new RuntimeProviderError(
          RUNTIME_REASONS.MUTATION_ATTEMPTED,
          `revision ${args.revision.revisionId} names the same image digest as ${previousId}. An update must be a new immutable digest; nothing is mutated in place.`,
        );
      }
      await this.stop(previousId).catch(() => undefined);
      this.byAgent.delete(args.revision.agentId);
    }
    const created = await this.deploy({ ...args, revision: { ...args.revision, previousRevisionId: previousId } });
    return created;
  }

  /** Roll back to a pinned previous digest — the recorded one, never "the last thing that worked". */
  async rollback(toRevisionId: string): Promise<RuntimeRevision> {
    const target = this.live.get(toRevisionId);
    if (!target) {
      throw new RuntimeProviderError(
        RUNTIME_REASONS.NO_ROLLBACK_TARGET,
        `revision ${toRevisionId} is not retained by this provider. A rollback needs a pinned digest to go back to; there is no "previous version" to infer.`,
      );
    }
    await this.docker(["start", target.containerName]);
    target.revision.desiredState = "RUNNING";
    this.byAgent.set(target.revision.agentId, toRevisionId);
    return target.revision;
  }

  async stop(revisionId: string): Promise<RuntimeStatus> {
    const c = this.mustFind(revisionId);
    await this.docker(["rm", "--force", c.containerName]).catch(() => undefined);
    // The credential goes with the runtime. A volume left behind is a token left behind.
    await this.docker(["volume", "rm", "--force", c.tokenVolume]).catch(() => undefined);
    c.revision.desiredState = "STOPPED";
    const status: RuntimeStatus = {
      revisionId,
      providerId: this.id,
      running: false,
      observedImageDigest: null,
      health: "STOPPED",
      restarts: 0,
      // Said on every stop, because this is the sentence an operator is most likely to misread.
      detail: "The container is stopped. This is an operational stop: the ContextLock policy is unchanged, and any capability already issued to this agent remains valid.",
    };
    this.live.delete(revisionId);
    if (this.byAgent.get(c.revision.agentId) === revisionId) this.byAgent.delete(c.revision.agentId);
    return status;
  }

  async inspect(revisionId: string): Promise<RuntimeStatus> {
    const c = this.mustFind(revisionId);
    const raw = await this.docker(["inspect", c.containerName, "--format", "{{.State.Running}}|{{.State.Health.Status}}|{{.RestartCount}}|{{.Image}}|{{.State.Status}}"]);
    const [running, health, restarts, image, state] = raw.split("|");
    // What is running is READ BACK. A provider that reported the digest it was asked for would
    // never notice that it started something else.
    if (image && c.revision.imageDigest && image !== c.revision.imageDigest && !image.startsWith("sha256:")) {
      throw new RuntimeProviderError(RUNTIME_REASONS.DIGEST_MISMATCH, `container ${c.containerName} is running ${image}, not ${c.revision.imageDigest}`);
    }
    return {
      revisionId,
      providerId: this.id,
      running: running === "true",
      observedImageDigest: image || null,
      health: health && health !== "<no value>" ? health.toUpperCase() : (state ?? "unknown").toUpperCase(),
      restarts: Number(restarts || 0),
      detail: `docker state=${state}`,
    };
  }

  async health(revisionId: string): Promise<RuntimeStatus> {
    return this.inspect(revisionId);
  }

  private mustFind(revisionId: string): LiveContainer {
    const c = this.live.get(revisionId);
    if (!c) throw new RuntimeProviderError(RUNTIME_REASONS.UNKNOWN_PROVIDER, `no live revision ${revisionId} in this provider`);
    return c;
  }

  /** For the control plane's use: what this provider currently holds. */
  revisions(): RuntimeRevision[] {
    return [...this.live.values()].map((c) => c.revision);
  }
}

export const newRevisionId = (): string => `rev_${randomUUID().slice(0, 8)}`;
