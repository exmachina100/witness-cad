import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.WITNESS_HOME = mkdtempSync(join(tmpdir(), 'witness-api-'));

let client: any, store: any;
beforeAll(async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createWitnessServer } = await import('../mcp/server');
  ({ store } = await import('../mcp/store'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createWitnessServer().connect(b);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(a);
});
const call = async (name: string, args: any) => { const r = await client.callTool({ name, arguments: args }); return { r, text: r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') }; };

describe('MCP extras', () => {
  it('reports credits, honours request ids and keeps a command history', async () => {
    const m = store.create('Api', { 'main.forge.js': 'return box(10,10,10);' });
    const a = await call('create_draft', { project: m.id, name: 'x', request_id: 'r1', max_credits: 5 });
    const b = await call('create_draft', { project: m.id, name: 'x', request_id: 'r1' });
    expect(a.text).toContain('creditsUsed: 0');
    expect(JSON.parse(b.r.content[0].text).draft).toBe(JSON.parse(a.r.content[0].text).draft);
    expect(JSON.parse(b.r.content[0].text).replayed).toBe(true);
    const d = JSON.parse(a.r.content[0].text).draft;
    const c = await call('create_draft', { project: m.id, name: 'y', from_draft_id: d });
    expect(JSON.parse(c.r.content[0].text).from).toBe(d);
    const v1 = await call('save_version', { project: m.id, name: 'v', request_id: 's1' });
    const v2 = await call('save_version', { project: m.id, name: 'v', request_id: 's1' });
    expect(JSON.parse(v2.r.content[0].text).version).toBe(JSON.parse(v1.r.content[0].text).version);
    const h = await call('read_command_history', { project: m.id, limit: 3 });
    expect(JSON.parse(h.r.content[0].text)[0].tool).toBe('save_version');
    const neg = await call('build_model', { project: m.id, max_credits: -1 });
    expect(neg.r.isError).toBe(true);
  });
  it('generates procedural image assets', async () => {
    const m = store.create('Img', { 'main.forge.js': 'return box(1,1,1);' });
    const g = await call('generate_image_asset', { project: m.id, prompt: 'walnut wood grain', width: 64, height: 64 });
    expect(g.r.content[0].type).toBe('image');
    expect(g.text).toContain('wood');
  });
});

describe('HTTP API', () => {
  it('quotes, runs, lists items, downloads artifacts and uploads files', async () => {
    const { handleApi } = await import('../mcp/api');
    const srv = createServer((req, res) => handleApi(req, res));
    await new Promise<void>((ok) => srv.listen(0, ok));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/v1`;
    const post = (p: string, body: any) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    try {
      const m = store.create('Http', { 'main.forge.js': 'return box(10,10,10);' });
      expect((await fetch(base + '/capabilities').then((r) => r.json())).outputs.export).toContain('stl');
      expect((await fetch(base + '/openapi.json').then((r) => r.json())).openapi).toBe('3.1.0');
      expect((await post('/output-quotes', { project: m.id, outputs: [{ kind: 'export', format: 'stl' }] })).credits).toBe(0);
      const run = await post('/output-runs', { project: m.id, requestId: 'q1', outputs: [{ kind: 'export', format: 'stl' }, { kind: 'render', view: 'top', width: 64, height: 48 }] });
      expect(run.status).toBe('succeeded');
      expect((await post('/output-runs', { project: m.id, requestId: 'q1', outputs: [{ kind: 'export', format: 'stl' }] })).id).toBe(run.id);
      const items = (await fetch(`${base}/output-runs/${run.id}/items`).then((r) => r.json())).items;
      const dl = await fetch(base.replace('/api/v1', '') + items[1].artifact.download);
      expect(dl.headers.get('content-type')).toBe('image/png');
      const up = await post('/upload-sessions', { project: m.id });
      await fetch(`${base}/upload-sessions/${up.id}/files?path=main.forge.js`, { method: 'PUT', body: 'return box(3,3,3);' });
      const done = await post(`/upload-sessions/${up.id}/complete`, { saveVersion: 'Uploaded' });
      expect(done.version).toBeTruthy();
      expect(store.files(m.id)['main.forge.js']).toContain('box(3,3,3)');
      expect((await post(`/output-runs/${run.id}/cancel`, {})).status).toBe('succeeded');
    } finally { srv.close(); }
  });
});
