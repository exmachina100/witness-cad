// File-based project store for the MCP server and CLI: ~/.witness-cad/projects/<id>/{files/**, meta.json}.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';

export interface DiskVersion { id: string; name: string; note?: string; files: Record<string, string>; createdAt: number; parent?: string }
export interface DiskDraft { id: string; name: string; baseVersion: string; brief?: string; files: Record<string, string>; createdAt: number }
export interface DiskMeta { id: string; name: string; description?: string; entry: string; alias?: string; createdAt: number; updatedAt: number; currentVersion: string; versions: DiskVersion[]; drafts: DiskDraft[]; params?: Record<string, any> }

export const HOME = process.env.WITNESS_HOME ?? join(homedir(), '.witness-cad');
const ROOT = join(HOME, 'projects');
const uid = (p: string) => p + Math.random().toString(36).slice(2, 10);
const safe = (p: string) => { const n = p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..').join('/'); if (!n) throw new Error('invalid path'); return n; };

export function projectDir(id: string) { return join(ROOT, id.replace(/[^\w-]/g, '')); }
export function readMeta(id: string): DiskMeta {
  const f = join(projectDir(id), 'meta.json');
  if (!existsSync(f)) throw new Error(`no project "${id}" (use list_projects)`);
  return JSON.parse(readFileSync(f, 'utf8'));
}
function writeMeta(m: DiskMeta) { m.updatedAt = Date.now(); writeFileSync(join(projectDir(m.id), 'meta.json'), JSON.stringify(m, null, 2)); }

export function readFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (n !== 'node_modules' && !n.startsWith('.')) walk(p); }
      else if (/\.(js|json|md|txt|svg|csv)$/.test(n)) out[relative(dir, p).replace(/\\/g, '/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}
function writeAll(dir: string, files: Record<string, string>) {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(files)) { const p = join(dir, safe(k)); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, v); }
}

export const store = {
  list(): DiskMeta[] {
    if (!existsSync(ROOT)) return [];
    return readdirSync(ROOT).filter((n) => existsSync(join(ROOT, n, 'meta.json'))).map((n) => readMeta(n)).sort((a, b) => b.updatedAt - a.updatedAt);
  },
  create(name: string, files?: Record<string, string>, description?: string): DiskMeta {
    const id = uid('p_');
    const f = files && Object.keys(files).length ? files : { 'main.forge.js': 'return box(50, 30, 10);\n' };
    const v: DiskVersion = { id: uid('v_'), name: 'Start', note: 'Initial project', files: f, createdAt: Date.now() };
    const m: DiskMeta = { id, name, description, entry: f['main.forge.js'] !== undefined ? 'main.forge.js' : Object.keys(f)[0], createdAt: Date.now(), updatedAt: Date.now(), currentVersion: v.id, versions: [v], drafts: [] };
    mkdirSync(projectDir(id), { recursive: true });
    writeAll(join(projectDir(id), 'files'), f);
    writeMeta(m);
    return m;
  },
  /** Working files: a draft's files when draftId is given, else the project's working copy. */
  files(id: string, draftId?: string): Record<string, string> {
    const m = readMeta(id);
    if (draftId) { const d = m.drafts.find((x) => x.id === draftId); if (!d) throw new Error(`no draft "${draftId}"`); return d.files; }
    return readFiles(join(projectDir(id), 'files'));
  },
  write(id: string, path: string, content: string, draftId?: string) {
    const m = readMeta(id);
    path = safe(path);
    if (draftId) { const d = m.drafts.find((x) => x.id === draftId); if (!d) throw new Error(`no draft "${draftId}"`); d.files[path] = content; writeMeta(m); return; }
    const p = join(projectDir(id), 'files', path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    writeMeta(m);
  },
  saveVersion(id: string, name: string, note?: string, draftId?: string): DiskVersion {
    const m = readMeta(id);
    const files = draftId ? store.files(id, draftId) : store.files(id);
    const v: DiskVersion = { id: uid('v_'), name, note, files, createdAt: Date.now(), parent: m.currentVersion };
    m.versions.push(v); m.currentVersion = v.id;
    if (draftId) { m.drafts = m.drafts.filter((d) => d.id !== draftId); writeAll(join(projectDir(id), 'files'), files); }
    writeMeta(m);
    return v;
  },
  createDraft(id: string, name: string, baseVersion?: string, brief?: string): DiskDraft {
    const m = readMeta(id);
    const base = m.versions.find((v) => v.id === (baseVersion ?? m.currentVersion));
    if (!base) throw new Error(`no version "${baseVersion}"`);
    const d: DiskDraft = { id: uid('d_'), name, baseVersion: base.id, brief, files: { ...base.files }, createdAt: Date.now() };
    m.drafts.push(d); writeMeta(m);
    return d;
  },
  setMeta(id: string, patch: Partial<DiskMeta>) { const m = readMeta(id); Object.assign(m, patch); writeMeta(m); return m; },
  versionFiles(id: string, versionId: string) { const v = readMeta(id).versions.find((x) => x.id === versionId); if (!v) throw new Error(`no version "${versionId}"`); return v.files; },
  exportsDir(id: string) { const d = join(projectDir(id), 'exports'); mkdirSync(d, { recursive: true }); return d; },
  byAlias(alias: string) { const m = store.list().find((x) => x.alias === alias); return m ? { files: store.files(m.id), entry: m.entry } : null; },
};
