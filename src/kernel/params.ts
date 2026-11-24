// Param.* declarations: each returns the live value and registers a UI control.
import { ctx, ParamDef } from './context';
import { ForgeError } from './errors';
import { polygon, spline2d, stroke } from './sketch';
import { Curve } from './curves';
import { Path2DParamValue, Spline2DParamValue, Placement2DParamValue } from './parity';

function declare(type: ParamDef['type'], name: string, def: any, opts: any = {}) {
  if (typeof name !== 'string' || !name) throw new ForgeError('PARAM.NAME', 'parameter name must be a non-empty string');
  const c = ctx();
  const existing = c.params.find((p) => p.name === name);
  const override = c.paramValues[name];
  let value = override !== undefined ? override : def;
  if (type === 'number') {
    value = Number(value);
    if (!Number.isFinite(value)) value = def;
    if (opts.integer) value = Math.round(value);
    if (opts.min != null && value < opts.min) value = opts.min;
    if (opts.max != null && value > opts.max) value = opts.max;
  }
  if (type === 'choice' && !opts.choices.includes(value)) value = def;
  if (type === 'bool') value = !!value;
  if (!existing) c.params.push({ name, type, default: def, value, opts, file: c.currentFile });
  return value;
}

function numberParam(name: string, def: number, opts: any = {}) {
  const o = { ...opts };
  if (o.min == null) o.min = def < 0 ? def * 4 : 0;
  if (o.max == null) o.max = def === 0 ? 100 : Math.abs(def) * 4;
  if (o.step == null) { o.step = o.integer ? 1 : niceStep((o.max - o.min) / 100); o.autoStep = !o.integer; }
  return declare('number', name, def, o) as number;
}
function niceStep(x: number) {
  if (!(x > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  return (m < 2 ? 1 : m < 5 ? 2 : 5) * p;
}

export const Param = {
  number: numberParam,
  string: (name: string, def: string, opts: any = {}) => declare('string', name, def, opts) as string,
  bool: (name: string, def: boolean, opts: any = {}) => declare('bool', name, def, opts) as boolean,
  boolean: (name: string, def: boolean, opts: any = {}) => declare('bool', name, def, opts) as boolean,
  choice: (name: string, def: string, choices: string[], opts: any = {}) => {
    if (!choices.includes(def)) throw new ForgeError('PARAM.CHOICE_DEFAULT', `default "${def}" is not one of the choices`);
    return declare('choice', name, def, { ...opts, choices }) as string;
  },
  list: (name: string, defItems: any[], opts: any = {}) => declare('list', name, defItems, opts) as any[],
  path2d: (name: string, defPoints: any[], opts: any = {}) => new Path2DParamValue(declare('path2d', name, defPoints, opts), opts.closed ?? true),
  spline2d: (name: string, defPoints: any[], opts: any = {}) => new Spline2DParamValue(declare('spline2d', name, defPoints, opts), opts.closed ?? true, opts.degree ?? 3),
  placement2d: (name: string, opts: any = {}) => new Placement2DParamValue(declare('placement2d', name, opts.items ?? [], opts)),
  variant: (name: string, values: Record<string, any>) => {
    declare('variant', name, values, {});
    return { name, values, withStageChoice: (set: string, choice: string) => ({ name, values: { ...values, [set]: choice } }) };
  },
  anchor: {
    sheetOnXY: (pt: any, o: any = {}) => ({ kind: 'anchor', plane: 'XY', point: pt, ...o }),
    sheetOnXZ: (pt: any, o: any = {}) => ({ kind: 'anchor', plane: 'XZ', point: pt, ...o }),
    sheetOnYZ: (pt: any, o: any = {}) => ({ kind: 'anchor', plane: 'YZ', point: pt, ...o }),
    point: (pt: any, o: any = {}) => ({ kind: 'anchor', point: pt, ...o }),
  },
};

export const param = numberParam;
