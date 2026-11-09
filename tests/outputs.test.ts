import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initNode } from '../src/kernel/node';
import { runProject } from '../src/kernel/runtime';
import { exportModel } from '../src/export';
import { renderTurntableGif } from '../src/render/video';

beforeAll(async () => { process.env.WITNESS_HOME = mkdtempSync(join(tmpdir(), 'wh-')); await initNode(); });
const run = (src: string, files: Record<string, string> = {}) => runProject({ files: { 'main.forge.js': src, ...files } }, {});

describe('outline exports, paint and video', () => {
  it('writes DXF and SVG outlines of the model', () => {
    const r = run('return box(40, 20, 10).subtract(cylinder(20, 4).translate(0, 0, -5));');
    const dxf = exportModel(r, 'dxf').data as string, svg = exportModel(r, 'svg').data as string, sec = exportModel(r, 'dxf-section').data as string;
    expect(dxf).toContain('LWPOLYLINE');
    expect(dxf.match(/LWPOLYLINE/g)!.length).toBe(2); // the through hole shows in the projection
    expect(sec.match(/LWPOLYLINE/g)!.length).toBe(2); // section keeps it
    expect(svg.startsWith('<svg')).toBe(true);
  });
  it('applies paint.json colours', () => {
    const r = run('return { plate: box(10, 10, 2), pin: cylinder(5, 1) };', { 'paint.json': '{"pin": "#ff0000", "*": "#00ff00"}' });
    expect(r.objects.find((o) => o.name === 'pin')!.color).toBe('#ff0000');
    expect(r.objects.find((o) => o.name === 'plate')!.color).toBe('#00ff00');
  });
  it('renders a turntable GIF', () => {
    const gif = renderTurntableGif(run('return box(10, 10, 10);'), { width: 64, height: 48, frames: 4 });
    expect(String.fromCharCode(...gif.slice(0, 6))).toBe('GIF89a');
  });
  it('MCP tools: paint, link, compare, surfaces, picture, video, draft copy', async () => {
    const { createWitnessServer } = await import('../mcp/server');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createWitnessServer(); await server.connect(a);
    const client = new Client({ name: 't', version: '1' }); await client.connect(b);
    const call = async (name: string, args: any) => { const r: any = await client.callTool({ name, arguments: args }); if (r.isError) throw new Error(r.content[0].text); return r; };
    const txt = (r: any) => r.content.find((c: any) => c.type === 'text').text;
    const p = JSON.parse(txt(await call('create_project', { name: 'cmp', files: { 'main.forge.js': 'return { body: box(20, 20, 20), skin: Surface.Plane({ width: 10 }) };', 'ref.obj': 'v -10 -10 0\nv 10 -10 0\nv 10 10 0\nv -10 10 0\nv -10 -10 20\nv 10 -10 20\nv 10 10 20\nv -10 10 20\nf 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 2 3 7 6\nf 3 4 8 7\nf 4 1 5 8\n' } }))).id;
    const cmp = JSON.parse(txt(await call('compare_to_reference', { project: p, reference: 'ref.obj' })));
    expect(cmp.iou).toBeGreaterThan(0.99);
    expect(JSON.parse(txt(await call('paint_model', { project: p, colors: { body: '#123456' } }))).paint.body).toBe('#123456');
    expect(JSON.parse(txt(await call('get_link', { project: p, app_url: 'https://cad.example/' }))).url).toMatch(/^https:\/\/cad\.example\/#\/share\//);
    expect(JSON.parse(txt(await call('check_surfaces', { project: p }))).ok).toBe(true);
    const pic = await call('render_picture', { project: p, azimuth: 30, elevation: 20, width: 200, height: 150 });
    expect(pic.content[0].type).toBe('image');
    expect(JSON.parse(txt(await call('render_video', { project: p, frames: 4, width: 80, height: 60 }))).status).toBe('done');
    const d1 = JSON.parse(txt(await call('create_draft', { project: p, name: 'one' }))).draft;
    await call('write_file', { project: p, draft: d1, path: 'note.txt', content: 'hi' });
    const d2 = JSON.parse(txt(await call('create_draft', { project: p, name: 'two', from_draft: d1 }))).draft;
    expect(txt(await call('read_file', { project: p, draft: d2, path: 'note.txt' }))).toContain('hi');
    const versions = JSON.parse(txt(await call('list_versions', { project: p })));
    expect((await call('read_version_picture', { project: p, version: versions[0].id })).content[0].type).toBe('image');
  }, 60000);
});
