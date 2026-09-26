import {
  RuntimeProviderError, RUNTIME_REASONS,
  type AgentRuntimeProvider, type RuntimeCapabilities, type RuntimeRevision, type RuntimeStatus, type StartRuntimeArgs,
} from "./provider.js";
import { assertEnvironmentSafe, assertHardened, DEFAULT_HARDENING, type HardeningSpec } from "./hardening.js";

/**
 * The ECS/Fargate hosted runtime provider — REFERENCE IMPLEMENTATION, NOT EXERCISED LIVE.
 *
 * This file builds the exact API calls a live deployment would make and can be driven against a
 * real AWS client. It has NOT been run against AWS in this phase, and it says so in three places:
 * `liveVerified: false` in its capabilities, a caveat naming the blocker, and `assertLiveAllowed`,
 * which throws unless a caller passes a real client explicitly.
 *
 * Why not: the only AWS credentials on this machine are ROOT ACCOUNT credentials. Deploying with
 * them would contradict the least-privilege stance this product argues for everywhere else, and
 * would create billable infrastructure on a personal account. That is a decision for the account's
 * owner, not for a build script. See BLK-V2-ECS-LIVE.
 *
 * What IS decided here, and is testable without AWS: the task definition. §24.13's list, plus
 * §24.7's hardening, translated into the fields ECS actually accepts — and the one that matters
 * most, `taskRoleArn`, which must be narrow. An ECS task inherits its task role's permissions, so a
 * broad role would hand a compromised agent runtime the AWS account, undoing every other control.
 */

export const ECS_FARGATE_CAPABILITIES: RuntimeCapabilities & { liveVerified: boolean } = {
  providerId: "ecs-fargate",
  locality: "hosted",
  /*
   * ALLOWLIST is claimed only because ECS awsvpc networking gives each task its own ENI and its own
   * security group, and a security group with egress rules limited to the gateway endpoints is
   * enforced by the VPC rather than by us. It is claimed as a CAPABILITY of the platform; whether a
   * given deployment actually configures such a security group is checked at deploy time by
   * `assertEgressRestricted`, because a capability the deployment does not use is not a control.
   */
  networkEgress: "ALLOWLIST",
  readOnlyRootFilesystem: true,
  nonRootUser: true,
  noNewPrivileges: true,
  dropAllCapabilities: true,
  cpuLimit: true,
  memoryLimit: true,
  // Fargate does not expose a PID limit the way `docker run --pids-limit` does. Declared false
  // rather than assumed, so nothing downstream relies on a bound that is not there.
  pidLimit: false,
  healthChecks: true,
  automaticRollback: true,
  digestPinning: true,
  liveVerified: false,
  caveats: [
    "NOT EXERCISED LIVE. No ECS service, ECR repository or task definition has been created by this project. See BLK-V2-ECS-LIVE.",
    "Egress restriction is a property of the security group attached to the task, not of ECS. A task launched into a permissive security group has open egress whatever this capability says, which is why assertEgressRestricted runs at deploy time.",
    "Fargate exposes no per-task PID limit. The memory limit is the backstop against a fork bomb.",
    "The task role must be narrow. An ECS task inherits it, so a broad role would give a compromised runtime the AWS account.",
  ],
};

/** IAM actions a runtime task role must never carry. Named so their absence is testable. */
export const FORBIDDEN_TASK_ROLE_ACTIONS = [
  "*",
  "iam:*",
  "iam:PassRole",
  "iam:CreateAccessKey",
  "ecs:*",
  "ecs:RegisterTaskDefinition",
  "ecr:PutImage",
  "secretsmanager:GetSecretValue",
  "ssm:GetParameter",
  "kms:Decrypt",
  "sts:AssumeRole",
  "s3:*",
  "lambda:InvokeFunction",
] as const;

