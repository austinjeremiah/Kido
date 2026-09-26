import { describe, expect, it } from "vitest";
import {
  applyResolutions,
  buildBlockers,
  emptyBlueprint,
  nextRevision,
  ConfirmedRequirementError,
  type KidoAgentBlueprint,
  type RequirementResolution,
} from "../src/index.js";

const EVM = `0x${"11".repeat(20)}`;
const SUI = `0x${"ab".repeat(32)}`;

/** A minimal buildable bounded-finance blueprint on one chain (REPAY on Aave, USDC limits). */
function baseline(patch: (b: KidoAgentBlueprint) => Partial<KidoAgentBlueprint> = () => ({})): KidoAgentBlueprint {
  const e = emptyBlueprint("p1", "s", "protect my Aave position");
  const bp = nextRevision(e, {
    chains: ["ethereum-sepolia"],
    assets: [{ symbol: "USDC", chain: "ethereum-sepolia", ref: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8", decimals: 6, testnetOnly: true }],
    authority: {
      ...e.authority,
      mode: "BOUNDED_AUTONOMOUS_FINANCE",
      provider: "AMANE",
      autonomy: "VERIFIABLE_CONDITION",
      allowedActions: ["REPAY"],
      limits: [{ chain: "ethereum-sepolia", asset: "USDC", perAction: "250000000", perWindow: "500000000", windowSeconds: 3600, total: "2000000000" }],
      beneficiaries: [{ label: "self", chain: "ethereum-sepolia", address: "SELF" }],
      bridgeAllowed: false,
    },
    recovery: { ...e.recovery, onPartialExecution: "HALT_AND_NOTIFY" },
    privacy: { required: false, values: [], providers: [] },
    identity: { ...e.identity, public: false },
  });
  return nextRevision(bp, patch(bp));
}
const codes = (bp: KidoAgentBlueprint) => buildBlockers(bp).map((b) => b.code);

describe("BREAK: buildability gate", () => {
  it("baseline fixture is buildable", () => {
    expect(codes(baseline())).toEqual([]);
  });

  it("break_F0514_withdraw_or_borrow_granted_passes_gate", () => {
    // Withdrawal and borrowing are never agent authority (§10.3.3; catalog marks them UNSATISFIABLE).
    const withdraw = baseline((b) => ({ authority: { ...b.authority, allowedActions: ["REPAY", "WITHDRAW"], forbiddenActions: ["BORROW"] } }));
    expect(codes(withdraw).length).toBeGreaterThan(0);
    const borrow = baseline((b) => ({ authority: { ...b.authority, allowedActions: ["REPAY", "BORROW"], forbiddenActions: ["WITHDRAW"] } }));
    expect(codes(borrow).length).toBeGreaterThan(0);
  });

  it("break_F0515_user_required_resolved_without_user_answer_passes_gate", () => {
    const req = (o: Partial<RequirementResolution>): RequirementResolution => ({
      key: "authority.bridge", topic: "AUTHORITY", class: "USER_REQUIRED", critical: true, status: "RESOLVED", value: true, confirmed: false, ...o,
    });
    for (const provenance of [undefined, { kind: "SAFE_DEFAULT" as const, reason: "x" }, { kind: "INFERRED" as const, from: ["chains"], rule: "x" }]) {
      const bp = baseline((b) => ({ requirements: [req({ provenance })] }));
      expect(codes(bp), JSON.stringify(provenance)).toContain("KIDO_BLUEPRINT_UNRESOLVED");
    }
  });

  it("break_F0504_bridge_action_allowed_while_bridging_denied", () => {
    const denied = baseline((b) => ({ authority: { ...b.authority, allowedActions: ["REPAY", "BRIDGE"], bridgeAllowed: false } }));
    expect(codes(denied).length).toBeGreaterThan(0);
  });

  it("break_F0504_bridge_allowed_with_empty_cross_chain_policy", () => {
    const empty = baseline((b) => ({
      chains: ["ethereum-sepolia"],
      authority: { ...b.authority, bridgeAllowed: true },
      crossChain: { allowed: true, transports: [], maxAmountPerIntent: [], recoveryDeadlineSeconds: 3600 },
    }));
    expect(codes(empty).length).toBeGreaterThan(0);
  });

  it("break_F0516_limits_not_bound_to_assets_or_unique", () => {
    // limit denominated in an asset the blueprint does not hold on that chain
    const wrongAsset = baseline((b) => ({ authority: { ...b.authority, limits: [{ ...b.authority.limits[0]!, asset: "AMSUI" }] } }));
    expect(codes(wrongAsset).length).toBeGreaterThan(0);
    // two limits for the same chain/asset: which one does the policy compiler honour?
    const dup = baseline((b) => ({ authority: { ...b.authority, limits: [b.authority.limits[0]!, { ...b.authority.limits[0]!, perAction: "1000000000000000", perWindow: "1000000000000000", total: "1000000000000000" }] } }));
    expect(codes(dup).length).toBeGreaterThan(0);
    // limit for a chain the agent does not operate on
    const foreign = baseline((b) => ({ authority: { ...b.authority, limits: [...b.authority.limits, { ...b.authority.limits[0]!, chain: "sui-testnet", asset: "AMUSD" }] } }));
    expect(codes(foreign).length).toBeGreaterThan(0);
  });

  it("break_F0517_payee_or_beneficiary_off_chain_or_malformed", () => {
    const suiBeneficiary = baseline((b) => ({ authority: { ...b.authority, beneficiaries: [{ label: "self", chain: "sui-testnet", address: SUI }] } }));
    expect(codes(suiBeneficiary).length).toBeGreaterThan(0);
    const badPayee = baseline((b) => ({ authority: { ...b.authority, allowedActions: ["REPAY", "PAY"], payees: [{ label: "x", chain: "ethereum-sepolia", address: "anyone" }] } }));
    expect(codes(badPayee).length).toBeGreaterThan(0);
    const dual = baseline((b) => ({
      chains: ["ethereum-sepolia", "sui-testnet"],
      authority: { ...b.authority, allowedActions: ["PAY"], beneficiaries: [], payees: [{ label: "acme", chain: "ethereum-sepolia", address: EVM }], limits: [...b.authority.limits, { chain: "sui-testnet", asset: "AMUSD", perAction: "1", perWindow: "1", windowSeconds: 3600, total: "1" }] },
    }));
    // PAY is authorised on Sui with a Sui budget but no Sui payee exists
    expect(codes(dual).length).toBeGreaterThan(0);
  });

  it("break_F0518_identity_binding_wrong_provider_or_chain", () => {
    const ensOnSui = baseline((b) => ({ identity: { ...b.identity, public: true, bindings: [{ provider: "ens", chain: "sui-testnet", name: "agent.acme.eth", status: "PLANNED" }] } }));
    expect(codes(ensOnSui).length).toBeGreaterThan(0);
    const suinsForEth = baseline((b) => ({ identity: { ...b.identity, public: true, bindings: [{ provider: "suins", chain: "ethereum-sepolia", name: "agent.sui", status: "PLANNED" }] } }));
    expect(codes(suinsForEth).length).toBeGreaterThan(0);
  });

  it("break_F0509_secret_store_accepted_for_value_hidden_from_backend", () => {
    const v = { id: "api-credential", description: "api key", kind: "PRIVATE_API_CREDENTIAL" as const, hiddenFrom: ["NORMAL_KIDO_BACKEND" as const, "CLOUD_HOST" as const], plaintextBoundary: "KIDO_SECRET_STORE" as const, allowedDisclosure: "DECISION_ONLY" as const, failurePolicy: "FAIL_CLOSED" as const };
    const bp = baseline(() => ({ privacy: { required: true, values: [v], providers: [] } }));
    expect(codes(bp)).toContain("KIDO_BLUEPRINT_PRIVACY_UNSATISFIED");
  });

  it("break_F0509_privacy_provider_on_wrong_chain_or_unknown_satisfies", () => {
    const v = { id: "risk-threshold", description: "t", kind: "PRIVATE_POLICY" as const, hiddenFrom: ["PUBLIC_CHAIN" as const], plaintextBoundary: "APPROVED_ENCLAVE" as const, allowedDisclosure: "DECISION_ONLY" as const, failurePolicy: "FAIL_CLOSED" as const };
    const nautilusOnEth = baseline(() => ({ privacy: { required: true, values: [v], providers: [{ providerId: "nautilus", chain: "ethereum-sepolia", capabilities: ["CONFIDENTIAL_COMPUTE"], satisfies: ["risk-threshold"] }] } }));
    expect(codes(nautilusOnEth).length).toBeGreaterThan(0);
    const ghost = baseline(() => ({ privacy: { required: true, values: [v], providers: [{ providerId: "made-up-tee", chain: null, capabilities: [], satisfies: ["risk-threshold"] }] } }));
    expect(codes(ghost).length).toBeGreaterThan(0);
  });

  it("break_F0520_non_financial_mode_carries_authority", () => {
    const ro = baseline((b) => ({
      authority: { ...b.authority, mode: "READ_ONLY", provider: "AMANE", allowedActions: ["SWAP", "PAY"], payees: [{ label: "x", chain: "ethereum-sepolia", address: EVM }] },
      amane: { manifestRef: "Aname/deployments/testnet.json", accountId: null, endpoints: [{ chain: "ethereum-sepolia", account: null }], policyHash: null },
    }));
    expect(codes(ro).length).toBeGreaterThan(0);
  });
});

describe("BREAK: confirmed requirements", () => {
  it("break_F0524_next_revision_overwrites_confirmed_requirement", () => {
    const r: RequirementResolution = { key: "authority.bridge", topic: "AUTHORITY", class: "USER_REQUIRED", critical: true, status: "RESOLVED", value: false, confirmed: true, provenance: { kind: "USER_ANSWER", quote: "no", turn: 1 } };
    const bp = applyResolutions(emptyBlueprint("p1", "s", "x"), [{ resolution: r }]);
    expect(() => applyResolutions(bp, [{ resolution: { ...r, value: true } }])).toThrow(ConfirmedRequirementError);
    // the same change through the public revision primitive is not refused
    expect(() => nextRevision(bp, { requirements: [{ ...r, value: true }] })).toThrow(ConfirmedRequirementError);
    // nor is silently dropping the confirmed requirement
    expect(() => nextRevision(bp, { requirements: [] })).toThrow(ConfirmedRequirementError);
  });
});
