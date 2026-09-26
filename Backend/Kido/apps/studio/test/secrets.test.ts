import { describe, it, expect } from "vitest";
import { protectedSecret, SecretUnavailableError } from "../src/secrets.js";

describe("protected secrets", () => {
  it("hands the value to a callback and never returns it", async () => {
    const s = protectedSecret("THEGRAPH_API_KEY", { THEGRAPH_API_KEY: "k-test-only" });
    expect(s.source).toBe("env");
    expect(await s.withValue(async (v) => v.length)).toBe(11);
    expect(JSON.stringify(await s.view())).not.toContain("k-test-only");
  });

  it("an absent secret fails closed", async () => {
    const s = protectedSecret("THEGRAPH_API_KEY", {});
    expect(s.source).toBe("absent");
    await expect(s.withValue(async (v) => v)).rejects.toBeInstanceOf(SecretUnavailableError);
  });
});
