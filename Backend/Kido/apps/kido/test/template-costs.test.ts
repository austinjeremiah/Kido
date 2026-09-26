import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INTERVIEW_TEMPLATES } from "@kido/design-interview";
import { PRICING } from "@kido/registry";
import { createFoundry, loadConfig } from "../src/index.js";

/** The cross-chain treasury template asks three questions and builds five agents; its costs come from the registry. */
const here = fileURLToPath(new URL(".", import.meta.url));
const f = createFoundry(loadConfig({ KIDO_DATA_DIR: mkdtempSync(join(tmpdir(), "kido-tpl-")), KIDO_AMANE_MANIFEST: resolve(here, "../../../../Aname/deployments/testnet.json") }));
const tpl = INTERVIEW_TEMPLATES.find((t) => t.id === "tpl_crosschain_treasury")!;
const ANSWERS: Record<string, string> = {
  payees: `northwind on Ethereum Sepolia: 0x${"ab".repeat(20)}; harbor on Sui testnet: 0x${"cd".repeat(32)}`,
  beneficiary: `0x${"ef".repeat(20)} on Ethereum Sepolia`,
  "limits.window": "100 per hour, 1000 total",
};

describe("interview template", () => {
  it("asks only the template's questions and builds every agent", async () => {
    const c = await f.create("", undefined, tpl.id);
    expect(f.summary(c.projectId).interview.warnings).toEqual([]);
    const asked: string[] = [];
    let q = c.question;
    while (q) {
      asked.push(q.key);
      q = (await f.answer(c.projectId, ANSWERS[q.key]!)).next;
    }
    expect(asked).toEqual(tpl.asks.map((a) => a.key));
    expect((await f.edit(c.projectId, "identity.name", "treasury.acmecorp")).accepted).toBe(true);
    const fin = f.finalize(c.projectId);
    expect(fin.blockers).toEqual([]);
    expect(fin.blueprint.agents.map((a) => a.role).sort()).toEqual(["BridgeAgent", "PaymentAgent", "RecoveryAgent", "RepayDebtAgent", "SwapAgent"]);
    expect(fin.blueprint.authority.limits.every((l) => l.perWindow !== "0")).toBe(true);
    expect(fin.identityPlan.filter((b) => !b.role).map((b) => b.name).sort()).toEqual(["treasury.acmecorp.eth", "treasury.acmecorp.sui"]);
    // A template answer is visible as such, not disguised as something the user typed.
    expect(fin.blueprint.requirements.find((r) => r.key === "protocols")?.provenance?.kind).toBe("TEMPLATE");
    expect(f.securityReview(c.projectId).blocking).toBe(false);
    expect((await f.simulate(c.projectId)).passed).toBe(true);
    f.build(c.projectId);

    const k = f.costs(c.projectId);
    const line = (id: string) => k.lines.find((l) => l.id === id)!;
    for (const id of ["amane", "aave-v3", "uniswap-v3", "cetus-clmm", "wormhole", "ens", "suins", "the-graph", "openai-model"]) expect(line(id)).toBeDefined();
    expect(line("uniswap-v3").paid).toBe(false);
    expect(line("ens").items[0]!.usd).toBeCloseTo(PRICING.ens!.namePerYearUsd! / 12, 2);
    expect(line("suins").items[0]!.usd).toBeCloseTo(PRICING.suins!.namePerYearUsd! / 12, 2);
    expect(line("nautilus").optional).toBe(true);
    expect(k.totals.monthlyUsd).toBeCloseTo(k.lines.filter((l) => !l.optional).reduce((n, l) => n + l.monthlyUsd, 0), 1);
    // Fewer actions cost less; the owner's assumptions drive the estimate.
    expect(f.costs(c.projectId, { actionsPerMonth: { SWAP: 1 } }).totals.monthlyUsd).toBeLessThan(k.totals.monthlyUsd);
  });

  it("rejects a limits answer without both amounts", async () => {
    const c = await f.create("", undefined, tpl.id);
    let q = c.question;
    while (q && q.key !== "limits.window") q = (await f.answer(c.projectId, ANSWERS[q.key]!)).next;
    const r = await f.answer(c.projectId, "100 per hour");
    expect(r.accepted).toBe(false);
  });
});
