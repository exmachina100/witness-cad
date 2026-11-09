import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initNode } from '../src/kernel/node';
import { runProject } from '../src/kernel/runtime';
import { renderPng } from '../src/render/raster';
import { EXAMPLES } from '../src/app/examples';

process.env.WITNESS_HOME = mkdtempSync(join(tmpdir(), 'witness-'));
beforeAll(async () => { await initNode(); });

describe('examples and headless tools', () => {
  it('builds every example without errors or failing checks', () => {
    for (const ex of EXAMPLES) {
      const r = runProject({ files: ex.files, entry: 'main.forge.js' }, {});
      expect(r.error?.message, ex.id).toBeUndefined();
      expect(r.checks.filter((c) => !c.pass).map((c) => c.label), ex.id).toEqual([]);
      expect(r.objects.length, ex.id).toBeGreaterThan(0);
    }
  });
  it('renders text with real glyph outlines', () => {
    const r = runProject({ files: { 'main.forge.js': 'return text2d("Hi", { size: 10 }).extrude(1);' } }, {});
    expect(r.ok).toBe(true);
    expect(r.objects[0].stats!.volume).toBeGreaterThan(10);
  });
  it('renders a PNG headlessly', () => {
    const r = runProject({ files: { 'main.forge.js': 'return box(40, 20, 10);' } }, {});
    const png = renderPng(r, { width: 64, height: 48 });
    expect([...png.slice(0, 4)]).toEqual([137, 80, 78, 71]);
  });
  it('stores projects, drafts and versions on disk', async () => {
    const { store } = await import('../mcp/store');
    const m = store.create('Test', { 'main.forge.js': 'return box(1,1,1);' });
    const d = store.createDraft(m.id, 'wider');
    store.write(m.id, 'main.forge.js', 'return box(2,1,1);', d.id);
    expect(store.files(m.id)['main.forge.js']).toContain('box(1,1,1)');
    store.saveVersion(m.id, 'Wider', undefined, d.id);
    expect(store.files(m.id)['main.forge.js']).toContain('box(2,1,1)');
    expect(store.list()[0].versions.length).toBe(2);
  });
});
