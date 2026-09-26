import { isIP } from "node:net";

/**
 * Egress control for imported APIs.
 *
 * An imported OpenAPI document is a description of somewhere to send requests, written by whoever
 * supplied the document. That makes every field in it an SSRF vector: a `servers` entry pointing at
 * `169.254.169.254`, a `$ref` to an internal host, a redirect that lands on `127.0.0.1`.
 *
 * The defence is not a blocklist of strings. A hostname is checked, then RESOLVED, and the resolved
 * addresses are checked — because `evil.example.com` resolving to `127.0.0.1` passes any check that
 * only reads the name. Redirects are re-checked at every hop for the same reason: a public host
 * that 302s to a private one defeats a check performed only on the first URL.
 */

export const EGRESS_REASONS = {
  NOT_HTTPS: "EGRESS-NOT-HTTPS",
  HOST_NOT_ALLOWED: "EGRESS-HOST-NOT-ALLOWED",
  PRIVATE_ADDRESS: "EGRESS-PRIVATE-ADDRESS",
  METADATA_ENDPOINT: "EGRESS-METADATA-ENDPOINT",
  DNS_FAILED: "EGRESS-DNS-FAILED",
  TOO_MANY_REDIRECTS: "EGRESS-TOO-MANY-REDIRECTS",
  MALFORMED_URL: "EGRESS-MALFORMED-URL",
  PORT_NOT_ALLOWED: "EGRESS-PORT-NOT-ALLOWED",
  CREDENTIALS_IN_URL: "EGRESS-CREDENTIALS-IN-URL",
} as const;
export type EgressReason = (typeof EGRESS_REASONS)[keyof typeof EGRESS_REASONS];

export type EgressVerdict = { ok: true; url: URL } | { ok: false; reason: EgressReason; detail: string };

/**
 * Cloud metadata endpoints.
 *
 * Listed by address rather than by name because the name is the attacker's to choose. These are the
 * addresses that hand out instance credentials to anything that asks, which makes them the single
 * highest-value SSRF target on any hosted deployment.
 */
const METADATA_ADDRESSES = new Set([
  "169.254.169.254", // AWS / Azure / GCP / DigitalOcean IMDS
  "169.254.170.2",   // AWS ECS task metadata
  "100.100.100.200", // Alibaba Cloud
  "192.0.0.192",     // Oracle Cloud
  "fd00:ec2::254",   // AWS IMDSv6
]);

/** Parse an IPv4 dotted quad into its four octets, or null. */
const v4 = (a: string): number[] | null => {
  const p = a.split(".");
  if (p.length !== 4) return null;
  const n = p.map((x) => Number(x));
  return n.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? n : null;
};

/**
 * Is this address one we must never send a request to?
 *
 * Covers loopback, RFC1918, link-local (including the metadata range), carrier-grade NAT, and the
 * IPv6 equivalents — plus IPv4-mapped IPv6, which is how `::ffff:127.0.0.1` sneaks a loopback
 * address past a checker that only understands one family.
 */
export function isPrivateAddress(address: string): boolean {
  const addr = address.toLowerCase().replace(/^\[|\]$/g, "");

  if (isIP(addr) === 4) {
    const o = v4(addr);
    if (!o) return true; // unparseable: fail closed
    const [a, b] = o as [number, number, number, number];
    if (a === 0 || a === 127) return true;              // this-network, loopback
    if (a === 10) return true;                          // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true;   // RFC1918
    if (a === 192 && b === 168) return true;            // RFC1918
    if (a === 169 && b === 254) return true;            // link-local, includes IMDS
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
    if (a >= 224) return true;                          // multicast and reserved
    return false;
  }

  if (isIP(addr) === 6) {
    // IPv4-mapped: ::ffff:127.0.0.1 is loopback wearing an IPv6 hat.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
    if (mapped) return isPrivateAddress(mapped[1]!);
    if (addr === "::1" || addr === "::") return true;                 // loopback, unspecified
    if (addr.startsWith("fe80") || addr.startsWith("fec0")) return true; // link-local, site-local
    if (/^f[cd]/.test(addr)) return true;                              // unique-local fc00::/7
    if (addr.startsWith("ff")) return true;                            // multicast
    return false;
  }

  return true; // not an IP at all: fail closed
}

