// The 3D viewport: Three.js scene for solids, sketches, assemblies, labels, measurements and inspect modes.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { RunResult, SceneObject } from '../../kernel/runtime';

export type InspectMode = 'shaded' | 'xray' | 'wireframe' | 'normals' | 'zebra' | 'mask' | 'colliders' | 'distance' | 'interference' | 'thickness' | 'process' | 'stress';
export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

export interface ViewportOptions {
  edges: boolean;
  ortho: boolean;
  mode: InspectMode;
  explode: number;
  cut: { enabled: boolean; axis: 'x' | 'y' | 'z'; offset: number; flip: boolean };
  grid: boolean;
  hidden: Set<string>;
  interference?: { a: string; b: string }[];
  dark: boolean;
  /** Strength results drawn in 'stress' mode: world-space mesh with per-vertex von Mises (MPa) and displacement (mm). */
  fea?: FeaDisplay | null;
}

export interface FeaDisplay { positions: Float32Array; indices: Uint32Array; vonMises: Float32Array; displacement: Float32Array; range: [number, number]; scale: number }

/** Blue to red colour ramp used for stress plots (t in 0..1). */
export function stressColor(t: number, out = new THREE.Color()): THREE.Color {
  const x = Math.min(1, Math.max(0, t));
  const stops: [number, number, number][] = [[0.13, 0.27, 0.86], [0.1, 0.72, 0.95], [0.2, 0.85, 0.35], [0.98, 0.85, 0.15], [0.93, 0.2, 0.13]];
  const f = x * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), u = f - i;
  return out.setRGB(stops[i][0] + (stops[i + 1][0] - stops[i][0]) * u, stops[i][1] + (stops[i + 1][1] - stops[i][1]) * u, stops[i][2] + (stops[i + 1][2] - stops[i][2]) * u, THREE.SRGBColorSpace);
}

export interface Selection { name: string; object?: SceneObject; point: [number, number, number]; normal: [number, number, number] }

export interface ViewportHandle {
  screenshot(width?: number, height?: number): string;
  recordTurntable(seconds?: number): Promise<Blob>;
  setView(v: ViewName): void;
  fit(): void;
  clearMeasure(): void;
}

interface Props {
  result: RunResult | null;
  transforms: Record<string, number[]>;
  options: ViewportOptions;
  onSelect?: (s: Selection | null) => void;
  onMeasure?: (d: number | null) => void;
  selected?: string | null;
}

const VIEW_DIRS: Record<ViewName, [number, number, number]> = {
  front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 0, 1], bottom: [0, 0, -1], iso: [1, -1.2, 0.9],
};

function zebraMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { stripes: { value: 18 } },
    vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform float stripes; varying vec3 vN; varying vec3 vV; void main(){ vec3 r = reflect(-vV, normalize(vN)); float s = step(0.5, fract(r.y*stripes*0.5)); gl_FragColor = vec4(vec3(s*0.9+0.05),1.0); }`,
  });
}

export const Viewport = forwardRef<ViewportHandle, Props>(function Viewport({ result, transforms, options, onSelect, onMeasure, selected }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const three = useRef<any>({});
  const [hover, setHover] = useState<string | null>(null);

  // ---------------------------------------------------------------- setup once
  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.localClippingEnabled = true;
    renderer.shadowMap.enabled = true;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const persp = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
    const orthoCam = new THREE.OrthographicCamera(-100, 100, 100, -100, -100000, 100000);
    for (const c of [persp, orthoCam]) { c.up.set(0, 0, 1); c.position.set(160, -200, 140); }
    const controls = new OrbitControls(persp, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 1.4);
    hemi.position.set(0, 0, 1);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(200, -300, 500);
    key.castShadow = true;
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-300, 200, 200);
    const defaultLights = new THREE.Group();
    defaultLights.add(hemi, key, fill);
    scene.add(defaultLights);
    const grid = new THREE.GridHelper(1000, 100, 0x556070, 0x2a3038);
    grid.rotation.x = Math.PI / 2;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    scene.add(grid);
    const axes = new THREE.AxesHelper(30);
    scene.add(axes);
    const root = new THREE.Group();
    scene.add(root);
    const measureGroup = new THREE.Group();
    scene.add(measureGroup);

    // axis gizmo renderer (corner)
    const gizmoScene = new THREE.Scene();
    const gizmoCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
    gizmoCam.up.set(0, 0, 1);
    const g = new THREE.AxesHelper(1.2);
    gizmoScene.add(g);

    const state = three.current;
    Object.assign(state, { renderer, scene, persp, orthoCam, camera: persp, controls, grid, axes, root, measureGroup, defaultLights, gizmoScene, gizmoCam, meshes: [] as THREE.Object3D[], measurePts: [] as THREE.Vector3[], bounds: new THREE.Box3() });

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h);
      persp.aspect = w / h;
      persp.updateProjectionMatrix();
      const span = state.orthoSpan ?? 200;
      orthoCam.left = (-span * w) / h; orthoCam.right = (span * w) / h; orthoCam.top = span; orthoCam.bottom = -span;
      orthoCam.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      controls.update();
      const cam: THREE.Camera = state.camera;
      if (state.camera === orthoCam) {
        // keep ortho zoom in sync with orbit distance
        const d = persp.position.distanceTo(controls.target);
        state.orthoSpan = d * Math.tan((persp.fov * Math.PI) / 360);
        orthoCam.position.copy(persp.position); orthoCam.quaternion.copy(persp.quaternion);
        const w = el.clientWidth, h = el.clientHeight;
        orthoCam.left = (-state.orthoSpan * w) / h; orthoCam.right = (state.orthoSpan * w) / h; orthoCam.top = state.orthoSpan; orthoCam.bottom = -state.orthoSpan;
        orthoCam.updateProjectionMatrix();
      }
      renderer.setViewport(0, 0, el.clientWidth, el.clientHeight);
      renderer.setScissorTest(false);
      renderer.render(scene, cam);
      // gizmo
      const s = 90;
      gizmoCam.position.copy(persp.position).sub(controls.target).normalize().multiplyScalar(4);
      gizmoCam.lookAt(0, 0, 0);
      renderer.setScissorTest(true);
      renderer.setScissor(8, 8, s, s);
      renderer.setViewport(8, 8, s, s);
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(gizmoScene, gizmoCam);
      renderer.autoClear = true;
      renderer.setScissorTest(false);
      updateOverlay();
    };

    const updateOverlay = () => {
      const ov = overlay.current;
      if (!ov) return;
      const items: { el: HTMLElement; pos: THREE.Vector3 }[] = state.overlayItems ?? [];
      const w = el.clientWidth, h = el.clientHeight;
      for (const it of items) {
        const p = it.pos.clone().project(state.camera);
        const visible = p.z < 1 && p.z > -1;
        it.el.style.display = visible ? '' : 'none';
        it.el.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px) translate(-50%, -50%)`;
      }
    };
    tick();

    // picking
    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downAt = [0, 0];
    const pick = (ev: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(pointer, state.camera);
      const hits = ray.intersectObjects(state.meshes, false).filter((h) => h.object.visible);
      return hits[0];
    };
    const onDown = (ev: PointerEvent) => { downAt = [ev.clientX, ev.clientY]; };
    const onUp = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 4) return;
      const hit = pick(ev);
      if (state.mode === 'distance') {
        if (!hit) return;
        state.measurePts.push(hit.point.clone());
        if (state.measurePts.length > 2) state.measurePts = [hit.point.clone()];
        drawMeasure();
        return;
      }
      if (!hit) { state.onSelect?.(null); return; }
      const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 0, 1);
      state.onSelect?.({ name: hit.object.userData.name, object: hit.object.userData.obj, point: hit.point.toArray(), normal: n.toArray() });
    };
    const onMove = (ev: PointerEvent) => {
      const hit = pick(ev);
      setHover(hit ? hit.object.userData.name : null);
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('pointermove', onMove);

    const drawMeasure = () => {
      measureGroup.clear();
      const pts: THREE.Vector3[] = state.measurePts;
      const dotGeo = new THREE.SphereGeometry(state.markerSize ?? 1, 12, 12);
      for (const p of pts) { const m = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false })); m.position.copy(p); m.renderOrder = 10; measureGroup.add(m); }
      if (pts.length === 2) {
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false }));
        line.renderOrder = 10;
        measureGroup.add(line);
        state.onMeasure?.(pts[0].distanceTo(pts[1]));
      } else state.onMeasure?.(null);
      state.rebuildOverlay?.();
    };
    state.drawMeasure = drawMeasure;

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);

  // keep callbacks current
  useEffect(() => { three.current.onSelect = onSelect; three.current.onMeasure = onMeasure; }, [onSelect, onMeasure]);

  // ---------------------------------------------------------------- build scene objects from result
  useEffect(() => {
    const s = three.current;
    if (!s.root) return;
    s.root.clear();
    s.meshes = [];
    s.objects = [] as { obj: SceneObject; node: THREE.Object3D; mesh?: THREE.Mesh; edges?: THREE.LineSegments; center: THREE.Vector3 }[];
    if (!result) return;
    const box = new THREE.Box3();
    for (const o of result.objects) {
      const node = new THREE.Group();
      node.userData = { name: o.name, obj: o };
      if (o.kind === 'solid' && o.mesh) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(o.mesh.positions, 3));
        geo.setIndex(new THREE.BufferAttribute(o.mesh.indices, 1));
        const nonIndexed = geo.toNonIndexed();
        nonIndexed.computeVertexNormals();
        const m = o.material ?? {};
        const mat = new THREE.MeshPhysicalMaterial({
          color: new THREE.Color(o.color ?? '#9aa7b6'), metalness: m.metalness ?? 0.05, roughness: m.roughness ?? 0.45,
          clearcoat: m.clearcoat ?? 0.1, clearcoatRoughness: m.clearcoatRoughness ?? 0.4, transparent: (m.opacity ?? 1) < 1 || !!o.mock,
          opacity: o.mock ? 0.35 : m.opacity ?? 1, emissive: new THREE.Color(m.emissive ?? '#000000'), emissiveIntensity: m.emissiveIntensity ?? 1,
          transmission: m.transmission ?? 0, ior: m.ior ?? 1.45, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        });
        const mesh = new THREE.Mesh(nonIndexed, mat);
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData = { name: o.name, obj: o, baseColor: mat.color.clone() };
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: 0x0b0f14, transparent: true, opacity: 0.6 }));
        node.add(mesh, edges);
        s.meshes.push(mesh);
        s.objects.push({ obj: o, node, mesh, edges, center: new THREE.Vector3() });
      } else if (o.lines) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(o.lines, 3));
        const ls = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(o.color ?? (o.kind === 'curve' ? '#ffb347' : '#5ad1ff')) }));
        node.add(ls);
        s.objects.push({ obj: o, node, center: new THREE.Vector3() });
      }
      if (o.transform) { node.matrixAutoUpdate = false; node.matrix.fromArray(o.transform); }
      s.root.add(node);
      node.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(node);
      if (!b.isEmpty()) { box.union(b); b.getCenter(s.objects[s.objects.length - 1].center); }
    }
    s.bounds = box;
    // scene() options
    const sc = result.scene ?? {};
    const bg = sc.background;
    s.sceneBg = typeof bg === 'string' ? bg : bg?.top ?? null;
    if (sc.lights?.length) {
      s.defaultLights.visible = false;
      s.customLights?.removeFromParent();
      const lg = new THREE.Group();
      for (const l of sc.lights) {
        const color = new THREE.Color(l.color ?? '#ffffff');
        let light: THREE.Light;
        if (l.type === 'ambient') light = new THREE.AmbientLight(color, l.intensity ?? 0.5);
        else if (l.type === 'hemisphere') light = new THREE.HemisphereLight(new THREE.Color(l.skyColor ?? '#ffffff'), new THREE.Color(l.groundColor ?? '#444444'), l.intensity ?? 1);
        else if (l.type === 'point') light = new THREE.PointLight(color, l.intensity ?? 1, l.distance ?? 0, l.decay ?? 2);
        else if (l.type === 'spot') light = new THREE.SpotLight(color, l.intensity ?? 1, l.distance ?? 0, ((l.angle ?? 30) * Math.PI) / 180, l.penumbra ?? 0.2);
        else light = new THREE.DirectionalLight(color, l.intensity ?? 1);
        if (l.position) light.position.set(l.position[0], l.position[1], l.position[2]);
        light.castShadow = !!l.castShadow;
        lg.add(light);
      }
      s.scene.add(lg);
      s.customLights = lg;
    } else { s.defaultLights.visible = true; s.customLights?.removeFromParent(); s.customLights = null; }
    if (sc.fog) s.scene.fog = sc.fog.density ? new THREE.FogExp2(sc.fog.color ?? '#888888', sc.fog.density) : new THREE.Fog(sc.fog.color ?? '#888888', sc.fog.near ?? 100, sc.fog.far ?? 5000);
    else s.scene.fog = null;
    // first build or explicit camera → frame
    if (sc.camera?.position) {
      s.persp.position.set(...(sc.camera.position as [number, number, number]));
      if (sc.camera.target) s.controls.target.set(...(sc.camera.target as [number, number, number]));
      if (sc.camera.fov) { s.persp.fov = sc.camera.fov; s.persp.updateProjectionMatrix(); }
    } else if (!s.framed && !box.isEmpty()) { fitTo(box, 'iso'); s.framed = true; }
    const size = box.isEmpty() ? 100 : box.getSize(new THREE.Vector3()).length();
    s.markerSize = size / 150;
    // grid scale
    const step = Math.pow(10, Math.floor(Math.log10(Math.max(10, size))) - 1);
    s.grid.scale.setScalar(step / 10);
    s.grid.position.z = box.isEmpty() ? 0 : Math.min(0, box.min.z);
    rebuildOverlay();
    applyOptions();
    applyTransforms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const fitTo = (box: THREE.Box3, view: ViewName = 'iso') => {
    const s = three.current;
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
    const d = VIEW_DIRS[view];
    const dir = new THREE.Vector3(...d).normalize();
    const dist = r / Math.sin((s.persp.fov * Math.PI) / 360) * 1.05;
    s.persp.position.copy(c).addScaledVector(dir, dist);
    s.persp.up.set(0, 0, 1);
    if (view === 'top' || view === 'bottom') s.persp.up.set(0, 1, 0);
    s.controls.target.copy(c);
    s.persp.near = dist / 1000; s.persp.far = dist * 100;
    s.persp.updateProjectionMatrix();
    s.controls.update();
  };

  const rebuildOverlay = () => {
    const s = three.current;
    const ov = overlay.current;
    if (!ov) return;
    ov.innerHTML = '';
    const items: { el: HTMLElement; pos: THREE.Vector3 }[] = [];
    const add = (text: string, pos: THREE.Vector3, cls: string, style: Partial<CSSStyleDeclaration> = {}) => {
      const d = document.createElement('div');
      d.className = cls;
      d.textContent = text;
      Object.assign(d.style, style);
      ov.appendChild(d);
      items.push({ el: d, pos });
    };
    for (const l of result?.labels ?? []) add(l.text, new THREE.Vector3(...l.at), 'vp-label', { color: l.opts?.color ?? '', background: l.opts?.background ?? '' });
    for (const dm of result?.dims ?? []) {
      const a = new THREE.Vector3(...dm.from), b = new THREE.Vector3(...dm.to);
      add(`${dm.label ? dm.label + ' ' : ''}${dm.value.toFixed(2)} mm`, a.clone().add(b).multiplyScalar(0.5), 'vp-dim');
    }
    if (s.measurePts?.length === 2) add(`${s.measurePts[0].distanceTo(s.measurePts[1]).toFixed(3)} mm`, s.measurePts[0].clone().add(s.measurePts[1]).multiplyScalar(0.5), 'vp-measure');
    s.overlayItems = items;
    // dims as lines
    s.dimGroup?.removeFromParent();
    const dg = new THREE.Group();
    for (const dm of result?.dims ?? []) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...dm.from), new THREE.Vector3(...dm.to)]), new THREE.LineBasicMaterial({ color: dm.color ?? 0x7fd1ff, depthTest: false }));
      line.renderOrder = 5;
      dg.add(line);
    }
    s.scene.add(dg);
    s.dimGroup = dg;
  };
  three.current.rebuildOverlay = rebuildOverlay;

  // ---------------------------------------------------------------- options
  const applyOptions = () => {
    const s = three.current;
    if (!s.objects) return;
    const o = options;
    s.camera = o.ortho ? s.orthoCam : s.persp;
    s.grid.visible = o.grid;
    s.axes.visible = o.grid;
    s.mode = o.mode;
    const bg = s.sceneBg ?? (o.dark ? '#14181d' : '#eef1f4');
    s.scene.background = new THREE.Color(bg);
    const center = s.bounds && !s.bounds.isEmpty() ? s.bounds.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    const planes: THREE.Plane[] = [];
    if (o.cut.enabled) {
      const n = new THREE.Vector3(o.cut.axis === 'x' ? 1 : 0, o.cut.axis === 'y' ? 1 : 0, o.cut.axis === 'z' ? 1 : 0).multiplyScalar(o.cut.flip ? 1 : -1);
      planes.push(new THREE.Plane(n, o.cut.flip ? -o.cut.offset : o.cut.offset));
    }
    for (const cp of result?.cutPlanes ?? []) if (cp.opts?.enabled !== false && !o.cut.enabled) planes.push(new THREE.Plane(new THREE.Vector3(...cp.normal).negate(), cp.offset));
    const collide = new Set((o.interference ?? []).flatMap((p) => [p.a, p.b]));
    for (const it of s.objects) {
      const name = it.obj.name;
      it.node.visible = !o.hidden.has(name);
      if (!it.mesh) continue;
      const mat = it.mesh.material as THREE.MeshPhysicalMaterial;
      if (o.mode === 'normals') it.mesh.material = s.normalMat ?? (s.normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide }));
      else if (o.mode === 'zebra') it.mesh.material = s.zebraMat ?? (s.zebraMat = zebraMaterial());
      else {
        const base = it.mesh.userData.physMat ?? mat;
        it.mesh.userData.physMat = base;
        it.mesh.material = base;
        base.wireframe = o.mode === 'wireframe';
        const xray = o.mode === 'xray' || o.mode === 'interference';
        base.transparent = xray || !!it.obj.mock || (it.obj.material?.opacity ?? 1) < 1;
        base.opacity = xray ? (o.mode === 'interference' && collide.has(name) ? 0.9 : 0.25) : it.obj.mock ? 0.35 : it.obj.material?.opacity ?? 1;
        base.depthWrite = !xray;
        const baseColor: THREE.Color = it.mesh.userData.baseColor;
        if (o.mode === 'mask') base.color.set(o.dark ? '#d8dee6' : '#222831');
        else if (o.mode === 'interference' && collide.has(name)) base.color.set('#ff3b3b');
        else if (o.mode === 'process') base.color.set(processColor(it.obj));
        else if (o.mode === 'thickness') base.color.copy(thicknessColor(it.obj));
        else base.color.copy(baseColor);
        if (selected && name === selected) base.emissive.set('#2a5cff'); else base.emissive.set(it.obj.material?.emissive ?? '#000000');
        base.clippingPlanes = planes;
        base.clipShadows = true;
        base.needsUpdate = true;
      }
      (it.mesh.material as THREE.Material).clippingPlanes = planes;
      if (it.edges) { it.edges.visible = o.edges && o.mode !== 'wireframe'; (it.edges.material as THREE.Material).clippingPlanes = planes; }
      // colliders: show bounding boxes
      if (o.mode === 'colliders') {
        if (!it.mesh.userData.bbox) {
          const helper = new THREE.Box3Helper(new THREE.Box3().setFromBufferAttribute(it.mesh.geometry.getAttribute('position') as THREE.BufferAttribute), new THREE.Color('#39ff88'));
          it.node.add(helper);
          it.mesh.userData.bbox = helper;
        }
        it.mesh.userData.bbox.visible = true;
      } else if (it.mesh.userData.bbox) it.mesh.userData.bbox.visible = false;
      // explode
      const off = it.center.clone().sub(center).multiplyScalar(o.explode);
      it.node.userData.explode = off;
    }
    if (o.mode !== 'distance') { s.measurePts = []; s.measureGroup?.clear(); }
    // stress plot overlay
    s.feaMesh?.removeFromParent();
    s.feaMesh = null;
    if (o.mode === 'stress' && o.fea) {
      const d = o.fea;
      const nv = d.positions.length / 3;
      const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
      const c = new THREE.Color();
      const span = Math.max(1e-12, d.range[1] - d.range[0]);
      for (let i = 0; i < nv; i++) {
        for (let k = 0; k < 3; k++) pos[i * 3 + k] = d.positions[i * 3 + k] + d.displacement[i * 3 + k] * d.scale;
        stressColor((d.vonMises[i] - d.range[0]) / span, c);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(new THREE.BufferAttribute(d.indices, 1));
      const flat = geo.toNonIndexed();
      flat.computeVertexNormals();
      const fm = new THREE.Mesh(flat, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0, side: THREE.DoubleSide, clippingPlanes: planes }));
      s.scene.add(fm);
      s.feaMesh = fm;
      for (const it of s.objects) if (it.obj.kind === 'solid') it.node.visible = false;
    }
    applyTransforms();
  };

  const applyTransforms = () => {
    const s = three.current;
    if (!s.objects) return;
    for (const it of s.objects) {
      const part = it.obj.part;
      const T = (part && transforms[part]) || it.obj.transform;
      const ex: THREE.Vector3 = it.node.userData.explode ?? new THREE.Vector3();
      if (T || ex.lengthSq() > 0) {
        it.node.matrixAutoUpdate = false;
        const m = new THREE.Matrix4();
        if (T) m.fromArray(T);
        m.premultiply(new THREE.Matrix4().makeTranslation(ex.x, ex.y, ex.z));
        it.node.matrix.copy(m);
        it.node.matrixWorldNeedsUpdate = true;
      }
    }
  };

  useEffect(applyOptions, [options, selected, result]);
  useEffect(applyTransforms, [transforms]);

  useImperativeHandle(ref, () => ({
    screenshot(w?: number, h?: number) {
      const s = three.current;
      const r: THREE.WebGLRenderer = s.renderer;
      if (w && h) {
        const old = r.getSize(new THREE.Vector2());
        r.setSize(w, h, false);
        r.render(s.scene, s.camera);
        const url = r.domElement.toDataURL('image/png');
        r.setSize(old.x, old.y, false);
        return url;
      }
      r.render(s.scene, s.camera);
      return r.domElement.toDataURL('image/png');
    },
    async recordTurntable(seconds = 6) {
      const s = three.current;
      const canvas: HTMLCanvasElement = s.renderer.domElement;
      const stream = (canvas as any).captureStream(30);
      const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm' });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise<Blob>((res) => (rec.onstop = () => res(new Blob(chunks, { type: 'video/webm' }))));
      const target: THREE.Vector3 = s.controls.target.clone();
      const start = s.persp.position.clone().sub(target);
      const t0 = performance.now();
      rec.start();
      await new Promise<void>((res) => {
        const step = () => {
          const t = (performance.now() - t0) / 1000;
          const a = (t / seconds) * Math.PI * 2;
          const p = start.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), a);
          s.persp.position.copy(target).add(p);
          s.persp.lookAt(target);
          if (t < seconds) requestAnimationFrame(step); else res();
        };
        step();
      });
      rec.stop();
      s.persp.position.copy(target).add(start);
      return done;
    },
    setView(v: ViewName) { fitTo(three.current.bounds, v); },
    fit() { fitTo(three.current.bounds, 'iso'); },
    clearMeasure() { three.current.measurePts = []; three.current.drawMeasure?.(); },
  }), []);

  return (
    <div className="viewport">
      <div ref={host} className="viewport-canvas" />
      <div ref={overlay} className="viewport-overlay" />
      {hover && <div className="vp-hover">{hover}</div>}
    </div>
  );
});

function processColor(o: SceneObject): string {
  const p = o.meta?.manufacturing?.process ?? o.meta?.process;
  return ({ print: '#5fb3ff', resin: '#b78cff', powder: '#ffd166', machine: '#ff8c42', cut: '#7bd389', mold: '#ef476f', urethane: '#f78fb3', buy: '#adb5bd' } as Record<string, string>)[p] ?? '#8d99ae';
}
function thicknessColor(o: SceneObject): THREE.Color {
  // approximate wall thickness from volume / (area / 2)
  const t = o.stats ? (2 * o.stats.volume) / Math.max(1e-6, o.stats.area) : 1;
  const k = Math.max(0, Math.min(1, t / 10));
  return new THREE.Color().setHSL(0.66 * k, 0.75, 0.5);
}
