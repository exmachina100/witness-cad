// Project workspace: top bar, left rail panels, 3D viewport, code editor and status bar.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, actions, getState } from '../store';
import { getEngine } from '../engine';
import type { RunResult } from '../../kernel/runtime';
import { Viewport, ViewportHandle, ViewportOptions, Selection, ViewName } from '../components/Viewport';
import { Editor } from '../components/Editor';
import { Icon } from './icons';
import { go, toast, blobToDataUrl } from './util';
import { FilesPanel, AgentPanel, ParamsPanel, ViewsPanel, MakePanel, ArtifactsPanel, InspectPanel, MotionState } from './Panels';
import { Palette, ExportDialog, ShareDialog, TestsDialog, HelpDialog, VersionMenu } from './Dialogs';

const RAIL = [
  ['files', 'Files', 'files'], ['agent', 'Agent', 'agent'], ['params', 'Params', 'params'], ['views', '2D views', 'views'],
  ['make', 'Make', 'make'], ['artifacts', 'Artifacts', 'artifacts'], ['inspect', 'Inspect', 'inspect'],
] as const;

export function Workspace({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const settings = useStore((s) => s.settings);
  const allProjects = useStore((s) => s.projects);
  const vp = useRef<ViewportHandle>(null);

  const [result, setResult] = useState<RunResult | null>(null);
  const [building, setBuilding] = useState(false);
  const [panel, setPanel] = useState<string>('files');
  const [showLeft, setShowLeft] = useState(true);
  const [activeFile, setActiveFile] = useState<string>(project?.entry ?? 'main.forge.js');
  const [editorOpen, setEditorOpen] = useState(true);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [dialog, setDialog] = useState<null | 'palette' | 'export' | 'share' | 'tests' | 'help'>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [measure, setMeasure] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [transforms, setTransforms] = useState<Record<string, number[]>>({});
  const [jointValues, setJointValues] = useState<Record<string, Record<string, any>>>({});
  const [motion, setMotion] = useState<MotionState>({ playing: null, t: 0 });
  const dark = document.documentElement.dataset.theme !== 'light';
  const [opts, setOpts] = useState<ViewportOptions>({
    edges: true, ortho: false, mode: 'shaded', explode: 0, grid: true, hidden: new Set(), dark,
    cut: { enabled: false, axis: 'z', offset: 0, flip: false },
  });
  useEffect(() => setOpts((o) => ({ ...o, dark })), [dark]);

  // ------------------------------------------------------------------ build
  const buildSeq = useRef(0);
  const build = useCallback(async () => {
    const p = getState().projects.find((x) => x.id === projectId);
    if (!p) return null;
    const seq = ++buildSeq.current;
    setBuilding(true);
    const others: Record<string, any> = {};
    for (const o of getState().projects) if (o.alias && o.id !== p.id) others[o.alias] = { files: o.files, entry: o.entry };
    try {
      const r = await getEngine().run(p.files, p.entry, p.params ?? {}, others);
      if (seq !== buildSeq.current) return r;
      setResult(r);
      setTransforms({});
      // keep joint sliders in range of the new model
      const jv: Record<string, Record<string, any>> = {};
      for (const a of r.assemblies) jv[a.name] = { ...a.values, ...(jointValues[a.name] ?? {}) };
      setJointValues(jv);
      for (const a of r.assemblies) if (jointValues[a.name]) getEngine().solve(a.name, jv[a.name]).then((s) => s && setTransforms((t) => ({ ...t, ...s.transforms })));
      if (r.ok) setTimeout(() => {
        const shot = vp.current?.screenshot(320, 200);
        if (shot) actions.setThumbnail(projectId, shot);
      }, 400);
      return r;
    } catch (e: any) {
      const r: any = { ok: false, objects: [], params: [], checks: [], bom: [], dims: [], labels: [], logs: [], assemblies: [], warnings: [], scene: null, cutPlanes: [], explode: null, error: { message: e.message }, timeMs: 0 };
      setResult(r);
      return r;
    } finally {
      if (seq === buildSeq.current) setBuilding(false);
    }
  }, [projectId, jointValues]);

  const filesKey = project ? JSON.stringify([project.files, project.entry, project.params]) : '';
  const first = useRef(true);
  useEffect(() => {
    if (!project) return;
    if (!settings.autoBuild && !first.current) return;
    first.current = false;
    const t = setTimeout(build, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesKey, settings.autoBuild]);

  // ------------------------------------------------------------------ joints, animation, simulation
  const setJoints = useCallback(async (asm: string, values: Record<string, any>) => {
    setJointValues((jv) => ({ ...jv, [asm]: { ...(jv[asm] ?? {}), ...values } }));
    const merged = { ...(jointValues[asm] ?? {}), ...values };
    const s = await getEngine().solve(asm, merged);
    if (s) setTransforms((t) => ({ ...t, ...s.transforms }));
  }, [jointValues]);

  useEffect(() => {
    if (!motion.playing || !result) return;
    const { asm, kind, name } = motion.playing;
    const info = result.assemblies.find((a) => a.name === asm);
    if (!info) return;
    let raf = 0, stop = false;
    const t0 = performance.now();
    if (kind === 'animation') {
      const anim = info.animations[name];
      const dur = (anim.duration ?? 2) * 1000;
      const kfs: any[] = anim.keyframes ?? [];
      const tick = async () => {
        if (stop) return;
        let u = (performance.now() - t0) / dur;
        if (u > 1) { if (anim.loop === false) { setMotion({ playing: null, t: 1 }); return; } u = u % 1; }
        const vals: Record<string, number> = {};
        for (let i = 0; i < kfs.length - 1; i++) {
          const a = kfs[i], b = kfs[i + 1];
          if (u >= a.at && u <= b.at) {
            const k = (u - a.at) / Math.max(1e-9, b.at - a.at);
            for (const j of Object.keys(b.values)) vals[j] = (a.values[j] ?? b.values[j]) + ((b.values[j] - (a.values[j] ?? b.values[j])) * k);
          }
        }
        await setJoints(asm, vals);
        setMotion((m) => ({ ...m, t: u }));
        raf = requestAnimationFrame(tick);
      };
      tick();
    } else if (kind === 'simulation' && motion.frames) {
      const frames = motion.frames;
      const dur = (frames[frames.length - 1]?.t ?? 1) * 1000;
      const tick = () => {
        if (stop) return;
        const tt = ((performance.now() - t0) % dur) / 1000;
        let f = frames[0];
        for (const fr of frames) { if (fr.t <= tt) f = fr; else break; }
        if (f?.transforms) setTransforms((t) => ({ ...t, ...f.transforms }));
        setMotion((m) => ({ ...m, t: tt / (dur / 1000) }));
        raf = requestAnimationFrame(tick);
      };
      tick();
    }
    return () => { stop = true; cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [motion.playing, motion.frames, result]);

  // ------------------------------------------------------------------ shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); setDialog('palette'); }
      else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setDialog('palette'); }
      else if (mod && e.key === 'Enter') { e.preventDefault(); build(); }
      else if (e.key === 'Escape') setDialog(null);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [build]);

  if (!project) return <div className="panel"><p>Project not found.</p><button onClick={() => go('#/')}>Back to projects</button></div>;
  const files = Object.keys(project.files).sort();
  const file = project.files[activeFile] !== undefined ? activeFile : project.entry;
  const openFiles = (project.openFiles ?? [project.entry]).filter((f) => f in project.files);
  const openFile = (f: string) => { actions.openFile(project.id, f); setActiveFile(f); setEditorOpen(true); };

  // ------------------------------------------------------------------ actions
  const screenshot = () => {
    const url = vp.current?.screenshot(1600, 1000);
    if (!url) return;
    actions.addArtifact(project.id, { name: `${project.name} render.png`, kind: 'render', mime: 'image/png', dataUrl: url, size: Math.round(url.length * 0.75) });
    toast('Screenshot saved to Artifacts');
  };
  const video = async () => {
    if (!vp.current || recording) return;
    setRecording(true);
    toast('Recording a 6 s turntable…');
    try {
      const blob = await vp.current.recordTurntable(6);
      const url = await blobToDataUrl(blob);
      actions.addArtifact(project.id, { name: `${project.name} turntable.webm`, kind: 'video', mime: 'video/webm', dataUrl: url, size: blob.size });
      toast('Video saved to Artifacts');
    } catch (e: any) { toast(`Recording failed: ${e.message}`); }
    setRecording(false);
  };
  const saveVersion = () => {
    const name = prompt('Version name', `Version ${project.versions.length + 1}`);
    if (!name) return;
    actions.saveVersion(project.id, name, undefined, vp.current?.screenshot(320, 200));
    toast(`Saved "${name}"`);
  };

  const ctx = {
    project, result, build, building, vp, opts, setOpts, selection, setSelection, measure, transforms, setTransforms,
    jointValues, setJoints, motion, setMotion, openFile, activeFile: file, setDialog, screenshot, video, saveVersion, allProjects,
  };
  const leftPanel = {
    files: <FilesPanel {...ctx} />, agent: <AgentPanel {...ctx} />, params: <ParamsPanel {...ctx} />, views: <ViewsPanel {...ctx} />,
    make: <MakePanel {...ctx} />, artifacts: <ArtifactsPanel {...ctx} />, inspect: <InspectPanel {...ctx} />,
  }[panel];

  const err = result && !result.ok ? result.error : null;
  const passed = result?.checks.filter((c) => c.pass).length ?? 0;
  const failed = (result?.checks.length ?? 0) - passed;
  const views: ViewName[] = ['top', 'front', 'right', 'left', 'iso', 'back', 'bottom'];

  return (
    <div className="ws">
      <header className="topbar">
        <button className="ghost" onClick={() => go('#/')} title="Back to projects" aria-label="Back to projects"><Icon name="back" /></button>
        <div className="crumb">
          <span className="muted hide-sm">Projects /</span>
          <input value={project.name} onChange={(e) => actions.rename(project.id, e.target.value)} aria-label="Project name" />
        </div>
        <VersionMenu project={project} onSave={saveVersion} />
        <button className="filesearch" onClick={() => setDialog('palette')}><span className="row"><Icon name="search" size={14} /> Search files</span><span className="mono">⌘P</span></button>
        <div className="spacer" />
        <label className="row hide-sm" title="Rebuild automatically when files change" style={{ gap: 5 }}>
          <input type="checkbox" checked={settings.autoBuild} onChange={(e) => actions.settings({ autoBuild: e.target.checked })} /> Auto-build
        </label>
        <button onClick={build} title="Rebuild (⌘↵)" disabled={building}><Icon name="refresh" /> <span className="hide-sm">{building ? 'Building…' : 'Rebuild'}</span></button>
        <button onClick={() => setDialog('tests')} title="Run tests and verify checks"><Icon name="test" /> <span className="hide-sm">Run tests</span></button>
        <button className="ghost" onClick={screenshot} title="Screenshot" aria-label="Screenshot"><Icon name="camera" /></button>
        <button className="ghost" onClick={video} title="Record turntable video" aria-label="Video" disabled={recording}><Icon name="video" /></button>
        <button onClick={() => setDialog('export')}><Icon name="download" /> Export</button>
        <button className="primary" onClick={() => setDialog('share')}><Icon name="share" /> Share</button>
        <button className="ghost" onClick={() => setDialog('help')} title="Help" aria-label="Help"><Icon name="help" /></button>
      </header>

      <div className={'main' + (showLeft ? ' show-left' : '')} style={showLeft ? undefined : { gridTemplateColumns: '48px 0 1fr' }}>
        <nav className="rail">
          {RAIL.map(([id, label, icon]) => (
            <button key={id} className={panel === id && showLeft ? 'on' : ''} onClick={() => { if (panel === id) setShowLeft(!showLeft); else { setPanel(id); setShowLeft(true); } }} title={label}>
              <Icon name={icon} /> {label.split(' ')[0]}
            </button>
          ))}
          <div className="spacer" />
          <button className={editorOpen ? 'on' : ''} onClick={() => setEditorOpen(!editorOpen)} title="Toggle code editor"><Icon name="code" /> Code</button>
        </nav>
        <section className="left">{showLeft && leftPanel}</section>

        <div className={'center' + (editorOpen ? '' : ' no-editor')}>
          <div className="vp-wrap">
            <Viewport ref={vp} result={result} transforms={transforms} options={opts} onSelect={setSelection} onMeasure={setMeasure} selected={selection?.name ?? null} />
            <div className="vp-tools">
              <div className="seg">
                <button className={!opts.ortho ? 'on' : ''} onClick={() => setOpts({ ...opts, ortho: false })}>3D</button>
                <button className={opts.ortho ? 'on' : ''} onClick={() => { setOpts({ ...opts, ortho: true }); vp.current?.setView('top'); }}>Flat</button>
              </div>
              <button onClick={() => vp.current?.fit()} title="Fit to view">Fit</button>
              <button className={opts.edges ? 'active' : ''} onClick={() => setOpts({ ...opts, edges: !opts.edges })}>Edges</button>
              <button className={opts.mode === 'distance' ? 'active' : ''} onClick={() => { setOpts({ ...opts, mode: opts.mode === 'distance' ? 'shaded' : 'distance' }); vp.current?.clearMeasure(); }}>Measure</button>
              <button className={opts.cut.enabled ? 'active' : ''} onClick={() => setOpts({ ...opts, cut: { ...opts.cut, enabled: !opts.cut.enabled } })}>Section</button>
              {measure != null && <span className="chip">{measure.toFixed(2)} mm</span>}
            </div>
            <div className="viewcube" aria-label="View presets">
              {views.map((v) => <button key={v} onClick={() => vp.current?.setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}
            </div>
            {err && (
              <div className="error-banner" role="alert">
                {err.file ? `${err.file}${err.line ? `:${err.line}` : ''}  ` : ''}{err.code ? `[${err.code}] ` : ''}{err.message}
                {err.file && err.file !== file && <> <button style={{ marginLeft: 8 }} onClick={() => openFile(err.file!)}>Open file</button></>}
              </div>
            )}
            {selection && (
              <div className="sel-card">
                <div className="row"><b className="grow">{selection.name}</b><button className="ghost" onClick={() => setSelection(null)} aria-label="Close"><Icon name="x" size={12} /></button></div>
                {selection.object?.stats && (() => {
                  const s = selection.object.stats;
                  const size = s.bbox.max.map((v, i) => (v - s.bbox.min[i]).toFixed(1)).join(' × ');
                  return <div className="col" style={{ gap: 2, marginTop: 6 }}>
                    <span>Size {size} mm</span><span>Volume {(s.volume / 1000).toFixed(2)} cm³</span><span>Area {(s.area / 100).toFixed(1)} cm²</span>
                    {selection.object.part && <span className="muted">Part of {selection.object.assembly}</span>}
                  </div>;
                })()}
                <div className="muted mono" style={{ marginTop: 6, fontSize: 11 }}>at {selection.point.map((v) => v.toFixed(1)).join(', ')}</div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button onClick={() => setOpts({ ...opts, hidden: new Set([...opts.hidden, selection.name]) })}>Hide</button>
                  <button onClick={() => setOpts({ ...opts, hidden: new Set(result?.objects.map((o) => o.name).filter((n) => n !== selection.name)) })}>Isolate</button>
                </div>
              </div>
            )}
            {result?.assemblies.map((a) => a.joints.filter((j) => j.type !== 'fixed' && !j.follows).length > 0 && panel !== 'inspect' && (
              <div className="joint-bar" key={a.name}>
                {a.joints.filter((j) => j.type !== 'fixed' && !j.follows).slice(0, 6).map((j) => {
                  const v = Number(jointValues[a.name]?.[j.name] ?? j.default ?? 0);
                  return (
                    <div key={j.name}>
                      <span>{j.name}</span>
                      <input type="range" min={j.min ?? (j.type === 'prismatic' ? 0 : -180)} max={j.max ?? (j.type === 'prismatic' ? 100 : 180)} step={0.5} value={v}
                        onChange={(e) => setJoints(a.name, { [j.name]: Number(e.target.value) })} aria-label={`${j.name} joint`} />
                      <span className="mono">{v.toFixed(1)}{j.type === 'prismatic' ? ' mm' : '°'}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {editorOpen && (
            <div className="editor-wrap">
              <div className="tabs">
                {openFiles.map((f) => (
                  <div key={f} className={'tab' + (f === file ? ' on' : '')} onClick={() => setActiveFile(f)}>
                    {f.split('/').pop()}{f === project.entry && <span className="chip">root</span>}
                    <span className="x" onClick={(e) => { e.stopPropagation(); actions.closeFile(project.id, f); if (f === file) setActiveFile(project.entry); }}>×</span>
                  </div>
                ))}
              </div>
              <Editor path={file} value={project.files[file] ?? ''} onChange={(v) => actions.writeFile(project.id, file, v)} error={err} dark={dark} onSave={build} />
              {consoleOpen && (
                <div className="console" aria-label="Console">
                  {(result?.logs ?? []).map((l, i) => <div key={i} className={l.level}>{l.level !== 'log' ? `[${l.level}] ` : ''}{l.message}</div>)}
                  {(result?.warnings ?? []).map((w, i) => <div key={'w' + i} className="warn">[warn] {w}</div>)}
                  {err && <div className="error">[error] {err.message}{err.stack ? '\n' + err.stack : ''}</div>}
                  {!result?.logs.length && !result?.warnings.length && !err && <div className="muted">Console is empty. Use console.log() in your script.</div>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <footer className="statusbar">
        {building ? <span>Building…</span> : result ? (result.ok ? <span className="ok">Built ✓ {Math.round(result.timeMs)} ms</span> : <span className="bad">Build failed</span>) : <span>Loading kernel…</span>}
        <button onClick={() => setConsoleOpen(!consoleOpen)}>Console{result?.logs.length ? ` (${result.logs.length})` : ''}</button>
        {result && result.checks.length > 0 && <span className={failed ? 'bad' : 'ok'}>{passed}/{result.checks.length} checks</span>}
        {result && <span>{result.objects.length} object{result.objects.length === 1 ? '' : 's'}</span>}
        {result?.warnings.length ? <span style={{ color: 'var(--warn)' }}>{result.warnings.length} warning{result.warnings.length > 1 ? 's' : ''}</span> : null}
        <div className="spacer" />
        <span className="hide-sm">{project.activeDraft ? `Draft: ${project.drafts.find((d) => d.id === project.activeDraft)?.name}` : `Version: ${project.versions.find((v) => v.id === project.currentVersion)?.name ?? '—'}`}</span>
        <span className="hide-sm">Manifold · local</span>
        <button onClick={() => actions.settings({ theme: dark ? 'light' : 'dark' })} aria-label="Toggle theme"><Icon name="sun" size={13} /></button>
      </footer>

      {dialog === 'palette' && <Palette files={files} project={project} onOpen={openFile} onClose={() => setDialog(null)} run={{ build, screenshot, video, saveVersion, setPanel: (p: string) => { setPanel(p); setShowLeft(true); }, setDialog }} />}
      {dialog === 'export' && <ExportDialog project={project} result={result} transforms={transforms} onClose={() => setDialog(null)} />}
      {dialog === 'share' && <ShareDialog project={project} onClose={() => setDialog(null)} />}
      {dialog === 'tests' && <TestsDialog project={project} result={result} onClose={() => setDialog(null)} />}
      {dialog === 'help' && <HelpDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

export type WorkspaceCtx = {
  project: ReturnType<typeof getState>['projects'][number];
  result: RunResult | null;
  build: () => Promise<any>;
  building: boolean;
  vp: React.RefObject<ViewportHandle>;
  opts: ViewportOptions;
  setOpts: (o: ViewportOptions) => void;
  selection: Selection | null;
  setSelection: (s: Selection | null) => void;
  measure: number | null;
  transforms: Record<string, number[]>;
  setTransforms: (t: Record<string, number[]>) => void;
  jointValues: Record<string, Record<string, any>>;
  setJoints: (asm: string, v: Record<string, any>) => Promise<void>;
  motion: MotionState;
  setMotion: (m: MotionState) => void;
  openFile: (f: string) => void;
  activeFile: string;
  setDialog: (d: any) => void;
  screenshot: () => void;
  video: () => void;
  saveVersion: () => void;
  allProjects: any[];
};
