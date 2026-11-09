// Local project store: projects, files, versions, drafts and artifacts, persisted to localStorage.
import { useSyncExternalStore } from 'react';
import { EXAMPLES } from './examples';

export interface Version { id: string; name: string; note?: string; files: Record<string, string>; createdAt: number; parent?: string; thumbnail?: string }
export interface Draft { id: string; name: string; baseVersion: string; files: Record<string, string>; createdAt: number; updatedAt: number; brief?: string }
export interface Artifact { id: string; name: string; kind: 'export' | 'render' | 'video' | 'upload'; mime: string; dataUrl?: string; size: number; createdAt: number; versionId?: string }
export interface Project {
  id: string; name: string; description?: string;
  files: Record<string, string>; entry: string; openFiles?: string[];
  versions: Version[]; drafts: Draft[]; activeDraft?: string | null; currentVersion?: string;
  artifacts: Artifact[]; favorite?: boolean; trashed?: boolean; published?: boolean; alias?: string;
  thumbnail?: string; createdAt: number; updatedAt: number; params?: Record<string, any>;
}
export interface Settings { theme: 'dark' | 'light' | 'system'; autoBuild: boolean; apiKey?: string; model: string; view: 'grid' | 'list'; sort: 'updated' | 'name' | 'created' }

const KEY = 'witness-cad:v1';
interface State { projects: Project[]; settings: Settings }

const uid = (p = '') => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const newId = uid;

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* first run */ }
  const now = Date.now();
  const starter = makeProject('My first part', { 'main.forge.js': 'return box(50, 30, 10);\n' });
  starter.createdAt = starter.updatedAt = now;
  return { projects: [starter], settings: { theme: 'dark', autoBuild: true, model: 'claude-opus-5-5', view: 'grid', sort: 'updated' } };
}

let state: State = typeof localStorage !== 'undefined' ? load() : { projects: [], settings: { theme: 'dark', autoBuild: true, model: 'claude-opus-5-5', view: 'grid', sort: 'updated' } };
const listeners = new Set<() => void>();
let saveTimer: any;
function emit() {
  state = { ...state };
  listeners.forEach((l) => l());
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch {
      // storage full: drop artifact payloads and thumbnails of old versions
      for (const p of state.projects) { p.artifacts = p.artifacts.map((a) => ({ ...a, dataUrl: undefined })); p.versions.forEach((v) => (v.thumbnail = undefined)); }
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* give up */ }
    }
  }, 250);
}
export function subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); }
export function getState() { return state; }
export function useStore<T>(sel: (s: State) => T): T { return useSyncExternalStore(subscribe, () => sel(state)); }

export function makeProject(name: string, files: Record<string, string>, entry = 'main.forge.js'): Project {
  const now = Date.now();
  const v: Version = { id: uid('v_'), name: 'Start', note: 'Initial project', files: { ...files }, createdAt: now };
  return { id: uid('p_'), name, files: { ...files }, entry, openFiles: [entry], versions: [v], drafts: [], activeDraft: null, currentVersion: v.id, artifacts: [], createdAt: now, updatedAt: now };
}

function mutate(id: string, fn: (p: Project) => void) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;
  fn(p);
  p.updatedAt = Date.now();
  state.projects = [...state.projects];
  emit();
}

