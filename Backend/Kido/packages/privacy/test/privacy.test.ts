import { describe, expect, it } from "vitest";
import { buildBlockers, emptyBlueprint, nextRevision, type KidoAgentBlueprint, type PrivateValueSpec } from "@kido/blueprint";
import { ProviderRegistry } from "@kido/registry";
import { PrivacyGuard, PrivacyLeakError, applyPrivacyPlan, compilePrivacy } from "../src/index.js";
const FACTS = new ProviderRegistry().gateFacts();

const reg = new ProviderRegistry();
const v = (o: Partial<PrivateValueSpec>): PrivateValueSpec => ({ id: "x", description: "x", kind: "PRIVATE_API_CREDENTIAL", hiddenFrom: ["AI_AGENT"], plaintextBoundary: "KIDO_SECRET_STORE", allowedDisclosure: "FULL_RESULT", failurePolicy: "FAIL_CLOSED", ...o });
const bp = (chains: KidoAgentBlueprint["chains"], values: PrivateValueSpec[], required = true) => {
  const b = emptyBlueprint("p", "s", "x");
  return nextRevision(b, { chains, authority: { ...b.authority, mode: "READ_ONLY" }, privacy: { required, values, providers: [] } });
};

describe("privacy requirements compiler", () => {
  it("no privacy requirement → no provider at all", () => {
    expect(compilePrivacy(bp(["sui-testnet"], [], false), reg)).toEqual({ required: false, values: [], providers: [], liveBlockers: [] });
  });

  it("API key hidden from the model only → host secret store, nothing external", () => {
    const p = compilePrivacy(bp(["ethereum-sepolia"], [v({ id: "api-key" })]), reg);
    expect(p.values[0]).toMatchObject({ status: "SATISFIED", selected: ["kido-secret-store"], requiredCapabilities: ["SECRET_STORAGE"] });
    expect(p.providers.map((x) => x.providerId)).toEqual(["kido-secret-store"]);
  });

  it("API key hidden from Kido's own backend cannot sit in Kido's secret store", () => {
    const p = compilePrivacy(bp(["sui-testnet"], [v({ id: "api-key", hiddenFrom: ["AI_AGENT", "NORMAL_KIDO_BACKEND"] })]), reg);
    expect(p.values[0]).toMatchObject({ status: "UNSATISFIABLE" });
    expect(p.values[0]!.reasons[0]).toMatch(/contradicts/);
  });

  it("API key hidden from the backend, plaintext only in an enclave → Seal (persistent, enclave-only access) + Nautilus on Sui, planning-only with its live blocker", () => {
    const p = compilePrivacy(bp(["sui-testnet"], [v({ id: "api-key", hiddenFrom: ["NORMAL_KIDO_BACKEND"], plaintextBoundary: "APPROVED_ENCLAVE" })]), reg);
    expect(p.values[0]).toMatchObject({ status: "SATISFIED_PLANNING_ONLY" });
    expect([...p.values[0]!.selected].sort()).toEqual(["nautilus", "seal"]);
    expect(p.liveBlockers.join()).toMatch(/BE-NAUT-1/);
  });

  it("private threshold with decision-only output: Sui → Seal + Nautilus, Ethereum → CRE (different providers, same Kido role)", () => {
    const val = v({ id: "risk-threshold", kind: "PRIVATE_POLICY", hiddenFrom: ["PUBLIC_CHAIN", "AI_AGENT", "NORMAL_KIDO_BACKEND"], plaintextBoundary: "APPROVED_ENCLAVE", allowedDisclosure: "DECISION_ONLY" });
    const p = compilePrivacy(bp(["sui-testnet", "ethereum-sepolia"], [val]), reg);
    const bySel = Object.fromEntries(p.values.map((x) => [x.chain, x.selected]));
    expect([...bySel["sui-testnet"]!].sort()).toEqual(["nautilus", "seal"]);
    expect(bySel["ethereum-sepolia"]).toEqual(["chainlink-cre"]);
    expect(p.values[0]!.requiredCapabilities).toEqual(expect.arrayContaining(["CONFIDENTIAL_COMPUTE", "VERIFIABLE_COMPUTE", "DECISION_ONLY_OUTPUT"]));
    expect(p.values.every((x) => x.trust.length > 0)).toBe(true);
  });

  it("encrypted persistent state kept off-chain → Seal on Sui (live), no compute enclave added", () => {
    const p = compilePrivacy(bp(["sui-testnet"], [v({ id: "state", kind: "ENCRYPTED_STATE", hiddenFrom: ["PUBLIC_CHAIN", "OTHER_USERS"], plaintextBoundary: "APPROVED_ENCLAVE" })]), reg);
    expect(p.values[0]).toMatchObject({ status: "SATISFIED", selected: ["seal"], requiredCapabilities: ["ENCRYPTED_STATE"] });
  });

  it("encrypted state on Ethereum has no provider → UNSATISFIABLE, never silently downgraded", () => {
    const p = compilePrivacy(bp(["ethereum-sepolia"], [v({ id: "state", kind: "ENCRYPTED_STATE", hiddenFrom: ["PUBLIC_CHAIN"], plaintextBoundary: "APPROVED_ENCLAVE" })]), reg);
    expect(p.values[0]!.status).toBe("UNSATISFIABLE");
  });

  it("a value needed at runtime cannot live only on the user's device", () => {
    const p = compilePrivacy(bp(["sui-testnet"], [v({ id: "t", kind: "PRIVATE_POLICY", plaintextBoundary: "USER_DEVICE" })]), reg);
    expect(p.values[0]!.status).toBe("UNSATISFIABLE");
  });

  it("the compiled plan makes the blueprint buildable; an unsatisfiable value keeps it blocked", () => {
    const ok = bp(["ethereum-sepolia"], [v({ id: "api-key" })]);
    expect(buildBlockers(applyPrivacyPlan(ok, compilePrivacy(ok, reg)), FACTS)).toEqual([]);
    const bad = bp(["ethereum-sepolia"], [v({ id: "api-key", hiddenFrom: ["NORMAL_KIDO_BACKEND"] })]);
    expect(buildBlockers(applyPrivacyPlan(bad, compilePrivacy(bad, reg)), FACTS).map((b) => b.code)).toContain("KIDO_BLUEPRINT_UNSATISFIABLE");
  });
});

describe("privacy guard", () => {
  it("redacts registered values from log lines and refuses them in model context or public records", () => {
    const g = new PrivacyGuard();
    g.register("risk-threshold", "1.4375");
    const lines: string[] = [];
    g.logger((l) => lines.push(l))("threshold 1.4375 crossed");
    expect(lines).toEqual(["threshold [private:risk-threshold] crossed"]);
    expect(() => g.assertClean("context: act below 1.4375", "model-context")).toThrow(PrivacyLeakError);
    expect(() => g.assertCleanObject({ records: { note: "fine" } }, "ens-records")).not.toThrow();
  });
});
