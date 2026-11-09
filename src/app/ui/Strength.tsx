// Strength tab: run declared Fea studies or a quick study, show results and the stress plot.
import { useEffect, useState } from 'react';
import { getEngine } from '../engine';
import { toast } from './util';
import type { WorkspaceCtx } from './Workspace';

const MATERIALS: [string, string][] = [
  ['isotropicPrintedPla', 'PLA'], ['petg', 'PETG'], ['abs', 'ABS'], ['nylon', 'Nylon PA12'], ['aluminum6061T6', 'Aluminium 6061-T6'],
  ['astmA36StructuralSteel', 'Steel A36'], ['stainless304', 'Stainless 304'], ['titanium6Al4V', 'Titanium Ti-6Al-4V'],
];
const FACES = ['bottom', 'top', 'left', 'right', 'front', 'back'];
const DIRS: Record<string, [number, number, number]> = { '-Z': [0, 0, -1], '+Z': [0, 0, 1], '-X': [-1, 0, 0], '+X': [1, 0, 0], '-Y': [0, -1, 0], '+Y': [0, 1, 0] };
const QUALITY: Record<string, number> = { Draft: 4000, Normal: 12000, Fine: 30000 };

const fmt = (x: number | null | undefined, d = 3) => (x == null ? 'n/a' : !isFinite(x) ? '∞' : Math.abs(x) >= 1000 ? x.toFixed(0) : x.toPrecision(d));

