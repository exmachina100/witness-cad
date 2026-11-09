import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initNode } from '../src/kernel/node';
import { runProject } from '../src/kernel/runtime';
import { exportModel } from '../src/export';
import { loadOcct } from './helpers/occt';

beforeAll(async () => { process.env.WITNESS_HOME = mkdtempSync(join(tmpdir(), 'wh-')); await initNode(); });
const run = (src: string, files: Record<string, string> = {}) => { const r = runProject({ files: { 'main.forge.js': src, ...files } }, {}); if (!r.ok) throw new Error(r.error?.message); return r; };
const area = (res: any) => { let a = 0; for (const m of res.meshes ?? []) { const p = m.attributes.position.array, ix = m.index.array; for (let t = 0; t < ix.length; t += 3) { const A = [0, 1, 2].map((k) => p[ix[t] * 3 + k]), B = [0, 1, 2].map((k) => p[ix[t + 1] * 3 + k]), C = [0, 1, 2].map((k) => p[ix[t + 2] * 3 + k]); const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]]; a += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2; } } return a; };
const SRC = 'return box(20, 10, 5).subtract(cylinder(10, 2).translate(0, 0, -2));';

describe('IGES, BREP and G-code', () => {
  it('IGES and BREP read back in OpenCascade with the right area', async () => {
    const occ = await loadOcct();
    const r = run(SRC), want = r.objects[0].stats!.area ?? 737.7;
    const ig = occ.ReadIgesFile(new TextEncoder().encode(exportModel(r, 'iges').data as string), null);
    const br = occ.ReadBrepFile(new TextEncoder().encode(exportModel(r, 'brep').data as string), null);
    expect(ig.success).toBe(true); expect(br.success).toBe(true);
    expect(area(ig)).toBeCloseTo(want, 0);
    expect(area(br)).toBeCloseTo(want, 0);
    expect(br.meshes.length).toBe(1);
  });
  it('G-code has every layer, stays inside the part and extrudes about its volume', () => {
    const r = run('return box(20, 20, 4);');
    const g = exportModel(r, 'gcode').data as string;
    const lines = g.split('\n');
    expect(lines.filter((l) => l.startsWith('; LAYER')).length).toBe(20);
    const xs = lines.filter((l) => l.startsWith('G1 X')).map((l) => Number(l.split(' ')[1].slice(1)));
    expect(Math.min(...xs)).toBeGreaterThan(100); expect(Math.max(...xs)).toBeLessThan(120);
    const metres = Number(/filament used: ([\d.]+) m/.exec(g)![1]);
    const mm3 = metres * 1000 * Math.PI * 0.875 ** 2;
    expect(mm3).toBeGreaterThan(1600 * 0.4); expect(mm3).toBeLessThan(1600 * 1.15);
  });
});

describe('surface detail', () => {
  it('knurls, dimples and engraves faces', () => {
    const out = run(`const b = box(30, 20, 10);
      const k = b.surfaceDetail('top', { kind: 'knurl', spacing: 2, depth: 0.4 });
      const r = b.surfaceDetail('front', { kind: 'ribs', spacing: 3, height: 0.5 });
      const t = b.surfaceDetail('top', { kind: 'text', text: 'WX', size: 8, depth: 0.5 });
      console.log(k.volume() < b.volume(), r.volume() > b.volume(), t.volume() < b.volume(), k.meta.surfaceDetails.length);
      return k;`).logs.map((l: any) => l.message);
    expect(out[0]).toBe('true true true 1');
  });
  it('MCP add_surface_detail writes details.json and the build applies it', async () => {
    const { createWitnessServer } = await import('../mcp/server');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createWitnessServer().connect(a);
    const client = new Client({ name: 't', version: '1' }); await client.connect(b);
    const call = async (name: string, args: any) => { const r: any = await client.callTool({ name, arguments: args }); if (r.isError) throw new Error(r.content[0].text); return r.content[0].text as string; };
    const p = JSON.parse(await call('create_project', { name: 'grip', files: { 'main.forge.js': 'return { handle: box(40, 20, 10) };' } })).id;
    const before = runProject({ files: { 'main.forge.js': 'return { handle: box(40, 20, 10) };' } }, {}).objects[0].stats!.volume;
    expect(await call('add_surface_detail', { project: p, object: 'handle', face: 'top', kind: 'dimples', spacing: 4, depth: 0.5 })).toContain('dimples');
    const exp = JSON.parse(await call('export_model', { project: p, format: 'gcode' }));
    expect(exp.status).toBe('done');
    const { store } = await import('../mcp/store');
    const r = runProject({ files: store.files(p) }, {});
    expect(r.objects[0].stats!.volume).toBeLessThan(before);
  }, 60000);
});
