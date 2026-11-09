// Hash-routed app shell: home (projects), workspace, docs, gallery and shared-link import.
import { useEffect } from 'react';
import { useStore, actions } from './store';
import { useHash, go, decodeShare, useToastHost } from './ui/util';
import { Home } from './ui/Home';
import { Workspace } from './ui/Workspace';
import { Docs } from './ui/Docs';

export function App() {
  const hash = useHash();
  const theme = useStore((s) => s.settings.theme);
  const toastMsg = useToastHost();

  useEffect(() => {
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  // shared links: #/share/<data> imports a copy and opens it
  useEffect(() => {
    if (!hash.startsWith('#/share/')) return;
    try {
      const data = decodeShare(hash.slice(8));
      const p = actions.importProject(data);
      go(`#/p/${p.id}`);
    } catch { go('#/'); }
  }, [hash]);

  const parts = hash.replace(/^#\/?/, '').split('/');
  let page;
  if (parts[0] === 'p' && parts[1]) page = <Workspace key={parts[1]} projectId={parts[1]} />;
  else if (parts[0] === 'docs') page = <Docs pageId={parts[1] || 'welcome'} />;
  else page = <Home section={parts[0] || 'projects'} />;
  return (
    <>
      {page}
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </>
  );
}
