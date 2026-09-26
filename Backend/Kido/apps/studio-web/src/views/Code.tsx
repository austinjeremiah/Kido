import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * Code view.
 *
 * Every byte shown here is read back from the sandbox filesystem through the server. Nothing is a
 * model-generated preview: a preview that differs from the file on disk is worse than no preview,
 * because it looks like verification.
 */
export function CodeView({
  buildId,
  files,
  stale,
}: {
  buildId: string;
  files: Array<{ path: string; bytes: number; buildRevision: number }>;
  stale: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const latestRev = files[0]?.buildRevision;
  const current = files.filter((f) => f.buildRevision === latestRev);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    api
      .file(buildId, selected)
      .then(setContent)
      .catch((e) => setContent(`// could not read file: ${String(e)}`))
      .finally(() => setLoading(false));
  }, [buildId, selected]);

  useEffect(() => {
    if (!selected && current.length > 0) setSelected(current[0]!.path);
  }, [current, selected]);

  if (files.length === 0) {
    return <div className="empty">Files appear here as the builder writes them into the sandbox.</div>;
  }

  return (
    <div className="code">
      {stale && (
        <div className="banner warn">
          The Blueprint changed after this code was generated. These files are <b>stale</b> — rebuild
          to regenerate them.
        </div>
      )}
      <div className="tree">
        <div className="tree-head">
          {current.length} files · build revision {latestRev}
        </div>
        {current.map((f) => (
          <button
            key={f.path}
            className={`file ${selected === f.path ? "sel" : ""}`}
            onClick={() => setSelected(f.path)}
          >
            <span className="p">{f.path}</span>
            <span className="b">{f.bytes}b</span>
          </button>
        ))}
      </div>
      <pre className="source">
        {loading ? "loading…" : content}
      </pre>
    </div>
  );
}
