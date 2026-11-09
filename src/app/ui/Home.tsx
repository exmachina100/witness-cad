// Team home: projects, favorites, shared, gallery of examples, trash and appearance.
import { useMemo, useRef, useState } from 'react';
import { useStore, actions, Project } from '../store';
import { EXAMPLES } from '../examples';
import { Icon, Logo } from './icons';
import { ago, go, toast } from './util';

const NAV = [
  ['projects', 'Projects', 'cube'], ['inbox', 'Inbox', 'inbox'], ['shared', 'Shared', 'users'], ['favorites', 'Favorites', 'star'],
  ['gallery', 'Examples', 'grid'], ['trash', 'Trash', 'trash'],
] as const;

export function Home({ section }: { section: string }) {
  const projects = useStore((s) => s.projects);
  const settings = useStore((s) => s.settings);
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const list = useMemo(() => {
    let l = projects.filter((p) => (section === 'trash' ? p.trashed : !p.trashed));
    if (section === 'favorites') l = l.filter((p) => p.favorite);
    if (section === 'shared') l = l.filter((p) => p.published);
    if (section === 'inbox') l = l.filter((p) => p.drafts.length > 0);
    if (q) l = l.filter((p) => (p.name + ' ' + (p.description ?? '')).toLowerCase().includes(q.toLowerCase()));
    const s = settings.sort;
    return [...l].sort((a, b) => (s === 'name' ? a.name.localeCompare(b.name) : s === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt));
  }, [projects, section, q, settings.sort]);

  const open = (p: Project) => go(`#/p/${p.id}`);
  const newProject = () => { const p = actions.createProject('Untitled project'); go(`#/p/${p.id}`); };
  const importFile = async (f: File) => {
    try {
      const text = await f.text();
      if (f.name.endsWith('.json')) { const p = actions.importProject(JSON.parse(text)); go(`#/p/${p.id}`); }
      else { const p = actions.createProject(f.name.replace(/\.forge\.js$|\.js$/, ''), { 'main.forge.js': text }); go(`#/p/${p.id}`); }
    } catch (e: any) { toast(`Import failed: ${e.message}`); }
  };

  const title = NAV.find((n) => n[0] === section)?.[1] ?? 'Projects';
  return (
    <div className="home">
      <aside className="side">
        <div className="brand"><Logo /> Witness CAD</div>
        {NAV.map(([id, label, icon]) => (
          <button key={id} className={'nav' + (section === id ? ' on' : '')} onClick={() => go(`#/${id}`)}><Icon name={icon} /> {label}</button>
        ))}
        <div className="spacer" />
        <button className="nav" onClick={() => go('#/docs/welcome')}><Icon name="docs" /> Docs</button>
        <div className="col" style={{ padding: '8px 10px' }}>
          <h3>Appearance</h3>
          <div className="seg">
            {(['light', 'dark', 'system'] as const).map((t) => (
              <button key={t} className={settings.theme === t ? 'on' : ''} onClick={() => actions.settings({ theme: t })}>{t[0].toUpperCase() + t.slice(1)}</button>
            ))}
          </div>
        </div>
      </aside>
      <main className="home-main">
        <div className="home-head">
          <h1 style={{ fontSize: 20 }}>{title}</h1>
          <div className="spacer" />
          <input placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} aria-label="Search projects" />
          <select value={settings.sort} onChange={(e) => actions.settings({ sort: e.target.value as any })} aria-label="Sort">
            <option value="updated">Last edited</option><option value="created">Created</option><option value="name">Name</option>
          </select>
          <div className="seg">
            <button className={settings.view === 'grid' ? 'on' : ''} onClick={() => actions.settings({ view: 'grid' })} aria-label="Grid view"><Icon name="grid" /></button>
            <button className={settings.view === 'list' ? 'on' : ''} onClick={() => actions.settings({ view: 'list' })} aria-label="List view"><Icon name="list" /></button>
          </div>
          <div style={{ position: 'relative' }}>
            <button className="primary" onClick={() => setMenu(!menu)}><Icon name="plus" /> New project</button>
            {menu && (
              <div className="modal" style={{ position: 'absolute', right: 0, top: 36, width: 260, zIndex: 10, padding: 6, gap: 2 }} onMouseLeave={() => setMenu(false)}>
                <button className="ghost" onClick={newProject}><Icon name="file" /> Blank project</button>
                <button className="ghost" onClick={() => { setMenu(false); fileRef.current?.click(); }}><Icon name="upload" /> Import .forge.js or .json</button>
                <div className="muted" style={{ padding: '6px 10px 2px', fontSize: 11 }}>FROM AN EXAMPLE</div>
                {EXAMPLES.map((ex) => (
                  <button key={ex.id} className="ghost" onClick={() => { const p = actions.createFromExample(ex.id)!; go(`#/p/${p.id}`); }}>{ex.name}</button>
                ))}
              </div>
            )}
            <input ref={fileRef} type="file" accept=".js,.json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          </div>
        </div>

        {section === 'gallery' ? (
          <div className="cards">
            {EXAMPLES.map((ex) => (
              <div key={ex.id} className="card" onClick={() => { const p = actions.createFromExample(ex.id)!; go(`#/p/${p.id}`); }}>
                <div className="thumb"><Icon name="cube" size={40} /></div>
                <div className="body"><b>{ex.name}</b><span className="muted">{ex.description}</span><div className="row">{ex.tags.map((t) => <span key={t} className="chip">{t}</span>)}</div></div>
              </div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="muted" style={{ padding: 40, textAlign: 'center' }}>
            {section === 'trash' ? 'Trash is empty.' : section === 'inbox' ? 'No open drafts waiting for review.' : 'No projects here yet.'}
          </div>
        ) : settings.view === 'grid' ? (
          <div className="cards">
            {list.map((p) => (
              <div key={p.id} className="card" onClick={() => !p.trashed && open(p)}>
                <div className="thumb">{p.thumbnail ? <img src={p.thumbnail} alt="" /> : <Icon name="cube" size={40} />}</div>
                <div className="body">
                  <div className="row"><b className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</b><CardActions p={p} /></div>
                  <span className="muted">Edited {ago(p.updatedAt)} · {p.versions.length} version{p.versions.length === 1 ? '' : 's'}{p.drafts.length ? ` · ${p.drafts.length} draft` : ''}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div>
            {list.map((p) => (
              <div key={p.id} className="list-row" onClick={() => !p.trashed && open(p)}>
                {p.thumbnail ? <img src={p.thumbnail} alt="" /> : <div className="mini" />}
                <b>{p.name}</b>
                <span className="muted">{ago(p.updatedAt)}</span>
                <CardActions p={p} />
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function CardActions({ p }: { p: Project }) {
  const stop = (f: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); f(); };
  if (p.trashed) return (
    <div className="row">
      <button className="ghost" onClick={stop(() => actions.trash(p.id, false))}>Restore</button>
      <button className="ghost" onClick={stop(() => { if (confirm(`Delete "${p.name}" forever?`)) actions.deleteForever(p.id); })}>Delete</button>
    </div>
  );
  return (
    <div className="row" style={{ gap: 0 }}>
      <button className={'ghost' + (p.favorite ? ' active' : '')} title="Favorite" onClick={stop(() => actions.toggleFavorite(p.id))}><Icon name="star" size={14} /></button>
      <button className="ghost" title="Duplicate" onClick={stop(() => { actions.duplicate(p.id); toast('Duplicated'); })}><Icon name="files" size={14} /></button>
      <button className="ghost" title="Move to trash" onClick={stop(() => actions.trash(p.id))}><Icon name="trash" size={14} /></button>
    </div>
  );
}
