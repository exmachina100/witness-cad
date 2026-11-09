// Left-rail panels: Files, Agent, Params, 2D views, Make, Artifacts and Inspect.
import { useEffect, useMemo, useRef, useState } from 'react';
import { actions } from '../store';
import { getEngine, download } from '../engine';
import { runAgent, ChatMessage, AgentEvent } from '../agent';
import type { InspectMode } from '../components/Viewport';
import type { WorkspaceCtx } from './Workspace';
import { StrengthPanel } from './Strength';
import { Icon } from './icons';
import { ago, fmtBytes, toast, blobToDataUrl } from './util';

export interface MotionState { playing: null | { asm: string; kind: 'animation' | 'simulation'; name: string }; t: number; frames?: any[] }

// ============================================================ Files
export function FilesPanel({ project, result, openFile, activeFile, building }: WorkspaceCtx) {
  const files = Object.keys(project.files).sort();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => {
    const rows: { path: string; depth: number; dir: boolean; name: string }[] = [];
    const seen = new Set<string>();
    for (const f of files) {
      const parts = f.split('/');
      for (let i = 0; i < parts.length; i++) {
        const p = parts.slice(0, i + 1).join('/');
        if (seen.has(p)) continue;
        seen.add(p);
        const hiddenBy = [...collapsed].some((c) => p.startsWith(c + '/'));
        if (!hiddenBy && !p.endsWith('.keep')) rows.push({ path: p, depth: i, dir: i < parts.length - 1, name: parts[i] });
      }
    }
    return rows;
  }, [files.join('|'), collapsed]);

  const newFile = (dir = '') => {
    const name = prompt('New file name', dir ? `${dir}/part.forge.js` : 'part.forge.js');
    if (!name) return;
    actions.writeFile(project.id, name, name.endsWith('.forge.js') ? '// New part\nconst w = Param.number("Width", 40);\nreturn box(w, 20, 10);\n' : '');
    openFile(name);
  };
  const newFolder = () => {
    const name = prompt('Folder name', 'parts');
    if (name) actions.writeFile(project.id, `${name}/.keep`, '');
  };
  const importRef = useRef<HTMLInputElement>(null);
  const importFile = async (f: File) => {
    const ext = (/\.([a-z0-9]+)$/i.exec(f.name)?.[1] ?? '').toLowerCase();
    const textual = ['dxf', 'svg', 'obj', 'ply', 'step', 'stp', 'json', 'js', 'csv', 'txt'].includes(ext);
    let content = textual ? await f.text() : await blobToDataUrl(f);
    if (ext === 'stl' && !/[^\x09\x0a\x0d\x20-\x7e]/.test((await f.slice(0, 512).text()))) content = await f.text();
    actions.writeFile(project.id, f.name, content);
    const call = ext === 'dxf' ? 'Import.dxfSketch' : ext === 'svg' ? 'Import.svgSketch' : ext === 'step' || ext === 'stp' ? 'Import.step' : 'Import.mesh';
    toast(`Added ${f.name}. Use ${call}("${f.name}") in your model.`);
  };
  const rename = (f: string) => { const to = prompt('Rename to', f); if (to && to !== f) actions.renameFile(project.id, f, to); };
  const del = (f: string) => { if (confirm(`Delete ${f}?`)) actions.deleteFile(project.id, f); };

  return (
    <div className="panel">
      <div className="panel-head"><h3 className="grow">Files</h3>
        <button onClick={() => newFile()} title="New file"><Icon name="plus" size={13} /> File</button>
        <button onClick={newFolder} title="New folder"><Icon name="folder" size={13} /> Folder</button>
        <button onClick={() => importRef.current?.click()} title="Import DXF, SVG, STL, OBJ, 3MF, PLY or STEP"><Icon name="upload" size={13} /> Import</button>
        <input ref={importRef} type="file" hidden accept=".dxf,.svg,.stl,.obj,.3mf,.ply,.step,.stp" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
      </div>
      <div>
        {tree.map((r) => (
          <div key={r.path} className={'tree-item' + (r.path === activeFile ? ' on' : '')} style={{ paddingLeft: 6 + r.depth * 14 }}
            onClick={() => (r.dir ? setCollapsed((c) => { const n = new Set(c); n.has(r.path) ? n.delete(r.path) : n.add(r.path); return n; }) : openFile(r.path))}>
            <Icon name={r.dir ? 'folder' : 'file'} size={14} />
            <span>{r.name}</span>
            {r.path === project.entry && <span className="chip ok" title="Root file: the build starts here">Root</span>}
            <span className="acts">
              {r.dir && <button className="ghost" onClick={(e) => { e.stopPropagation(); newFile(r.path); }}>+</button>}
              {!r.dir && r.path !== project.entry && r.path.endsWith('.js') && <button className="ghost" onClick={(e) => { e.stopPropagation(); actions.setEntry(project.id, r.path); }} title="Make root">Root</button>}
              <button className="ghost" onClick={(e) => { e.stopPropagation(); rename(r.path); }}>Rename</button>
              <button className="ghost" onClick={(e) => { e.stopPropagation(); del(r.path); }}>Delete</button>
            </span>
          </div>
        ))}
      </div>
      <div className="col" style={{ gap: 4 }}>
        <h3>Project</h3>
        <textarea rows={2} placeholder="Description" value={project.description ?? ''} onChange={(e) => actions.setDescription(project.id, e.target.value)} />
        <label className="field"><label>Import alias <span className="muted">require("project:alias")</span></label>
          <input value={project.alias ?? ''} placeholder="e.g. fasteners" onChange={(e) => actions.setAlias(project.id, e.target.value.replace(/[^\w-]/g, ''))} /></label>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        {building ? 'Building…' : result ? (result.ok ? <span style={{ color: 'var(--ok)' }}>Built ✓ {Math.round(result.timeMs)} ms</span> : <span style={{ color: 'var(--danger)' }}>Build failed</span>) : ''}
      </div>
    </div>
  );
}

