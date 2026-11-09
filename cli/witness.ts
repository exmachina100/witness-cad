// Witness CAD command line: build, check, export, render and inspect params of a project folder or .forge.js file.
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { initNode } from '../src/kernel/node';
import { runProject, projectResolver, RunResult } from '../src/kernel/runtime';
import { exportModel, EXPORT_FORMATS } from '../src/export';
import { renderPng, RenderView } from '../src/render/raster';
import { summarizeBuild } from '../src/app/agent-summary';
import { readFiles, store } from '../mcp/store';

const USAGE = `witness <command> <project> [options]

Commands
  build   <project>                       build and print a summary
  check   <project>                       build and exit 1 if the build or any verify check fails
  params  <project>                       list parameters and their values
  export  <project> --format <fmt> [--out file]   formats: ${Object.keys(EXPORT_FORMATS).join(', ')}
  render  <project> [--view iso|front|top|…] [--out file.png] [--size 1200x800]

<project> is a folder with main.forge.js, a single .forge.js file, or the id of a project in ~/.witness-cad.
Options: --set Name=value (repeatable) overrides parameters; --entry file.forge.js picks the root file.`;

function args() {
  const [cmd, target, ...rest] = process.argv.slice(2);
  const o: Record<string, string> = {}, set: Record<string, any> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2), v = rest[i + 1];
    if (k === 'set') { const [n, ...val] = v.split('='); const s = val.join('='); set[n] = s === 'true' ? true : s === 'false' ? false : isNaN(Number(s)) ? s : Number(s); }
    else o[k] = v;
    i++;
  }
  return { cmd, target, o, set };
}

function load(target: string, entry?: string) {
  const p = resolve(target);
  if (existsSync(p) && statSync(p).isDirectory()) {
    const files = readFiles(p);
    return { name: basename(p), files, entry: entry ?? (files['main.forge.js'] !== undefined ? 'main.forge.js' : Object.keys(files).find((f) => f.endsWith('.forge.js'))!) };
  }
  if (existsSync(p)) {
    const files = readFiles(dirname(p));
    return { name: basename(p).replace(/\.forge\.js$|\.js$/, ''), files, entry: basename(p) };
  }
  const m = store.list().find((x) => x.id === target || x.name === target);
  if (m) return { name: m.name, files: store.files(m.id), entry: entry ?? m.entry };
  throw new Error(`no project at "${target}"`);
}

async function main() {
  const { cmd, target, o, set } = args();
  if (!cmd || !target || cmd === 'help') { console.log(USAGE); process.exit(cmd ? 0 : 1); }
  await initNode();
  projectResolver.fn = (alias) => store.byAlias(alias);
  const proj = load(target, o.entry);
  const r: RunResult = runProject({ files: proj.files, entry: proj.entry }, set);
  switch (cmd) {
    case 'build': console.log(summarizeBuild(r)); process.exit(r.ok ? 0 : 1);
    case 'check': {
      console.log(summarizeBuild(r));
      const bad = !r.ok || r.checks.some((c) => !c.pass);
      console.log(bad ? '\nFAILED' : `\nOK: ${r.checks.length} check(s) passed`);
      process.exit(bad ? 1 : 0);
    }
    case 'params':
      for (const p of r.params) console.log(`${p.name} = ${JSON.stringify(p.value)}  (${p.type}${p.opts?.min != null ? `, ${p.opts.min}..${p.opts.max}` : ''}${p.opts?.unit ? ` ${p.opts.unit}` : ''})`);
      process.exit(0);
    case 'export': {
      if (!r.ok) { console.error(summarizeBuild(r)); process.exit(1); }
      const fmt = o.format ?? '3mf';
      if (!(fmt in EXPORT_FORMATS)) throw new Error(`unknown format "${fmt}"`);
      const e = exportModel(r, fmt as any, { name: proj.name });
      const out = o.out ?? e.filename;
      writeFileSync(out, typeof e.data === 'string' ? e.data : Buffer.from(e.data));
      console.log(`wrote ${out}`);
      process.exit(0);
    }
    case 'render': {
      if (!r.ok) { console.error(summarizeBuild(r)); process.exit(1); }
      const [w, h] = (o.size ?? '1200x800').split('x').map(Number);
      const out = o.out ?? `${proj.name}-${o.view ?? 'iso'}.png`;
      writeFileSync(out, renderPng(r, { view: (o.view ?? 'iso') as RenderView, width: w, height: h }));
      console.log(`wrote ${out}`);
      process.exit(0);
    }
    default: console.log(USAGE); process.exit(1);
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
