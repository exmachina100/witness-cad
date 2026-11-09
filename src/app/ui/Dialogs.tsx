// Command palette, export, share, tests, help and the version/draft picker.
import { useEffect, useMemo, useRef, useState } from 'react';
import { actions, Project } from '../store';
import { getEngine, download } from '../engine';
import { EXPORT_FORMATS } from '../../export/formats-meta';
import type { RunResult } from '../../kernel/runtime';
import { Icon } from './icons';
import { ago, encodeShare, go, toast, fmtBytes } from './util';

function Modal({ onClose, children, className = '' }: { onClose: () => void; children: React.ReactNode; className?: string }) {
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal ' + className} role="dialog" aria-modal="true">{children}</div>
    </div>
  );
}

// ------------------------------------------------------------------ palette
export function Palette({ files, project, onOpen, onClose, run }: { files: string[]; project: Project; onOpen: (f: string) => void; onClose: () => void; run: any }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const items = useMemo(() => {
    const cmds: { label: string; hint: string; act: () => void }[] = [
      { label: 'Rebuild', hint: '⌘↵', act: run.build },
      { label: 'Save version', hint: 'command', act: run.saveVersion },
      { label: 'Screenshot', hint: 'command', act: run.screenshot },
      { label: 'Record video', hint: 'command', act: run.video },
      { label: 'Export…', hint: 'command', act: () => run.setDialog('export') },
      { label: 'Share…', hint: 'command', act: () => run.setDialog('share') },
      { label: 'Run tests', hint: 'command', act: () => run.setDialog('tests') },
      ...['files', 'agent', 'params', 'views', 'make', 'artifacts', 'inspect'].map((p) => ({ label: `Open ${p} panel`, hint: 'panel', act: () => run.setPanel(p) })),
      { label: 'Open docs', hint: 'help', act: () => go('#/docs/welcome') },
    ];
    const fileItems = files.filter((f) => !f.endsWith('.keep')).map((f) => ({ label: f, hint: f === project.entry ? 'root' : 'file', act: () => onOpen(f) }));
    const all = [...fileItems, ...cmds];
    const t = q.toLowerCase();
    return t ? all.filter((x) => fuzzy(x.label.toLowerCase(), t)) : all;
  }, [q, files, project.entry]);
  useEffect(() => setI(0), [q]);
  const pick = (k: number) => { const it = items[k]; if (!it) return; onClose(); it.act(); };
  return (
    <Modal onClose={onClose} className="palette">
      <input autoFocus placeholder="Search files and commands" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search files and commands"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setI(Math.min(items.length - 1, i + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setI(Math.max(0, i - 1)); }
          else if (e.key === 'Enter') pick(i);
        }} />
      <div style={{ maxHeight: '50vh', overflow: 'auto' }}>
        {items.map((it, k) => <div key={it.label} className={'item' + (k === i ? ' on' : '')} onMouseEnter={() => setI(k)} onClick={() => pick(k)}><span>{it.label}</span><span className="muted">{it.hint}</span></div>)}
        {!items.length && <div className="item muted">No matches</div>}
      </div>
    </Modal>
  );
}
function fuzzy(s: string, q: string) { let j = 0; for (const c of s) if (c === q[j]) j++; return j === q.length; }