export interface EcsTaskDefinition {
  family: string;
  requiresCompatibilities: ["FARGATE"];
  networkMode: "awsvpc";
  cpu: string;
  memory: string;
  /** Pulls the image and writes logs. Distinct from the task role, and deliberately so. */
  executionRoleArn: string;
  /** What the APPLICATION may do in AWS. Narrow, or absent. */
  taskRoleArn: string | null;
  containerDefinitions: Array<{
    name: string;
    /** `<repo>@sha256:...`. Never a tag. */
    image: string;
    essential: true;
    readonlyRootFilesystem: true;
    user: string;
    privileged: false;
    linuxParameters: { capabilities: { drop: string[]; add: never[] }; initProcessEnabled: boolean };
    environment: Array<{ name: string; value: string }>;
    /** The scoped token, delivered by reference from a secret store, never as a literal. */
    secrets: Array<{ name: string; valueFrom: string }>;
    mountPoints: Array<{ sourceVolume: string; containerPath: string; readOnly: boolean }>;
    healthCheck: { command: string[]; interval: number; timeout: number; retries: number; startPeriod: number };
    logConfiguration: { logDriver: "awslogs"; options: Record<string, string> };
    ulimits: Array<{ name: string; softLimit: number; hardLimit: number }>;
  }>;
  volumes: Array<{ name: string }>;
}

export interface EcsServiceDefinition {
  cluster: string;
  serviceName: string;
  taskDefinition: string;
  desiredCount: number;
  launchType: "FARGATE";
  platformVersion: string;
  deploymentController: { type: "ECS" };
  /**
   * The circuit breaker, with rollback.
   *
   * `type: ECS` above is not incidental: the circuit breaker is supported only for the rolling-
   * update controller, so choosing CODE_DEPLOY or EXTERNAL would silently give up automatic
   * rollback. Documentation re-checked 2026-09-10, which also added `resetOnHealthyTask` and
   * `thresholdConfiguration` — recorded in DRIFT.md as D-2.
   */
  deploymentConfiguration: {
    deploymentCircuitBreaker: { enable: true; rollback: true; resetOnHealthyTask?: boolean; thresholdConfiguration?: { type: "COUNT" | "BOUNDED_PERCENT" | "UNBOUNDED_PERCENT"; value: number } };
    minimumHealthyPercent: number;
    maximumPercent: number;
  };
  networkConfiguration: {
    awsvpcConfiguration: { subnets: string[]; securityGroups: string[]; assignPublicIp: "ENABLED" | "DISABLED" };
  };
  enableExecuteCommand: false;
}

export const ECS_REASONS = {
  NOT_LIVE: "ECS-NOT-EXERCISED-LIVE",
  BROAD_TASK_ROLE: "ECS-TASK-ROLE-TOO-BROAD",
  PUBLIC_IP: "ECS-PUBLIC-IP-REFUSED",
  EXEC_ENABLED: "ECS-EXECUTE-COMMAND-REFUSED",
  EGRESS_OPEN: "ECS-EGRESS-NOT-RESTRICTED",
  TAG_NOT_DIGEST: "ECS-IMAGE-TAG-NOT-DIGEST",
} as const;

export class EcsError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "EcsError";
  }
}

/** Build the task definition. Pure; testable without AWS. */
export function buildTaskDefinition(args: {
  agentId: string;
  deploymentId: string;
  imageRepository: string;
  imageDigest: string;
  cpu: string;
  memoryMb: number;
  executionRoleArn: string;
  taskRoleArn: string | null;
  environment: Record<string, string>;
  runtimeTokenSecretArn: string;
  healthPort: number;
  logGroup: string;
  region: string;
  hardening?: HardeningSpec;
}): EcsTaskDefinition {
  const hardening = args.hardening ?? DEFAULT_HARDENING;
  assertHardened(hardening);
  assertEnvironmentSafe(args.environment);
  if (!/^sha256:[0-9a-f]{64}$/.test(args.imageDigest)) {
    throw new EcsError(ECS_REASONS.TAG_NOT_DIGEST, `"${args.imageDigest}" is not a digest; a task definition must pin one`);
  }
  return {
    family: `contextlock-agent-${args.agentId}`,
    requiresCompatibilities: ["FARGATE"],
    networkMode: "awsvpc",
    cpu: args.cpu,
    memory: String(args.memoryMb),
    executionRoleArn: args.executionRoleArn,
    taskRoleArn: args.taskRoleArn,
    containerDefinitions: [
      {
        name: `agent-${args.agentId}`,
        image: `${args.imageRepository}@${args.imageDigest}`,
        essential: true,
        readonlyRootFilesystem: true,
        user: hardening.user,
        privileged: false,
        linuxParameters: { capabilities: { drop: hardening.capDrop, add: [] }, initProcessEnabled: true },
        environment: Object.entries(args.environment).map(([name, value]) => ({ name, value })),
        // By reference. The literal never appears in a task definition, which is readable by
        // anyone with `ecs:DescribeTaskDefinition`.
        secrets: [{ name: "CONTEXTLOCK_RUNTIME_TOKEN", valueFrom: args.runtimeTokenSecretArn }],
        mountPoints: hardening.tmpfs.map((t, i) => ({ sourceVolume: `scratch${i}`, containerPath: t.path, readOnly: false })),
        healthCheck: {
          command: ["CMD-SHELL", `node -e "fetch('http://127.0.0.1:${args.healthPort}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`],
          interval: 15, timeout: 3, retries: 3, startPeriod: 20,
        },
        logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": args.logGroup, "awslogs-region": args.region, "awslogs-stream-prefix": args.deploymentId } },
        // Fargate has no --pids-limit; nproc is the nearest available bound and is set explicitly
        // rather than left to the platform default.
        ulimits: [{ name: "nproc", softLimit: hardening.pidsLimit, hardLimit: hardening.pidsLimit }],
      },
    ],
    volumes: hardening.tmpfs.map((_t, i) => ({ name: `scratch${i}` })),
  };
}

