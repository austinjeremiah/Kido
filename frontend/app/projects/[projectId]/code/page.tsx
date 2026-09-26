'use client';

/**
 * Code: a read-only explorer of what the agent is built from.
 *
 * Kido does not generate a code repository; an agent is its canonical Blueprint plus what the
 * lifecycle derives from it. This page lays those derived artifacts out as a file tree so they can
 * be read the way code is read: the current Blueprint revision, the exact context each specialist
 * role receives (and the knowledge packs inside it), the authority policy, the build, security and
 * simulation reports, the privacy plan and the runtime self-model. Every file is fetched from the
 * Kido API; none can be edited here — changes go through the Composer, which re-runs the gates.
 *
 * `?role=<Role>` opens that role's context; `?file=<path>` opens any file.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  Braces,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  FileText,
  Folder,
  FolderOpen,
  Lock,
  Search,
  X,
} from 'lucide-react';
import { StudioPage } from '@/components/studio/PageScaffold';
import { Badge, BlockerBanner, EmptyState, Skeleton, shortHash } from '@/components/studio/primitives';
import { WithProject } from '@/components/studio/kido';
import { SourceView, countMatches, type SourceLanguage } from '@/components/studio/code/SourceView';
import { kido } from '@/lib/kido/api';
import { keys, useAgentContext, useSelfModel } from '@/lib/kido/hooks';
import type { Freshness, ProjectSummary } from '@/lib/kido/types';

/* ------------------------------------------------------------------ model */

interface AgentContext {
  role: string;
  sections: { id: string; text: string }[];
  knowledge: { included: string[]; missing: string[] };
  text: string;
}

type FileKind = 'blueprint' | 'context' | 'prompt' | 'pack' | 'policy' | 'build' | 'security' | 'simulation' | 'privacy' | 'self-model';

interface VFile {
  path: string;
  name: string;
  kind: FileKind;
  language: SourceLanguage;
  role?: string;
  pack?: string;
  /** Where the content comes from, shown above the editor. */
  source: string;
  /** Tree marks: absent (not produced yet), stale, missing pack. */
  mark?: { tone: 'warn' | 'blocked' | 'deny'; label: string; title: string };
}

interface TreeFolder {
  id: string;
  label: string;
  files: VFile[];
  folders: TreeFolder[];
}

const staleMark = (f: Freshness | undefined, what: string): VFile['mark'] =>
  f === 'STALE' ? { tone: 'warn', label: 'STALE', title: `The ${what} was produced for an older Blueprint revision` } : undefined;
const absentMark = (what: string): VFile['mark'] => ({ tone: 'blocked', label: 'NONE', title: `No ${what} yet` });

