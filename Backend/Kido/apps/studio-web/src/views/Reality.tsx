import type React from "react";
import { useEffect, useState } from "react";
import type { RealityView, RealityMode, SourceStatus, NetworkBadge } from "../lab-api";

/**
 * The Reality selector (§P28.8–P28.11).
 *
 * > Do not hide disabled options. Explain them.
 *
 * The instinct a product has is to hide what does not work. Here that removes the user's only signal
 * that a capability exists, leaves them believing the modes they can see are the modes there are,
 * and — worst — means the option cannot carry the reason it is unavailable, so nobody fixes it.
 *
 * Every mode renders, including the unavailable ones, each with its reason, blocker and remedy.
 */

const TONE_CLASS: Record<SourceStatus["tone"], string> = {
  GREEN: "tone-green",
  AMBER: "tone-amber",
  GREY: "tone-grey",
};

function ModeOption({ mode, selected, onSelect }: { mode: RealityMode; selected: boolean; onSelect: () => void }): React.ReactElement {
  const disabled = mode.availability === "BLOCKED";
  return (
    <li className={`reality-mode availability-${mode.availability.toLowerCase()}`}>
      <label>
        <input
          type="radio"
          name="reality-mode"
          checked={selected}
          disabled={disabled}
          onChange={onSelect}
        />
        <span className="mode-label">{mode.label}</span>
        <span className="mode-availability">{mode.availability}</span>
      </label>

      {mode.reason && <p className="mode-reason">{mode.reason}</p>}
      {mode.effect && <p className="mode-effect">{mode.effect}</p>}
      {mode.blocker && (
        <p className="mode-blocker">
          <code>{mode.blocker}</code>
          {mode.remedy && <span className="mode-remedy"> — {mode.remedy}</span>}
        </p>
      )}
      {/*
        * §P28.11 asks for a way forward on the archive case rather than a dead end. The button is
        * rendered where a remedy exists; it does not pretend the capability is present.
        */}
      {mode.remedy?.includes("archive") && (
        <button type="button" className="secondary" disabled title="Set MAINNET_ARCHIVE_RPC_URL and restart the API">
          Configure Archive RPC
        </button>
      )}
    </li>
  );
}

function SourceCard({ source }: { source: SourceStatus }): React.ReactElement {
  return (
    <article className={`source-card ${TONE_CLASS[source.tone]}`}>
      <header>
        <h4>{source.displayName}</h4>
        <span className="source-status">{source.status}</span>
      </header>
      <dl>
        {source.reason && (<><dt>Reason</dt><dd>{source.reason}</dd></>)}
        {source.effect && (<><dt>Effect</dt><dd>{source.effect}</dd></>)}
        {/*
          * The field that matters when a source is missing. The interesting fact is not that it is
          * absent — it is that nothing quietly replaced it.
          */}
        {source.securityImpact && (<><dt>Security impact</dt><dd className="security-impact">{source.securityImpact}</dd></>)}
        {source.blocker && (<><dt>Blocker</dt><dd><code>{source.blocker}</code></dd></>)}
      </dl>
    </article>
  );
}

/**
 * The two network badges.
 *
 * Rendered as two distinct blocks with distinct headings, never as one list. §P28.9 forbids
 * `Network: Ethereum` without the role, and a renderer that iterated a list would be one refactor
 * away from producing exactly that.
 */
export function NetworkBadges({ networks }: { networks: { marketSource: NetworkBadge; executionTarget: NetworkBadge } }): React.ReactElement {
  return (
    <div className="network-badges">
      <div className="badge badge-source">
        <span className="badge-purpose">MARKET SOURCE</span>
        <span className="badge-name">{networks.marketSource.name}</span>
        <span className="badge-role">{networks.marketSource.roleLabel}</span>
      </div>
      <div className="badge badge-target">
        <span className="badge-purpose">EXECUTION TARGET</span>
        <span className="badge-name">{networks.executionTarget.name}</span>
        <span className="badge-role">{networks.executionTarget.roleLabel}</span>
      </div>
    </div>
  );
}

export interface RealityViewProps {
  fetchReality: () => Promise<RealityView>;
  /** The host decides what a mode means for the screens below; this component only reports the choice. */
  onSelect?: (mode: RealityMode["mode"]) => void;
  initial?: RealityMode["mode"];
}

export function RealitySelector({ fetchReality, onSelect, initial }: RealityViewProps): React.ReactElement {
  const [data, setData] = useState<RealityView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RealityMode["mode"]>(initial ?? "LIVE_MAINNET_MIRROR");

  useEffect(() => {
    let live = true;
    fetchReality()
      .then((d) => { if (live) setData(d); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [fetchReality]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="loading">Reading capabilities…</p>;

  return (
    <div className="reality-view">
      <NetworkBadges networks={data.networks} />

      <section className="reality-modes">
        <h3>Market reality</h3>
        <ul>
          {data.modes.map((m) => (
            <ModeOption
              key={m.mode}
              mode={m}
              selected={selected === m.mode}
              onSelect={() => { if (m.availability !== "BLOCKED") { setSelected(m.mode); onSelect?.(m.mode); } }}
            />
          ))}
        </ul>
      </section>

      <section className="reality-sources">
        <h3>Sources</h3>
        {data.sources.map((s) => <SourceCard key={s.sourceId} source={s} />)}
      </section>
    </div>
  );
}