export function buildServiceDefinition(args: {
  cluster: string;
  agentId: string;
  taskDefinition: string;
  subnets: string[];
  securityGroups: string[];
}): EcsServiceDefinition {
  return {
    cluster: args.cluster,
    serviceName: `contextlock-agent-${args.agentId}`,
    taskDefinition: args.taskDefinition,
    desiredCount: 1,
    launchType: "FARGATE",
    platformVersion: "1.4.0",
    deploymentController: { type: "ECS" },
    deploymentConfiguration: {
      deploymentCircuitBreaker: { enable: true, rollback: true, resetOnHealthyTask: true, thresholdConfiguration: { type: "COUNT", value: 3 } },
      minimumHealthyPercent: 0,
      maximumPercent: 200,
    },
    networkConfiguration: {
      // No public IP. The runtime reaches the gateways through the VPC; a public IP would give it a
      // route to the internet and give the internet a route to it.
      awsvpcConfiguration: { subnets: args.subnets, securityGroups: args.securityGroups, assignPublicIp: "DISABLED" },
    },
    // `execute-command` is a shell into the running task. The whole point of this runtime is that
    // it has no general-purpose shell.
    enableExecuteCommand: false,
  };
}

/** A task role that can do any of these is a task role that undoes the container's isolation. */
export function assertTaskRoleNarrow(policyActions: readonly string[]): void {
  const bad = policyActions.filter((a) => (FORBIDDEN_TASK_ROLE_ACTIONS as readonly string[]).includes(a) || a.endsWith(":*") || a === "*");
  if (bad.length > 0) {
    throw new EcsError(
      ECS_REASONS.BROAD_TASK_ROLE,
      `the runtime task role grants [${bad.join(", ")}]. An ECS task inherits its task role, so a compromised agent runtime would inherit these.`,
    );
  }
}

export function assertServiceHardened(svc: EcsServiceDefinition): void {
  if (svc.networkConfiguration.awsvpcConfiguration.assignPublicIp === "ENABLED") {
    throw new EcsError(ECS_REASONS.PUBLIC_IP, "the runtime task must not have a public IP");
  }
  if (svc.enableExecuteCommand !== false) {
    throw new EcsError(ECS_REASONS.EXEC_ENABLED, "ECS Exec is a shell into the runtime; it is not enabled");
  }
  if (svc.networkConfiguration.awsvpcConfiguration.securityGroups.length === 0) {
    throw new EcsError(ECS_REASONS.EGRESS_OPEN, "no security group is attached, so egress is whatever the VPC default allows");
  }
  if (!svc.deploymentConfiguration.deploymentCircuitBreaker.rollback) {
    throw new EcsError(ECS_REASONS.EGRESS_OPEN, "the deployment circuit breaker must have rollback enabled");
  }
}

