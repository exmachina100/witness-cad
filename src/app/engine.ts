// Promise wrapper around the evaluation worker. Only one build runs at a time; the newest request wins.
import type { RunResult } from '../kernel/runtime';

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };

class Engine {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => {
      const { id, ok, result, error } = ev.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    };
  }
  call<T = any>(type: string, payload: any = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }
  run(files: Record<string, string>, entry: string, params: Record<string, any>, projects?: Record<string, any>) {
    return this.call<RunResult>('run', { files, entry, params, projects });
  }
  solve(assembly: string, values: Record<string, any>) { return this.call<{ transforms: Record<string, number[]>; values: any; warnings: string[] } | null>('solve', { assembly, values }); }
  export(format: string, opts: any = {}) { return this.call<{ data: Uint8Array; filename: string; mime: string }>('export', { format, opts }); }
  simulate(assembly: string, opts: any = {}) { return this.call('simulate', { assembly, opts }); }
  section(normal: number[], offset: number, mode: 'slice' | 'projection' = 'slice') { return this.call<{ polygons: number[][][]; area: number; bounds: any }>('section', { normal, offset, mode }); }
}

let engine: Engine | null = null;
export function getEngine() { if (!engine) engine = new Engine(); return engine; }

export function download(data: Uint8Array | string | Blob, filename: string, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data as any], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