// ============================================================ Agent
export function AgentPanel(ctx: WorkspaceCtx) {
  const { project } = ctx;
  const [apiKey, setApiKey] = useState(() => localStorageGet('witness-cad:apiKey'));
  const [model, setModel] = useState(() => localStorageGet('witness-cad:model') || 'claude-opus-5-5');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<(AgentEvent & { user?: string })[]>([]);
  const history = useRef<ChatMessage[]>([]);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [events]);

  const host = {
    listFiles: () => Object.keys(currentProject(ctx).files),
    readFile: (p: string) => currentProject(ctx).files[p],
    writeFile: (p: string, c: string) => actions.writeFile(project.id, p, c),
    build: () => ctx.build(),
    screenshot: () => ctx.vp.current?.screenshot(1024, 640) ?? '',
    setParams: (v: Record<string, any>) => actions.setParams(project.id, { ...(currentProject(ctx).params ?? {}), ...v }),
    exportModel: async (format: string) => { const r = await getEngine().export(format, { name: project.name }); download(r.data, r.filename, r.mime); return `exported ${r.filename} (${r.data.byteLength} bytes)`; },
    saveVersion: (name: string) => actions.saveVersion(project.id, name),
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!apiKey) { toast('Add an Anthropic API key first'); return; }
    setInput('');
    setBusy(true);
    setEvents((e) => [...e, { kind: 'text', user: text }]);
    abort.current = new AbortController();
    try {
      history.current = await runAgent({
        apiKey, model, history: [...history.current, { role: 'user', content: text }], host, signal: abort.current.signal,
        onEvent: (ev) => setEvents((e) => [...e, ev]),
      });
    } catch (e: any) { setEvents((ev) => [...ev, { kind: 'error', text: e.message }]); }
    setBusy(false);
  };

  return (
    <div className="panel" style={{ minHeight: '100%' }}>
      <div className="panel-head"><h3 className="grow">Agent</h3>
        <button className="ghost" onClick={() => { history.current = []; setEvents([]); }}>New chat</button>
      </div>
      {!apiKey && (
        <div className="check col">
          <span>The agent runs in your browser with your own Anthropic API key. The key is stored only on this device.</span>
          <input type="password" placeholder="sk-ant-…" onKeyDown={(e) => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.trim(); localStorageSet('witness-cad:apiKey', v); setApiKey(v); } }} aria-label="API key" />
          <span className="muted" style={{ fontSize: 11 }}>Press Enter to save. You can also drive Witness CAD from Claude Code or Claude Desktop through the MCP server (see Docs → Agents).</span>
        </div>
      )}
      <div className="chat">
        {events.length === 0 && <div className="muted">Describe a part or a change, e.g. “add four M3 mounting holes 5 mm from each corner”. The agent edits files, builds, checks and looks at the result.</div>}
        {events.map((e, i) => e.user ? <div key={i} className="msg user">{e.user}</div>
          : e.kind === 'text' ? <div key={i} className="msg">{e.text}</div>
          : e.kind === 'tool' ? <div key={i} className="msg tool">→ {e.tool}{e.input?.path ? ` ${e.input.path}` : ''}</div>
          : e.kind === 'result' ? (e.image ? <div key={i} className="msg tool"><img src={e.image} alt="Viewport" /></div> : <div key={i} className="msg tool">{(e.output ?? '').slice(0, 400)}</div>)
          : e.kind === 'error' ? <div key={i} className="msg" style={{ color: 'var(--danger)' }}>{e.text}</div>
          : null)}
        {busy && <div className="muted">Working…</div>}
        <div ref={bottom} />
      </div>
      <div className="spacer" />
      <textarea rows={3} value={input} placeholder="Ask the agent…" onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} aria-label="Message the agent" />
      <div className="row">
        <select value={model} onChange={(e) => { setModel(e.target.value); localStorageSet('witness-cad:model', e.target.value); }} aria-label="Model">
          <option value="claude-opus-5-5">Opus 5.5</option><option value="claude-sonnet-5-5">Sonnet 5.5</option><option value="claude-haiku-5-5">Haiku 5.5</option>
        </select>
        <div className="spacer" />
        {apiKey && <button className="ghost" onClick={() => { localStorageSet('witness-cad:apiKey', ''); setApiKey(''); }}>Forget key</button>}
        {busy ? <button onClick={() => abort.current?.abort()}>Stop</button> : <button className="primary" onClick={send}>Send</button>}
      </div>
    </div>
  );
}
function currentProject(ctx: WorkspaceCtx) { return ctx.allProjects.find((p) => p.id === ctx.project.id) ?? ctx.project; }
function localStorageGet(k: string) { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } }
function localStorageSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

