// Usage: npx tsx scripts/probe.ts names.txt  -> prints names that do not resolve.
// Lines: "Foo.bar" (global path) or "#Class.method" (prototype method on a runtime class).
import { readFileSync } from 'node:fs';
import { initNode } from '../src/kernel/node';
import { runProject } from '../src/kernel/runtime';
await initNode();
const names = readFileSync(process.argv[2], 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('//'));
const src = `const miss = [];
const N = ${JSON.stringify(names)};
const g = { Shape, Sketch, Assembly };
const sample = {}; const mk = (k, f) => { try { sample[k] = f(); } catch (e) { console.log('sample ' + k + ' failed: ' + e.message); } };
mk('Shape', () => box(1,1,1)); mk('Sketch', () => rect(1,1)); mk('ShapeGroup', () => group({name:'a',shape:box(1,1,1)}));
mk('Assembly', () => assembly()); mk('Solved', () => assembly().addPart('a', box(1,1,1)).solve()); mk('Path', () => path());
mk('Dimension', () => dim([0,0,0],[1,0,0])); mk('ConstrainedSketchBuilder', () => constrainedSketch()); mk('SheetMetalPart', () => sheetMetal({ panel: { width: 50, height: 40 }, thickness: 1, bendRadius: 1 }));
mk('WoodBoard', () => Wood.board(100, 50, 18)); mk('LaserKit', () => Laser.kit()); mk('FlatPart', () => Laser.panel('p', 50, 40, 3));
mk('ConstraintSketch', () => { const b = constrainedSketch(); b.moveTo(0,0).lineTo(10,0).lineTo(10,10).close(); return b.solve(); });
mk('TangentLoop2D', () => lib.tangentLoop2d([{center:[0,0],radius:5},{center:[30,0],radius:8}])); mk('DriveWheelBuilder', () => lib.driveWheel());
mk('Curve', () => Curve.Line([0,0,0],[1,0,0]));
for (const n of N) {
  try {
    if (n.startsWith('@')) { const [e, ms] = n.slice(1).split('|'); let o; try { o = eval(e); } catch (er) { miss.push(n + ' (expr: ' + er.message + ')'); continue; } for (const m of ms.split(',')) if (o == null || o[m.trim()] === undefined) miss.push(e.slice(0,40) + ' .' + m.trim()); continue; }
    if (n.startsWith('#')) { const [c, m] = n.slice(1).split('.'); const o = sample[c]; if (!o || o[m] === undefined) miss.push(n); continue; }
    const parts = n.split('.'); let o = eval(parts[0]); for (const p of parts.slice(1)) { o = o?.[p]; } if (o === undefined) miss.push(n);
  } catch (e) { miss.push(n + '  (' + e.message + ')'); }
}
console.log('@@'+JSON.stringify(miss));
return box(1,1,1);`;
const r = runProject({ files: { 'main.forge.js': src } }, {});
if (!r.ok) { console.error(r.error); process.exit(1); }
for (const l of r.logs) if (!String(l.message).startsWith('@@')) console.log(l.message);
const miss = JSON.parse(r.logs.find((l) => String(l.message).startsWith('@@')).message.slice(2));
console.log(miss.length ? miss.join('\n') : 'ALL RESOLVE');
