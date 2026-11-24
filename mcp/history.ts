// MCP command history and request-id idempotency, stored under ~/.witness-cad.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './store';

const HIST = () => join(HOME, 'history.jsonl');
const IDEM = () => join(HOME, 'requests.json');
const ensure = () => mkdirSync(HOME, { recursive: true });

export function summarizeArgs(a: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(a ?? {})) out[k] = typeof v === 'string' && v.length > 120 ? `${v.slice(0, 117)}…` : typeof v === 'object' && v ? JSON.stringify(v).slice(0, 120) : v;
  return out;
}
export function recordHistory(entry: Record<string, any>) { try { ensure(); appendFileSync(HIST(), JSON.stringify(entry) + '\n'); } catch { /* history is best effort */ } }
export function readHistory(project?: string, limit = 50) {
  if (!existsSync(HIST())) return [];
  const rows = readFileSync(HIST(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return rows.filter((r) => !project || r.project === project).reverse().slice(0, limit);
}
function idem(): Record<string, any> { try { return existsSync(IDEM()) ? JSON.parse(readFileSync(IDEM(), 'utf8')) : {}; } catch { return {}; } }
export function idempotencyGet(tool: string, project: string, id: string) { return idem()[`${tool}:${project}:${id}`]?.result ?? null; }
export function idempotencySet(tool: string, project: string, id: string, result: any) {
  ensure(); const all = idem(); all[`${tool}:${project}:${id}`] = { result, at: Date.now() };
  const keys = Object.keys(all); if (keys.length > 5000) for (const k of keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 5000)) delete all[k];
  writeFileSync(IDEM(), JSON.stringify(all));
}
