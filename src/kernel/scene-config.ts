// scene() normalisation (ForgeCAD SceneOptions): camera, named views, guided journeys,
// lights, environment presets, fog, ground and capture settings. Renderer-only keys
// (jointOverlay, postProcessing) are kept and listed as inactive.
import type { SceneObject } from './runtime';

export type Vec3 = [number, number, number];
export interface SceneCamera { position?: Vec3 | string; target?: Vec3; up?: Vec3; fov?: number; type?: 'perspective' | 'orthographic'; distance?: number }
export interface SceneView { name: string; title?: string; camera: SceneCamera }
export interface JourneyStep { id: string; title?: string; caption?: string; focus?: string | string[]; camera?: SceneCamera; resolvedFocusId?: string; resolvedFocusPath?: string[] }
export interface Journey { name: string; title: string; startsAt: number; behavior: 'opt-in' | 'auto'; steps: JourneyStep[]; valid: boolean; problems: string[] }
export interface NormalizedScene {
  background?: string | { top: string; bottom: string }; camera?: SceneCamera; views: Record<string, SceneView>; journeys: Record<string, Journey>;
  lights?: any[]; environment?: { preset?: string; intensity: number; background: boolean; sky: string; ground: string; backgroundGradient?: { top: string; bottom: string }; floor?: any };
  fog?: any; ground?: { visible: boolean; color: string; offset: number; receiveShadow: boolean }; capture: { framesPerTurn: number; holdFrames: number; pitchDeg: number; fps: number; size: [number, number]; background?: any };
  jointOverlay?: any; postProcessing?: any; inactive: string[];
}

/** Environment presets: sky / ground light tints and a matching background gradient. */
export const ENVIRONMENT_PRESETS: Record<string, { sky: string; ground: string; top: string; bottom: string; intensity: number }> = {
  studio: { sky: '#ffffff', ground: '#8a8f99', top: '#f4f5f7', bottom: '#c9ccd2', intensity: 1 },
  sunset: { sky: '#ffd2a1', ground: '#5b3a5e', top: '#ff9e6b', bottom: '#3c2a4d', intensity: 0.9 },
  dawn: { sky: '#cfe3ff', ground: '#8a7a8c', top: '#a9c8f2', bottom: '#f3d6c6', intensity: 0.85 },
  warehouse: { sky: '#fff4e0', ground: '#4a4a48', top: '#9a958c', bottom: '#4b4a47', intensity: 0.9 },
  forest: { sky: '#d8f0d0', ground: '#2f4a2a', top: '#9cc29a', bottom: '#2f3f2c', intensity: 0.8 },
  apartment: { sky: '#fff0dc', ground: '#7a6a5a', top: '#efe4d6', bottom: '#a89584', intensity: 0.9 },
  city: { sky: '#dfe8f2', ground: '#55595f', top: '#b8c6d6', bottom: '#5a6068', intensity: 0.9 },
  park: { sky: '#e6f4ff', ground: '#4e6a3a', top: '#bfe0ff', bottom: '#7fa65c', intensity: 0.95 },
  lobby: { sky: '#fff8ee', ground: '#6e6660', top: '#ece6dc', bottom: '#9b928a', intensity: 0.9 },
  night: { sky: '#3a4a7a', ground: '#0c0f18', top: '#141a2e', bottom: '#05070c', intensity: 0.5 },
};

const vec = (v: any): Vec3 | undefined => (Array.isArray(v) && v.length >= 3 ? [Number(v[0]), Number(v[1]), Number(v[2])] : undefined);
function cam(c: any): SceneCamera | undefined {
  if (!c) return undefined;
  return { position: typeof c.position === 'string' ? c.position : vec(c.position), target: vec(c.target), up: vec(c.up), fov: c.fov, type: c.type, distance: c.distance };
}

/** "front-right", "top", "iso", "back-left-top" → view direction (Z up, front looks from -Y). */
export function directionFromName(s: string): Vec3 | null {
  const words = s.toLowerCase().split(/[-_\s]+/).filter(Boolean);
  if (words.length === 1 && words[0] === 'iso') return [1, -1.2, 0.9];
  const d: Vec3 = [0, 0, 0];
  for (const w of words) {
    if (w === 'front') d[1] -= 1; else if (w === 'back' || w === 'rear') d[1] += 1;
    else if (w === 'right') d[0] += 1; else if (w === 'left') d[0] -= 1;
    else if (w === 'top') d[2] += 1; else if (w === 'bottom') d[2] -= 1;
    else return null;
  }
  return d[0] || d[1] || d[2] ? d : null;
}

