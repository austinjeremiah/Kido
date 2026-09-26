import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * The official Chainlink CRE CLI, really executed.
 *
 * Everything else in this package proves the provider builds the right command and behaves when the
 * process misbehaves. Only this proves the command is one the real tool accepts — the seam a fake
 * cannot cover, which is the lesson FND-V2-E-004 cost a live deployment to learn.
 *
 * It needs the CRE CLI, a funded RPC and network access, so it is opt-in:
 *
 *     CONTEXTLOCK_LIVE_CRE=1 npx vitest run crelab-live
 *
 * When it is skipped, the recorded evidence from the last real run is still asserted, so a claim
 * about the simulator is never left resting on nothing.
 */

const CLI = `${process.env.HOME}/.cre/bin/cre`;
const WORKFLOW_DIR = new URL("../../../workflows/cre-policy/contextlock-cre/", import.meta.url).pathname;
const EVIDENCE = new URL("../../../reports/group-testnet-lab/evidence/p26-cre-simulation-live.txt", import.meta.url).pathname;

/** A real Sepolia transaction that emitted `CapabilityRequested` from the deployed gateway. */
const REAL_TX = "0x62753fddb9c92d2ff9989c430e2ca47224f992ac3243eb77bea05eda21679843";
/** The binary hash this workflow compiles to. Unchanged since Phase 4. */
const PINNED_WASM = "800d0d561132d79476981e6297979ff51a18372b23bd8b0a0e891f32d10800e0";

const live = process.env.CONTEXTLOCK_LIVE_CRE === "1" && existsSync(CLI);

describe("CRELAB-003 the official CRE CLI, executed for real", () => {
  it.skipIf(!live)("CRELAB-003-LIVE a real Sepolia event drives a real simulation", () => {
    /*
     * Both streams.
     *
     * The CLI writes its verdict to stdout and its progress — including the line proving it fetched
     * the real receipt — to stderr. Reading stdout alone captures the answer and loses the evidence
     * of where the answer came from, which is the half that matters here.
     */
    const run = spawnSync(CLI, [
      "workflow", "simulate", "policy",
      "--target", "staging-settings",
      "--non-interactive",
      "--trigger-index", "0",
      "--evm-tx-hash", REAL_TX,
      "--evm-event-index", "0",
    ], { cwd: WORKFLOW_DIR, encoding: "utf8", timeout: 300_000, env: { ...process.env } });
    const out = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    expect(run.status, `the CLI exited ${run.status}:\n${out}`).toBe(0);

    // The official tool compiled and ran it.
    expect(out).toMatch(/Workflow compiled/);
    expect(out).toMatch(new RegExp(`Binary hash: ${PINNED_WASM}`));
    // Production limits, on by default and stated in the output (CRELAB-005).
    expect(out).toMatch(/Simulation limits enabled/);
    // It fetched the real receipt rather than a fixture.
    expect(out).toMatch(new RegExp(`Fetching transaction receipt for ${REAL_TX}`));
    expect(out).toMatch(/Workflow Simulation Result/);
    // And it is a simulation: no deployment, no DON, no attestation.
    expect(out).not.toMatch(/Workflow deployed|Execution ID|DON execution/i);
  }, 320_000);

  it("CRELAB-003-EVIDENCE the recorded live run says what a simulation may say, and nothing more", () => {
    /*
     * Asserted whether or not the live test runs, because the evidence file is what the report cites.
     * If the file ever disappears or is rewritten to claim a deployment, this fails.
     */
    expect(existsSync(EVIDENCE), `${EVIDENCE} is missing — the P26 report cites it`).toBe(true);
    const text = readFileSync(EVIDENCE, "utf8");

    // Five scenes, five verdicts, all produced by the official binary.
    const results = [...text.matchAll(/^"([A-Z]+:[A-Z_]+:[A-Z]+)"$/gm)].map((m) => m[1]);
    expect(results).toEqual([
      "ALLOW:ALLOW_POLICY_MATCH:LOW",
      "ESCALATE:ESCALATE_AMOUNT:MEDIUM",
      "DENY:DENY_AMOUNT_TOO_HIGH:HIGH",
      "ESCALATE:ESCALATE_RISK:HIGH",
      "DENY:DENY_SLIPPAGE:HIGH",
    ]);

    // One artifact across all five runs: the same code decided every verdict.
    const binaries = new Set([...text.matchAll(/Binary hash: ([0-9a-f]{64})/g)].map((m) => m[1]));
    expect([...binaries]).toEqual([PINNED_WASM]);

    // Five different configs, so the config hash tracks the config rather than being decorative.
    const configs = new Set([...text.matchAll(/Config hash: ([0-9a-f]{64})/g)].map((m) => m[1]));
    expect(configs.size).toBe(5);

    // Production limits were enabled on every run — none of these results came from --limits none.
    expect([...text.matchAll(/Simulation limits enabled/g)].length).toBe(5);

    // No claim a simulation is not entitled to make.
    expect(text).not.toMatch(/workflow deployed|execution id|DON execution|TEE attested/i);
    // The simulator's own disclaimer is present rather than stripped.
    expect(text).toMatch(/The simulator is not a real TEE/);
  });

  it("CRELAB-003-EVIDENCE-b the transactions it simulated are real, and are the gateway's", () => {
    const text = readFileSync(EVIDENCE, "utf8");
    // topic0 of CapabilityRequested, recorded from `cast sig-event` rather than pasted.
    expect(text).toMatch(/topic0\s+: 0x819e594ed0e379e230a6144ae81e8ce064d230e0ab3a38e8afcf81b600a1494b/);
    expect(text).toMatch(/gateway\s+: 0xA2cD6003b092a4F4a69b86e75b60dcDD7737d9Bb/);
    // Each scene names the block its transaction is in, so the claim is checkable on a block explorer.
    const blocks = [...text.matchAll(/on-chain block : (\d+)/g)].map((m) => Number(m[1]));
    expect(blocks.length).toBe(5);
    for (const b of blocks) expect(b).toBeGreaterThan(11_000_000);
  });
});