function buildFiles(s: ProjectSummary): { files: VFile[]; tree: TreeFolder } {
  const bp = s.blueprint;
  const files: VFile[] = [];
  const add = (f: VFile) => (files.push(f), f);

  const root: TreeFolder = { id: '', label: 'root', files: [], folders: [] };
  root.files.push(
    add({
      path: 'blueprint.json',
      name: 'blueprint.json',
      kind: 'blueprint',
      language: 'json',
      source: bp ? `Canonical Agent Blueprint, revision ${bp.revision}${s.blueprintHash ? ` · hash ${shortHash(s.blueprintHash, 10, 6)}` : ''}` : 'The Blueprint is compiled when the interview finishes',
      mark: bp ? undefined : absentMark('Blueprint'),
    }),
  );

  const agentsDir: TreeFolder = { id: 'agents', label: 'agents', files: [], folders: [] };
  for (const a of bp?.agents ?? []) {
    const built = s.build?.agents.find((b) => b.role === a.role);
    const dir: TreeFolder = { id: `agents/${a.role}`, label: a.role, files: [], folders: [] };
    dir.files.push(
      add({
        path: `agents/${a.role}/context.json`,
        name: 'context.json',
        kind: 'context',
        language: 'json',
        role: a.role,
        source: `GET /projects/:id/context/${a.role} — the exact context the ${a.role} specialist receives, section by section`,
      }),
      add({
        path: `agents/${a.role}/prompt.md`,
        name: 'prompt.md',
        kind: 'prompt',
        language: 'md',
        role: a.role,
        source: `The assembled context text handed to the ${a.role} model, verbatim`,
      }),
    );
    const packs: TreeFolder = { id: `agents/${a.role}/knowledge`, label: 'knowledge', files: [], folders: [] };
    for (const p of a.knowledgePacks) {
      const missing = built?.missingPacks.includes(p);
      packs.files.push(
        add({
          path: `agents/${a.role}/knowledge/${p}.md`,
          name: `${p}.md`,
          kind: 'pack',
          language: 'md',
          role: a.role,
          pack: p,
          source: `Knowledge pack ${p}, as included in the ${a.role} context`,
          mark: missing ? { tone: 'deny', label: 'MISSING', title: 'The build could not include this pack' } : undefined,
        }),
      );
    }
    if (packs.files.length) dir.folders.push(packs);
    agentsDir.folders.push(dir);
  }
  if (agentsDir.folders.length) root.folders.push(agentsDir);

  const authorityDir: TreeFolder = { id: 'authority', label: 'authority', files: [], folders: [] };
  authorityDir.files.push(
    add({
      path: 'authority/policy.json',
      name: 'policy.json',
      kind: 'policy',
      language: 'json',
      source: 'blueprint.authority (what the owner decided) and build.authority (what the build compiled for Amane)',
      mark: bp ? staleMark(s.build?.freshness, 'build') : absentMark('authority'),
    }),
  );
  root.folders.push(authorityDir);

  const lifecycleDir: TreeFolder = { id: 'lifecycle', label: 'lifecycle', files: [], folders: [] };
  lifecycleDir.files.push(
    add({ path: 'build.json', name: 'build.json', kind: 'build', language: 'json', source: s.build ? `Build r${s.build.buildRevision} of Blueprint r${s.build.blueprintRevision} · ${s.build.freshness}` : 'Produced by the Build gate', mark: s.build ? staleMark(s.build.freshness, 'build') : absentMark('build') }),
    add({ path: 'security.json', name: 'security.json', kind: 'security', language: 'json', source: s.security ? `Security review of Blueprint r${s.security.blueprintRevision} · ${s.security.freshness}` : 'Produced by the Security review gate', mark: s.security ? staleMark(s.security.freshness, 'security review') : absentMark('security review') }),
    add({ path: 'simulation.json', name: 'simulation.json', kind: 'simulation', language: 'json', source: s.simulation ? `Simulation of Blueprint r${s.simulation.blueprintRevision} · ${s.simulation.freshness}` : 'Produced by the Simulation gate', mark: s.simulation ? staleMark(s.simulation.freshness, 'simulation') : absentMark('simulation') }),
    add({ path: 'privacy-plan.json', name: 'privacy-plan.json', kind: 'privacy', language: 'json', source: 'The compiled privacy plan: provider per private value, per chain', mark: s.privacyPlan ? undefined : absentMark('privacy plan') }),
  );
  root.folders.push(lifecycleDir);

  const runtimeDir: TreeFolder = { id: 'runtime', label: 'runtime', files: [], folders: [] };
  runtimeDir.files.push(
    add({ path: 'self-model.json', name: 'self-model.json', kind: 'self-model', language: 'json', source: 'GET /projects/:id/self-model — what the agent knows about itself: providers, execution adapters, authority, privacy', mark: bp ? undefined : absentMark('self-model') }),
  );
  root.folders.push(runtimeDir);

  return { files, tree: root };
}

/** The knowledge section of a context, split back into its packs. */
function splitPacks(ctx: Partial<AgentContext> | undefined): Record<string, { header: string; body: string }> {
  const text = ctx?.sections?.find((x) => x.id === 'knowledge')?.text ?? '';
  const out: Record<string, { header: string; body: string }> = {};
  const re = /^=== KNOWLEDGE PACK (\S+) \((.*)\) ===$/gm;
  const heads = [...text.matchAll(re)];
  heads.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < heads.length ? heads[i + 1]!.index ?? text.length : text.length;
    out[m[1]!] = { header: m[2]!, body: text.slice(start, end).trim() };
  });
  return out;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