function resolveFocus(focus: any, objects: SceneObject[]): string[] {
  const names = (Array.isArray(focus) ? focus : [focus]).filter(Boolean).map(String);
  const out: string[] = [];
  for (const n of names) for (const o of objects) {
    if (o.name === n || o.part === n || o.name.split('/').pop() === n || o.name.startsWith(`${n}/`)) out.push(o.name);
  }
  return [...new Set(out)];
}

export function normalizeScene(sc: any, objects: SceneObject[], warnings: string[]): NormalizedScene | null {
  if (!sc) return null;
  const views: Record<string, SceneView> = {};
  for (const [name, v] of Object.entries<any>(sc.views ?? {})) {
    const c = cam(v?.camera ?? v);
    if (!c?.position) { warnings.push(`scene view "${name}" needs a camera position`); continue; }
    views[name] = { name, title: v?.title, camera: c };
  }
  const journeys: Record<string, Journey> = {};
  for (const [name, j] of Object.entries<any>(sc.journeys ?? {})) {
    const problems: string[] = [];
    const steps: JourneyStep[] = (Array.isArray(j?.steps) ? j.steps : []).map((s: any, i: number) => {
      const step: JourneyStep = { id: String(s?.id ?? `step${i + 1}`), title: s?.title, caption: s?.caption, focus: s?.focus, camera: typeof s?.camera === 'string' ? views[s.camera]?.camera : cam(s?.camera) };
      if (typeof s?.camera === 'string' && !views[s.camera]) problems.push(`step "${step.id}" names unknown view "${s.camera}"`);
      if (s?.focus != null) {
        const p = resolveFocus(s.focus, objects);
        if (!p.length) problems.push(`step "${step.id}" focuses on "${s.focus}", which is not in the model`);
        step.resolvedFocusPath = p; step.resolvedFocusId = objects.find((o) => o.name === p[0])?.id;
      }
      return step;
    });
    const ids = new Set<string>();
    for (const s of steps) { if (ids.has(s.id)) problems.push(`duplicate step id "${s.id}"`); ids.add(s.id); }
    if (!steps.length) problems.push('a journey needs at least one step');
    const startsAt = typeof j?.startsAt === 'string' ? Math.max(0, steps.findIndex((s) => s.id === j.startsAt)) : Math.max(0, Math.min(steps.length - 1, Number(j?.startsAt ?? 0)));
    for (const p of problems) warnings.push(`scene journey "${name}": ${p}`);
    journeys[name] = { name, title: j?.title ?? name, startsAt, behavior: j?.behavior === 'auto' ? 'auto' : 'opt-in', steps, valid: j?.valid !== false && !problems.length, problems };
  }
  let environment: NormalizedScene['environment'];
  if (sc.environment) {
    const e = typeof sc.environment === 'string' ? { preset: sc.environment } : sc.environment;
    const p = ENVIRONMENT_PRESETS[e.preset ?? 'studio'];
    if (e.preset && !p) warnings.push(`unknown environment preset "${e.preset}" (${Object.keys(ENVIRONMENT_PRESETS).join(', ')})`);
    const q = p ?? ENVIRONMENT_PRESETS.studio;
    environment = { preset: e.preset, intensity: e.intensity ?? q.intensity, background: e.background !== false, sky: q.sky, ground: q.ground, backgroundGradient: { top: q.top, bottom: q.bottom }, floor: e.floor };
    if (e.panorama) warnings.push('scene environment panorama images are not loaded; the preset lighting is used');
  }
  const g = sc.ground;
  const ground = g ? { visible: g.visible !== false, color: g.color ?? '#9aa0a8', offset: g.offset ?? 0, receiveShadow: g.receiveShadow !== false } : undefined;
  const cp = sc.capture ?? {};
  const size = Array.isArray(cp.size) ? cp.size : typeof cp.size === 'string' ? cp.size.split('x').map(Number) : [480, 360];
  const capture = { framesPerTurn: cp.framesPerTurn ?? 36, holdFrames: cp.holdFrames ?? 0, pitchDeg: cp.pitchDeg ?? 25, fps: cp.fps ?? 15, size: [size[0], size[1]] as [number, number], background: cp.background };
  const inactive = ['postProcessing', 'jointOverlay'].filter((k) => sc[k] != null);
  return {
    background: sc.background ?? (environment?.background ? environment.backgroundGradient : undefined), camera: cam(sc.camera), views, journeys, lights: sc.lights, environment,
    fog: sc.fog, ground, capture, jointOverlay: sc.jointOverlay, postProcessing: sc.postProcessing, inactive,
  };
}
