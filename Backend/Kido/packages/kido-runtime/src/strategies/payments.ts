import type { Chain } from "@kido/agents";
import type { DeterministicResponder, ResponderResult } from "../gate.js";
import type { MonitorEvent, MonitorSpec } from "../monitor.js";
import type { DataObservation } from "../observation.js";

/** An invoice raised by an approved payee. The memo is untrusted outside-world text. */
export interface Invoice {
  id: string;
  payee: string;
  asset: string;
  amount: bigint;
  preferredChain: Chain;
  memo: string;
}

export interface PaymentWorld {
  approvedPayees: Record<Chain, string[]>;
  perActionCap: Record<Chain, bigint>;
  vaultBalance: Record<Chain, bigint>;
}

export const INVOICE_DUE = "INVOICE_DUE";

export function invoiceMonitor(id: string, fetchInvoices: () => Promise<Invoice[]>, clock: () => number = Date.now): MonitorSpec {
  return {
    id,
    requiredTrust: "USER_UNTRUSTED",
    async observe() {
      const now = clock();
      return (await fetchInvoices()).map(
        (inv): DataObservation<Invoice> => ({
          id: `invoice:${inv.id}`,
          adapterId: "kido.invoice-inbox@1",
          chain: inv.preferredChain,
          subject: inv.payee,
          kind: "INVOICE",
          value: inv,
          observedAt: now,
          freshnessMs: 60_000,
          trust: "USER_UNTRUSTED",
        }),
      );
    },
    evaluate(obs) {
      return obs.map((o) => {
        const inv = o.value as Invoice;
        return { kind: INVOICE_DUE, key: `invoice:${inv.id}`, data: { invoice: inv } };
      });
    },
  };
}

/**
 * The known response to an invoice: pay it from the preferred endpoint when the payee is pinned,
 * the amount fits one action and the endpoint holds enough. Anything else is either impossible by
 * policy (no model can fix that) or needs reasoning about funding.
 */
export const payInvoiceResponder: DeterministicResponder<PaymentWorld> = {
  id: "pay-invoice",
  handles: INVOICE_DUE,
  respond(event: MonitorEvent, w: PaymentWorld): ResponderResult {
    const inv = event.data.invoice as Invoice;
    const chains: Chain[] = ["ethereum-sepolia", "sui-testnet"];
    const payable = chains.filter((c) => w.approvedPayees[c].includes(inv.payee));
    if (payable.length === 0) return { kind: "NO_ACTION", reason: `payee ${inv.payee} is not pinned in the root policy; only the owner can add it` };
    const c = inv.preferredChain;
    if (w.approvedPayees[c].includes(inv.payee) && inv.amount <= w.perActionCap[c] && w.vaultBalance[c] >= inv.amount) {
      return {
        kind: "ACTIONS",
        steps: [{ stepId: "pay", chain: c, action: "PAY", asset: inv.asset, assetOut: null, amount: inv.amount, payee: inv.payee, dependsOn: [], origin: "DETERMINISTIC" }],
      };
    }
    const total = payable.reduce((s, x) => s + w.vaultBalance[x], 0n);
    if (total < inv.amount) return { kind: "NO_ACTION", reason: "approved endpoints together cannot fund this invoice" };
    return {
      kind: "WAKE",
      condition: inv.amount > w.perActionCap[c] ? "CONSTRAINT_CONFLICT" : "RESOURCE_SHORTFALL",
      specialist: "PaymentAgent",
      reason: `preferred endpoint ${c} cannot pay ${inv.amount} in one action; ${payable.length} approved endpoint(s) hold ${total}`,
    };
  },
};