export const isMetadataAddress = (a: string) => METADATA_ADDRESSES.has(a.toLowerCase().replace(/^\[|\]$/g, ""));

export interface EgressPolicy {
  /** Exact hostnames permitted. Empty means nothing is permitted — default deny, not default allow. */
  allowedHosts: string[];
  allowedPorts: number[];
  maxRedirects: number;
  /** Injected so tests can drive resolution without a network. */
  resolve: (hostname: string) => Promise<string[]>;
}

export const DEFAULT_EGRESS: Omit<EgressPolicy, "resolve" | "allowedHosts"> = {
  allowedPorts: [443],
  maxRedirects: 2,
};

/**
 * Check one URL.
 *
 * Order is deliberate: scheme, then credentials, then host allow-list, then port, and only then
 * DNS. Resolving first would leak a lookup for a host we were never going to contact — a small
 * oracle, but an oracle.
 */
export async function checkUrl(raw: string, policy: EgressPolicy): Promise<EgressVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: EGRESS_REASONS.MALFORMED_URL, detail: raw };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: EGRESS_REASONS.NOT_HTTPS, detail: `${url.protocol}//` };
  }
  if (url.username || url.password) {
    // Credentials in a URL end up in logs and referrers. They are also a classic way to make a
    // hostile host look like a familiar one: https://api.trusted.com@evil.example/.
    return { ok: false, reason: EGRESS_REASONS.CREDENTIALS_IN_URL, detail: url.host };
  }

  const host = url.hostname.toLowerCase();
  if (!policy.allowedHosts.map((h) => h.toLowerCase()).includes(host)) {
    return { ok: false, reason: EGRESS_REASONS.HOST_NOT_ALLOWED, detail: host };
  }

  const port = url.port === "" ? 443 : Number(url.port);
  if (!policy.allowedPorts.includes(port)) {
    return { ok: false, reason: EGRESS_REASONS.PORT_NOT_ALLOWED, detail: String(port) };
  }

  // A literal address in the URL is checked directly; a name is resolved and every answer checked.
  const literals = isIP(host) ? [host] : [];
  let addresses: string[];
  if (literals.length > 0) addresses = literals;
  else {
    try {
      addresses = await policy.resolve(host);
    } catch (e) {
      return { ok: false, reason: EGRESS_REASONS.DNS_FAILED, detail: (e as Error).message };
    }
    if (addresses.length === 0) return { ok: false, reason: EGRESS_REASONS.DNS_FAILED, detail: `${host} resolved to nothing` };
  }

  for (const a of addresses) {
    // Checked before the private-range test so the more specific reason is the one reported.
    if (isMetadataAddress(a)) return { ok: false, reason: EGRESS_REASONS.METADATA_ENDPOINT, detail: `${host} -> ${a}` };
    // EVERY answer must be safe, not merely one of them: a rebinding record returns a good address
    // beside a bad one and hopes the caller connects to the second.
    if (isPrivateAddress(a)) return { ok: false, reason: EGRESS_REASONS.PRIVATE_ADDRESS, detail: `${host} -> ${a}` };
  }

  return { ok: true, url };
}

/**
 * Follow a redirect chain, re-checking at every hop.
 *
 * The whole point: a host on the allow-list that answers 302 to `http://169.254.169.254/` is a
 * fully working SSRF unless the destination is checked too. Checking only the first URL is the
 * mistake this function exists to make impossible.
 */
export async function checkRedirectChain(
  start: string,
  hops: string[],
  policy: EgressPolicy,
): Promise<EgressVerdict> {
  if (hops.length > policy.maxRedirects) {
    return { ok: false, reason: EGRESS_REASONS.TOO_MANY_REDIRECTS, detail: `${hops.length} > ${policy.maxRedirects}` };
  }
  let last = await checkUrl(start, policy);
  if (!last.ok) return last;
  for (const hop of hops) {
    // Relative redirects resolve against the previous URL, exactly as a client would.
    const absolute = new URL(hop, last.ok ? last.url : undefined).toString();
    last = await checkUrl(absolute, policy);
    if (!last.ok) return last;
  }
  return last;
}