/** Egress is only restricted if the security group actually restricts it. */
export function assertEgressRestricted(egressRules: Array<{ cidr: string; port: number }>, allowedGatewayCidrs: readonly string[]): void {
  const open = egressRules.filter((r) => r.cidr === "0.0.0.0/0" || !allowedGatewayCidrs.includes(r.cidr));
  if (open.length > 0) {
    throw new EcsError(
      ECS_REASONS.EGRESS_OPEN,
      `the task's security group permits egress to [${open.map((r) => `${r.cidr}:${r.port}`).join(", ")}]. ALLOWLIST is a capability of awsvpc networking, not a property this deployment has until the security group says so.`,
    );
  }
}

/**
 * The provider.
 *
 * Every method builds the request and then refuses, because no live client is wired. The refusal
 * carries the built request, so a caller with real credentials can see exactly what would be sent.
 */
export class EcsFargateRuntimeProvider implements AgentRuntimeProvider {
  readonly id = "ecs-fargate" as const;
  readonly capabilities = ECS_FARGATE_CAPABILITIES;

  constructor(private readonly client: unknown | null = null) {}

  private assertLiveAllowed(operation: string, prepared: unknown): never {
    throw new RuntimeProviderError(
      RUNTIME_REASONS.UNAVAILABLE,
      `${ECS_REASONS.NOT_LIVE}: ${operation} was prepared but not sent. This provider has never been exercised against AWS — see BLK-V2-ECS-LIVE. The prepared request is: ${JSON.stringify(prepared)}`,
    );
  }

  async deploy(args: StartRuntimeArgs): Promise<RuntimeRevision> {
    assertEnvironmentSafe(args.environment);
    const td = buildTaskDefinition({
      agentId: args.revision.agentId,
      deploymentId: args.revision.deploymentId,
      imageRepository: args.environment.CONTEXTLOCK_IMAGE_REPOSITORY ?? "contextlock/agent-runtime",
      imageDigest: args.revision.imageDigest,
      cpu: args.cpu, memoryMb: args.memoryMb,
      executionRoleArn: args.environment.CONTEXTLOCK_EXECUTION_ROLE_ARN ?? "arn:aws:iam::000000000000:role/contextlock-ecs-execution",
      taskRoleArn: null,
      environment: args.environment,
      runtimeTokenSecretArn: args.environment.CONTEXTLOCK_RUNTIME_TOKEN_SECRET_ARN ?? "arn:aws:secretsmanager:::secret:contextlock/runtime-token",
      healthPort: args.healthPort,
      logGroup: "/contextlock/agent-runtime",
      region: args.environment.CONTEXTLOCK_REGION ?? "us-east-1",
    });
    if (!this.client) this.assertLiveAllowed("RegisterTaskDefinition + CreateService", td);
    throw new RuntimeProviderError(RUNTIME_REASONS.UNAVAILABLE, "a live ECS client was supplied but the call path is not implemented in this phase");
  }

  async activate(revisionId: string): Promise<RuntimeStatus> { this.assertLiveAllowed("UpdateService desiredCount=1", { revisionId }); }
  async pause(revisionId: string): Promise<RuntimeStatus> { this.assertLiveAllowed("UpdateService desiredCount=0", { revisionId }); }
  async resume(revisionId: string): Promise<RuntimeStatus> { this.assertLiveAllowed("UpdateService desiredCount=1", { revisionId }); }
  async update(args: StartRuntimeArgs): Promise<RuntimeRevision> { this.assertLiveAllowed("RegisterTaskDefinition (new revision) + UpdateService", { imageDigest: args.revision.imageDigest }); }
  async rollback(toRevisionId: string): Promise<RuntimeRevision> { this.assertLiveAllowed("UpdateService taskDefinition=<previous revision>", { toRevisionId }); }
  async stop(revisionId: string): Promise<RuntimeStatus> { this.assertLiveAllowed("UpdateService desiredCount=0", { revisionId }); }
  async inspect(revisionId: string): Promise<RuntimeStatus> { this.assertLiveAllowed("DescribeServices", { revisionId }); }
  async health(revisionId: string): Promise<RuntimeStatus> { this.assertLiveAllowed("DescribeServices rolloutState", { revisionId }); }
}