export function StrengthPanel(ctx: WorkspaceCtx) {
  const { result, opts, setOpts } = ctx;
  const studies = result?.feaStudies ?? [];
  const solids = (result?.objects ?? []).filter((o) => o.kind === 'solid').map((o) => o.part ?? o.name);
  const [quick, setQuick] = useState({ part: '', fix: 'bottom', load: 'top', newtons: 100, dir: '-Z', material: 'isotropicPrintedPla', gravity: false });
  const [quality, setQuality] = useState('Normal');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const [scale, setScale] = useState(0);
  const [clip, setClip] = useState(true);

  // results go stale when the model is rebuilt
  useEffect(() => { setRes(null); if (opts.mode === 'stress') setOpts({ ...opts, mode: 'shaded', fea: null }); }, [result]); // eslint-disable-line react-hooks/exhaustive-deps

  const autoScale = (r: any) => {
    const b = r.display.positions; let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < b.length; i++) { lo = Math.min(lo, b[i]); hi = Math.max(hi, b[i]); }
    return r.maxDisplacementMm > 0 ? (0.08 * (hi - lo)) / r.maxDisplacementMm : 0;
  };
  const show = (r: any, s: number, c: boolean) => {
    if (!r) return;
    setOpts({ ...opts, mode: 'stress', fea: { positions: r.display.positions, indices: r.display.indices, vonMises: r.display.vonMises, displacement: r.display.displacement, range: [0, c ? r.p99VonMisesMPa : r.maxVonMisesMPa], scale: s } });
  };
  const run = async (payload: any) => {
    setBusy(true);
    try {
      const r = await getEngine().call('fea', { ...payload, targetElements: QUALITY[quality] });
      const s = autoScale(r);
      setRes(r); setScale(s); show(r, s, clip);
    } catch (e: any) { toast(`Strength study failed: ${e.message}`); } finally { setBusy(false); }
  };
  const runQuick = () => run({ quick: { part: quick.part || undefined, fix: quick.fix, load: quick.load, newtons: quick.newtons, direction: DIRS[quick.dir], material: quick.material, gravity: quick.gravity } });

  if (!result?.ok) return <div className="muted">Build the model to run a strength study.</div>;
  const sf = res?.safetyFactor;
  const top = res ? (clip ? res.p99VonMisesMPa : res.maxVonMisesMPa) : 0;

  return <>
    <h3>Studies in this model</h3>
    {studies.length === 0 && <div className="muted">None declared. Add <code>Fea.study.staticStress(...)</code> to the script, or run a quick study below.</div>}
    {studies.map((s) => (
      <div key={s.name} className="row">
        <span className="grow">{s.name}<span className="muted"> · {s.part ?? 'whole model'}{s.material ? ` · ${s.material}` : ''}{s.target ? ` · SF ≥ ${s.target}` : ''}</span></span>
        <button disabled={busy} onClick={() => run({ study: s.name })}>Run</button>
      </div>
    ))}

    <h3>Quick study</h3>
    {solids.length > 1 && <div className="field"><label><span>Part</span></label>
      <select value={quick.part} onChange={(e) => setQuick({ ...quick, part: e.target.value })}><option value="">Whole model</option>{solids.map((p) => <option key={p} value={p}>{p}</option>)}</select></div>}
    <div className="row">
      <div className="field grow"><label><span>Fixed face</span></label>
        <select value={quick.fix} onChange={(e) => setQuick({ ...quick, fix: e.target.value })}>{FACES.map((f) => <option key={f}>{f}</option>)}</select></div>
      <div className="field grow"><label><span>Load face</span></label>
        <select value={quick.load} onChange={(e) => setQuick({ ...quick, load: e.target.value })}>{FACES.map((f) => <option key={f}>{f}</option>)}</select></div>
    </div>
    <div className="row">
      <div className="field grow"><label><span>Force (N)</span></label>
        <input type="number" value={quick.newtons} onChange={(e) => setQuick({ ...quick, newtons: Number(e.target.value) })} aria-label="Force in newtons" /></div>
      <div className="field grow"><label><span>Direction</span></label>
        <select value={quick.dir} onChange={(e) => setQuick({ ...quick, dir: e.target.value })}>{Object.keys(DIRS).map((d) => <option key={d}>{d}</option>)}</select></div>
    </div>
    <div className="field"><label><span>Material</span></label>
      <select value={quick.material} onChange={(e) => setQuick({ ...quick, material: e.target.value })}>{MATERIALS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
    <label className="row"><input type="checkbox" checked={quick.gravity} onChange={(e) => setQuick({ ...quick, gravity: e.target.checked })} /> Include self weight</label>
    <div className="row">
      <div className="seg">{Object.keys(QUALITY).map((q) => <button key={q} className={quality === q ? 'on' : ''} onClick={() => setQuality(q)}>{q}</button>)}</div>
      <button className="grow" disabled={busy} onClick={runQuick}>{busy ? 'Solving…' : 'Run quick study'}</button>
    </div>

    {res && <>
      <h3>{res.study}</h3>
      <div className={'check col'} style={{ gap: 2 }}>
        <span>Max von Mises <b>{fmt(res.maxVonMisesMPa)} MPa</b> <span className="muted">(99th pct {fmt(res.p99VonMisesMPa)})</span></span>
        <span>Max displacement <b>{fmt(res.maxDisplacementMm)} mm</b></span>
        <span>Safety factor <b>{fmt(sf)}</b> <span className="muted">vs {res.material} yield {fmt(res.yieldStrengthMPa)} MPa</span></span>
        {res.target != null && <span className={'chip ' + (res.pass ? 'ok' : 'bad')}>{res.pass ? 'Pass' : 'Fail'}: target safety factor {res.target}</span>}
        <span className="muted">{res.elements.toLocaleString()} hex elements · {res.iterations} solver iterations · {(res.solveMs / 1000).toFixed(1)} s</span>
        <span className="muted">Load {res.appliedForceN.map((x: number) => fmt(x)).join(', ')} N · reaction {res.reactionForceN.map((x: number) => fmt(x)).join(', ')} N</span>
      </div>
      {res.warnings.map((w: string, i: number) => <div key={i} className="chip warn">{w}</div>)}
      <div className="col" style={{ gap: 2 }}>
        <div style={{ height: 10, borderRadius: 4, background: 'linear-gradient(90deg, rgb(33,69,219), rgb(26,184,242), rgb(51,217,89), rgb(250,217,38), rgb(237,51,33))' }} />
        <div className="row muted" style={{ justifyContent: 'space-between', fontSize: 11 }}><span>0 MPa</span><span>{fmt(top / 2)}</span><span>{clip ? '≥ ' : ''}{fmt(top)} MPa</span></div>
      </div>
      <label className="row"><input type="checkbox" checked={clip} onChange={(e) => { setClip(e.target.checked); show(res, scale, e.target.checked); }} /> Clip colours at 99th percentile</label>
      <div className="field"><label><span>Deformation scale</span><span className="mono">{fmt(scale, 2)}×</span></label>
        <input type="range" min={0} max={Math.max(1, autoScale(res) * 4)} step={Math.max(1e-6, autoScale(res) / 50)} value={scale} onChange={(e) => { const s = Number(e.target.value); setScale(s); show(res, s, clip); }} aria-label="Deformation scale" /></div>
      <div className="row">
        <button onClick={() => (opts.mode === 'stress' ? setOpts({ ...opts, mode: 'shaded' }) : show(res, scale, clip))}>{opts.mode === 'stress' ? 'Hide stress plot' : 'Show stress plot'}</button>
      </div>
    </>}
    <div className="muted" style={{ fontSize: 11 }}>Linear static finite element solve on a hexahedral mesh. Peak values at sharp corners and fixture edges can be singular; the 99th percentile is the steadier number.</div>
  </>;
}
