import { expect, it } from "vitest";
import { parsePayees } from "../src/index.js";
const SUI = `0x${"ac".repeat(32)}`;
it("bullet/backtick answers keep the entity name, one payee per chain", () => {
  expect(parsePayees("Only ACME may be paid:\n- Ethereum: `0xacE0000000000000000000000000000000000ACE`\n- Sui: `" + SUI + "`")).toEqual({ ok: true, value: [
    { label: "acme", chain: "ethereum-sepolia", address: "0xacE0000000000000000000000000000000000ACE" },
    { label: "acme", chain: "sui-testnet", address: SUI },
  ] });
});
it("an address valid on no chain makes the answer unclear instead of dropping it", () => {
  const r = parsePayees(`ACME sui 0x${"ac".repeat(33)}`);
  expect(r.ok).toBe(false);
  expect((r as { reason: string }).reason).toMatch(/66 hex digits/);
});
