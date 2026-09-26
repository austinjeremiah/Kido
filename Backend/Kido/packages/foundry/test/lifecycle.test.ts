import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAmaneManifest } from "@kido/amane-bridge";
import { RuleBasedInterviewModel } from "@kido/design-interview";
import { FileProjectStore, Foundry, LifecycleError } from "../src/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const manifest = loadAmaneManifest(resolve(here, "../../../../Aname/deployments/testnet.json"));
// Simulation-only signer addresses: nothing here holds a controller key.
const addr = () => privateKeyToAccount(generatePrivateKey()).address;
const SUI_PAYEE = `0x${"ab".repeat(32)}`;

let foundry: Foundry;
beforeEach(() => {
  foundry = new Foundry({
    store: new FileProjectStore(mkdtempSync(join(tmpdir(), "kido-foundry-"))),
    model: new RuleBasedInterviewModel(),
    amaneManifest: manifest,
    signers: { controllers: [addr()], issuer: addr(), agent: addr() },
  });
});

async function interview(objective: string, answers: Record<string, string>) {
  const { projectId, question } = await foundry.create(objective);
  let q = question;
  while (q) {
    const a = answers[q.key];
    if (a === undefined) throw new Error(`unexpected question ${q.key}: ${q.text}`);
    q = (await foundry.answer(projectId, a)).next;
  }
  return projectId;
}

const PAYMENTS = {
  "authority.mode": "act on its own within limits",
  "authority.withdraw": "no",
  "actions.allowed": "pay approved recipients",
  "authority.arbitrary_recipients": "no, only approved ones",
  "authority.autonomy": "automatically",
  payees: `acme supplies: ${SUI_PAYEE}`,
  "limits.window": "50",
  "limits.total": "500",
  "identity.public": "no",
  "privacy.required": "no",
  "recovery.partial": "stop and notify me",
};

describe("foundry lifecycle", () => {
  it("a Sui payments agent goes from interview to build through every gate", async () => {
    const id = await interview("Build a Sui agent that pays my supplier invoices", PAYMENTS);
    const fin = foundry.finalize(id);
    expect(fin.blockers).toEqual([]);
    const review = foundry.securityReview(id);
    expect(review.findings.filter((f) => f.blocking)).toEqual([]);
    const sim = await foundry.simulate(id);
    const verdict = Object.fromEntries(sim.results.map((r) => [r.id, r.actual]));
    expect(verdict).toMatchObject({ "happy-path": "ALLOW", overspend: "REJECT", "wrong-recipient": "REJECT", "expired-authority": "REJECT", "prompt-injection": "REJECT" });
    expect(sim.passed).toBe(true);
    const build = foundry.build(id);
    expect(build.authority).toMatchObject({ mode: "BOUNDED_AUTONOMOUS_FINANCE", provider: "AMANE", excludedActions: [] });
    expect(build.agents.map((a) => a.role)).toEqual(["PaymentAgent"]);
    expect(build.agents[0]!.missingPacks).toEqual([]);
    expect(foundry.status(id)).toMatchObject({ security: "CURRENT", simulation: "CURRENT", build: "CURRENT", blockers: [] });
  });

  it("an edit after review makes the review and simulation stale and blocks the build", async () => {
    const id = await interview("Build a Sui agent that pays my supplier invoices", PAYMENTS);
    foundry.finalize(id);
    foundry.securityReview(id);
    await foundry.simulate(id);
    expect((await foundry.edit(id, "limits.window", "20")).accepted).toBe(true);
    const next = foundry.finalize(id);
    expect(next.blueprint.authority.limits[0]!.perWindow).toBe("20000000");
    expect(foundry.status(id)).toMatchObject({ security: "STALE", simulation: "STALE" });
    expect(() => foundry.build(id)).toThrow(/KIDO_LIFECYCLE_STALE_REVIEW/);
  });

  it("build refuses before finalize", async () => {
    const id = await interview("Build a Sui agent that pays my supplier invoices", PAYMENTS);
    expect(() => foundry.build(id)).toThrow(LifecycleError);
    expect(() => foundry.build(id)).toThrow(/KIDO_LIFECYCLE_NOT_FINALIZED/);
  });

  it("an action whose Amane adapter is not shipped blocks the build instead of being granted", async () => {
    const id = await interview("Build me an agent that protects my Aave position.", {
      "authority.mode": "Act on its own within limits I set",
      "authority.withdraw": "No, never",
      "actions.allowed": "It may repay my debt",
      "authority.autonomy": "Only when a condition it can prove on-chain occurs",
      "limits.window": "500 USDC",
      "limits.total": "2,000",
      "identity.public": "no",
      "privacy.required": "no",
      "monitor.condition": "health factor below 1.5",
      "recovery.partial": "stop and notify me",
    });
    expect(foundry.finalize(id).blockers).toEqual([]);
    const review = foundry.securityReview(id);
    expect(review.findings.some((f) => f.blocking && /adapter/.test(f.evidence))).toBe(true);
    await foundry.simulate(id);
    expect(() => foundry.build(id)).toThrow(/KIDO_LIFECYCLE_BLOCKING_FINDINGS/);
  });
});
