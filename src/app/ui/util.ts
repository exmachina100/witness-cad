import { strToU8, strFromU8, zlibSync, unzlibSync } from 'fflate';
import { useEffect, useState } from 'react';

export function useHash() {
  const [h, setH] = useState(location.hash || '#/');
  useEffect(() => { const f = () => setH(location.hash || '#/'); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
}
export const go = (h: string) => { location.hash = h; };

export function encodeShare(data: any): string {
  const z = zlibSync(strToU8(JSON.stringify(data)), { level: 9 });
  let s = ''; for (const b of z) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeShare(s: string): any {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return JSON.parse(strFromU8(unzlibSync(u)));
}
export function ago(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}
export function fmtBytes(n: number) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
export function blobToDataUrl(b: Blob): Promise<string> { return new Promise((r) => { const f = new FileReader(); f.onload = () => r(String(f.result)); f.readAsDataURL(b); }); }

let toastFn: ((s: string) => void) | null = null;
export function toast(s: string) { toastFn?.(s); }
export function useToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { let t: any; toastFn = (s) => { setMsg(s); clearTimeout(t); t = setTimeout(() => setMsg(null), 2600); }; return () => { toastFn = null; }; }, []);
  return msg;
}
