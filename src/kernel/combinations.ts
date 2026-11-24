// Combination index over a model's parameters (ForgeCAD semantics). Each bool has 2 values,
// each choice one per option, each number one per step from min to max counted from its
// default. Combination 0 is all defaults; the first declared parameter changes fastest.
// Parameters declared with { combination: false } are held out of the index.
import type { ParamDef } from './context';
import type { RunResult } from './runtime';

export interface Factor { name: string; type: string; count: number; values: any[]; autoStep?: boolean }
export interface CombinationSpace { factors: Factor[]; held: string[]; total: number }

const round = (x: number) => +x.toFixed(10);
export function levelsOf(p: ParamDef): any[] | null {
  if (p.opts?.combination === false) return null;
  if (p.type === 'bool') return [!!p.default, !p.default];
  if (p.type === 'choice') return [p.default, ...p.opts.choices.filter((c: any) => c !== p.default)];
  if (p.type === 'number') {
    const step = Number(p.opts?.step) || 1, lo = p.opts?.min ?? p.default, hi = p.opts?.max ?? p.default, d = Number(p.default);
    const out = [d];
    for (let v = d + step; v <= hi + 1e-9 && out.length < 100000; v += step) out.push(round(v));
    for (let v = d - step; v >= lo - 1e-9 && out.length < 200000; v -= step) out.push(round(v));
    return out;
  }
  return null;
}

export function combinationSpace(params: ParamDef[]): CombinationSpace {
  const factors: Factor[] = [], held: string[] = [];
  for (const p of params) {
    if (p.type === 'variant') continue;
    const lv = levelsOf(p);
    if (!lv) { if (['number', 'bool', 'choice'].includes(p.type)) held.push(p.name); continue; }
    factors.push({ name: p.name, type: p.type, count: lv.length, values: lv, autoStep: !!p.opts?.autoStep });
  }
  return { factors, held, total: factors.reduce((t, f) => t * f.count, 1) };
}

export function combinationValues(space: CombinationSpace, index: number): Record<string, any> {
  if (!(index >= 0 && index < space.total) || !Number.isInteger(index)) throw new Error(`combination ${index} is out of range (0..${space.total - 1})`);
  const out: Record<string, any> = {};
  let r = index;
  for (const f of space.factors) { out[f.name] = f.values[r % f.count]; r = Math.floor(r / f.count); }
  return out;
}
export function combinationIndex(space: CombinationSpace, values: Record<string, any>): number | null {
  let idx = 0, mul = 1;
  for (const f of space.factors) {
    const v = values[f.name];
    const i = v === undefined ? 0 : f.values.findIndex((x) => (typeof x === 'number' ? Math.abs(x - Number(v)) < 1e-9 : x === v));
    if (i < 0) return null;
    idx += i * mul; mul *= f.count;
  }
  return idx;
}

/** "combination 0 of 1,872 = Size 3 × Handle 2 × ... (auto step) · Held: Mode" */
export function describeSpace(space: CombinationSpace, index = 0): string {
  const parts = space.factors.map((f) => `${f.name} ${f.count}${f.autoStep ? ' (auto step)' : ''}`);
  return `combination ${index} of ${space.total.toLocaleString('en-US')}${parts.length ? ` = ${parts.join(' × ')}` : ''}${space.held.length ? ` · Held: ${space.held.map((h) => `${h} (opted out)`).join(', ')}` : ''}`;
}

function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Indices to check: everything up to 100, else a pairwise covering set + the last combination + 20 random ones. */
export function samplePlan(space: CombinationSpace, o: { limit?: number; random?: number; seed?: number } = {}): { indices: number[]; exhaustive: boolean } {
  const limit = o.limit ?? 100;
  if (space.total <= limit) return { indices: Array.from({ length: space.total }, (_, i) => i), exhaustive: true };
  const F = space.factors, set = new Set<number>([0]);
  // greedy pairwise cover over level indices (capped per factor so huge number ranges stay tractable)
  const lv = F.map((f) => (f.count <= 12 ? Array.from({ length: f.count }, (_, i) => i) : [0, 1, f.count - 1, ...Array.from({ length: 9 }, (_, i) => Math.round(((i + 1) * (f.count - 1)) / 10))].filter((v, i, a) => a.indexOf(v) === i)));
  const need = new Set<string>();
  for (let a = 0; a < F.length; a++) for (let b = a + 1; b < F.length; b++) for (const x of lv[a]) for (const y of lv[b]) need.add(`${a}:${x}|${b}:${y}`);
  const toIndex = (row: number[]) => row.reduce((acc, v, i) => acc + v * F.slice(0, i).reduce((m, f) => m * f.count, 1), 0);
  const rand = rng(o.seed ?? 7);
  let guard = 0;
  while (need.size && guard++ < 5000) {
    let best: number[] | null = null, bestN = -1;
    for (let t = 0; t < 30; t++) {
      const row = lv.map((l) => l[Math.floor(rand() * l.length)]);
      // seed the row with one uncovered pair
      const first = need.values().next().value as string;
      const [[a, x], [b, y]] = first.split('|').map((s) => s.split(':').map(Number));
      row[a] = x; row[b] = y;
      let n = 0;
      for (let i = 0; i < F.length; i++) for (let j = i + 1; j < F.length; j++) if (need.has(`${i}:${row[i]}|${j}:${row[j]}`)) n++;
      if (n > bestN) { bestN = n; best = row; }
    }
    for (let i = 0; i < F.length; i++) for (let j = i + 1; j < F.length; j++) need.delete(`${i}:${best![i]}|${j}:${best![j]}`);
    set.add(toIndex(best!));
  }
  set.add(space.total - 1);
  for (let i = 0; i < (o.random ?? 20); i++) set.add(Math.floor(rand() * space.total));
  return { indices: [...set].sort((a, b) => a - b), exhaustive: false };
}

