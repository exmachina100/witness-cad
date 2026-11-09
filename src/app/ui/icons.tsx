// Small stroke icons drawn for Witness CAD.
const P: Record<string, string> = {
  files: 'M4 4h6l2 2h8v13H4z',
  agent: 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z',
  params: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4',
  views: 'M3 6l9-3 9 3-9 3zM3 6v12l9 3 9-3V6M12 9v12',
  make: 'M4 20h16M6 20V10l6-5 6 5v10M10 20v-5h4v5',
  artifacts: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
  inspect: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l5 5',
  plus: 'M12 5v14M5 12h14',
  folder: 'M3 6h6l2 2h10v11H3z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  back: 'M15 5l-7 7 7 7',
  play: 'M7 5l12 7-12 7z',
  pause: 'M7 5h3v14H7zM14 5h3v14h-3z',
  camera: 'M4 8h4l2-3h4l2 3h4v11H4zM12 11a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  video: 'M3 7h12v10H3zM15 10l6-3v10l-6-3z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  share: 'M16 6a2 2 0 1 0 0-.1M6 12a2 2 0 1 0 0-.1M16 18a2 2 0 1 0 0-.1M8 11l6-4M8 13l6 4',
  help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6M12 17h.01',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  test: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1 2h6l1-2h5',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  list: 'M4 6h16M4 12h16M4 18h16',
  docs: 'M5 4h10l4 4v12H5zM9 12h6M9 16h6',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  users: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3 3-5 6-5s6 2 6 5M17 11a3 3 0 1 0 0-6M21 20c0-2.5-1.5-4.3-4-4.8',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l5 5',
  code: 'M9 7l-5 5 5 5M15 7l5 5-5 5',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12l2-1-1-3-2 .5-1.5-1.5.5-2-3-1-1 2h-2l-1-2-3 1 .5 2L6 9.5 4 9l-1 3 2 1v2l-2 1 1 3 2-.5 1.5 1.5-.5 2 3 1 1-2h2l1 2 3-1-.5-2 1.5-1.5 2 .5 1-3-2-1z',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-.1M6 21a3 3 0 1 0 0-.1M18 9c0 6-12 3-12 9',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
};
export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] ?? P.cube} />
    </svg>
  );
}
export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--accent)" />
      <path d="M7 10l4 13 5-9 5 9 4-13" fill="none" stroke="#062421" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
