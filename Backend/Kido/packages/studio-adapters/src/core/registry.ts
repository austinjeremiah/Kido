import {
  ContextLockAdapterManifestSchema,
  EXECUTION_ADAPTER_TYPES,
  DATA_ADAPTER_TYPES,
  adapterRef,
  type ContextLockAdapterManifest,
} from "./manifest.js";
import type { DataAdapter, ExecutionAdapter } from "./contracts.js";
import { satisfiesTrust, type DataTrustClass } from "./trust.js";

/**
 * The adapter registry.
 *
 * Every provider integration enters the Studio through here, and the Studio only ever talks to this
 * interface. There is no `if (provider === "uniswap")` anywhere above this layer — that is the
 * entire point of Group B, and the thing that keeps the fifth integration from costing what the
 * first one did.
 *
 * Registration is a gate, not a bookkeeping step. An adapter that cannot describe itself accurately
 * is refused, because everything downstream — trust enforcement, freshness checks, the graph, the
 * generated code, the artifact validator — reads the manifest and believes it.
 */

export type RegisteredAdapter =
  | { kind: "execution"; manifest: ContextLockAdapterManifest; adapter: ExecutionAdapter }
  | { kind: "data"; manifest: ContextLockAdapterManifest; adapter: DataAdapter };

export class AdapterRegistrationError extends Error {
  constructor(readonly code: string, detail: string) {
    // The code is carried in the message as well as on the instance. A rejection that reaches a log
    // or a UI should say WHY without the reader needing the class definition to hand.
    super(`${code}: ${detail}`);
    this.name = "AdapterRegistrationError";
  }
}

export class AdapterNotFoundError extends Error {
  constructor(ref: string) {
    super(`no adapter registered as "${ref}"`);
    this.name = "AdapterNotFoundError";
  }
}

export interface CapabilityQuery {
  capability?: string;
  dataKind?: string;
  adapterType?: ContextLockAdapterManifest["adapterType"];
  chainId?: number;
  minimumTrustClass?: DataTrustClass;
  maxAgeMs?: number;
}

export class AdapterRegistry {
  private readonly byRef = new Map<string, RegisteredAdapter>();

