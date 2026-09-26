import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelProblem } from "./Absent";
import type { DriverObservation, ForkPositionView, TickSample } from "../lab-api";

/**
 * The agent's performance on the fork.
 *
 * One question, answered from the fork's own state on every refresh: is the position the agent
 * guards where the agent is supposed to keep it, and what did the agent do about it when it was
 * not? The health factor over time is the whole story, so it is the one chart; the policy's
 * lines are drawn on it so a reader sees the target the agent aims at and the floor below which
 * it must ask a human.
 *
 * Nothing here is kept as state beyond what is being looked at. A reload rebuilds it from the
 * runtime's own samples.
 */

const REFRESH_MS = 6_000;
const hf = (bps: number): string => (bps / 10_000).toFixed(3);
const usd = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

export interface PerformanceProps {
  deploymentId: string;
  projectId: string;
  fetchPosition: (deploymentId: string) => Promise<ForkPositionView>;
  stress: (deploymentId: string, driverId: string, option: string, value: number) => Promise<{ before: DriverObservation; after: DriverObservation; detail: string; note: string }>;
  approve: (deploymentId: string, correlationId: string) => Promise<{ signer: string }>;
  decline: (deploymentId: string, correlationId: string, reason: string) => Promise<unknown>;
  tick: (deploymentId: string) => Promise<unknown>;
  /** Opens the "why did it act?" view for one decision. */
  onDecision: (correlationId: string) => void;
}

/* ───────────────────────────── the chart ───────────────────────────── */

const W = 720;
const H = 220;
const PAD = { l: 44, r: 12, t: 14, b: 26 };

interface Line { at: number; label: string; tone: "accent" | "warn" | "bad" | "muted"; side: "above" | "below" }

/**
 * Health factor over time. A single series, so no legend; the reference lines are labeled where
 * they sit. Executions and proposals are marked with a distinct shape, not only a colour, and the
 * tooltip names them.
 */