// ---------------------------------------------------------------- reports
export interface CombinationIssue { index: number; values: Record<string, any>; code: string; message: string }
const solidsOf = (r: RunResult) => r.objects.filter((o) => o.kind === 'solid' && !o.mock);
const fingerprint = (r: RunResult) => solidsOf(r).map((o) => `${o.name}:${(o.stats?.volume ?? 0).toFixed(3)}:${o.stats?.bbox.min.map((v) => v.toFixed(3))}:${o.stats?.bbox.max.map((v) => v.toFixed(3))}`).join('|');
const boxesOverlap = (a: any, b: any, eps = 1e-6) => a && b && [0, 1, 2].every((k) => a.min[k] < b.max[k] - eps && b.min[k] < a.max[k] - eps);
function collidingPairs(r: RunResult, overlapVolume?: (a: any, b: any) => number): Set<string> {
  const s = solidsOf(r), out = new Set<string>();
  if (s.length > 60) return out;
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
    if (s[i].transform || s[j].transform) continue; // assembly parts: use check_fit at poses instead
    if (!boxesOverlap(s[i].stats?.bbox, s[j].stats?.bbox)) continue;
    if (!overlapVolume || overlapVolume(s[i], s[j]) > 1e-3) out.add(`${s[i].name} × ${s[j].name}`);
  }
  return out;
}

/** Build the planned combinations and report build failures, failed checks, level-count changes, degenerate parts, new collisions and identical geometry. */
export function checkCombinations(build: (values: Record<string, any>) => RunResult, base: RunResult, o: { indices?: number[]; overlapVolume?: (a: any, b: any) => number } = {}) {
  const space = combinationSpace(base.params);
  const plan = o.indices ? { indices: o.indices, exhaustive: false } : samplePlan(space);
  const issues: CombinationIssue[] = [];
  const baseCount = solidsOf(base).length, baseColl = collidingPairs(base, o.overlapVolume);
  const seen = new Map<string, number>();
  for (const index of plan.indices) {
    const values = combinationValues(space, index);
    const r = index === 0 ? base : build(values);
    const add = (code: string, message: string) => issues.push({ index, values, code, message });
    if (!r.ok) { add('COMBINATION.BUILD_FAILED', r.error?.message ?? 'build failed'); continue; }
    for (const c of r.checks) if (!c.pass) add('COMBINATION.CHECK_FAILED', `${c.label}${c.message ? `: ${c.message}` : ''}`);
    const n = solidsOf(r).length;
    if (n !== baseCount) add('COMBINATION.LEVEL_COUNT', `${n} solid parts here vs ${baseCount} at combination 0; keep part counts fixed and vary offsets or positions`);
    for (const s of solidsOf(r)) if (!s.stats || s.stats.volume < 1e-6) add('COMBINATION.DEGENERATE', `part "${s.name}" has no volume`);
    for (const p of collidingPairs(r, o.overlapVolume)) if (!baseColl.has(p)) add('COMBINATION.NEW_COLLISION', `new collision: ${p}`);
    const fp = fingerprint(r), prev = seen.get(fp);
    if (prev != null && prev !== index) add('COMBINATION.IDENTICAL', `geometry is identical to combination ${prev}; a parameter that changes has no visible effect`);
    else seen.set(fp, index);
  }
  return { space, ...plan, checked: plan.indices.length, issues, pass: issues.length === 0 };
}

/** check variants: declaration problems (unknown parameter, out-of-range value) and builds. */
export function checkVariants(build: (values: Record<string, any>) => RunResult, base: RunResult) {
  const variants = base.params.filter((p) => p.type === 'variant');
  const rows: { name: string; ok: boolean; problems: string[]; failedChecks: string[] }[] = [];
  for (const v of variants) {
    const problems: string[] = [];
    for (const [k, val] of Object.entries<any>(v.default ?? {})) {
      const p = base.params.find((x) => x.name === k && x.type !== 'variant');
      if (!p) { problems.push(`unknown parameter "${k}"`); continue; }
      if (p.type === 'number' && ((p.opts.min != null && val < p.opts.min) || (p.opts.max != null && val > p.opts.max))) problems.push(`${k} = ${val} is outside ${p.opts.min}..${p.opts.max}`);
      if (p.type === 'choice' && !p.opts.choices.includes(val)) problems.push(`${k} = "${val}" is not one of ${p.opts.choices.join(', ')}`);
    }
    const r = build(v.default ?? {});
    if (!r.ok) problems.push(`build failed: ${r.error?.message}`);
    rows.push({ name: v.name, ok: !problems.length && r.ok && r.checks.every((c) => c.pass), problems, failedChecks: r.ok ? r.checks.filter((c) => !c.pass).map((c) => c.label) : [] });
  }
  return { variants: rows, pass: rows.every((r) => r.ok) };
}
/** URL-safe variant key: "Long reach" → "long_reach". */
export const variantKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
