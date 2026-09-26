'use client';

/**
 * Custom Architecture node.
 *
 * One node type renders every category, distinguished by icon, label and its
 * network role. When the live overlay is on, the observed state replaces the
 * configured state — the same graph, never a second one (spec §13).
 */
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  Boxes,
  CircleUser,
  Cpu,
  Database,
  Fingerprint,
  Globe,
  Landmark,
  Link2,
  Radio,
  ScrollText,
  Server,
  ShieldCheck,
  Ticket,
  Waypoints,
  Wallet,
  Send,
  Activity,
  EyeOff,
  Repeat,
  UserCheck,
  Zap,
} from 'lucide-react';
import { StatusBadge, statusTone } from '../primitives';
import type { ArchNodeData, ArchNodeKind } from '@/lib/studio/types';

const ICONS: Record<ArchNodeKind, React.ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>> = {
  operator: CircleUser,
  'agent-runtime': Server,
  ens: Fingerprint,
  policy: ShieldCheck,
  cre: Radio,
  'chainlink-feed': Link2,
  'the-graph': Database,
  aave: Landmark,
  uniswap: Waypoints,
  'adapter-broker': Boxes,
  'reality-engine': Globe,
  'local-fork': Cpu,
  capability: Ticket,
  executor: Send,
  treasury: Wallet,
  ledger: ScrollText,
};

/** Icons for node categories the shared kind list does not name (monitors, privacy, transports…). */
const EXTRA_ICONS = {
  monitor: Activity,
  privacy: EyeOff,
  transport: Repeat,
  payee: UserCheck,
  action: Zap,
} as const;
export type ArchExtraIcon = keyof typeof EXTRA_ICONS;

/**
 * `chainTag` names the chain a node lives on (shown instead of the generic network role line);
 * `subtitle` is one short fact under the status; `iconKey` overrides the kind's icon.
 */
export type ArchFlowNodeData = ArchNodeData & { liveOverlay: boolean; dimmed: boolean; chainTag?: string; subtitle?: string; iconKey?: ArchExtraIcon };

export function ArchFlowNode({ data, selected }: NodeProps) {
  const d = data as ArchFlowNodeData;
  const Icon = (d.iconKey ? EXTRA_ICONS[d.iconKey] : undefined) ?? ICONS[d.kind] ?? Boxes;
  const status = d.liveOverlay ? (d.liveStatus ?? d.status) : d.status;
  const tone = statusTone(status);

  return (
    <div
      style={{
        width: 216,
        background: 'var(--cl-panel)',
        border: `1px solid ${selected ? 'var(--cl-brand)' : 'var(--cl-line-strong)'}`,
        /* Was a hardcoded rgba(0,66,175) — the old cream theme's blue ink,
           written out by hand, so it survived the flip as a faint navy halo
           nobody could see on a dark canvas. */
        boxShadow: selected ? '0 0 0 2px var(--cl-brand-soft)' : 'none',
        opacity: d.dimmed ? 0.26 : 1,
        transition: 'opacity 0.2s ease, box-shadow 0.15s ease, border-color 0.15s ease',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: 'var(--cl-ink-3)', width: 7, height: 7, border: 'none' }} />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          borderBottom: '1px solid var(--cl-line)',
          background: 'var(--cl-panel-2)',
        }}
      >
        <Icon size={15} strokeWidth={1.6} aria-hidden />
        <span
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            fontFamily: 'var(--medium)',
            fontSize: 12.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {d.label}
        </span>
        <span
          className="cl-badge-dot"
          style={{ background: `var(--cl-${tone === 'neutral' ? 'ink-2' : tone})`, flex: '0 0 auto' }}
          aria-hidden
        />
      </div>

      <div style={{ padding: '8px 10px' }}>
        <div className="cl-row cl-row-wrap" style={{ gap: 4 }}>
          <StatusBadge status={status} icon={false} />
          {d.trustClass ? (
            <span className="cl-badge" data-tone={d.trustClass === 'VERIFIED_ORACLE' ? 'pass' : d.trustClass === 'SIMULATED' ? 'sim' : 'data'}>
              {d.trustClass.replace(/_/g, ' ')}
            </span>
          ) : null}
        </div>
        {d.subtitle ? (
          <div className="cl-meta" style={{ marginTop: 6, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.subtitle}>
            {d.subtitle}
          </div>
        ) : null}
        {d.chainTag ? (
          <div className="cl-meta" style={{ marginTop: 6, fontSize: 10.5 }}>
            {d.chainTag.toUpperCase()}
          </div>
        ) : d.networkRole === 'MAINNET_READ_ONLY' ? (
          <div className="cl-meta" style={{ marginTop: 6, fontSize: 10.5 }}>
            MAINNET · READ ONLY
          </div>
        ) : d.networkRole === 'EXECUTION_TESTNET' ? (
          <div className="cl-meta" style={{ marginTop: 6, fontSize: 10.5 }}>
            SEPOLIA · TESTNET
          </div>
        ) : null}
      </div>

      <Handle type="source" position={Position.Right} style={{ background: 'var(--cl-ink-3)', width: 7, height: 7, border: 'none' }} />
    </div>
  );
}
