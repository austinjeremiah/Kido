'use client';

/**
 * Evidence the registry cites, openable. Each citation resolves on the backend to the files it names
 * (a test, a script, a run's evidence JSON, or every run matching a glob) and opens read-only in a
 * viewer; secret-shaped values arrive redacted. A citation that names no file says so.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Download, FileSearch, FileText, FolderOpen } from 'lucide-react';
import { Modal } from './dialogs';
import { Badge, Skeleton } from './primitives';
import { SourceView, countMatches } from './code/SourceView';
import { kido } from '@/lib/kido/api';

const ROOT_LABEL: Record<string, string> = { kido: 'Kido', amane: 'Amane', gauntlet: 'Testnet evidence' };

/** A list of citations; each opens the viewer. */
export function EvidenceList({ items, compact }: { items: string[]; compact?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!items.length) return <span className="cl-meta">No evidence recorded.</span>;
  return (
    <>
      <ul className="ev-list" data-compact={compact ? '' : undefined}>
        {items.map((e) => (
          <li key={e}>
            <button type="button" className="ev-link" onClick={() => setOpen(e)} title="Open this evidence">
              <FileSearch size={12} aria-hidden />
              <span>{e}</span>
            </button>
          </li>
        ))}
      </ul>
      {open ? <EvidenceViewer ref_={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

export function EvidenceViewer({ ref_, onClose }: { ref_: string; onClose: () => void }) {
  const res = useQuery({ queryKey: ['kido', 'evidence', ref_], queryFn: () => kido.evidenceResolve(ref_), retry: false });
  const [fileId, setFileId] = useState<string | null>(null);
  useEffect(() => setFileId(res.data?.files[0]?.id ?? null), [res.data]);
  const file = useQuery({ queryKey: ['kido', 'evidence-file', fileId], queryFn: () => kido.evidenceFile(fileId!), enabled: Boolean(fileId), retry: false });
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const matches = useMemo(() => (file.data && query ? countMatches(file.data.content, file.data.language, query) : 0), [file.data, query]);
  const download = () => {
    if (!file.data) return;
    const url = URL.createObjectURL(new Blob([file.data.content], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: file.data.path.split('/').pop() ?? 'evidence.txt' });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal open onClose={onClose} wide title="Evidence" subtitle={ref_} icon={<FileText size={18} aria-hidden style={{ marginTop: 2 }} />}>
      {res.isLoading ? <Skeleton height={120} /> : null}
      {res.isError ? <p className="cl-meta" style={{ color: 'var(--cl-deny)' }}>{(res.error as Error).message}</p> : null}
      {res.data && !res.data.files.length ? (
        <div className="ev-empty">
          <FolderOpen size={16} aria-hidden />
          <div>
            <div className="cl-strong">{res.data.note}</div>
            <p className="cl-meta" style={{ whiteSpace: 'normal', margin: '4px 0 0' }}>The citation is kept as written: {ref_}</p>
          </div>
        </div>
      ) : null}
      {res.data?.files.length ? (
        <div className="ev-split">
          <div className="ev-files">
            <div className="cl-label" style={{ marginBottom: 6 }}>{res.data.files.length} file{res.data.files.length === 1 ? '' : 's'}</div>
            {res.data.files.map((f) => (
              <button key={f.id} type="button" className="ev-file" data-selected={f.id === fileId ? '' : undefined} onClick={() => { setFileId(f.id); setCurrent(0); }}>
                <span className="cl-mono">{f.path}</span>
                <span className="cl-meta">{ROOT_LABEL[f.root] ?? f.root} · {(f.size / 1024).toFixed(1)} KB · {new Date(f.modifiedAt).toLocaleString()}</span>
              </button>
            ))}
          </div>
          <div className="ev-view">
            <div className="cl-row" style={{ gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
              <input className="cl-input" style={{ flex: '1 1 180px', minWidth: 0 }} placeholder="Search in file" value={query} onChange={(e) => { setQuery(e.target.value); setCurrent(0); }} onKeyDown={(e) => { if (e.key === 'Enter' && matches) setCurrent((c) => (c + (e.shiftKey ? matches - 1 : 1)) % matches); }} />
              <span className="cl-meta">{query ? `${matches ? current + 1 : 0}/${matches}` : ''}</span>
              <button type="button" className="cl-btn cl-btn-sm" disabled={!file.data} onClick={() => file.data && void navigator.clipboard.writeText(file.data.content)}><Copy size={12} aria-hidden />Copy</button>
              <button type="button" className="cl-btn cl-btn-sm" disabled={!file.data} onClick={download}><Download size={12} aria-hidden />Download</button>
            </div>
            {file.data ? (
              <div className="cl-row" style={{ gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                <Badge tone="neutral">{ROOT_LABEL[file.data.root] ?? file.data.root}</Badge>
                <span className="cl-mono cl-meta">{file.data.path}</span>
                {file.data.redactions ? <Badge tone="warn">{file.data.redactions} secret-shaped value{file.data.redactions === 1 ? '' : 's'} redacted</Badge> : null}
                {file.data.truncated ? <Badge tone="warn">truncated to 512 KB</Badge> : null}
              </div>
            ) : null}
            <div className="ev-source">
              {file.isLoading ? <Skeleton height={200} /> : file.isError ? <p className="cl-meta" style={{ color: 'var(--cl-deny)' }}>{(file.error as Error).message}</p> : file.data ? <SourceView text={file.data.content} language={file.data.language} query={query} current={current} /> : null}
            </div>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
