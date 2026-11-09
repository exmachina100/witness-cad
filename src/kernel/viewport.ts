// Scene / viewport declarations: scene(), cutPlane(), explodeView(), Viewport.label/highlight, mock().
import { ctx } from './context';
import { toVec3, v3, Vec3 } from './math';

export function scene(options: any = {}) { ctx().scene = { ...(ctx().scene ?? {}), ...options }; }
export function cutPlane(name: string, normal: Vec3, offset: number | any = 0, opts: any = {}) {
  const o = typeof offset === 'object' ? offset : { ...opts, offset };
  ctx().cutPlanes.push({ name, normal: v3.norm(toVec3(normal)), offset: o.offset ?? 0, opts: o });
}
export function explodeView(opts: any = {}) { ctx().explode = { enabled: true, ...opts }; }
export function compareWith(path: string, opts: any = {}) { ctx().compares.push({ path, ...opts }); }
export function mock<T extends object>(shape: T, name?: string): T {
  ctx().mocks.add(shape);
  if (name) (shape as any).__mockName = name;
  return shape;
}
export const Viewport = {
  label: (text: string, at: Vec3, opts: any = {}) => { ctx().labels.push({ text, at: toVec3(at), opts }); },
  highlight: (target: any, opts: any = {}) => { ctx().highlights.push({ target, opts }); },
};
