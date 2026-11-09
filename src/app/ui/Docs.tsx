// Built-in documentation browser.
import { marked } from 'marked';
import { useMemo, useState } from 'react';
import { PAGES, searchDocs } from '../../docs';
import { Icon, Logo } from './icons';
import { go } from './util';

export function Docs({ pageId }: { pageId: string }) {
  const [q, setQ] = useState('');
  const page = PAGES.find((p) => p.id === pageId) ?? PAGES[0];
  const html = useMemo(() => marked.parse(page.body, { async: false }) as string, [page]);
  const hits = q ? searchDocs(q) : [];
  return (
    <div className="docs">
      <aside className="side">
        <div className="brand" style={{ cursor: 'pointer' }} onClick={() => go('#/')}><Logo /> Witness CAD</div>
        <button className="nav" onClick={() => go('#/')}><Icon name="back" /> Projects</button>
        <input placeholder="Search docs" value={q} onChange={(e) => setQ(e.target.value)} style={{ margin: '8px 4px' }} aria-label="Search docs" />
        {q ? hits.map((h, i) => (
          <button key={i} className="nav" style={{ flexDirection: 'column', alignItems: 'flex-start' }} onClick={() => { setQ(''); go(`#/docs/${h.page}`); }}>
            <b>{PAGES.find((p) => p.id === h.page)?.title}</b><span className="muted" style={{ whiteSpace: 'normal', fontSize: 11 }}>{h.snippet}</span>
          </button>
        )) : PAGES.map((p) => (
          <button key={p.id} className={'nav' + (p.id === page.id ? ' on' : '')} onClick={() => go(`#/docs/${p.id}`)}>{p.title}</button>
        ))}
      </aside>
      <article dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