function HealthChart({ samples, lines }: { samples: TickSample[]; lines: Line[] }): React.ReactElement {
  const [hover, setHover] = useState<number | null>(null);
  const pts = samples;
  const t0 = pts[0]?.atMs ?? 0;
  const t1 = pts.at(-1)?.atMs ?? t0 + 1;
  const ys = [...pts.map((p) => p.healthFactorBps), ...lines.map((l) => l.at), 10_000];
  const yMin = Math.min(...ys) - 500;
  const yMax = Math.max(...ys) + 500;
  const x = (t: number): number => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v: number): number => H - PAD.b - ((v - yMin) / Math.max(1, yMax - yMin)) * (H - PAD.t - PAD.b);
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.atMs).toFixed(1)},${y(p.healthFactorBps).toFixed(1)}`).join(" ");
  const ticks = useMemo(() => {
    const step = (yMax - yMin) > 20_000 ? 5_000 : 2_500;
    const out: number[] = [];
    for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) out.push(v);
    return out;
  }, [yMin, yMax]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestD = Infinity;
    pts.forEach((p, i) => { const d = Math.abs(x(p.atMs) - mx); if (d < bestD) { bestD = d; best = i; } });
    setHover(pts.length ? best : null);
  };
  const h = hover !== null ? pts[hover] ?? null : null;

  if (pts.length < 2) return <p className="empty">The chart draws once the runtime has two observations.</p>;

  return (
    <div className="perf-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="health factor over time" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="perf-grid" />
            <text x={PAD.l - 6} y={y(v) + 3.5} className="perf-axis" textAnchor="end">{(v / 10_000).toFixed(2)}</text>
          </g>
        ))}
        {lines.map((l) => (
          <g key={l.label}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(l.at)} y2={y(l.at)} className={`perf-ref perf-ref-${l.tone}`} />
            <text x={W - PAD.r - 4} y={l.side === "above" ? y(l.at) - 3 : y(l.at) + 10} className="perf-ref-label" textAnchor="end">{l.label}</text>
          </g>
        ))}
        <path d={path} className="perf-line" />
        {pts.map((p, i) => p.action === "EXECUTED"
          ? <rect key={i} x={x(p.atMs) - 5} y={y(p.healthFactorBps) - 5} width={10} height={10} className="perf-mark perf-mark-executed" transform={`rotate(45 ${x(p.atMs)} ${y(p.healthFactorBps)})`} />
          : p.action === "PROPOSED" && p.verdict !== "ALLOW"
            ? <circle key={i} cx={x(p.atMs)} cy={y(p.healthFactorBps)} r={4.5} className={`perf-mark perf-mark-${p.verdict === "ESCALATE" ? "escalate" : "deny"}`} />
            : null)}
        {h && (
          <g>
            <line x1={x(h.atMs)} x2={x(h.atMs)} y1={PAD.t} y2={H - PAD.b} className="perf-crosshair" />
            <circle cx={x(h.atMs)} cy={y(h.healthFactorBps)} r={4} className="perf-hover-dot" />
          </g>
        )}
        <text x={PAD.l} y={H - 8} className="perf-axis">{new Date(t0).toLocaleTimeString()}</text>
        <text x={W - PAD.r} y={H - 8} className="perf-axis" textAnchor="end">{new Date(t1).toLocaleTimeString()}</text>
      </svg>
      <div className="perf-tooltip" aria-live="polite">
        {h
          ? <>
              <span>{new Date(h.atMs).toLocaleTimeString()} · block {h.blockNumber}</span>
              <span>lowest health factor <b>{hf(h.healthFactorBps)}</b> · ETH ${usd(h.ethUsd)} · {h.protocols.map((p) => `${p.label}: ${p.detail}`).join(" · ")}</span>
              <span>
                {h.action === "EXECUTED" ? "◆ the agent acted through the executor"
                  : h.action === "PROPOSED" ? `● proposed — ${h.verdict} ${h.reasonCode ?? ""}`
                  : h.action === "ERROR" ? "✕ an execution failed; see the activity log"
                  : h.policyEnabled ? "observing; nothing to do" : "observing; policy DISABLED"}
              </span>
            </>
          : <span className="perf-tooltip-hint">Hover the chart for the observation at that moment. ◆ executed · ● proposed and waiting</span>}
      </div>
    </div>
  );
}

/* ───────────────────────────── the panel ───────────────────────────── */

const money = (usd6: string): string => `$${usd(Number(usd6) / 1e6)}`;

/** One protocol's reading, as a tile. Health is shown where the protocol has one; the rest show their own numbers. */
function ProtocolTile({ obs, targetBps }: { obs: DriverObservation; targetBps: number }): React.ReactElement {
  const warn = obs.healthBps !== null && obs.healthBps < targetBps;
  const rows = Object.entries(obs.metrics).filter(([k]) => k !== "healthFactorBps").slice(0, 3);
  return (
    <div className={`perf-tile ${warn ? "perf-tile-warn" : ""}`}>
      <span className="perf-tile-label">{obs.label}</span>
      <span className="perf-tile-value">{obs.healthBps !== null ? hf(obs.healthBps) : (rows[0] ? fmtMetric(rows[0][0], rows[0][1]) : "—")}</span>
      <span className="perf-tile-detail">{obs.healthBps !== null ? "health factor" : rows[0]?.[0].replace(/([A-Z])/g, " $1").toLowerCase()}</span>
      <span className="perf-tile-detail">{obs.detail}</span>
    </div>
  );
}

const fmtMetric = (k: string, v: number): string => /usd/i.test(k) ? `$${usd(v)}` : /bps/i.test(k) ? `${(v / 100).toFixed(1)}%` : v.toFixed(4);

export function PerformancePanel({ deploymentId, fetchPosition, stress, approve, decline, tick, onDecision }: PerformanceProps): React.ReactElement {
  const [data, setData] = useState<ForkPositionView | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [custom, setCustom] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    let live = true;
    fetchPosition(deploymentId)
      .then((d) => { if (live) { setData(d); setError(null); } })
      .catch((e: Error) => { if (live) setError(e); });
    return () => { live = false; };
  }, [deploymentId, fetchPosition]);

  useEffect(() => {
    const stop = load();
    const t = setInterval(load, REFRESH_MS);
    return () => { stop(); clearInterval(t); };
  }, [load]);

  const doStress = async (driverId: string, option: string, value: number): Promise<void> => {
    setBusy(`stress:${driverId}`);
    setNote(null);
    try {
      const r = await stress(deploymentId, driverId, option, value);
      setNote(`${r.detail}. ${r.before.label}: ${r.before.detail} → ${r.after.detail}. ${r.note}`);
      await tick(deploymentId).catch(() => undefined);
      load();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const doApprove = async (correlationId: string): Promise<void> => {
    setBusy(`approve:${correlationId}`);
    setNote(null);
    try {
      const r = await approve(deploymentId, correlationId);
      setNote(`Approved and executed. Signer: ${r.signer}.`);
      load();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const doDecline = async (correlationId: string): Promise<void> => {
    setBusy(`decline:${correlationId}`);
    try {
      await decline(deploymentId, correlationId, "declined by the operator");
      setNote("Declined. The authorization stays ESCALATE; the executor cannot run it.");
      load();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (error) return <PanelProblem error={error} absent="This deployment has no fork position. Performance is measured on a local mainnet fork deployment." />;
  if (!data) return <p className="loading">Reading the position…</p>;

  const l = data.latest;
  const lending = data.samples.some((s) => s.protocols.some((p) => p.healthBps !== null));
  const lines: Line[] = [
    { at: data.policy.restoreHealthFactorBps, label: `restore target ${hf(data.policy.restoreHealthFactorBps)}`, tone: "accent", side: "above" },
    { at: data.policy.targetHealthFactorBps, label: `floor ${hf(data.policy.targetHealthFactorBps)} — the agent acts below this`, tone: "warn", side: "below" },
    { at: data.policy.minHealthFactorBps, label: `risk floor ${hf(data.policy.minHealthFactorBps)} — escalates below this`, tone: "bad", side: "below" },
    { at: 10_000, label: "liquidation 1.000", tone: "muted", side: "above" },
  ];
  const stressed = busy !== null || data.runtime.state === "STOPPED";

  return (
    <div className="performance">
      <div className="perf-head">
        <h3>Agent performance on the fork</h3>
        <p className="lede">
          Read from chain {data.network.chainId} ({data.network.role.replace("_", " ")}, forked from mainnet at block {data.network.forkBlock ?? "?"}).
          Every transaction below is a <strong>{data.network.label}</strong>: it exists on this machine and nowhere else.
          Autonomous up to ${usd(data.policy.autoLimitUsd)} per action; ${usd(data.policy.autoLimitUsd)}–${usd(data.policy.escalationLimitUsd)} needs a human signature; above that is refused.
        </p>
      </div>

      <div className="perf-tiles">
        {(l?.protocols ?? []).map((p) => <ProtocolTile key={p.driverId} obs={p} targetBps={data.policy.targetHealthFactorBps} />)}
        <div className="perf-tile">
          <span className="perf-tile-label">Vault</span>
          <span className="perf-tile-value">{data.vault.usdc !== null ? `${usd(data.vault.usdc)} USDC` : "—"}</span>
          <span className="perf-tile-detail">{data.vault.eth !== null ? `${data.vault.eth.toFixed(4)} ETH · ` : ""}ETH ${l ? usd(l.ethUsd) : "—"} · what the executor pays from</span>
        </div>
        <div className={`perf-tile ${data.policyEnabled ? "" : "perf-tile-muted"}`}>
          <span className="perf-tile-label">Policy</span>
          <span className="perf-tile-value">{data.policyEnabled === null ? "UNKNOWN" : data.policyEnabled ? "ENABLED" : "DISABLED"}</span>
          <span className="perf-tile-detail">runtime {data.runtime.state} · {data.runtime.ticks} observations{l ? ` · block ${l.blockNumber} · ${ago(l.atMs)}` : ""}</span>
        </div>
      </div>

      {lending && <HealthChart samples={data.samples} lines={lines} />}

      {data.pending.map((p) => (
        <div key={p.correlationId} className="perf-pending">
          <p>
            <strong>Waiting for a human.</strong> {p.protocol}: the agent proposed to {p.label} ({money(p.amountUsd6)}) and the policy said ESCALATE
            ({p.reasonCode}) {ago(p.sinceMs)}. Its capability is issued and its authorization is recorded as ESCALATE — the executor will run it only
            once a signature is in the approval registry. It expires at {new Date(p.expiresAtUnix * 1000).toLocaleTimeString()}.
            {" "}<button type="button" className="linklike" onClick={() => onDecision(p.correlationId)}>Why?</button>
          </p>
          <div className="perf-pending-actions">
            <button type="button" className="primary" disabled={busy !== null} onClick={() => void doApprove(p.correlationId)}>
              {busy === `approve:${p.correlationId}` ? "Signing and executing…" : "Approve with the stand-in signer"}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void doDecline(p.correlationId)}>Decline</button>
            <span className="perf-pending-note">Signer <code>{data.approver.address.slice(0, 10)}…</code> — {data.approver.note}</span>
          </div>
        </div>
      ))}
      {data.runtime.lastError && <p className="error">runtime: {data.runtime.lastError}</p>}

      <section className="perf-stress">
        <h4>Stress a position</h4>
        <p className="perf-stress-lede">
          Operator actions, not the agent's — the agent may only take its Blueprint's actions. Each control moves one protocol's position; watch what the agent does next.
        </p>
        {data.scenarios.map((sc) => (
          <div key={sc.driverId} className="perf-stress-row">
            <span className="perf-stress-protocol">{sc.protocol}</span>
            {sc.stressOptions.map((o) => o.kind === "health-target" ? (
              <span key={o.id} className="perf-stress-buttons">
                <span className="perf-stress-label">{o.label}</span>
                {[15_000, 14_000, 13_000].map((t) => (
                  <button key={t} type="button" disabled={stressed} onClick={() => void doStress(sc.driverId, o.id, t)}>{hf(t)}</button>
                ))}
              </span>
            ) : (
              <span key={o.id} className="perf-stress-buttons">
                <span className="perf-stress-label">{o.label}</span>
                <input value={custom[sc.driverId] ?? ""} placeholder={/USDC/.test(o.label) ? "2000" : "0.5"} onChange={(e) => setCustom({ ...custom, [sc.driverId]: e.target.value })} size={6} inputMode="decimal" />
                <button type="button" disabled={stressed || !Number.isFinite(Number(custom[sc.driverId]))} onClick={() => void doStress(sc.driverId, o.id, Number(custom[sc.driverId]))}>send</button>
              </span>
            ))}
          </div>
        ))}
        <div className="perf-stress-buttons">
          <button type="button" disabled={busy !== null} onClick={() => { setBusy("tick"); void tick(deploymentId).finally(() => { setBusy(null); load(); }); }}>observe now</button>
        </div>
        {data.unexercisedActionKinds.length > 0 && <p className="perf-note">No fork scenario for {data.unexercisedActionKinds.join(", ")} — granted by the Blueprint, not exercised here.</p>}
        {note && <p className="perf-note">{note}</p>}
      </section>

      <section className="perf-decisions">
        <h4>Decisions</h4>
        {data.decisions.length === 0
          ? <p className="empty">No proposal yet. The agent proposes when a position needs it: a health factor below {hf(data.policy.targetHealthFactorBps)}, idle ETH, or an allocation off target.</p>
          : (
            <table>
              <thead><tr><th>when</th><th>protocol</th><th>verdict</th><th>reason</th><th>proposed</th><th>health</th><th>outcome</th><th /></tr></thead>
              <tbody>
                {data.decisions.slice(0, 14).map((d) => (
                  <tr key={d.correlationId} className={`decision-${d.verdict.toLowerCase()}`}>
                    <td>{new Date(d.atMs).toLocaleTimeString()}</td>
                    <td>{d.protocol}</td>
                    <td className="decision-verdict">{d.verdict}</td>
                    <td><code>{d.reasonCode}</code></td>
                    <td>{d.label} · {money(d.amountUsd6)}</td>
                    <td>{d.healthFactorBps !== null ? <>{hf(d.healthFactorBps)}{d.healthFactorAfterBps !== null && <> → {hf(d.healthFactorAfterBps)}</>}</> : "—"}</td>
                    <td>{d.executed ? `executed${d.approvedByHuman ? " after human approval (stand-in signer, not a Ledger — BLK-002)" : " autonomously"} · ${d.txHashes.length} fork txs` : d.verdict === "ALLOW" ? (d.policyEnabled ? "execution failed" : "policy disabled") : d.verdict === "ESCALATE" ? "awaiting human approval" : "refused"}</td>
                    <td><button type="button" className="linklike" onClick={() => onDecision(d.correlationId)}>why?</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>

      {data.executions.length > 0 && (
        <section className="perf-executions">
          <h4>Executions</h4>
          <ul>
            {data.executions.slice(0, 8).map((e) => (
              <li key={e.correlationId}>
                <span>{new Date(e.atMs).toLocaleTimeString()} · {e.label} · {money(e.amountUsd6)}{e.healthFactorBeforeBps !== null && e.healthFactorAfterBps !== null && <> · health factor {hf(e.healthFactorBeforeBps)} → {hf(e.healthFactorAfterBps)}</>}{e.approvedByHuman ? " · after human approval (stand-in signer, not a Ledger — BLK-002)" : " · autonomous"}</span>
                <ul className="perf-txs">
                  {e.txs.map((t) => (
                    <li key={t.hash}><code>{t.hash.slice(0, 18)}…</code> block {t.blockNumber} · {t.status} · gas {t.gasUsed} · <em>{data.network.label}</em></li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
