// Witness CAD HTTP API (/api/v1), served next to /mcp by `npm run mcp -- --http <port>`.
// Local runs cost no credits; quotes and runs report credits as 0. Set WITNESS_API_KEY to require
// "Authorization: Bearer <key>".
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { store, readMeta } from './store';
import { initNode, ensureStepReaderNode } from '../src/kernel/node';
import { projectNeedsStep } from '../src/kernel/importers';
import { runProject, RunResult } from '../src/kernel/runtime';
import { exportModel, EXPORT_FORMATS } from '../src/export';
import { renderPng } from '../src/render/raster';
import { renderTurntableGif } from '../src/render/video';

type OutputSpec = { kind: 'export'; format: string } | { kind: 'render'; view?: string; width?: number; height?: number } | { kind: 'video'; frames?: number; width?: number; height?: number };
interface Artifact { id: string; runId: string; kind: string; filename: string; mime: string; bytes: number; path: string }
interface Run { id: string; project: string; draft?: string; params?: Record<string, any>; outputs: OutputSpec[]; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'; items: { index: number; output: OutputSpec; status: string; artifact?: string; error?: string }[]; creditsUsed: 0; createdAt: string; finishedAt?: string; error?: string; requestId?: string }
const runs = new Map<string, Run>(), artifacts = new Map<string, Artifact>(), uploads = new Map<string, { id: string; project: string; draft?: string; files: string[]; status: 'open' | 'complete'; createdAt: string }>();
const byRequest = new Map<string, string>();
const id = (p: string) => `${p}_${Math.random().toString(36).slice(2, 12)}`;

const CAPABILITIES = {
  api: 'witness-cad', version: 'v1', credits: { model: 'local', perOutput: 0 },
  outputs: { export: Object.keys(EXPORT_FORMATS), render: ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom', '<scene view name>'], video: ['turntable'] },
  limits: { maxOutputsPerRun: 50, maxUploadBytes: 50 * 1024 * 1024 },
};

const OPENAPI = {
  openapi: '3.1.0', info: { title: 'Witness CAD API', version: '1.0.0', description: 'Build, render and export Witness CAD projects over HTTP. Local runs cost 0 credits.' },
  paths: {
    '/api/v1/capabilities': { get: { summary: 'Supported outputs, formats and limits' } },
    '/api/v1/openapi.json': { get: { summary: 'This document' } },
    '/api/v1/output-quotes': { post: { summary: 'Quote a set of outputs (credits and estimated seconds)', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/OutputRequest' } } } } } },
    '/api/v1/output-runs': { post: { summary: 'Start an output run (idempotent with requestId)' }, get: { summary: 'List runs' } },
    '/api/v1/output-runs/{id}': { get: { summary: 'Run status' } },
    '/api/v1/output-runs/{id}/items': { get: { summary: 'Per-output items with artifact ids' } },
    '/api/v1/output-runs/{id}/cancel': { post: { summary: 'Cancel a queued or running run' } },
    '/api/v1/artifacts/{id}': { get: { summary: 'Artifact metadata' } },
    '/api/v1/artifacts/{id}/download': { get: { summary: 'Download artifact bytes' } },
    '/api/v1/capture-quotes': { post: { summary: 'Quote a still capture' } },
    '/api/v1/video-quotes': { post: { summary: 'Quote a turntable video' } },
    '/api/v1/upload-sessions': { post: { summary: 'Open an upload session for a project (or draft)' } },
    '/api/v1/upload-sessions/{id}/files': { put: { summary: 'Upload one file: ?path=main.forge.js, raw body' } },
    '/api/v1/upload-sessions/{id}/complete': { post: { summary: 'Close the session (optionally save a version)' } },
  },
  components: { schemas: { OutputRequest: { type: 'object', required: ['project', 'outputs'], properties: { project: { type: 'string' }, draft: { type: 'string' }, params: { type: 'object' }, requestId: { type: 'string' }, maxCredits: { type: 'number' }, outputs: { type: 'array', items: { type: 'object', properties: { kind: { enum: ['export', 'render', 'video'] }, format: { type: 'string' }, view: { type: 'string' } } } } } } } },
};

const send = (res: ServerResponse, code: number, body: any) => { res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body, null, 2)); };
const readBody = (req: IncomingMessage) => new Promise<Buffer>((ok, bad) => { const c: Buffer[] = []; let n = 0; req.on('data', (d: Buffer) => { n += d.length; if (n > CAPABILITIES.limits.maxUploadBytes) { bad(new Error('body too large')); req.destroy(); } else c.push(d); }); req.on('end', () => ok(Buffer.concat(c))); req.on('error', bad); });
const json = async (req: IncomingMessage) => { const b = await readBody(req); return b.length ? JSON.parse(b.toString('utf8')) : {}; };

function estimate(outputs: OutputSpec[]) {
  const secs = outputs.reduce((s, o) => s + (o.kind === 'video' ? 8 : o.kind === 'render' ? 1 : o.kind === 'export' && ['step', 'package', 'guide'].includes((o as any).format) ? 4 : 1), 0);
  return { credits: 0, estimatedSeconds: secs, outputs: outputs.length };
}
function validate(outputs: any): OutputSpec[] {
  if (!Array.isArray(outputs) || !outputs.length) throw new Error('outputs must be a non-empty array');
  if (outputs.length > CAPABILITIES.limits.maxOutputsPerRun) throw new Error(`at most ${CAPABILITIES.limits.maxOutputsPerRun} outputs per run`);
  for (const o of outputs) {
    if (o.kind === 'export' && !(o.format in EXPORT_FORMATS)) throw new Error(`unknown export format "${o.format}"`);
    if (!['export', 'render', 'video'].includes(o.kind)) throw new Error(`unknown output kind "${o.kind}"`);
  }
  return outputs;
}
async function buildFor(project: string, draft?: string, params?: Record<string, any>): Promise<RunResult> {
  await initNode();
  const m = readMeta(project), files = store.files(project, draft);
  if (projectNeedsStep(files)) await ensureStepReaderNode();
  return runProject({ files, entry: m.entry }, { ...(m.params ?? {}), ...(params ?? {}) });
}
async function execute(run: Run) {
  run.status = 'running';
  try {
    const r = await buildFor(run.project, run.draft, run.params);
    if (!r.ok) throw new Error(r.error?.message ?? 'build failed');
    const name = readMeta(run.project).name.replace(/[^\w.-]+/g, '_');
    for (const item of run.items) {
      if ((run.status as string) === 'canceled') { item.status = 'canceled'; continue; }
      try {
        const o = item.output; let data: Uint8Array, filename: string, mime: string;
        if (o.kind === 'export') { const e = exportModel(r, o.format as any, { name }); data = typeof e.data === 'string' ? Buffer.from(e.data) : e.data; filename = e.filename; mime = e.mime; }
        else if (o.kind === 'render') { data = renderPng(r, { view: o.view ?? 'iso', width: Math.min(o.width ?? 1200, 2400), height: Math.min(o.height ?? 800, 1600) }); filename = `${name}-${o.view ?? 'iso'}.png`; mime = 'image/png'; }
        else { const cap = (r.scene as any)?.capture; data = renderTurntableGif(r, { frames: o.frames ?? cap?.framesPerTurn, width: Math.min(o.width ?? cap?.size?.[0] ?? 480, 960), height: Math.min(o.height ?? cap?.size?.[1] ?? 360, 720), elevation: cap?.pitchDeg, fps: cap?.fps }); filename = `${name}-turntable.gif`; mime = 'image/gif'; }
        const aid = id('art'), path = join(store.exportsDir(run.project), `${aid}-${filename}`);
        writeFileSync(path, data);
        artifacts.set(aid, { id: aid, runId: run.id, kind: o.kind, filename, mime, bytes: data.length, path });
        item.status = 'succeeded'; item.artifact = aid;
      } catch (e: any) { item.status = 'failed'; item.error = e.message; }
    }
    if ((run.status as string) !== 'canceled') run.status = run.items.every((i) => i.status === 'succeeded') ? 'succeeded' : 'failed';
  } catch (e: any) { run.status = 'failed'; run.error = e.message; for (const i of run.items) if (i.status === 'queued') { i.status = 'failed'; i.error = e.message; } }
  run.finishedAt = new Date().toISOString();
}

export async function handleApi(req: IncomingMessage, res: ServerResponse) {
  try {
    const key = process.env.WITNESS_API_KEY;
    if (key && req.headers.authorization !== `Bearer ${key}`) return send(res, 401, { error: 'unauthorized' });
    const url = new URL(req.url ?? '/', 'http://local');
    const p = url.pathname.replace(/\/+$/, '').split('/').slice(3); // after /api/v1
    const M = req.method ?? 'GET';
    if (M === 'GET' && p[0] === 'capabilities') return send(res, 200, CAPABILITIES);
    if (M === 'GET' && p[0] === 'openapi.json') return send(res, 200, OPENAPI);
    if (M === 'POST' && p[0] === 'output-quotes') { const b = await json(req); readMeta(b.project); return send(res, 200, estimate(validate(b.outputs))); }
    if (M === 'POST' && p[0] === 'capture-quotes') { const b = await json(req); return send(res, 200, estimate([{ kind: 'render', view: b.view } as OutputSpec].concat(Array(Math.max(0, (b.count ?? 1) - 1)).fill({ kind: 'render' })))); }
    if (M === 'POST' && p[0] === 'video-quotes') { const b = await json(req); return send(res, 200, { ...estimate([{ kind: 'video', frames: b.frames }]), frames: b.frames ?? 36 }); }
    if (p[0] === 'output-runs') {
      if (M === 'GET' && !p[1]) return send(res, 200, { runs: [...runs.values()].reverse().slice(0, 100) });
      if (M === 'POST' && !p[1]) {
        const b = await json(req);
        if (b.requestId && byRequest.has(b.requestId)) return send(res, 200, { ...runs.get(byRequest.get(b.requestId)!), replayed: true });
        readMeta(b.project);
        const outputs = validate(b.outputs);
        if (b.maxCredits != null && b.maxCredits < 0) return send(res, 400, { error: 'maxCredits must be >= 0' });
        const run: Run = { id: id('run'), project: b.project, draft: b.draft, params: b.params, outputs, status: 'queued', items: outputs.map((o, i) => ({ index: i, output: o, status: 'queued' })), creditsUsed: 0, createdAt: new Date().toISOString(), requestId: b.requestId };
        runs.set(run.id, run); if (b.requestId) byRequest.set(b.requestId, run.id);
        const timeout = b.maxDurationSeconds ? new Promise<void>((ok) => setTimeout(() => { if (run.status === 'running' || run.status === 'queued') { run.status = 'failed'; run.error = `stopped after maxDurationSeconds=${b.maxDurationSeconds}`; } ok(); }, b.maxDurationSeconds * 1000)) : null;
        const job = execute(run);
        if (b.wait !== false) await (timeout ? Promise.race([job, timeout]) : job);
        return send(res, 201, run);
      }
      const run = runs.get(p[1]);
      if (!run) return send(res, 404, { error: `no run "${p[1]}"` });
      if (M === 'GET' && !p[2]) return send(res, 200, run);
      if (M === 'GET' && p[2] === 'items') return send(res, 200, { items: run.items.map((i) => ({ ...i, artifact: i.artifact ? artifacts.get(i.artifact) && { ...artifacts.get(i.artifact), path: undefined, download: `/api/v1/artifacts/${i.artifact}/download` } : undefined })) });
      if (M === 'POST' && p[2] === 'cancel') { if (run.status === 'queued' || run.status === 'running') run.status = 'canceled'; return send(res, 200, run); }
    }
    if (p[0] === 'artifacts' && p[1]) {
      const a = artifacts.get(p[1]);
      if (!a || !existsSync(a.path)) return send(res, 404, { error: `no artifact "${p[1]}"` });
      if (p[2] === 'download') { res.writeHead(200, { 'content-type': a.mime, 'content-disposition': `attachment; filename="${a.filename}"`, 'content-length': a.bytes }).end(readFileSync(a.path)); return; }
      return send(res, 200, { ...a, path: undefined, download: `/api/v1/artifacts/${a.id}/download` });
    }
    if (p[0] === 'upload-sessions') {
      if (M === 'POST' && !p[1]) { const b = await json(req); readMeta(b.project); const u = { id: id('up'), project: b.project, draft: b.draft, files: [] as string[], status: 'open' as const, createdAt: new Date().toISOString() }; uploads.set(u.id, u); return send(res, 201, { ...u, put: `/api/v1/upload-sessions/${u.id}/files?path=<file>` }); }
      const u = uploads.get(p[1]);
      if (!u) return send(res, 404, { error: `no upload session "${p[1]}"` });
      if (M === 'PUT' && p[2] === 'files') {
        if (u.status !== 'open') return send(res, 409, { error: 'session is complete' });
        const path = url.searchParams.get('path'); if (!path) return send(res, 400, { error: 'missing ?path=' });
        const body = await readBody(req);
        const binary = /\.(stl|3mf)$/i.test(path) && !(path.toLowerCase().endsWith('.stl') && body.subarray(0, 5).toString('latin1') === 'solid');
        store.write(u.project, path, binary ? `data:application/octet-stream;base64,${body.toString('base64')}` : body.toString('utf8'), u.draft);
        u.files.push(path); return send(res, 200, { ok: true, path, bytes: body.length });
      }
      if (M === 'POST' && p[2] === 'complete') { const b = await json(req).catch(() => ({})); u.status = 'complete'; const v = b.saveVersion ? store.saveVersion(u.project, b.saveVersion, b.note, u.draft) : null; return send(res, 200, { ...u, version: v?.id }); }
      if (M === 'GET' && !p[2]) return send(res, 200, u);
    }
    return send(res, 404, { error: `no route ${M} ${url.pathname}`, see: '/api/v1/openapi.json' });
  } catch (e: any) { return send(res, 400, { error: e?.message ?? String(e) }); }
}
