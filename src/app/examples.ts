// Built-in gallery projects. Each one is an original Witness CAD model.
export interface Example { id: string; name: string; description: string; tags: string[]; files: Record<string, string> }

export const EXAMPLES: Example[] = [
  {
    id: 'starter-plate', name: 'Starter plate', tags: ['basics', 'params'],
    description: 'A parametric mounting plate with filleted edges and a hole grid.',
    files: {
      'main.forge.js': `// Parametric mounting plate
const width = Param.number("Width", 90, { min: 40, max: 160, unit: "mm" });
const depth = Param.number("Depth", 56, { min: 30, max: 120, unit: "mm" });
const thick = Param.number("Thickness", 6, { min: 2, max: 20, unit: "mm" });
const holes = Param.number("Holes per row", 3, { min: 1, max: 8, integer: true });
const size = Param.choice("Screw", "M4", ["M3", "M4", "M5", "M6"]);

let plate = box(width, depth, thick).color("#5f87c6");
plate = fillet(plate, Math.min(thick / 2, 3), plate.edgesOf("top"));

const pitch = (width - 20) / Math.max(1, holes - 1);
for (let i = 0; i < holes; i++) {
  for (const v of [-depth / 2 + 10, depth / 2 - 10]) {
    plate = plate.hole("top", { clearance: size, u: holes === 1 ? 0 : -width / 2 + 10 + i * pitch, v, counterbore: { diameter: 9, depth: 2 } });
  }
}

verify.inRange("plate stays printable", thick, 2, 20);
bom(1, "Mounting plate", { material: "Aluminum 6061", process: "CNC", dimensions: [width, depth, thick] });
return { "Mounting plate": plate };
`,
    },
  },
  {
    id: 'enclosure', name: 'Electronics enclosure', tags: ['shell', 'multi-file'],
    description: 'A two-part enclosure with a shelled body, screw bosses and a lid that requires a helper file.',
    files: {
      'main.forge.js': `const { body, lid } = require("./enclosure.forge.js");
const L = Param.number("Length", 80, { min: 40, max: 200, unit: "mm" });
const W = Param.number("Width", 55, { min: 30, max: 150, unit: "mm" });
const H = Param.number("Height", 30, { min: 15, max: 100, unit: "mm" });
const wall = Param.number("Wall", 2, { min: 1.2, max: 5, step: 0.1, unit: "mm" });
const exploded = Param.bool("Exploded", true);

const b = body(L, W, H, wall).color("#2f3b48");
const l = lid(L, W, wall).color("#8fb3d9").translate(0, 0, exploded ? H + 15 : H);

verify.notColliding("lid clears body", b, l);
bom(1, "Enclosure body", { material: "PETG", process: "FDM" });
bom(1, "Enclosure lid", { material: "PETG", process: "FDM" });
bom(4, "M3x8 screw", { unit: "pieces" });
return group({ name: "Body", shape: b }, { name: "Lid", shape: l });
`,
      'enclosure.forge.js': `function body(L, W, H, wall) {
  let shell = roundedRect(L, W, 4).extrude(H).shell(wall, { openFaces: ["top"] });
  const boss = cylinder(H - wall, 3.5).subtract(cylinder(H, 1.25)).translate(0, 0, wall);
  for (const [x, y] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) shell = shell.add(boss.translate(x * (L / 2 - 6), y * (W / 2 - 6), 0));
  // USB-C cut-out on the front face
  return shell.cutout(slot(10, 4).onFace(shell, "front", { v: 0 }), { depth: wall + 1 });
}
function lid(L, W, wall) {
  let l = roundedRect(L, W, 4).extrude(wall);
  for (const [x, y] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) l = l.hole("top", { diameter: 3.2, u: x * (L / 2 - 6), v: y * (W / 2 - 6), countersink: { diameter: 6 } });
  return l.add(roundedRect(L - 2 * wall - 0.4, W - 2 * wall - 0.4, 2).subtract(roundedRect(L - 4 * wall, W - 4 * wall, 1)).extrude(3).translate(0, 0, -3));
}
return { body, lid };
`,
    },
  },
  {
    id: 'gearbox', name: 'Gear pair', tags: ['library', 'gears'],
    description: 'Two meshing involute spur gears with a checked ratio and centre distance.',
    files: {
      'main.forge.js': `const m = Param.number("Module", 1.5, { min: 0.5, max: 4, step: 0.25 });
const z1 = Param.number("Pinion teeth", 14, { min: 8, max: 40, integer: true });
const z2 = Param.number("Gear teeth", 36, { min: 12, max: 120, integer: true });
const fw = Param.number("Face width", 8, { min: 3, max: 30, unit: "mm" });

const pair = gearPair({ module: m, teethA: z1, teethB: z2, faceWidth: fw, boreDiameter: 5 });
verify.equal("ratio", pair.ratio, z2 / z1, 1e-9);
verify.equal("centre distance", pair.centerDistance, m * (z1 + z2) / 2, 1e-9);
Viewport.label("ratio " + pair.ratio.toFixed(2) + ":1", [pair.centerDistance / 2, 0, fw + 6]);
return group({ name: "Pinion", shape: pair.a.color("#d98f4e") }, { name: "Gear", shape: pair.b.color("#6f8fb0") });
`,
    },
  },
  {
    id: 'robot-arm', name: 'Two-link robot arm', tags: ['assembly', 'joints', 'sim'],
    description: 'A base, shoulder and elbow joined by servo-driven revolute joints. Exports to URDF, MJCF and SDF.',
    files: {
      'main.forge.js': `const L1 = Param.number("Upper arm", 120, { min: 60, max: 250, unit: "mm" });
const L2 = Param.number("Forearm", 100, { min: 50, max: 200, unit: "mm" });

const base = cylinder(20, 40).color("#3a4350").withConnectors({
  yaw: connector("yaw", { origin: [0, 0, 20], axis: [0, 0, 1], up: [1, 0, 0] }),
});
const turret = cylinder(30, 25).add(box(16, 30, 14).translate(0, 0, 24)).color("#5d6b7c").withConnectors({
  bottom: connector("bottom", { origin: [0, 0, 0], axis: [0, 0, -1], up: [1, 0, 0] }),
  shoulder: connector("shoulder", { origin: [0, 0, 36], axis: [0, -1, 0], up: [1, 0, 0] }),
});
const link = (len, color) => box(len, 18, 18).translate(len / 2, 0, -9).color(color)
  .add(cylinder(22, 12).rotateX(90).translate(0, 11, 0)).withConnectors({
    root: connector("root", { origin: [0, 0, 0], axis: [0, 1, 0], up: [1, 0, 0] }),
    tip: connector("tip", { origin: [len, 0, 0], axis: [0, -1, 0], up: [1, 0, 0] }),
  });
const servo = (deg) => Sim.drive.servo({ maxTorqueNm: 2.5, maxSpeedRpm: 60, stiffnessNmPerDeg: 0.05 });

const arm = assembly("Arm")
  .addPart("Base", base, { sim: { motion: Sim.motion.static() } })
  .addPart("Turret", turret)
  .addPart("Upper", link(L1, "#e0a43a"), { metadata: { densityKgM3: 1240 } })
  .addPart("Fore", link(L2, "#d76a4a"))
  .connect("Base.yaw", "Turret.bottom", { as: "yaw", type: "revolute", min: -170, max: 170, default: 0, drive: servo() })
  .connect("Turret.shoulder", "Upper.root", { as: "shoulder", type: "revolute", min: -10, max: 120, default: 45, drive: servo() })
  .connect("Upper.tip", "Fore.root", { as: "elbow", type: "revolute", min: -135, max: 135, default: -60, drive: servo() })
  .addPose("folded", { yaw: 0, shoulder: 90, elbow: -135 })
  .addPose("reach", { yaw: 30, shoulder: 10, elbow: 0 })
  .addAnimation("wave", { duration: 3, loop: true, keyframes: [
    { at: 0, values: { yaw: -30, shoulder: 40, elbow: -40 } },
    { at: 0.5, values: { yaw: 30, shoulder: 70, elbow: -90 } },
    { at: 1, values: { yaw: -30, shoulder: 40, elbow: -40 } },
  ] });

const solved = arm.solve();
verify.lessThan("shoulder load within servo torque", Math.abs(solved.jointLoad("shoulder")), 2.5);
return arm;
`,
    },
  },
  {
    id: 'hinged-lid', name: 'Spring-loaded lid', tags: ['assembly', 'springs'],
    description: 'A box with a lid on a torsion-spring hinge and a stop, with a motion study.',
    files: {
      'main.forge.js': `const box0 = box(80, 50, 30).shell(2, { openFaces: ["top"] }).color("#4b5d6e").withConnectors({
  hinge: connector("hinge", { origin: [0, 25, 30], axis: [1, 0, 0], up: [0, 0, 1] }),
});
const lid = box(80, 50, 3).translate(0, -25, 0).color("#c9d4de").withConnectors({
  hinge: connector("hinge", { origin: [0, 0, 0], axis: [-1, 0, 0], up: [0, 0, 1] }),
});
const asm = assembly("Lid box")
  .addPart("Box", box0)
  .addPart("Lid", lid)
  .connect("Box.hinge", "Lid.hinge", { as: "open", type: "revolute", min: 0, max: 105, default: 30,
    drive: Sim.drive.torsionSpring({ stiffnessNmPerDeg: 0.004, restDeg: 100, damping: 0.02 }) })
  .addMotionStudy("open sweep", { joint: "open", from: 0, to: 105, steps: 21 })
  .addAnimation("open", { duration: 2, keyframes: [{ at: 0, values: { open: 0 } }, { at: 1, values: { open: 105 } }] });
return asm;
`,
    },
  },
  {
    id: 'nameplate', name: 'Nameplate', tags: ['text', 'sketch'],
    description: 'Raised text on a rounded plate, ready for two-colour printing.',
    files: {
      'main.forge.js': `const label = Param.string("Text", "WITNESS CAD", { maxLength: 24 });
const size = Param.number("Letter size", 10, { min: 4, max: 30, unit: "mm" });
const w = textWidth(label, { size }) + 16;
const plate = roundedRect(w, size * 2.2, 4).extrude(3).color("#1d2733");
const letters = text2d(label, { size, align: "center", baseline: "center" }).extrude(1.2).translate(0, 0, 3).color("#f2c14e");
return group({ name: "Plate", shape: plate }, { name: "Letters", shape: letters });
`,
    },
  },
  {
    id: 'pipe-run', name: 'Pipe run', tags: ['curves', 'sweep'],
    description: 'A routed pipe with bends and flanges, built with Curve.Route and sweep.',
    files: {
      'main.forge.js': `const r = Param.number("Pipe radius", 6, { min: 2, max: 20, unit: "mm" });
const bend = Param.number("Bend radius", 18, { min: 6, max: 60, unit: "mm" });
const pts = [[0, 0, 0], [0, 0, 60], [80, 0, 60], [80, 70, 60], [80, 70, 120]];
const p = pipeRoute(pts, r, { bendRadius: bend, wall: 1.5 }).color("#b87333");
const flange = cylinder(4, r * 2.2).subtract(cylinder(10, r - 1.5).translate(0, 0, -3)).color("#8a8f94");
return group({ name: "Pipe", shape: p }, { name: "Inlet flange", shape: flange.translate(0, 0, -4) }, { name: "Outlet flange", shape: flange.translate(80, 70, 120) });
`,
    },
  },
  {
    id: 'shelf', name: 'Wall shelf', tags: ['wood', 'bom'],
    description: 'A plywood shelf with brackets, a cut list and dimension callouts.',
    files: {
      'main.forge.js': `const length = Param.number("Length", 600, { min: 300, max: 1200, unit: "mm" });
const depthMm = Param.number("Depth", 180, { min: 100, max: 300, unit: "mm" });
const board = Wood.plywood(length, depthMm, 18).translate(0, 0, 200);
const br = bracket(30, 180, depthMm - 10, 4, 5).color("#30353a");
const left = br.translate(-length / 2 + 60, 0, 20), right = br.translate(length / 2 - 60, 0, 20);
dim([-length / 2, -depthMm / 2, 218], [length / 2, -depthMm / 2, 218], { label: "length" });
bom(1, "Plywood shelf", { material: "Birch plywood", dimensions: [length, depthMm, 18], process: "cut" });
bom(2, "Steel bracket 30x180", { material: "Steel" });
return group({ name: "Shelf", shape: board }, { name: "Bracket L", shape: left }, { name: "Bracket R", shape: right });
`,
    },
  },
  {
    id: 'shelf-bracket-fea', name: 'Shelf bracket strength', tags: ['fea', 'strength', 'params'],
    description: 'An L bracket with a gusset and a declared finite element study: wall face fixed, shelf loaded. Run it from Inspect, Strength.',
    files: {
      'main.forge.js': `// Shelf bracket with a static stress study
const load = Param.number("Shelf load", 300, { min: 20, max: 2000, unit: "N" });
const t = Param.number("Thickness", 5, { min: 2, max: 12, unit: "mm" });
const gusset = Param.bool("Gusset", true);
const width = 30, arm = 80, height = 70;

let part = box(arm, width, t).translate(arm / 2, 0, 0)
  .add(box(t, width, height).translate(t / 2, 0, 0));
if (gusset) {
  const tri = polygon([[0, 0], [arm * 0.6, 0], [0, height * 0.6]]).extrude(t).rotate([90, 0, 0]).translate(0, t / 2, 0);
  part = part.add(tri.translate(t, 0, t));
}
part = part.color("#7d93b2");

Fea.study.staticStress("Shelf load", {
  part: "bracket",
  material: Fea.materials.aluminum6061T6(),
  fixtures: [Fea.fix.fixed(Fea.region.side("xmin"))],
  loads: [Fea.load.force(Fea.region.box([arm * 0.6, -width, t - 0.5], [arm + 1, width, t + 0.5]), { newtons: load, direction: [0, 0, -1] })],
  target: Fea.target.minSafetyFactor(2),
});

return { bracket: part };
`,
    },
  },
];
