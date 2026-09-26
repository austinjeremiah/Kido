'use client';

/**
 * Read-only source viewer for the Code explorer: line numbers, a small tokenizer that colours JSON
 * and Markdown-ish text, and in-file search that highlights every match and scrolls to the current
 * one. No editor library: every file shown here is derived data, never edited in place.
 */
import { Fragment, useEffect, useMemo, useRef, type ReactNode } from 'react';

export type SourceLanguage = 'json' | 'md' | 'text';

type Tok = { t: 'key' | 'str' | 'num' | 'bool' | 'null' | 'punct' | 'head' | 'rule' | 'bullet' | 'plain'; v: string };

const TOK_COLOR: Record<Tok['t'], string | undefined> = {
  key: 'var(--cl-data)',
  str: 'var(--cl-pass)',
  num: 'var(--cl-warn)',
  bool: 'var(--cl-sim)',
  null: 'var(--cl-ink-3)',
  punct: 'var(--cl-ink-3)',
  head: 'var(--cl-brand)',
  rule: 'var(--cl-sim)',
  bullet: 'var(--cl-ink-3)',
  plain: undefined,
};

const JSON_RE = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b|([{}[\],:])/g;

function tokenizeJsonLine(line: string): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  for (const m of line.matchAll(JSON_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ t: 'plain', v: line.slice(last, i) });
    if (m[1] !== undefined) {
      out.push({ t: m[2] ? 'key' : 'str', v: m[1] });
      if (m[2]) out.push({ t: 'punct', v: m[2] });
    } else if (m[3] !== undefined) out.push({ t: 'num', v: m[3] });
    else if (m[4] !== undefined) out.push({ t: 'bool', v: m[4] });
    else if (m[5] !== undefined) out.push({ t: 'null', v: m[5] });
    else out.push({ t: 'punct', v: m[6]! });
    last = i + m[0].length;
  }
  if (last < line.length) out.push({ t: 'plain', v: line.slice(last) });
  return out;
}

function tokenizeMdLine(line: string): Tok[] {
  if (/^\s*#{1,6}\s/.test(line)) return [{ t: 'head', v: line }];
  if (/^={3}.*={3}$/.test(line.trim())) return [{ t: 'rule', v: line }];
  const b = /^(\s*[-*]\s|\s*\d+\.\s)(.*)$/.exec(line);
  if (b) return [{ t: 'bullet', v: b[1]! }, { t: 'plain', v: b[2]! }];
  return [{ t: 'plain', v: line }];
}

/** Wraps every case-insensitive occurrence of `q` in a <mark>; `current` gets the strong style. */
function highlight(text: string, q: string, startIndex: number, current: number): { node: ReactNode; count: number } {
  if (!q) return { node: text, count: 0 };
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let count = 0;
  for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + needle.length)) {
    if (i > from) parts.push(text.slice(from, i));
    const idx = startIndex + count;
    parts.push(
      <mark
        key={i}
        data-match={idx}
        style={{
          background: idx === current ? 'var(--cl-warn)' : 'var(--cl-warn-bg)',
          color: idx === current ? 'var(--cl-ink-inv)' : 'inherit',
          borderRadius: 2,
        }}
      >
        {text.slice(i, i + needle.length)}
      </mark>,
    );
    from = i + needle.length;
    count++;
  }
  if (from < text.length) parts.push(text.slice(from));
  return { node: parts, count };
}

function tokenize(line: string, language: SourceLanguage): Tok[] {
  return language === 'json' ? tokenizeJsonLine(line) : language === 'md' ? tokenizeMdLine(line) : [{ t: 'plain', v: line }];
}

function countIn(text: string, needle: string): number {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Matches of `q` as the viewer highlights them (within tokens), so the counter and the marks agree. */
export function countMatches(text: string, language: SourceLanguage, q: string): number {
  if (!q) return 0;
  const needle = q.toLowerCase();
  let n = 0;
  for (const line of text.split('\n')) for (const tok of tokenize(line, language)) n += countIn(tok.v.toLowerCase(), needle);
  return n;
}

export function SourceView({ text, language, query, current }: { text: string; language: SourceLanguage; query: string; current: number }) {
  const lines = useMemo(() => text.split('\n'), [text]);
  const tokenized = useMemo(
    () => lines.map((l) => tokenize(l, language)),
    [lines, language],
  );
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!query) return;
    const el = ref.current?.querySelector<HTMLElement>(`[data-match="${current}"]`);
    const box = ref.current?.parentElement;
    if (!el || !box) return;
    /* Vertical only: scrollIntoView also scrolls sideways and hides the line numbers. */
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTop = Math.max(0, top - box.clientHeight / 2);
    const left = el.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft;
    if (left > box.scrollLeft + box.clientWidth - 40 || left < box.scrollLeft) box.scrollLeft = Math.max(0, left - box.clientWidth / 2);
  }, [query, current, text]);

  const gutter = String(lines.length).length;
  let seen = 0;
  return (
    <div
      ref={ref}
      className="cl-mono"
      style={{ fontSize: 12.5, lineHeight: '20px', padding: '10px 0', minWidth: 'max-content' }}
      role="region"
      aria-label="File contents"
    >
      {tokenized.map((toks, n) => (
        <div key={n} style={{ display: 'flex', whiteSpace: 'pre' }}>
          <span
            aria-hidden
            style={{ flex: `0 0 ${gutter + 3}ch`, textAlign: 'right', paddingRight: 14, color: 'var(--cl-ink-3)', userSelect: 'none', opacity: 0.8 }}
          >
            {n + 1}
          </span>
          <span style={{ paddingRight: 24 }}>
            {toks.map((tok, i) => {
              const h = highlight(tok.v, query, seen, current);
              seen += h.count;
              return (
                <Fragment key={i}>
                  <span style={{ color: TOK_COLOR[tok.t] }}>{h.node}</span>
                </Fragment>
              );
            })}
          </span>
        </div>
      ))}
    </div>
  );
}
