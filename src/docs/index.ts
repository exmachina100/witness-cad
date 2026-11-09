import { PAGES } from './pages';
export { PAGES };
export const DOCS_INDEX = PAGES.map(({ id, title }) => ({ id, title }));
export function readDoc(id: string): string | null { return PAGES.find((p) => p.id === id)?.body ?? null; }
export function searchDocs(q: string) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: { page: string; snippet: string; score: number }[] = [];
  for (const p of PAGES) for (const line of p.body.split('\n')) {
    const l = line.toLowerCase();
    const score = terms.reduce((s, t) => s + (l.includes(t) ? 1 : 0), 0);
    if (score) hits.push({ page: p.id, snippet: line.trim().slice(0, 240), score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 20);
}
