import { describe, it, expect } from "vitest";
import { scanArtifactHonesty } from "../src/honesty.js";
import { renderProject } from "@contextlock/studio-templates";
import { validGuardian, copy } from "../../../packages/studio-blueprint/test/fixtures.js";
import { SIM_PRIVATE_POLICY } from "@contextlock/studio-simulation";

/**
 * A scanner that has only ever been observed passing is not evidence. Every flag below is planted
 * and confirmed to fire, then removed and confirmed to clear.
 */
const bp = validGuardian();
const clean = renderProject(bp);

describe("the honesty scan passes on genuine artifacts", () => {
  it("raises nothing on the real generated project", () => {
    expect(scanArtifactHonesty(clean, bp)).toEqual({
      claimsHardwareEvidence: false,
      claimsLiveCreDeployment: false,
      claimsTeeExecution: false,
      exposesConfidentialValues: false,
    });
  });

  it("does not fire on honest NEGATIVE statements", () => {
    // The generated README and templates say, at length, that these things did not happen. A
    // scanner that cannot tell a denial from a claim would block every truthful build.
    const negations = [
      { path: "a.md", content: "No physical device evidence exists. Nothing ran in a TEE. Not deployed to CRE." },
      { path: "b.ts", content: "export const PHYSICAL_DEVICE_EVIDENCE = false;\nexport const REAL_TEE_EXECUTION = false;" },
      { path: "c.md", content: "This was NOT approved on a Ledger device and no DON-signed report exists." },
    ];
    expect(scanArtifactHonesty(negations, bp)).toEqual({
      claimsHardwareEvidence: false,
      claimsLiveCreDeployment: false,
      claimsTeeExecution: false,
      exposesConfidentialValues: false,
    });
  });
});

describe("the honesty scan catches each false claim", () => {
  it("catches an asserted hardware-evidence constant", () => {
    const f = [...clean, { path: "x.ts", content: "export const PHYSICAL_DEVICE_EVIDENCE = true;" }];
    expect(scanArtifactHonesty(f, bp).claimsHardwareEvidence).toBe(true);
  });

  it("catches prose claiming a device approval", () => {
    const f = [{ path: "x.md", content: "The transaction was approved on a Ledger device by the operator." }];
    expect(scanArtifactHonesty(f, bp).claimsHardwareEvidence).toBe(true);
  });

  it("catches a claimed live CRE deployment", () => {
    const f = [{ path: "x.ts", content: "export const LIVE_CRE_DEPLOYMENT = true;" }];
    expect(scanArtifactHonesty(f, bp).claimsLiveCreDeployment).toBe(true);
  });

  it("catches a claimed DON-signed report", () => {
    const f = [{ path: "x.md", content: "Verdicts arrive as a DON-signed report from the network." }];
    expect(scanArtifactHonesty(f, bp).claimsLiveCreDeployment).toBe(true);
  });

  it("catches a claimed TEE execution", () => {
    const f = [{ path: "x.md", content: "The policy runs in a real TEE on AWS Nitro." }];
    expect(scanArtifactHonesty(f, bp).claimsTeeExecution).toBe(true);
  });

  it("catches a leaked confidential threshold value", () => {
    const f = [...clean, { path: "x.ts", content: `const limit = ${SIM_PRIVATE_POLICY.autoLimit}n;` }];
    expect(scanArtifactHonesty(f, bp).exposesConfidentialValues).toBe(true);
  });

  it("catches the confidential canary", () => {
    const f = [{ path: "x.json", content: JSON.stringify({ note: SIM_PRIVATE_POLICY.canary }) }];
    expect(scanArtifactHonesty(f, bp).exposesConfidentialValues).toBe(true);
  });

  it("catches a parameter name adjacent to ANY number, not only a known one", () => {
    // The threshold is disclosed by `name: 12345` regardless of whether we recognise 12345.
    const name = bp.confidentialPolicy.parameterNames[0]!;
    const f = [{ path: "x.ts", content: `export const cfg = { ${name}: 13579 };` }];
    expect(scanArtifactHonesty(f, bp).exposesConfidentialValues).toBe(true);
  });

  it("does NOT fire on a parameter name listed without a value", () => {
    const name = bp.confidentialPolicy.parameterNames[0]!;
    const f = [{ path: "x.ts", content: `export const NAMES = ["${name}"]; // values live in the enclave` }];
    expect(scanArtifactHonesty(f, bp).exposesConfidentialValues).toBe(false);
  });
});

describe("the scan ignores its own commentary", () => {
  it("a comment describing a false claim is not a false claim", () => {
    const f = [
      {
        path: "x.ts",
        content: `/**
 * Never write PHYSICAL_DEVICE_EVIDENCE = true here, and never say this ran in a TEE.
 */
export const ok = 1;`,
      },
    ];
    const r = scanArtifactHonesty(f, bp);
    expect(r.claimsHardwareEvidence).toBe(false);
    expect(r.claimsTeeExecution).toBe(false);
  });
});

describe("the user's own stated limits are not confidential values", () => {
  it("does not flag limits the user said out loud and must be able to review", () => {
    // $1,000 / $5,000 came from the user's prompt and are quoted back with sourceQuote. Treating
    // them as leaks would make every honest blueprint unbuildable.
    const b = copy(bp);
    expect(b.autonomousPolicy.maxValueUsdCents.known).toBe(true);
    expect(scanArtifactHonesty(clean, b).exposesConfidentialValues).toBe(false);
  });
});

describe("the negation guard is not a blanket suppressor", () => {
  it("a claim in the SAME text as an unrelated denial is still caught", () => {
    // The dangerous failure: a document that says the right thing in one paragraph and the wrong
    // thing in another. A guard that scanned the whole document for any negator would pass this.
    const f = [
      {
        path: "x.md",
        content:
          "No physical device was available for testing.\n\nThe workflow executed in a real TEE on Nitro.",
      },
    ];
    expect(scanArtifactHonesty(f, bp).claimsTeeExecution).toBe(true);
  });

  it("a negator on a previous sentence does not excuse the next one", () => {
    const f = [{ path: "x.md", content: "This is not audited. It was approved on a Ledger device." }];
    expect(scanArtifactHonesty(f, bp).claimsHardwareEvidence).toBe(true);
  });

  it("a clause-level denial is still honoured", () => {
    const f = [{ path: "x.md", content: "This build was never approved on a Ledger device." }];
    expect(scanArtifactHonesty(f, bp).claimsHardwareEvidence).toBe(false);
  });

  it("a pending/blocked framing reads as a denial", () => {
    const f = [{ path: "x.md", content: "Hardware approval is pending; approval on a Ledger device is blocked by BLK-002." }];
    expect(scanArtifactHonesty(f, bp).claimsHardwareEvidence).toBe(false);
  });
});