// ------------------------------------------------------------------ export
export function ExportDialog({ project, result, transforms, onClose }: { project: Project; result: RunResult | null; transforms: Record<string, number[]>; onClose: () => void }) {
  const [format, setFormat] = useState<string>('3mf');
  const [busy, setBusy] = useState(false);
  const [save, setSave] = useState(true);
  const groups = useMemo(() => {
    const g: Record<string, [string, any][]> = {};
    for (const [k, v] of Object.entries(EXPORT_FORMATS)) (g[v.group] ??= []).push([k, v]);
    return g;
  }, []);
  const hasAsm = (result?.assemblies.length ?? 0) > 0;
  const go_ = async () => {
    setBusy(true);
    try {
      const r = await getEngine().export(format, { name: project.name, transforms });
      download(r.data, r.filename, r.mime);
      if (save) {
        let dataUrl: string | undefined;
        if (r.data.byteLength < 1.5e6) { let s = ''; for (let i = 0; i < r.data.length; i += 0x8000) s += String.fromCharCode(...r.data.subarray(i, i + 0x8000)); dataUrl = `data:${r.mime};base64,${btoa(s)}`; }
        actions.addArtifact(project.id, { name: r.filename, kind: 'export', mime: r.mime, dataUrl, size: r.data.byteLength });
      }
      toast(`Exported ${r.filename} (${fmtBytes(r.data.byteLength)})`);
      onClose();
    } catch (e: any) { toast(`Export failed: ${e.message}`); }
    setBusy(false);
  };
  return (
    <Modal onClose={onClose}>
      <h2 style={{ fontSize: 16 }}>Export</h2>
      {!result?.ok && <div className="chip bad">Build the model without errors before exporting.</div>}
      {Object.entries(groups).map(([g, fs]) => (
        <div key={g} className="col" style={{ gap: 4 }}>
          <h3>{g}</h3>
          {fs.map(([k, v]) => (
            <label key={k} className="check" style={{ cursor: 'pointer', opacity: v.group === 'Simulation' && k !== 'usd' && !hasAsm ? 0.55 : 1 }}>
              <input type="radio" name="fmt" checked={format === k} onChange={() => setFormat(k)} />
              <span className="grow">{v.label}</span>{k === '3mf' && <span className="chip ok">recommended</span>}
            </label>
          ))}
        </div>
      ))}
      <label className="row"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Also save to Artifacts</label>
      <div className="row"><div className="spacer" /><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !result?.ok} onClick={go_}>{busy ? 'Exporting…' : 'Export'}</button></div>
    </Modal>
  );
}

// ------------------------------------------------------------------ share
export function ShareDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const link = useMemo(() => `${location.origin}${location.pathname}#/share/${encodeShare({ name: project.name, description: project.description, files: project.files, entry: project.entry })}`, [project.files, project.name]);
  const copy = async () => { try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { toast('Copy failed: select the link and copy it'); } };
  return (
    <Modal onClose={onClose}>
      <h2 style={{ fontSize: 16 }}>Share “{project.name}”</h2>
      <span className="muted">Anyone with this link opens their own copy of the current files. The whole project travels inside the link, so nothing is uploaded.</span>
      <div className="row"><input readOnly value={link} className="grow mono" onFocus={(e) => e.target.select()} aria-label="Share link" /><button className="primary" onClick={copy}>Copy link</button></div>
      <span className="muted" style={{ fontSize: 11 }}>{link.length.toLocaleString()} characters</span>
      <label className="row"><input type="checkbox" checked={!!project.published} onChange={(e) => actions.setPublished(project.id, e.target.checked)} /> List under “Shared” on my home page</label>
      <div className="row">
        <button onClick={() => download(JSON.stringify({ name: project.name, description: project.description, entry: project.entry, files: project.files }, null, 2), `${project.name}.witness.json`, 'application/json')}><Icon name="download" size={13} /> Project JSON</button>
        <button onClick={() => download(project.files[project.entry] ?? '', project.entry.split('/').pop()!, 'text/javascript')}><Icon name="file" size={13} /> Root file</button>
        <div className="spacer" /><button onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ tests
export function TestsDialog({ project, result, onClose }: { project: Project; result: RunResult | null; onClose: () => void }) {
  const [rows, setRows] = useState<{ file: string; label: string; pass: boolean; message?: string }[] | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const out: { file: string; label: string; pass: boolean; message?: string }[] = [];
      for (const c of result?.checks ?? []) out.push({ file: project.entry, ...c });
      if (result && !result.ok) out.push({ file: project.entry, label: 'Model builds', pass: false, message: result.error?.message });
      const tests = Object.keys(project.files).filter((f) => /\.test\.(forge\.)?js$/.test(f));
      for (const t of tests) {
        try {
          const r = await getEngine().run(project.files, t, project.params ?? {});
          if (!r.ok) out.push({ file: t, label: 'Test file builds', pass: false, message: r.error?.message });
          for (const c of r.checks) out.push({ file: t, ...c });
          if (r.ok && !r.checks.length) out.push({ file: t, label: 'Test file builds', pass: true });
        } catch (e: any) { out.push({ file: t, label: 'Test file builds', pass: false, message: e.message }); }
      }
      // rebuild the root so the viewport's live result matches again
      if (tests.length) await getEngine().run(project.files, project.entry, project.params ?? {});
      if (alive) setRows(out);
    })();
    return () => { alive = false; };
  }, []);
  const failed = rows?.filter((r) => !r.pass).length ?? 0;
  return (
    <Modal onClose={onClose}>
      <h2 style={{ fontSize: 16 }}>Tests</h2>
      {!rows ? <span className="muted">Running…</span> : rows.length === 0 ? <span className="muted">No checks yet. Add <code className="mono">verify.*</code> calls to your model, or files named <code className="mono">*.test.forge.js</code>.</span> : <>
        <span className={'chip ' + (failed ? 'bad' : 'ok')}>{rows.length - failed} passed · {failed} failed</span>
        {rows.map((r, i) => <div key={i} className="check"><span className={'chip ' + (r.pass ? 'ok' : 'bad')}>{r.pass ? 'pass' : 'fail'}</span><span className="grow">{r.label}{r.message && <span className="muted"> · {r.message}</span>}</span><span className="muted mono" style={{ fontSize: 11 }}>{r.file}</span></div>)}
      </>}
      <div className="row"><div className="spacer" /><button onClick={onClose}>Close</button></div>
    </Modal>
  );
}

