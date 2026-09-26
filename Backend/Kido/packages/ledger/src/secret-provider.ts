import { LedgerKeyRing, KeyRingError, type KeyRingConfig } from "./key-ring.js";
import type { RiskAssessment } from "./protected-service.js";

/**
 * The agent-facing boundary.
 *
 * The agent can cause an authenticated call to happen. It cannot obtain the credential that
 * authenticated it. That asymmetry is the entire point, and it is enforced by the shape of this
 * interface rather than by any check performed at call time: there is simply no method that
 * returns a secret.
 */
export interface ProtectedActionProvider {
  /** Perform the protected action and return only its scoped result. */
  performProtectedAction(input: { url: string }): Promise<RiskAssessment>;
  /** Non-secret health signal. */
  status(): Promise<string>;
}

export class LedgerKeyRingSecretProvider implements ProtectedActionProvider {
  private readonly ring: LedgerKeyRing;

  constructor(cfg: KeyRingConfig) {
    this.ring = new LedgerKeyRing(cfg);
  }

  async status(): Promise<string> {
    return this.ring.status();
  }

  async performProtectedAction(input: { url: string }): Promise<RiskAssessment> {
    return this.ring.withSecret(async (secret) => {
      const res = await fetch(input.url, { headers: { Authorization: `Bearer ${secret}` } });
      if (!res.ok) {
        // Note what is NOT included: the token, the Authorization header, and the raw body.
        throw new KeyRingError("UNKNOWN", `Protected service rejected the request (${res.status})`);
      }
      const body = (await res.json()) as RiskAssessment;
      // Return only the scoped result. Even if the upstream echoed the credential back, the
      // explicit field projection below means it cannot travel any further.
      return { riskBand: body.riskBand, score: body.score, observedAtUnix: body.observedAtUnix };
    });
  }
}