// ============================================================ Params
export function ParamsPanel({ project, result, jointValues, setJoints }: WorkspaceCtx) {
  const values = project.params ?? {};
  const set = (name: string, v: any) => actions.setParams(project.id, { ...values, [name]: v });
  const params = result?.params ?? [];
  const groups = useMemo(() => {
    const g: Record<string, typeof params> = {};
    for (const p of params) (g[p.opts?.group ?? (p.file && p.file !== project.entry ? p.file : '')] ??= []).push(p);
    return g;
  }, [params, project.entry]);
  return (
    <div className="panel">
      <div className="panel-head"><h3 className="grow">Parameters</h3>
        {Object.keys(values).length > 0 && <button className="ghost" onClick={() => actions.setParams(project.id, {})}>Reset all</button>}
      </div>
      {params.length === 0 && <div className="muted">No parameters. Declare them in code, e.g. <code className="mono">Param.number("Width", 40, {'{ min: 10, max: 120 }'})</code>.</div>}
      {Object.entries(groups).map(([g, ps]) => (
        <div key={g} className="col">
          {g && <h3>{g}</h3>}
          {ps.map((p) => <ParamControl key={p.name} p={p} onChange={(v) => set(p.name, v)} changed={values[p.name] !== undefined} />)}
        </div>
      ))}
      {result?.assemblies.map((a) => a.joints.length > 0 && (
        <div key={a.name} className="col">
          <h3>Joints · {a.name}</h3>
          {a.joints.filter((j) => j.type !== 'fixed').map((j) => {
            const v = Number(jointValues[a.name]?.[j.name] ?? j.default ?? 0);
            const lo = j.min ?? (j.type === 'prismatic' ? 0 : -180), hi = j.max ?? (j.type === 'prismatic' ? 100 : 180);
            return (
              <div key={j.name} className="field">
                <label><span>{j.name} <span className="muted">{j.type}{j.follows ? ' (coupled)' : ''}</span></span><span className="mono">{v.toFixed(1)}{j.type === 'prismatic' ? ' mm' : '°'}</span></label>
                <input type="range" min={lo} max={hi} step={0.5} value={v} disabled={!!j.follows} onChange={(e) => setJoints(a.name, { [j.name]: Number(e.target.value) })} aria-label={j.name} />
              </div>
            );
          })}
          {Object.keys(a.poses).length > 0 && (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <span className="muted">Poses</span>
              {Object.entries(a.poses).map(([n, v]) => <button key={n} onClick={() => setJoints(a.name, v as any)}>{n}</button>)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ParamControl({ p, onChange, changed }: { p: any; onChange: (v: any) => void; changed: boolean }) {
  const label = <label><span>{p.name}{changed && <span title="Changed from default" style={{ color: 'var(--accent)' }}> •</span>}</span>
    {changed && <button className="ghost" style={{ padding: '0 4px', fontSize: 11 }} onClick={() => onChange(p.default)}>reset</button>}</label>;
  switch (p.type) {
    case 'number': return (
      <div className="field">{label}
        <div className="row">
          <input className="grow" type="range" min={p.opts.min} max={p.opts.max} step={p.opts.step} value={p.value} onChange={(e) => onChange(Number(e.target.value))} aria-label={p.name} />
          <input type="number" min={p.opts.min} max={p.opts.max} step={p.opts.step} value={p.value} onChange={(e) => onChange(Number(e.target.value))} aria-label={`${p.name} value`} />
          {p.opts.unit && <span className="muted">{p.opts.unit}</span>}
        </div>
      </div>
    );
    case 'bool': return <label className="row"><input type="checkbox" checked={!!p.value} onChange={(e) => onChange(e.target.checked)} /> {p.name}</label>;
    case 'choice': return (
      <div className="field">{label}
        <select value={p.value} onChange={(e) => onChange(e.target.value)} aria-label={p.name}>{p.opts.choices.map((c: string) => <option key={c}>{c}</option>)}</select>
      </div>
    );
    case 'string': return <div className="field">{label}<input value={p.value} onChange={(e) => onChange(e.target.value)} aria-label={p.name} /></div>;
    default: return (
      <div className="field">{label}
        <textarea className="mono" rows={3} defaultValue={JSON.stringify(p.value)} onBlur={(e) => { try { onChange(JSON.parse(e.target.value)); } catch { toast('Invalid JSON'); } }} aria-label={p.name} />
      </div>
    );
  }
}

// ============================================================ 2D views
export function ViewsPanel({ result, project }: WorkspaceCtx) {
  const [mode, setMode] = useState<'slice' | 'projection'>('slice');
  const [axis, setAxis] = useState<'x' | 'y' | 'z'>('z');
  const [offset, setOffset] = useState(5);
  const [sec, setSec] = useState<{ polygons: number[][][]; area: number; bounds: any } | null>(null);
  const [err, setErr] = useState('');
  const range = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    const k = { x: 0, y: 1, z: 2 }[axis];
    for (const o of result?.objects ?? []) if (o.stats) { lo = Math.min(lo, o.stats.bbox.min[k]); hi = Math.max(hi, o.stats.bbox.max[k]); }
    return Number.isFinite(lo) ? [lo, hi] : [0, 100];
  }, [result, axis]);
  useEffect(() => {
    if (!result?.ok) return;
    const normal = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1];
    const t = setTimeout(() => getEngine().section(normal, offset, mode).then((s) => { setSec(s); setErr(''); }).catch((e) => { setSec(null); setErr(e.message); }), 120);
    return () => clearTimeout(t);
  }, [result, axis, offset, mode]);
  const svg = sec ? polygonsToSvg(sec.polygons, sec.bounds) : '';
  return (
    <div className="panel">
      <h3>2D views</h3>
      <div className="seg"><button className={mode === 'slice' ? 'on' : ''} onClick={() => setMode('slice')}>Slice</button><button className={mode === 'projection' ? 'on' : ''} onClick={() => setMode('projection')}>Projection</button></div>
      <div className="row"><span className="muted">Normal</span>
        <div className="seg">{(['x', 'y', 'z'] as const).map((a) => <button key={a} className={axis === a ? 'on' : ''} onClick={() => setAxis(a)}>{a.toUpperCase()}</button>)}</div>
      </div>
      {mode === 'slice' && (
        <div className="field"><label><span>Offset</span><span className="mono">{offset.toFixed(1)} mm</span></label>
          <input type="range" min={range[0]} max={range[1]} step={0.1} value={offset} onChange={(e) => setOffset(Number(e.target.value))} aria-label="Slice offset" /></div>
      )}
      {err && <div className="muted">{err}</div>}
      {sec && <>
        <div className="svgbox" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="row"><span className="muted">Area {sec.area.toFixed(1)} mm² · {sec.bounds.width.toFixed(1)} × {sec.bounds.height.toFixed(1)} mm</span></div>
        <div className="row">
          <button onClick={() => download(svg, `${project.name}-${mode}-${axis}.svg`, 'image/svg+xml')}>SVG</button>
          <button onClick={() => download(polygonsToDxf(sec.polygons), `${project.name}-${mode}-${axis}.dxf`, 'application/dxf')}>DXF</button>
        </div>
      </>}
    </div>
  );
}
function polygonsToSvg(polys: number[][][], b: any) {
  const pad = 4, w = b.width + pad * 2, h = b.height + pad * 2;
  const d = polys.map((p) => 'M' + p.map(([x, y]) => `${(x - b.minX + pad).toFixed(3)},${(b.maxY - y + pad).toFixed(3)}`).join('L') + 'Z').join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}" width="${w.toFixed(2)}mm" height="${h.toFixed(2)}mm"><path d="${d}" fill="#4fd1c533" stroke="#0e6f66" stroke-width="${Math.max(w, h) / 400}" fill-rule="evenodd"/></svg>`;
}
function polygonsToDxf(polys: number[][][]) {
  const out = ['0', 'SECTION', '2', 'ENTITIES'];
  for (const p of polys) {
    out.push('0', 'LWPOLYLINE', '8', '0', '90', String(p.length), '70', '1');
    for (const [x, y] of p) out.push('10', x.toFixed(4), '20', y.toFixed(4));
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n');
}

// ============================================================ Make
const PROCESSES = ['All', 'Print', 'Buy', 'Machine', 'Cut', 'Resin', 'Powder', 'Mold', 'Urethane', 'Other'];
export function MakePanel({ result, project, setSelection }: WorkspaceCtx) {
  const [tab, setTab] = useState<'parts' | 'bom' | 'drawings' | 'build'>('parts');
  const [proc, setProc] = useState('All');
  const [drawing, setDrawing] = useState('');
  const parts = (result?.objects ?? []).filter((o) => o.kind === 'solid' && !o.mock).map((o) => ({ o, process: processOf(o) }));
  const shown = parts.filter((p) => proc === 'All' || p.process === proc);
  useEffect(() => {
    if (tab !== 'drawings' || !result?.ok) return;
    getEngine().export('drawing', { name: project.name }).then((r) => setDrawing(new TextDecoder().decode(r.data))).catch(() => setDrawing(''));
  }, [tab, result]);
  const exp = async (format: string) => { const r = await getEngine().export(format, { name: project.name }); download(r.data, r.filename, r.mime); };
  return (
    <div className="panel">
      <div className="seg">{(['parts', 'bom', 'drawings', 'build'] as const).map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'bom' ? 'BOM' : t[0].toUpperCase() + t.slice(1)}</button>)}</div>
      {tab === 'parts' && <>
        <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          {PROCESSES.map((p) => { const n = p === 'All' ? parts.length : parts.filter((x) => x.process === p).length; return n || p === 'All' ? <button key={p} className={proc === p ? 'active' : ''} onClick={() => setProc(p)}>{p} {n}</button> : null; })}
        </div>
        <table className="t"><thead><tr><th>Part</th><th>Process</th><th>Size (mm)</th></tr></thead><tbody>
          {shown.map(({ o, process }) => (
            <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => setSelection({ name: o.name, object: o, point: [0, 0, 0], normal: [0, 0, 1] })}>
              <td>{o.name}</td><td>{process}</td><td className="mono">{o.stats ? o.stats.bbox.max.map((v, i) => (v - o.stats!.bbox.min[i]).toFixed(0)).join('×') : ''}</td>
            </tr>
          ))}
        </tbody></table>
        {shown.length === 0 && <div className="muted">No parts.</div>}
      </>}
      {tab === 'bom' && <>
        {result?.bom.length ? (
          <table className="t"><thead><tr><th>Qty</th><th>Item</th><th>Unit</th></tr></thead><tbody>
            {result.bom.map((b, i) => <tr key={i}><td>{b.quantity}</td><td>{b.description}</td><td>{b.unit}</td></tr>)}
          </tbody></table>
        ) : <div className="muted">No BOM entries. Add them with <code className="mono">bom(qty, "M3 x 8 screw")</code>; solid parts are listed in the export automatically.</div>}
        <button onClick={() => exp('bom')}><Icon name="download" size={13} /> BOM CSV</button>
      </>}
      {tab === 'drawings' && <>
        {drawing ? <div className="svgbox" dangerouslySetInnerHTML={{ __html: drawing }} /> : <div className="muted">Build the model to generate a drawing.</div>}
        <button onClick={() => exp('drawing')}><Icon name="download" size={13} /> Drawing SVG</button>
      </>}
      {tab === 'build' && <>
        <div className="col" style={{ gap: 4 }}>
          {(result?.checks ?? []).map((c, i) => <div key={i} className="check"><span className={'chip ' + (c.pass ? 'ok' : 'bad')}>{c.pass ? 'pass' : 'fail'}</span><span>{c.label}{c.message ? <span className="muted"> · {c.message}</span> : null}</span></div>)}
          {!result?.checks.length && <div className="muted">No verify checks in this model.</div>}
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="primary" onClick={() => exp('package')}><Icon name="download" size={13} /> Manufacturing package</button>
          <button onClick={() => exp('3mf')}>3MF</button><button onClick={() => exp('step')}>STEP</button>
        </div>
      </>}
    </div>
  );
}
function processOf(o: any) {
  const p = String(o.meta?.process ?? o.material?.process ?? o.meta?.manufacturing?.process ?? '').toLowerCase();
  if (!p) return o.meta?.purchased || o.meta?.vendor ? 'Buy' : 'Print';
  const map: Record<string, string> = { print: 'Print', fdm: 'Print', sla: 'Resin', resin: 'Resin', buy: 'Buy', purchased: 'Buy', cnc: 'Machine', machine: 'Machine', laser: 'Cut', cut: 'Cut', sheet: 'Cut', powder: 'Powder', sls: 'Powder', mjf: 'Powder', mold: 'Mold', injection: 'Mold', urethane: 'Urethane' };
  for (const [k, v] of Object.entries(map)) if (p.includes(k)) return v;
  return 'Other';
}

// ============================================================ Artifacts
export function ArtifactsPanel({ project, screenshot, video }: WorkspaceCtx) {
  const upRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<'all' | 'render' | 'export' | 'video' | 'upload'>('all');
  const list = project.artifacts.filter((a) => filter === 'all' || a.kind === filter);
  const upload = async (f: File) => {
    const url = await blobToDataUrl(f);
    actions.addArtifact(project.id, { name: f.name, kind: 'upload', mime: f.type || 'application/octet-stream', dataUrl: url, size: f.size });
  };
  return (
    <div className="panel">
      <div className="panel-head"><h3 className="grow">Artifacts</h3>
        <button onClick={screenshot}><Icon name="camera" size={13} /> Render</button>
        <button onClick={video}><Icon name="video" size={13} /> Video</button>
        <button onClick={() => upRef.current?.click()}><Icon name="upload" size={13} /> Upload</button>
        <input ref={upRef} type="file" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </div>
      <div className="seg">{(['all', 'render', 'export', 'video', 'upload'] as const).map((f) => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}{f === 'all' ? '' : 's'}</button>)}</div>
      {list.length === 0 && <div className="muted">Renders, videos, exports and uploads for this project appear here.</div>}
      {list.map((a) => (
        <div key={a.id} className="check" style={{ flexDirection: 'column' }}>
          {a.dataUrl && a.mime.startsWith('image/') && <img src={a.dataUrl} alt={a.name} style={{ width: '100%', borderRadius: 6 }} />}
          {a.dataUrl && a.mime.startsWith('video/') && <video src={a.dataUrl} controls style={{ width: '100%', borderRadius: 6 }} />}
          <div className="row" style={{ width: '100%' }}>
            <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
            <span className="muted">{fmtBytes(a.size)} · {ago(a.createdAt)}</span>
          </div>
          <div className="row">
            {a.dataUrl && <a href={a.dataUrl} download={a.name}><button>Download</button></a>}
            <button className="ghost" onClick={() => actions.removeArtifact(project.id, a.id)}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================ Inspect
const MODES: [InspectMode, string][] = [
  ['shaded', 'Shaded'], ['xray', 'X-ray'], ['wireframe', 'Wireframe'], ['normals', 'Normals'], ['zebra', 'Zebra'], ['mask', 'Object mask'],
  ['colliders', 'Colliders'], ['distance', 'Measure'], ['interference', 'Interference'], ['thickness', 'Thickness'], ['process', 'Process'],
];
export function InspectPanel(ctx: WorkspaceCtx) {
  const { opts, setOpts, result, vp, project, motion, setMotion, jointValues, setJoints } = ctx;
  const [tab, setTab] = useState<'view' | 'model' | 'motion' | 'strength' | 'tools'>('view');
  const [report, setReport] = useState<any>(null);
  const [loads, setLoads] = useState<Record<string, number> | null>(null);
  const [simEngine, setSimEngine] = useState<'dynamics' | 'joints'>('dynamics');
  const [simSeconds, setSimSeconds] = useState(3);
  const [simInfo, setSimInfo] = useState<any>(null);
  const [hold, setHold] = useState<{ joint: string; load: number; result?: any }>({ joint: '', load: 1 });
  const asm = result?.assemblies[0];

  const checkInterference = async () => {
    if (!asm) return;
    const r = await getEngine().call('collisions', { assembly: asm.name, values: jointValues[asm.name] });
    setReport(r);
    setOpts({ ...opts, mode: 'interference', interference: r.collisions });
  };
  const simulate = async () => {
    if (!asm) return;
    toast('Simulating…');
    try {
      const r: any = await getEngine().simulate(asm.name, { engine: simEngine, duration: simSeconds, initial: jointValues[asm.name] });
      setSimInfo(r.summary ? { ...r.summary, warnings: r.warnings } : null);
      setMotion({ playing: { asm: asm.name, kind: 'simulation', name: 'sim' }, t: 0, frames: r.frames });
    } catch (e: any) { toast(`Simulation failed: ${e.message}`); }
  };

  return (
    <div className="panel">
      <div className="seg">{(['view', 'model', 'motion', 'strength', 'tools'] as const).map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div>

      {tab === 'view' && <>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button onClick={() => vp.current?.setView('iso')}>Home</button>
          <button onClick={() => vp.current?.fit()}>Fit</button>
          <div className="seg"><button className={!opts.ortho ? 'on' : ''} onClick={() => setOpts({ ...opts, ortho: false })}>Persp</button><button className={opts.ortho ? 'on' : ''} onClick={() => setOpts({ ...opts, ortho: true })}>Ortho</button></div>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          {(['top', 'front', 'right', 'left', 'back', 'bottom', 'iso'] as const).map((v) => <button key={v} onClick={() => vp.current?.setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}
        </div>
        <label className="row"><input type="checkbox" checked={opts.edges} onChange={(e) => setOpts({ ...opts, edges: e.target.checked })} /> Edges</label>
        <label className="row"><input type="checkbox" checked={opts.grid} onChange={(e) => setOpts({ ...opts, grid: e.target.checked })} /> Grid</label>
        <h3>Inspect mode</h3>
        <div className="modes">{MODES.map(([m, l]) => <button key={m} className={opts.mode === m ? 'active' : ''} onClick={() => setOpts({ ...opts, mode: m })}>{l}</button>)}</div>
        <h3>Section</h3>
        <label className="row"><input type="checkbox" checked={opts.cut.enabled} onChange={(e) => setOpts({ ...opts, cut: { ...opts.cut, enabled: e.target.checked } })} /> Cut plane</label>
        {opts.cut.enabled && <>
          <div className="row"><div className="seg">{(['x', 'y', 'z'] as const).map((a) => <button key={a} className={opts.cut.axis === a ? 'on' : ''} onClick={() => setOpts({ ...opts, cut: { ...opts.cut, axis: a } })}>{a.toUpperCase()}</button>)}</div>
            <label className="row"><input type="checkbox" checked={opts.cut.flip} onChange={(e) => setOpts({ ...opts, cut: { ...opts.cut, flip: e.target.checked } })} /> Flip</label></div>
          <input type="range" min={-200} max={200} step={0.5} value={opts.cut.offset} onChange={(e) => setOpts({ ...opts, cut: { ...opts.cut, offset: Number(e.target.value) } })} aria-label="Cut offset" />
        </>}
      </>}

      {tab === 'model' && <>
        <h3>Objects</h3>
        {(result?.objects ?? []).map((o) => {
          const hidden = opts.hidden.has(o.name);
          return (
            <div key={o.id} className={'tree-item' + (ctx.selection?.name === o.name ? ' on' : '')} onClick={() => ctx.setSelection({ name: o.name, object: o, point: [0, 0, 0], normal: [0, 0, 1] })}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: o.color ?? '#9aa7b4', display: 'inline-block' }} />
              <span className="grow" style={{ opacity: hidden ? 0.45 : 1 }}>{o.name}</span><span className="muted">{o.kind}</span>
              <button className="ghost" onClick={(e) => { e.stopPropagation(); const h = new Set(opts.hidden); hidden ? h.delete(o.name) : h.add(o.name); setOpts({ ...opts, hidden: h }); }}>{hidden ? 'Show' : 'Hide'}</button>
            </div>
          );
        })}
        {opts.hidden.size > 0 && <button onClick={() => setOpts({ ...opts, hidden: new Set() })}>Show all</button>}
        <h3>Timeline</h3>
        {[...project.versions].reverse().map((v) => (
          <div key={v.id} className={'tree-item' + (v.id === project.currentVersion && !project.activeDraft ? ' on' : '')} onClick={() => confirm(`Restore "${v.name}"? Unsaved changes are replaced.`) && actions.restoreVersion(project.id, v.id)}>
            <Icon name="branch" size={13} /><span className="grow">{v.name}</span><span className="muted">{ago(v.createdAt)}</span>
          </div>
        ))}
      </>}

      {tab === 'motion' && <>
        <div className="field"><label><span>Explode</span><span className="mono">{Math.round(opts.explode * 100)}%</span></label>
          <input type="range" min={0} max={1} step={0.01} value={opts.explode} onChange={(e) => setOpts({ ...opts, explode: Number(e.target.value) })} aria-label="Explode" /></div>
        {!asm && <div className="muted">Return an Assembly to get joints, poses, animations and simulation.</div>}
        {result?.assemblies.map((a) => (
          <div key={a.name} className="col">
            <h3>{a.name}</h3>
            {a.joints.filter((j) => j.type !== 'fixed').map((j) => {
              const v = Number(jointValues[a.name]?.[j.name] ?? j.default ?? 0);
              return (
                <div key={j.name} className="field">
                  <label><span>{j.name} <span className="muted">{j.type}</span></span><span className="mono">{v.toFixed(1)}</span></label>
                  <input type="range" min={j.min ?? -180} max={j.max ?? 180} step={0.5} value={v} disabled={!!j.follows} onChange={(e) => setJoints(a.name, { [j.name]: Number(e.target.value) })} aria-label={j.name} />
                </div>
              );
            })}
            {Object.keys(a.poses).length > 0 && <div className="row" style={{ flexWrap: 'wrap' }}>{Object.entries(a.poses).map(([n, v]) => <button key={n} onClick={() => setJoints(a.name, v as any)}>{n}</button>)}</div>}
            {Object.keys(a.animations).length > 0 && <>
              <h3>Animations</h3>
              {Object.keys(a.animations).map((n) => {
                const on = motion.playing?.kind === 'animation' && motion.playing.name === n;
                return <div key={n} className="row"><button onClick={() => setMotion(on ? { playing: null, t: 0 } : { playing: { asm: a.name, kind: 'animation', name: n }, t: 0 })}><Icon name={on ? 'pause' : 'play'} size={12} /> {n}</button>
                  {on && <progress max={1} value={motion.t} style={{ flex: 1 }} />}</div>;
              })}
            </>}
            <div className="row">
              <button onClick={() => (motion.playing?.kind === 'simulation' ? setMotion({ playing: null, t: 0 }) : simulate())}>
                <Icon name={motion.playing?.kind === 'simulation' ? 'pause' : 'play'} size={12} /> {motion.playing?.kind === 'simulation' ? 'Stop simulation' : 'Simulate'}
              </button>
              <button onClick={ctx.video}><Icon name="video" size={12} /> Video</button>
            </div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <div className="seg">
                <button className={simEngine === 'dynamics' ? 'on' : ''} onClick={() => setSimEngine('dynamics')} title="Rigid bodies with gravity, contacts, friction and joint constraints">Dynamics</button>
                <button className={simEngine === 'joints' ? 'on' : ''} onClick={() => setSimEngine('joints')} title="Fast joint-space preview without contacts">Joint-space</button>
              </div>
              <label className="row" style={{ gap: 4 }}>Seconds <input type="number" min={0.2} max={30} step={0.5} value={simSeconds} style={{ width: 56 }} onChange={(e) => setSimSeconds(Math.max(0.2, Math.min(30, Number(e.target.value) || 3)))} aria-label="Simulation seconds" /></label>
            </div>
            {simInfo && a.name === asm?.name && <div className="check col" style={{ gap: 2 }}>
              <span className={'chip ' + (simInfo.settled ? 'ok' : 'warn')}>{simInfo.settled ? 'Settled' : 'Still moving'} after {simInfo.duration.toFixed(1)} s · {simInfo.bodies} bodies</span>
              <span className="muted">Max contact penetration {simInfo.maxPenetrationMm.toFixed(2)} mm · peak contacts {simInfo.peakContacts}</span>
              {Object.entries(simInfo.parts).filter(([, p]: any) => p.displacementMm > 0.5).map(([n, p]: any) => <span key={n} className="mono">{n}: moved {p.displacementMm.toFixed(1)} mm, turned {p.rotationDeg.toFixed(1)}°</span>)}
              {Object.entries(simInfo.drives).map(([n, d]: any) => <span key={n} className={'mono' + (d.saturatedS > 0.1 ? ' bad' : '')}>{n}: peak {d.peakEffort.toFixed(3)}{d.limit != null ? ` / ${d.limit}` : ''}{d.saturatedS > 0 ? ` (saturated ${d.saturatedS.toFixed(2)} s)` : ''}</span>)}
              {(simInfo.warnings ?? []).map((w: string, i: number) => <span key={i} className="chip warn">{w}</span>)}
            </div>}
            {a.joints.some((j) => j.type === 'revolute' || j.type === 'prismatic') && a.name === asm?.name && <>
              <h3>Hold test</h3>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <select value={hold.joint} onChange={(e) => setHold({ ...hold, joint: e.target.value, result: undefined })} aria-label="Hold joint">
                  <option value="">Joint…</option>
                  {a.joints.filter((j) => j.type === 'revolute' || j.type === 'prismatic').map((j) => <option key={j.name} value={j.name}>{j.name}</option>)}
                </select>
                <input type="number" step={0.1} value={hold.load} style={{ width: 64 }} onChange={(e) => setHold({ ...hold, load: Number(e.target.value), result: undefined })} aria-label="Hold load" title="N·m for rotary joints, N for sliders" />
                <button disabled={!hold.joint} onClick={async () => { try { setHold({ ...hold, result: await getEngine().call('holdTest', { assembly: a.name, opts: { joint: hold.joint, load: hold.load, seconds: 2, initial: jointValues[a.name] } }) }); } catch (e: any) { toast(e.message); } }}>Run</button>
              </div>
              {hold.result && <div className={'chip ' + (hold.result.pass ? 'ok' : 'bad')}>{hold.result.pass ? 'Holds' : 'Gives'}: {hold.result.travel.toFixed(2)} {hold.result.travelUnit} under {hold.result.load} {hold.result.unit} (max {hold.result.maxTravel})</div>}
            </>}
            {a.warnings.length > 0 && a.warnings.map((w, i) => <div key={i} className="chip warn">{w}</div>)}
          </div>
        ))}
      </>}

      {tab === 'strength' && <StrengthPanel {...ctx} />}

      {tab === 'tools' && <>
        <button onClick={() => setOpts({ ...opts, mode: 'distance' })}>Measure distance (click two points)</button>
        {ctx.measure != null && <div className="chip">{ctx.measure.toFixed(3)} mm</div>}
        {asm && <>
          <button onClick={checkInterference}>Check interference</button>
          {report && (report.clean ? <div className="chip ok">No collisions</div> : report.collisions.map((c: any, i: number) => <div key={i} className="chip bad">{c.a} ↔ {c.b}: {c.volume.toFixed(1)} mm³</div>))}
          <button onClick={async () => setLoads(await getEngine().call('jointLoads', { assembly: asm.name, values: jointValues[asm.name] }))}>Joint torque (gravity)</button>
          {loads && <table className="t"><tbody>{Object.entries(loads).map(([k, v]) => <tr key={k}><td>{k}</td><td className="mono">{v.toFixed(3)} N·m</td></tr>)}</tbody></table>}
        </>}
      </>}
    </div>
  );
}
