/**
 * The demonstration protected service.
 *
 * A deterministic local risk endpoint that requires a bearer credential. Deliberately local and
 * deterministic so the Key Ring isolation test never depends on an external API's availability —
 * the property under test is "the agent never sees the credential", not "some third party is up".
 *
 * This is NOT a production API key. The token is a test value, generated for this demo.
 */
import { createServer, type Server } from "node:http";

export type RiskAssessment = {
  /** Coarse band only. The service's internal scoring inputs are not exposed. */
  riskBand: "LOW" | "MEDIUM" | "HIGH";
  score: number;
  observedAtUnix: number;
};

export type ProtectedServiceHandle = {
  url: string;
  close: () => Promise<void>;
  /** Requests observed, so tests can prove the credential actually authenticated a call. */
  authorizedCalls: number;
  unauthorizedCalls: number;
};

export async function startProtectedService(expectedToken: string, port = 0): Promise<ProtectedServiceHandle> {
  const state = { authorizedCalls: 0, unauthorizedCalls: 0 };

  const server: Server = createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${expectedToken}`) {
      state.unauthorizedCalls += 1;
      res.writeHead(401, { "content-type": "application/json" });
      // Never echo the presented credential back — an error body is a classic leak path.
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    state.authorizedCalls += 1;
    const body: RiskAssessment = {
      riskBand: "LOW",
      score: 17,
      observedAtUnix: Math.floor(Date.now() / 1000),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    url: `http://127.0.0.1:${boundPort}/risk`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    get authorizedCalls() { return state.authorizedCalls; },
    get unauthorizedCalls() { return state.unauthorizedCalls; },
  };
}
