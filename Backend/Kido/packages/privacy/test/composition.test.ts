import { describe, expect, it } from "vitest";
import { emptyBlueprint, nextRevision, type ChainId, type PrivateValueSpec } from "@kido/blueprint";
import { ProviderRegistry } from "@kido/registry";
import { compilePrivacy } from "../src/index.js";

const reg = new ProviderRegistry();
const blind: PrivateValueSpec["hiddenFrom"] = ["PUBLIC_CHAIN", "AI_AGENT", "NORMAL_KIDO_BACKEND"];
const v = (id: string, kind: PrivateValueSpec["kind"], o: Partial<PrivateValueSpec> = {}): PrivateValueSpec => ({ id, description: id, kind, hiddenFrom: blind, plaintextBoundary: "APPROVED_ENCLAVE", allowedDisclosure: "DECISION_ONLY", failurePolicy: "FAIL_CLOSED", ...o });
const plan = (chain: ChainId, values: PrivateValueSpec[], required = true) => compilePrivacy(nextRevision(emptyBlueprint("p", "s", "x"), { chains: [chain], privacy: { required, values, providers: [] } }), reg);
const providers = (p: ReturnType<typeof plan>) => [...new Set(p.providers.map((x) => x.providerId))].sort();

describe("privacy composition follows requirements, not the chain", () => {
  it("§10 example on Sui: API key and threshold enclave-only, decision-only → Seal + Nautilus", () => {
    const p = plan("sui-testnet", [v("risk-api-key", "PRIVATE_API_CREDENTIAL"), v("private-risk-threshold", "PRIVATE_POLICY")]);
    expect(providers(p)).toEqual(["nautilus", "seal"]);
    expect(p.values.every((x) => x.requiredCapabilities.includes("SECRET_ACCESS_CONTROL") && x.requiredCapabilities.includes("CONFIDENTIAL_COMPUTE"))).toBe(true);
  });

  it("the same requirement on Ethereum is one provider covering both roles (CRE), not Seal", () => {
    expect(providers(plan("ethereum-sepolia", [v("risk-api-key", "PRIVATE_API_CREDENTIAL")]))).toEqual(["chainlink-cre"]);
  });

  it("encrypted persistent state only → Seal only", () => {
    expect(providers(plan("sui-testnet", [v("agent-memory", "ENCRYPTED_STATE", { allowedDisclosure: "REDACTED_RESULT" })]))).toEqual(["seal"]);
  });

  it("runtime-fetched private API data processed in an enclave → Nautilus only", () => {
    expect(providers(plan("sui-testnet", [v("risk-score", "PRIVATE_API_RESPONSE")]))).toEqual(["nautilus"]);
  });

  it("a secret hidden only from the AI agent stays in Kido's secret store: no Seal, no Nautilus", () => {
    expect(providers(plan("sui-testnet", [v("risk-api-key", "PRIVATE_API_CREDENTIAL", { hiddenFrom: ["AI_AGENT"], plaintextBoundary: "KIDO_SECRET_STORE", allowedDisclosure: "BOOLEAN_RESULT" })]))).toEqual(["kido-secret-store"]);
  });

  it("no privacy requirement → no provider", () => {
    expect(providers(plan("sui-testnet", [], false))).toEqual([]);
  });

  it("nothing is reported live that is not: Nautilus leaves the plan planning-only with its blocker", () => {
    const p = plan("sui-testnet", [v("private-risk-threshold", "PRIVATE_POLICY")]);
    expect(p.values[0]!.status).toBe("SATISFIED_PLANNING_ONLY");
    expect(p.liveBlockers.join(" ")).toMatch(/nautilus IMPLEMENTED_LOCAL.*BLOCKED_ENV/);
  });
});