function staticContent(f: VFile, s: ProjectSummary): string | null {
  switch (f.kind) {
    case 'blueprint':
      return s.blueprint ? json(s.blueprint) : null;
    case 'policy':
      return s.blueprint ? json({ blueprint: s.blueprint.authority, build: s.build?.authority ?? null }) : null;
    case 'build':
      return s.build ? json(s.build) : null;
    case 'security':
      return s.security ? json(s.security) : null;
    case 'simulation':
      return s.simulation ? json(s.simulation) : null;
    case 'privacy':
      return s.privacyPlan ? json(s.privacyPlan) : null;
    default:
      return null;
  }
}

function saveText(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------- page */

function Explorer({ s }: { s: ProjectSummary }) {
  const params = useSearchParams();
  const qc = useQueryClient();
  const { files, tree } = useMemo(() => buildFiles(s), [s]);

  const initial = useMemo(() => {
    const file = params.get('file');
    const role = params.get('role');
    if (file && files.some((f) => f.path === file)) return file;
    if (role && files.some((f) => f.path === `agents/${role}/context.json`)) return `agents/${role}/context.json`;
    return 'blueprint.json';
  }, [params, files]);

  const [open, setOpen] = useState<string[]>([initial]);
  const [active, setActive] = useState(initial);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState(false);
  const [bundling, setBundling] = useState<string | null>(null);

  /* A changed ?role= / ?file= (e.g. a link from another page) opens that file. */
  useEffect(() => {
    setOpen((o) => (o.includes(initial) ? o : [...o, initial]));
    setActive(initial);
  }, [initial]);

  const file = files.find((f) => f.path === active) ?? files[0]!;
  const selfModel = useSelfModel(s.projectId, Boolean(s.blueprint));
  const ctxQ = useAgentContext(s.projectId, file.role ?? null);
  const ctx = ctxQ.data as AgentContext | undefined;
  const packs = useMemo(() => splitPacks(ctx), [ctx]);

  const content: { text: string | null; loading: boolean; error: string | null; empty: string } = (() => {
    switch (file.kind) {
      case 'context':
        return { text: ctx ? json(ctx) : null, loading: ctxQ.isLoading, error: ctxQ.error ? (ctxQ.error as Error).message : null, empty: 'No context' };
      case 'prompt':
        return { text: ctx?.text ?? null, loading: ctxQ.isLoading, error: ctxQ.error ? (ctxQ.error as Error).message : null, empty: 'No context' };
      case 'pack': {
        if (ctxQ.isLoading || ctxQ.error) return { text: null, loading: ctxQ.isLoading, error: ctxQ.error ? (ctxQ.error as Error).message : null, empty: '' };
        const p = packs[file.pack!];
        const missing = ctx?.knowledge.missing.includes(file.pack!);
        return {
          text: p ? p.body : null,
          loading: false,
          error: null,
          empty: missing ? `The ${file.role} context lists ${file.pack} as missing: the pack was not available when the context was assembled, so this specialist does not receive it.` : `${file.pack} is not in the ${file.role} context.`,
        };
      }
      case 'self-model':
        return { text: selfModel.data ? json(selfModel.data) : null, loading: selfModel.isLoading, error: selfModel.error ? (selfModel.error as Error).message : null, empty: 'The self-model exists once a Blueprint is compiled.' };
      default: {
        const t = staticContent(file, s);
        return { text: t, loading: false, error: null, empty: `${file.mark?.title ?? 'Nothing here yet'}. It is produced by the lifecycle gates in the Composer.` };
      }
    }
  })();

  const matches = content.text ? countMatches(content.text, file.language, query) : 0;
  useEffect(() => setCurrent(0), [query, active]);

  const openFile = (path: string) => {
    setOpen((o) => (o.includes(path) ? o : [...o, path]));
    setActive(path);
  };
  const closeFile = (path: string) => {
    setOpen((o) => {
      const next = o.filter((p) => p !== path);
      if (path === active) setActive(next[next.length - 1] ?? 'blueprint.json');
      return next.length ? next : ['blueprint.json'];
    });
  };

  /* Every file in one JSON document, fetching each role's context on the way. */
  const downloadBundle = async () => {
    setBundling('Collecting…');
    try {
      const out: Record<string, unknown> = {};
      const roles = s.blueprint?.agents.map((a) => a.role) ?? [];
      const ctxs = await Promise.all(
        roles.map((r) => qc.fetchQuery({ queryKey: keys.context(s.projectId, r), queryFn: () => kido.context(s.projectId, r) }).catch((e: Error) => ({ error: e.message }))),
      );
      const sm = s.blueprint ? await qc.fetchQuery({ queryKey: keys.selfModel(s.projectId), queryFn: () => kido.selfModel(s.projectId) }).catch((e: Error) => ({ error: e.message })) : null;
      for (const f of files) {
        if (f.kind === 'context') out[f.path] = ctxs[roles.indexOf(f.role!)];
        else if (f.kind === 'prompt') out[f.path] = (ctxs[roles.indexOf(f.role!)] as unknown as Partial<AgentContext>).text ?? null;
        else if (f.kind === 'pack') out[f.path] = splitPacks(ctxs[roles.indexOf(f.role!)] as unknown as Partial<AgentContext>)[f.pack!]?.body ?? null;
        else if (f.kind === 'self-model') out[f.path] = sm;
        else {
          const t = staticContent(f, s);
          out[f.path] = t ? JSON.parse(t) : null;
        }
      }
      saveText(`${s.projectId}-r${s.revision ?? 0}-sources.json`, json({ projectId: s.projectId, blueprintRevision: s.revision, blueprintHash: s.blueprintHash, files: out }));
    } finally {
      setBundling(null);
    }
  };

  const needle = filter.trim().toLowerCase();
  const visible = (f: VFile) => !needle || f.path.toLowerCase().includes(needle);
  const packHeader = file.kind === 'pack' ? packs[file.pack!]?.header : undefined;
  const lineCount = content.text ? content.text.split('\n').length : 0;

  const renderFolder = (folder: TreeFolder, depth: number): ReactNode => {
    const shown = folder.files.filter(visible);
    const sub = folder.folders.map((f) => ({ f, node: renderFolder(f, depth + 1) })).filter((x) => x.node !== null);
    if (!shown.length && !sub.length) return null;
    const isRoot = folder.id === '';
    const isCollapsed = !needle && collapsed.has(folder.id);
    return (
      <div key={folder.id || 'root'}>
        {isRoot ? null : (
          <button
            type="button"
            className="cl-nav-item"
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => setCollapsed((c) => {
              const n = new Set(c);
              if (n.has(folder.id)) n.delete(folder.id);
              else n.add(folder.id);
              return n;
            })}
            aria-expanded={!isCollapsed}
          >
            {isCollapsed ? <ChevronRight size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
            {isCollapsed ? <Folder size={13} aria-hidden /> : <FolderOpen size={13} aria-hidden />}
            <span className="cl-nav-item-label cl-mono" style={{ fontSize: 12.5 }}>{folder.label}</span>
            {folder.id.startsWith('agents/') && folder.id.split('/').length === 2 ? <Badge tone="data">role</Badge> : null}
          </button>
        )}
        {isCollapsed ? null : (
          <>
            {sub.map((x) => x.node)}
            {shown.map((f) => (
              <button
                key={f.path}
                type="button"
                className="cl-nav-item"
                data-active={f.path === active}
                style={{ paddingLeft: 10 + (isRoot ? depth : depth + 1) * 14 + 12 }}
                onClick={() => openFile(f.path)}
                title={f.path}
              >
                {f.language === 'json' ? <Braces size={12} aria-hidden /> : <FileText size={12} aria-hidden />}
                <span className="cl-nav-item-label cl-mono" style={{ fontSize: 12.5 }}>{f.name}</span>
                {f.mark ? (
                  <span className="cl-badge" data-tone={f.mark.tone} title={f.mark.title} style={{ height: 16, padding: '0 5px', fontSize: 9 }}>
                    {f.mark.label}
                  </span>
                ) : null}
              </button>
            ))}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="cl-split" style={{ borderTop: '1px solid var(--cl-line)' }}>
      {/* file tree */}
      <div className="cl-split-side" data-lenis-prevent style={{ flex: '0 0 280px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '10px 10px 6px' }}>
          <input className="cl-input" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter files" style={{ height: 28 }} />
        </div>
        <div className="cl-explorer-group">
          <span className="cl-label">{s.name}</span>
        </div>
        <div style={{ flex: '1 1 auto', overflowY: 'auto', paddingBottom: 12 }}>{renderFolder(tree, 0)}</div>
        <div className="cl-meta" style={{ padding: '8px 12px', borderTop: '1px solid var(--cl-line)' }}>
          {files.length} files · derived from Blueprint {s.revision === null ? '—' : `r${s.revision}`}
        </div>
      </div>

      {/* editor */}
      <div className="cl-split-main" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="cl-tabbar" role="tablist">
          {open.map((p) => {
            const f = files.find((x) => x.path === p);
            if (!f) return null;
            return (
              <div key={p} className="cl-tab" data-active={p === active} role="tab" aria-selected={p === active} onClick={() => setActive(p)} title={p}>
                {f.language === 'json' ? <Braces size={12} aria-hidden /> : <FileText size={12} aria-hidden />}
                <span className="cl-mono" style={{ fontSize: 12 }}>{f.role && f.kind !== 'pack' ? `${f.role}/${f.name}` : f.name}</span>
                <button
                  type="button"
                  className="cl-tab-close"
                  aria-label={`Close ${f.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeFile(p);
                  }}
                >
                  <X size={11} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>

        {/* toolbar */}
        <div className="cl-row cl-row-wrap" style={{ gap: 8, padding: '9px 14px', borderBottom: '1px solid var(--cl-line)', background: 'var(--cl-panel-2)', flex: '0 0 auto' }}>
          <span className="cl-mono" style={{ fontSize: 12.5 }}>{file.path}</span>
          <Badge tone="blocked" title="Derived from the Blueprint; change it in the Composer">
            <Lock size={10} aria-hidden /> Read-only
          </Badge>
          {file.mark ? <Badge tone={file.mark.tone} title={file.mark.title}>{file.mark.label}</Badge> : null}
          {packHeader ? <Badge tone={/VERIFIED_LIVE/.test(packHeader) ? 'pass' : 'warn'}>{packHeader}</Badge> : null}
          {file.kind === 'context' && ctx ? (
            <Badge tone={ctx.knowledge.missing.length ? 'deny' : 'neutral'}>
              {ctx.knowledge.included.length} packs{ctx.knowledge.missing.length ? ` · ${ctx.knowledge.missing.length} missing` : ''} · {ctx.text.length.toLocaleString()} chars
            </Badge>
          ) : null}
          <span className="cl-spacer" />
          <div className="cl-row" style={{ gap: 4, position: 'relative' }}>
            <Search size={12} aria-hidden style={{ position: 'absolute', left: 8, color: 'var(--cl-ink-3)' }} />
            <input
              className="cl-input"
              placeholder="Search in file"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && matches) setCurrent((c) => (e.shiftKey ? (c - 1 + matches) % matches : (c + 1) % matches));
                if (e.key === 'Escape') setQuery('');
              }}
              aria-label="Search in file"
              style={{ height: 28, width: 190, paddingLeft: 26 }}
            />
            <span className="cl-meta" style={{ minWidth: 52, textAlign: 'right' }}>{query ? (matches ? `${current + 1}/${matches}` : '0/0') : ''}</span>
            <button type="button" className="cl-btn cl-btn-sm cl-btn-ghost" aria-label="Previous match" disabled={!matches} onClick={() => setCurrent((c) => (c - 1 + matches) % matches)}>
              <ChevronUp size={12} aria-hidden />
            </button>
            <button type="button" className="cl-btn cl-btn-sm cl-btn-ghost" aria-label="Next match" disabled={!matches} onClick={() => setCurrent((c) => (c + 1) % matches)}>
              <ChevronDown size={12} aria-hidden />
            </button>
          </div>
          <button
            type="button"
            className="cl-btn cl-btn-sm"
            disabled={!content.text}
            onClick={() => {
              navigator.clipboard?.writeText(content.text ?? '');
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            }}
          >
            <Copy size={11} aria-hidden />
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            className="cl-btn cl-btn-sm"
            disabled={!content.text}
            onClick={() => saveText(file.path.replace(/\//g, '_'), content.text ?? '', file.language === 'json' ? 'application/json' : 'text/markdown')}
          >
            <Download size={11} aria-hidden />
            Download
          </button>
          <button type="button" className="cl-btn cl-btn-sm cl-btn-primary" disabled={!!bundling} onClick={() => void downloadBundle()} title="Every file in this tree as one JSON document">
            <Download size={11} aria-hidden />
            {bundling ?? 'Download all'}
          </button>
        </div>
        <div className="cl-meta" style={{ padding: '6px 14px', borderBottom: '1px solid var(--cl-line)', flex: '0 0 auto' }}>{file.source}</div>

        {/* editor surface */}
        <div data-lenis-prevent style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', background: 'var(--cl-canvas)' }}>
          {content.loading ? (
            <div style={{ padding: 16 }} className="cl-stack">
              {[92, 74, 86, 60, 78, 54].map((w, i) => <Skeleton key={i} height={12} width={`${w}%`} />)}
            </div>
          ) : content.error ? (
            <div style={{ padding: 16 }}>
              <BlockerBanner tone="deny" title="The Kido API refused">{content.error}</BlockerBanner>
            </div>
          ) : content.text === null ? (
            <div style={{ padding: 16 }}>
              <EmptyState
                title={`No ${file.name} yet`}
                body={content.empty}
                action={<Link className="cl-btn cl-btn-primary" href={`/projects/${s.projectId}/build`}>Open the Composer</Link>}
              />
            </div>
          ) : (
            <SourceView text={content.text} language={file.language} query={query} current={current} />
          )}
        </div>

        {/* status strip */}
        <div className="cl-row" style={{ gap: 12, padding: '6px 14px', borderTop: '1px solid var(--cl-line)', flex: '0 0 auto', fontSize: 12 }}>
          <span className="cl-meta">Derived artifacts are read-only: edit the Blueprint through the Composer and the lifecycle regenerates them.</span>
          <span className="cl-spacer" />
          {content.text ? (
            <span className="cl-meta cl-mono">
              {file.language.toUpperCase()} · {lineCount} lines · {content.text.length.toLocaleString()} chars
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Header({ s }: { s: ProjectSummary }) {
  return (
    <div className="cl-row cl-row-wrap" style={{ marginBottom: 12, gap: 8 }}>
      <span className="cl-page-title" style={{ fontSize: 22, marginRight: 8 }}>Code</span>
      <Badge tone="neutral">Blueprint {s.revision === null ? '—' : `r${s.revision}`}</Badge>
      {s.blueprintHash ? <Badge tone="neutral" title={s.blueprintHash}>{shortHash(s.blueprintHash, 8, 6)}</Badge> : null}
      {s.build ? <Badge tone={s.build.freshness === 'CURRENT' ? 'pass' : 'warn'}>Build r{s.build.buildRevision} · {s.build.freshness}</Badge> : <Badge tone="blocked">Not built</Badge>}
      <Badge tone="neutral">{s.blueprint?.agents.length ?? 0} roles</Badge>
      <span className="cl-spacer" />
      <Link className="cl-btn cl-btn-sm" href={`/projects/${s.projectId}/blueprint`}>Open Blueprint</Link>
      <Link className="cl-btn cl-btn-sm" href={`/projects/${s.projectId}/build`}>Open Composer</Link>
    </div>
  );
}

export default function CodePage() {
  return (
    <StudioPage segment="code" bleed>
      <WithProject>
        {(s) =>
          s.blueprint ? (
            <>
              <div style={{ padding: '12px 16px 0' }}>
                <Header s={s} />
              </div>
              <Explorer s={s} />
            </>
          ) : (
            <div className="cl-page-pad">
              <EmptyState
                title="Nothing to read yet"
                body="The agent's sources — Blueprint, specialist contexts, policy and reports — exist once the interview is finished and the Blueprint is compiled."
                action={<Link className="cl-btn cl-btn-primary" href={`/projects/${s.projectId}/build`}>Open the Composer</Link>}
              />
            </div>
          )
        }
      </WithProject>
    </StudioPage>
  );
}
