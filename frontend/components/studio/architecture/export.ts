/**
 * Architecture export: the graph as JSON (nodes, edges, positions, the blueprint it came from), or
 * drawn as a standalone SVG / PNG from the same positions, coloured with the canvas's own theme.
 */
import { EDGE_KIND, type GEdge, type GNode } from './graph';

const W = 216;
const H = 78;

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function exportJson(name: string, meta: Record<string, unknown>, nodes: GNode[], edges: GEdge[], statusOf: (id: string) => string) {
  const body = {
    ...meta,
    exportedAt: new Date().toISOString(),
    nodes: nodes.map((n) => ({ id: n.id, type: n.ref.type, label: n.data.label, kind: n.data.kind, chain: n.data.chainTag ?? null, status: statusOf(n.id), layers: n.data.layers, purpose: n.data.purpose, position: n.position, ref: n.ref })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, kind: e.kind, label: e.label, layers: e.layers })),
  };
  download(`${name}.json`, new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
}

function svgOf(nodes: GNode[], edges: GEdge[], statusOf: (id: string) => string, scope: Element | null): { svg: string; width: number; height: number } {
  const css = scope ? getComputedStyle(scope) : null;
  const token = (v: string, fallback: string) => {
    const m = /^var\((--[\w-]+)\)$/.exec(v);
    const name = m ? m[1]! : v;
    return (css?.getPropertyValue(name).trim() || fallback);
  };
  const bg = token('--cl-canvas', '#ffffff');
  const panel = token('--cl-panel', '#ffffff');
  const head = token('--cl-panel-2', '#f3f3f3');
  const line = token('--cl-line-strong', '#999999');
  const ink = token('--cl-ink', '#111111');
  const ink2 = token('--cl-ink-2', '#555555');
  const pad = 40;
  const xs = nodes.map((n) => n.position.x);
  const ys = nodes.map((n) => n.position.y);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const width = Math.max(...xs) + W + pad - minX;
  const height = Math.max(...ys) + H + pad - minY;
  const at = new Map(nodes.map((n) => [n.id, n.position]));
  const parts: string[] = [];
  edges.forEach((e) => {
    const s = at.get(e.source);
    const t = at.get(e.target);
    if (!s || !t) return;
    const x1 = s.x + W - minX, y1 = s.y + H / 2 - minY, x2 = t.x - minX, y2 = t.y + H / 2 - minY;
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    const tone = token(EDGE_KIND[e.kind].tone, ink2);
    parts.push(`<path d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}" fill="none" stroke="${tone}" stroke-width="1.4"/>`);
    parts.push(`<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 4}" font-size="9.5" fill="${tone}" text-anchor="middle" font-family="sans-serif">${esc(e.label)}</text>`);
  });
  nodes.forEach((n) => {
    const x = n.position.x - minX, y = n.position.y - minY;
    parts.push(`<g><rect x="${x}" y="${y}" width="${W}" height="${H}" fill="${panel}" stroke="${line}"/><rect x="${x}" y="${y}" width="${W}" height="26" fill="${head}" stroke="${line}"/>`);
    parts.push(`<text x="${x + 10}" y="${y + 17}" font-size="12" fill="${ink}" font-family="sans-serif" font-weight="600">${esc(n.data.label.slice(0, 30))}</text>`);
    parts.push(`<text x="${x + 10}" y="${y + 44}" font-size="10" fill="${ink2}" font-family="sans-serif">${esc(statusOf(n.id).replace(/_/g, ' '))}${n.data.chainTag ? ` · ${esc(n.data.chainTag)}` : ''}</text>`);
    if (n.data.subtitle) parts.push(`<text x="${x + 10}" y="${y + 62}" font-size="10" fill="${ink2}" font-family="sans-serif">${esc(n.data.subtitle.slice(0, 36))}</text>`);
    parts.push('</g>');
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${bg}"/>${parts.join('')}</svg>`;
  return { svg, width, height };
}

export function exportSvg(name: string, nodes: GNode[], edges: GEdge[], statusOf: (id: string) => string, scope: Element | null) {
  download(`${name}.svg`, new Blob([svgOf(nodes, edges, statusOf, scope).svg], { type: 'image/svg+xml' }));
}

export function exportPng(name: string, nodes: GNode[], edges: GEdge[], statusOf: (id: string) => string, scope: Element | null): Promise<void> {
  const { svg, width, height } = svgOf(nodes, edges, statusOf, scope);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * 2;
      canvas.height = height * 2;
      const g = canvas.getContext('2d');
      if (!g) return reject(new Error('canvas unavailable'));
      g.scale(2, 2);
      g.drawImage(img, 0, 0);
      canvas.toBlob((b) => (b ? (download(`${name}.png`, b), resolve()) : reject(new Error('PNG encoding failed'))), 'image/png');
    };
    img.onerror = () => reject(new Error('could not render the SVG'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}