// ------------------------------------------------------------------ help
export function HelpDialog({ onClose }: { onClose: () => void }) {
  const keys = [['⌘P / ⌘K', 'Search files and commands'], ['⌘↵', 'Rebuild'], ['⌘S', 'Rebuild from the editor'], ['Esc', 'Close dialogs'], ['Drag', 'Orbit · right-drag to pan · wheel to zoom'], ['Click', 'Select an object']];
  return (
    <Modal onClose={onClose}>
      <h2 style={{ fontSize: 16 }}>Help</h2>
      <table className="t"><tbody>{keys.map(([k, v]) => <tr key={k}><td className="mono">{k}</td><td>{v}</td></tr>)}</tbody></table>
      <div className="row"><button onClick={() => { onClose(); go('#/docs/welcome'); }}><Icon name="docs" size={13} /> Documentation</button><button onClick={() => { onClose(); go('#/docs/agents'); }}>Agents and MCP</button><div className="spacer" /><button onClick={onClose}>Close</button></div>
    </Modal>
  );
}

// ------------------------------------------------------------------ versions & drafts
export function VersionMenu({ project, onSave }: { project: Project; onSave: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener('mousedown', f);
    return () => removeEventListener('mousedown', f);
  }, [open]);
  const cur = project.versions.find((v) => v.id === project.currentVersion);
  const draft = project.drafts.find((d) => d.id === project.activeDraft);
  const dirty = !draft && cur && JSON.stringify(cur.files) !== JSON.stringify(project.files);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(!open)} title="Versions and drafts">
        <Icon name="branch" size={14} /> <span className="hide-sm">{draft ? `Draft · ${draft.name}` : `${cur?.name ?? 'Start'} · ${cur?.note ?? ''}`}</span>{dirty && <span style={{ color: 'var(--warn)' }}>•</span>}
      </button>
      {open && (
        <div className="modal" style={{ position: 'absolute', left: 0, top: 36, width: 320, zIndex: 20, padding: 8, gap: 6 }}>
          <div className="row"><h3 className="grow">Versions</h3><button className="primary" onClick={() => { setOpen(false); onSave(); }}>Save version</button></div>
          {[...project.versions].reverse().map((v) => (
            <div key={v.id} className={'tree-item' + (v.id === project.currentVersion && !draft ? ' on' : '')} onClick={() => { actions.restoreVersion(project.id, v.id); setOpen(false); }}>
              <span className="grow">{v.name}{v.note ? <span className="muted"> · {v.note}</span> : null}</span><span className="muted">{ago(v.createdAt)}</span>
            </div>
          ))}
          <div className="row"><h3 className="grow">Drafts</h3>
            <button onClick={() => { const n = prompt('Draft name', 'Try a variation'); if (n) { actions.createDraft(project.id, n); setOpen(false); } }}>New draft</button>
          </div>
          {project.drafts.length === 0 && <span className="muted">Drafts let you try changes without touching the saved version.</span>}
          {project.drafts.map((d) => (
            <div key={d.id} className={'tree-item' + (d.id === project.activeDraft ? ' on' : '')}>
              <span className="grow" onClick={() => actions.openDraft(project.id, d.id)}>{d.name}</span>
              <span className="acts" style={{ display: 'flex' }}>
                <button className="ghost" onClick={() => { actions.mergeDraft(project.id, d.id); toast(`Merged "${d.name}"`); }}>Merge</button>
                <button className="ghost" onClick={() => actions.discardDraft(project.id, d.id)}>Discard</button>
              </span>
            </div>
          ))}
          {draft && <button onClick={() => actions.openDraft(project.id, null)}>Back to saved version</button>}
        </div>
      )}
    </div>
  );
}