  /**
   * Validate a manifest without registering it.
   *
   * Split out so the checks are testable in isolation and so a build can validate a third-party
   * manifest before deciding whether to trust it.
   */
  verifyManifest(input: unknown): ContextLockAdapterManifest {
    const parsed = ContextLockAdapterManifestSchema.safeParse(input);
    if (!parsed.success) {
      throw new AdapterRegistrationError(
        "ADAPTER-MANIFEST-INVALID",
        `manifest failed schema validation: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const m = parsed.data;

    /*
     * A credential that a browser bundle could read is not a credential. `never-client` and the two
     * server placements are the only acceptable answers; anything else means a generated frontend
     * could end up holding a key.
     */
    if (m.auth.mode !== "none" && m.auth.requiredSecretNames.length === 0) {
      throw new AdapterRegistrationError(
        "ADAPTER-AUTH-UNDECLARED",
        `${adapterRef(m)} declares auth mode "${m.auth.mode}" but names no required secret`,
      );
    }
    if (m.auth.mode !== "none" && m.auth.placement === "never-client" && m.executionPlacement === "generated-agent") {
      throw new AdapterRegistrationError(
        "ADAPTER-AUTH-PLACEMENT",
        `${adapterRef(m)} needs a credential but runs in the generated agent; use a server or CRE placement`,
      );
    }

    /*
     * Trust must be consistent between the adapter and each capability it offers. A provider whose
     * manifest says INDEXED cannot advertise a VERIFIED_ORACLE capability — that is precisely the
     * silent upgrade the whole trust model exists to prevent.
     */
    for (const c of m.capabilities) {
      if (c.trustClass && !satisfiesTrust(m.trustClass, c.trustClass)) {
        throw new AdapterRegistrationError(
          "ADAPTER-TRUST-INCONSISTENT",
          `${adapterRef(m)} is ${m.trustClass} but capability ${c.name} claims ${c.trustClass}`,
        );
      }
    }

    // A data adapter that cannot say how old its value is cannot serve a freshness requirement.
    if (DATA_ADAPTER_TYPES.includes(m.adapterType)) {
      if (!m.capabilities.some((c) => c.dataKind)) {
        throw new AdapterRegistrationError(
          "ADAPTER-NO-DATAKIND",
          `${adapterRef(m)} is a data adapter but no capability declares a dataKind`,
        );
      }
    }

    /*
     * An execution adapter that does not independently decode what the provider built is not an
     * adapter, it is a pass-through. Refusing it here is the difference between a hostile provider
     * response being caught and being signed.
     */
    if (m.adapterType === "EXECUTION") {
      if (!m.safety.decodesPreparedTransactions || !m.safety.independentlyValidatesProviderOutput) {
        throw new AdapterRegistrationError(
          "ADAPTER-EXEC-UNVALIDATED",
          `${adapterRef(m)} is an execution adapter but does not declare independent decode + validation of provider output`,
        );
      }
    }

    if (m.securityAssertions.length === 0) {
      throw new AdapterRegistrationError("ADAPTER-NO-ASSERTIONS", `${adapterRef(m)} declares no security assertions`);
    }
    if (m.simulationProviders.length === 0) {
      throw new AdapterRegistrationError("ADAPTER-NO-SIMULATIONS", `${adapterRef(m)} contributes no simulation scenarios`);
    }
    if (m.generatedModules.length === 0) {
      throw new AdapterRegistrationError("ADAPTER-NO-MODULES", `${adapterRef(m)} generates no modules`);
    }
    return m;
  }

  register(entry: RegisteredAdapter): ContextLockAdapterManifest {
    const m = this.verifyManifest(entry.manifest);

    const declared = entry.adapter.manifest();
    if (declared.id !== m.id || declared.version !== m.version) {
      // The implementation and the manifest must agree about who they are, or version pinning is
      // pinning nothing.
      throw new AdapterRegistrationError(
        "ADAPTER-IDENTITY-MISMATCH",
        `registered manifest is ${adapterRef(m)} but the implementation reports ${adapterRef(declared)}`,
      );
    }

    // Derived from the shared list rather than from a comparison against one literal. The
    // literal version silently misfiled CROSS_CHAIN as a data adapter, which would have put a
    // money-moving adapter on the contract meant for readings.
    const expectedKind = EXECUTION_ADAPTER_TYPES.includes(m.adapterType) ? "execution" : "data";
    if (entry.kind !== expectedKind) {
      throw new AdapterRegistrationError(
        "ADAPTER-KIND-MISMATCH",
        `${adapterRef(m)} is ${m.adapterType} but was registered as a ${entry.kind} adapter`,
      );
    }

    const ref = adapterRef(m);
    if (this.byRef.has(ref)) {
      throw new AdapterRegistrationError("ADAPTER-DUPLICATE", `${ref} is already registered`);
    }
    this.byRef.set(ref, { ...entry, manifest: m });
    return m;
  }

  /**
   * Resolve an exact, pinned reference.
   *
   * There is deliberately no "latest" resolution and no semver range matching. A Blueprint pins
   * `uniswap-trading-api@1.0.0`, and registering 1.1.0 does not change what an existing build
   * resolves to — a silently upgraded adapter would invalidate every simulation result already
   * recorded against that build without anything saying so.
   */
  resolve(id: string, version: string): RegisteredAdapter {
    const found = this.byRef.get(`${id}@${version}`);
    if (!found) throw new AdapterNotFoundError(`${id}@${version}`);
    return found;
  }

  has(id: string, version: string): boolean {
    return this.byRef.has(`${id}@${version}`);
  }

  list(): ContextLockAdapterManifest[] {
    return [...this.byRef.values()].map((e) => e.manifest).sort((a, b) => adapterRef(a).localeCompare(adapterRef(b)));
  }

  /** Every registered version of one adapter id, newest-declared last. */
  versionsOf(id: string): string[] {
    return this.list()
      .filter((m) => m.id === id)
      .map((m) => m.version)
      .sort();
  }

  /**
   * Candidates that satisfy a query.
   *
   * Filtering only. It does not rank or choose — that is the resolver's job, and keeping selection
   * out of the registry means the selection rules are testable on their own.
   */
  findByCapability(q: CapabilityQuery): ContextLockAdapterManifest[] {
    return this.list().filter((m) => {
      if (q.adapterType && m.adapterType !== q.adapterType) return false;
      if (q.chainId !== undefined && !m.supportedChains.includes(q.chainId)) return false;
      if (q.capability && !m.capabilities.some((c) => c.name === q.capability)) return false;
      if (q.dataKind && !m.capabilities.some((c) => c.dataKind === q.dataKind)) return false;
      if (q.minimumTrustClass) {
        const cap = q.dataKind
          ? m.capabilities.find((c) => c.dataKind === q.dataKind)
          : undefined;
        const offered = cap?.trustClass ?? m.trustClass;
        if (!satisfiesTrust(offered, q.minimumTrustClass)) return false;
      }
      if (q.maxAgeMs !== undefined) {
        // An adapter that cannot express freshness cannot meet a freshness bound. Treating
        // "unknown" as "probably fine" is how a stale price gets used.
        if (m.freshnessSemantics.kind === "unknown") return false;
        const typical = m.freshnessSemantics.typicalStalenessMs;
        if (typical !== undefined && typical > q.maxAgeMs) return false;
      }
      return true;
    });
  }
}