export const actions = {
  createProject(name = 'Untitled project', files?: Record<string, string>) {
    const p = makeProject(name, files ?? { 'main.forge.js': 'return box(50, 30, 10);\n' });
    state.projects = [p, ...state.projects];
    emit();
    return p;
  },
  createFromExample(exampleId: string) {
    const ex = EXAMPLES.find((e) => e.id === exampleId);
    if (!ex) return null;
    const p = makeProject(ex.name, ex.files);
    p.description = ex.description;
    state.projects = [p, ...state.projects];
    emit();
    return p;
  },
  importProject(data: any) {
    const p = makeProject(data.name ?? 'Imported project', data.files ?? {}, data.entry ?? 'main.forge.js');
    p.description = data.description;
    state.projects = [p, ...state.projects];
    emit();
    return p;
  },
  duplicate(id: string) {
    const src = state.projects.find((x) => x.id === id);
    if (!src) return null;
    const p = makeProject(`${src.name} copy`, src.files, src.entry);
    state.projects = [p, ...state.projects];
    emit();
    return p;
  },
  rename(id: string, name: string) { mutate(id, (p) => (p.name = name)); },
  setDescription(id: string, d: string) { mutate(id, (p) => (p.description = d)); },
  setAlias(id: string, alias: string) { mutate(id, (p) => (p.alias = alias)); },
  toggleFavorite(id: string) { mutate(id, (p) => (p.favorite = !p.favorite)); },
  trash(id: string, trashed = true) { mutate(id, (p) => (p.trashed = trashed)); },
  deleteForever(id: string) { state.projects = state.projects.filter((p) => p.id !== id); emit(); },
  setPublished(id: string, v: boolean) { mutate(id, (p) => (p.published = v)); },
  setThumbnail(id: string, t: string) { mutate(id, (p) => (p.thumbnail = t)); },
  setParams(id: string, params: Record<string, any>) { mutate(id, (p) => (p.params = params)); },

  // files (writes go to the active draft when one is open)
  writeFile(id: string, path: string, content: string) {
    mutate(id, (p) => {
      p.files = { ...p.files, [path]: content };
      const d = p.drafts.find((x) => x.id === p.activeDraft);
      if (d) { d.files = { ...p.files }; d.updatedAt = Date.now(); }
    });
  },
  deleteFile(id: string, path: string) {
    mutate(id, (p) => {
      const f = { ...p.files };
      for (const k of Object.keys(f)) if (k === path || k.startsWith(path + '/')) delete f[k];
      p.files = f;
      p.openFiles = (p.openFiles ?? []).filter((x) => x in f);
    });
  },
  renameFile(id: string, from: string, to: string) {
    mutate(id, (p) => {
      const f: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.files)) {
        if (k === from) f[to] = v;
        else if (k.startsWith(from + '/')) f[to + k.slice(from.length)] = v;
        else f[k] = v;
      }
      p.files = f;
      if (p.entry === from) p.entry = to;
      p.openFiles = (p.openFiles ?? []).map((x) => (x === from ? to : x));
    });
  },
  setEntry(id: string, path: string) { mutate(id, (p) => (p.entry = path)); },
  openFile(id: string, path: string) { mutate(id, (p) => { if (!(p.openFiles ?? []).includes(path)) p.openFiles = [...(p.openFiles ?? []), path]; }); },
  closeFile(id: string, path: string) { mutate(id, (p) => (p.openFiles = (p.openFiles ?? []).filter((x) => x !== path))); },

  // versions & drafts
  saveVersion(id: string, name: string, note?: string, thumbnail?: string) {
    let v: Version | undefined;
    mutate(id, (p) => {
      v = { id: uid('v_'), name, note, files: { ...p.files }, createdAt: Date.now(), parent: p.currentVersion, thumbnail };
      p.versions = [...p.versions, v];
      p.currentVersion = v.id;
      if (p.activeDraft) { p.drafts = p.drafts.filter((d) => d.id !== p.activeDraft); p.activeDraft = null; }
    });
    return v;
  },
  restoreVersion(id: string, versionId: string) {
    mutate(id, (p) => {
      const v = p.versions.find((x) => x.id === versionId);
      if (!v) return;
      p.files = { ...v.files };
      p.currentVersion = v.id;
      p.activeDraft = null;
    });
  },
  createDraft(id: string, name: string, baseVersion?: string, brief?: string) {
    let d: Draft | undefined;
    mutate(id, (p) => {
      const base = p.versions.find((x) => x.id === (baseVersion ?? p.currentVersion)) ?? p.versions[p.versions.length - 1];
      d = { id: uid('d_'), name, baseVersion: base.id, files: { ...base.files }, createdAt: Date.now(), updatedAt: Date.now(), brief };
      p.drafts = [...p.drafts, d];
      p.activeDraft = d.id;
      p.files = { ...d.files };
    });
    return d;
  },
  openDraft(id: string, draftId: string | null) {
    mutate(id, (p) => {
      p.activeDraft = draftId;
      const d = p.drafts.find((x) => x.id === draftId);
      if (d) p.files = { ...d.files };
      else { const v = p.versions.find((x) => x.id === p.currentVersion); if (v) p.files = { ...v.files }; }
    });
  },
  discardDraft(id: string, draftId: string) {
    mutate(id, (p) => {
      p.drafts = p.drafts.filter((d) => d.id !== draftId);
      if (p.activeDraft === draftId) { p.activeDraft = null; const v = p.versions.find((x) => x.id === p.currentVersion); if (v) p.files = { ...v.files }; }
    });
  },
  mergeDraft(id: string, draftId: string, name?: string) {
    const p = state.projects.find((x) => x.id === id);
    const d = p?.drafts.find((x) => x.id === draftId);
    if (!p || !d) return;
    p.activeDraft = draftId;
    p.files = { ...d.files };
    return actions.saveVersion(id, name ?? d.name, d.brief);
  },

  addArtifact(id: string, a: Omit<Artifact, 'id' | 'createdAt'>) {
    mutate(id, (p) => { p.artifacts = [{ ...a, id: uid('a_'), createdAt: Date.now(), versionId: p.currentVersion }, ...p.artifacts].slice(0, 60); });
  },
  removeArtifact(id: string, artifactId: string) { mutate(id, (p) => (p.artifacts = p.artifacts.filter((a) => a.id !== artifactId))); },

  settings(patch: Partial<Settings>) { state.settings = { ...state.settings, ...patch }; emit(); },
};
