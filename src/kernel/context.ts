// Per-run collector: everything a script declares besides its return value.
import type { Vec3 } from './math';

export interface ParamDef {
  name: string;
  type: 'number' | 'string' | 'bool' | 'choice' | 'list' | 'path2d' | 'spline2d' | 'placement2d' | 'variant';
  default: any;
  value: any;
  opts: any;
  file?: string;
}
export interface CheckResult { label: string; pass: boolean; message?: string; actual?: any; expected?: any; kind: string }
export interface BomRow { quantity: number; description: string; unit: string; [k: string]: any }
export interface DimRecord { from: Vec3; to: Vec3; value: number; label?: string; color?: string; offset?: number; kind: string; tag?: string }
export interface LabelRecord { text: string; at: Vec3; opts: any }
export interface LogRecord { level: 'log' | 'warn' | 'error' | 'info'; message: string; time: number }

export class RunContext {
  params: ParamDef[] = [];
  paramValues: Record<string, any>;
  checks: CheckResult[] = [];
  bom: BomRow[] = [];
  dims: DimRecord[] = [];
  labels: LabelRecord[] = [];
  highlights: { target: any; opts: any }[] = [];
  logs: LogRecord[] = [];
  scene: any = null;
  cutPlanes: { name: string; normal: Vec3; offset: number; opts: any }[] = [];
  explode: any = null;
  compares: any[] = [];
  manufacturing: Record<string, any> = {};
  mocks = new WeakSet<object>();
  warnings: string[] = [];
  currentFile = 'main.forge.js';
  constructor(paramValues: Record<string, any> = {}) { this.paramValues = paramValues; }
  log(level: LogRecord['level'], ...args: any[]) {
    this.logs.push({ level, message: args.map(fmt).join(' '), time: Date.now() });
  }
}

function fmt(a: any): string {
  if (typeof a === 'string') return a;
  if (a && typeof a.toString === 'function' && a.toString !== Object.prototype.toString) return a.toString();
  try { return JSON.stringify(a); } catch { return String(a); }
}

export const ctxRef: { current: RunContext } = { current: new RunContext() };
export const ctx = () => ctxRef.current;
