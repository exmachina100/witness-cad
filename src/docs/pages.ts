// Witness CAD documentation, served in the app, to the in-app agent and over MCP (read_docs / search_docs).
export const PAGES: { id: string; title: string; body: string }[] = [
  { id: 'welcome', title: 'Welcome to Witness CAD', body: `# Welcome to Witness CAD

Witness CAD is code-first parametric CAD that runs in your browser. A model is a JavaScript file (\`main.forge.js\`) that declares parameters, builds immutable shapes and returns what to show. Every edit or slider change rebuilds the model with the Manifold kernel locally.

\`\`\`js
const width = Param.number("Width", 90, { min: 50, max: 160, unit: "mm" });
const height = Param.number("Height", 12, { min: 6, max: 32, unit: "mm" });
const base = box(width, 56, height).color("#5f87c6");
const hole = cylinder(height * 3, 5).translate(0, 0, -height);
return { "starter plate": base.subtract(hole) };
\`\`\`

## Conventions
- Units are millimetres, angles are degrees, Z is up.
- \`box\` and \`cylinder\` are centred in XY and sit on z = 0. \`sphere\` is centred on the origin.
- API functions are globals: there are no imports. Use \`require("./part.forge.js")\` to load another file (the extension is required) and \`require("project:alias")\` to load another project.
- A script may return a Shape, Sketch, group, Assembly, array, or a \`{ name: shape }\` map.
- \`require.main === module\` is true only in the file being built, so you can add preview-only geometry.

## The workspace
Files, Agent, Params, 2D views, Make, Artifacts and Inspect live on the left rail. The viewport and the code editor share the centre. Use ⌘S to save and rebuild, ⌘P to find a file, and ⌘⇧P for the command palette.

## Pages
core · sketch · curves · assembly · output · viewport · lib · agents · cli` },
  { id: 'core', title: 'Core API', body: `# Core API

## Primitives
- \`box(width, depth, height)\` — faces: top, bottom, front, back, left, right
- \`roundedBox(width, depth, height, radius)\`
- \`cylinder(height, radius, radiusTop?, segments?)\` — faces: top, bottom, side
- \`cone(height, radius, radiusTop = 0)\`, \`sphere(radius, segments?)\`, \`torus(major, minor)\`, \`polyhedron(vertices, faces)\`, \`hull(...shapesOrPoints)\`

## Booleans
\`union(...)\`, \`difference(base, ...cutters)\`, \`intersection(a, b, ...)\` and the methods \`.add()\`, \`.subtract()\`, \`.intersect()\`. Each accepts shapes or arrays. \`union\` keeps the first operand's colour; use \`group()\` to keep parts separate.
\`.split(cutter)\`, \`.splitByPlane(normal, offset)\`, \`.trimByPlane(normal, offset)\`.

## Transforms (all return a new shape)
\`.translate(x, y, z)\`, \`.translatePolar(r, deg, z)\`, \`.rotate(axis, deg, { pivot })\`, \`.rotateX/Y/Z(deg)\`, \`.scale(v)\` (about the bounding-box centre), \`.scaleAround(pivot, v)\`, \`.mirror(normal)\`, \`.mirrorThrough(point, normal)\`, \`.pointAlong(direction)\`, \`.transform(mat4)\`, \`.placeOnFrame(frame)\`.

## Edge features
- \`fillet(shape, radius, edges?)\` — omit edges to round every edge. Edges can be a face name (\`"top"\`), \`shape.edgesOf("top")\`, \`shape.edgesBetween("top", "front")\`, \`"top|front"\`, or \`"convex"\`/\`"concave"\`.
- \`chamfer(shape, size, edges?)\`, \`draft(shape, angleDeg, pull?, neutral?)\`, \`offsetSolid(shape, thickness)\`

## Features
- \`.shell(thickness, { openFaces: ["top"] })\`
- \`.pocket(face, depth, { inset, scale, join })\`, \`.boss(face, height, { inset })\`
- \`.hole(face, { diameter | thread: "M6" | clearance: "M6", clearanceClass, depth, upToFace, u, v, counterbore: { diameter, depth }, countersink: { diameter, angleDeg } })\`
- \`.cutout(sketch.onFace(shape, "front"), { depth, upToFace, taperScale })\`

## Topology
\`.face(name)\` returns a FaceRef \`{ name, normal, center, uAxis, vAxis, size, area }\`. Direction names (top, bottom, front, back, left, right) always work. Sketch edge labels become face names after \`extrude\`. \`.faceNames()\`, \`.edgesOf(face, { convex, concave, minLength, exclude })\`, \`.edgesBetween(a, b)\`, \`.as(prefix)\`, \`.labelFace(name, face)\`.

## Patterns
\`linearPattern(shape, count, dx, dy?, dz?)\`, \`circularPattern(shape, count, { centerX, centerY, axis, origin })\`, \`mirrorCopy(shape, normal)\`, \`circularLayout(count, radius, opts)\`, \`polygonVertices(sides, radius)\`.

## Parameters
\`Param.number(name, default, { min, max, step, unit, integer })\`, \`Param.string\`, \`Param.bool\`, \`Param.choice(name, default, choices)\`, \`Param.list\`, \`Param.path2d\`, \`Param.spline2d\`, \`Param.placement2d\`, \`Param.variant\`. Each returns the current value and adds a control to the Params tab.

## Measurement
\`.boundingBox()\` → \`{ min, max, size, center }\`, \`.volume()\`, \`.surfaceArea()\`, \`.centroid()\`, \`.minGap(other)\`, \`PhysicalProperties.approximate(shape, { densityKgM3 })\` → mass, centre of mass and inertia.

## Materials and appearance
\`.color("#rrggbb")\`, \`.material({ metalness, roughness, opacity, emissive, transmission, ior, clearcoat })\`, \`PhysicalMaterial.define(name, { densityKgM3 })\`, \`PhysicalMaterial.presets.aluminum6061T6()\`.

## Checks
\`verify.that\`, \`equal\`, \`notEqual\`, \`greaterThan\`, \`lessThan\`, \`inRange\`, \`notColliding\`, \`minClearance\`, \`clearanceBetween\`, \`parallel\`, \`perpendicular\`, \`coplanar\`, \`faceAt\`, \`volumeApprox\`, \`areaApprox\`, \`boundingBoxSize\`, \`centersCoincide\`, \`connectorDistance\`, \`isEmpty\`, \`notEmpty\`, \`noTinyEdges\`, \`noSliverFaces\`, \`noSelfIntersection\`, \`simReady\`. Results show under Run tests and in builds over MCP.

## Groups and imports
\`group(...items)\` keeps named children (\`{ name, shape, tags }\`). \`require(path)\` returns whatever the file returns.` },
  { id: 'sketch', title: 'Sketches', body: `# Sketches (2D)

## Primitives
\`rect(w, h)\` (centred), \`circle2d(r)\`, \`roundedRect(w, h, r)\`, \`polygon(points)\`, \`ngon(sides, r)\`, \`ellipse(rx, ry)\`, \`slot(length, width)\`, \`arcSlot(pitchRadius, sweepDeg, thickness)\`, \`stroke(points, width)\`, \`spline2d(points, { closed, tension, strokeWidth })\`, \`text2d(text, { size, align, baseline, letterSpacing, font })\`, \`textWidth(text, { size })\`.

## Paths
\`path().moveTo(x, y).lineTo().lineH().lineV().lineAngled(len, deg).arcTo(x, y, r, cw).tangentArcTo(x, y).arc(cx, cy, r, a0, a1).bezierTo(...).blendTo(x, y).smoothThrough(points).nurbsTo(points).fillet(r).chamfer(d).label(name).mirror('y').close()\` → Sketch. \`.stroke(width)\` makes an open path into a band.

## Operations
\`.translate\`, \`.rotate\`, \`.rotateAround\`, \`.scale\`, \`.mirror\`, \`.add\`, \`.subtract\`, \`.intersect\`, \`.hull\`, \`.offset(delta, join)\`, \`.filletCorners(r)\`, \`.chamferCorners(s)\`, \`.regions()\`, \`.region(seed)\`, \`.area()\`, \`.bounds()\`, \`.labelEdges(...)\`, \`.attachTo(target, anchor, selfAnchor, offset)\`.
Booleans as functions: \`union2d\`, \`difference2d\`, \`intersection2d\`; patterns: \`linearPattern2d\`, \`circularPattern2d\`.

## To 3D
- \`.extrude(height, { twist, scale, center, labels: { start, end } })\` or \`.extrude({ upToFace: shape.face("top") })\`
- \`.revolve(degrees = 360)\` — sketch X is the radius, sketch Y becomes Z.
- \`.onFace(shape, "top", { u, v, protrude })\` places a sketch on a face, then \`.extrude()\` grows from that face and \`shape.cutout(sketch)\` cuts into it.

## Constrained sketches
\`\`\`js
const s = constrainedSketch();
const r = s.rect({ width: 40, height: 20 });
s.fix(r.points[0], 0, 0);
const solved = s.solve();            // solved.constraintMeta: { status, dof, maxError }
return solved.extrude(5);
\`\`\`
Entities: point, line, circle, arcByCenter, rect, regularPolygon, addPolygon, turtle drawing (moveTo, lineTo, close). Constraints: horizontal, vertical, parallel, perpendicular, collinear, distance, length, hDistance, vDistance, angle, absoluteAngle, radius, diameter, equal, equalRadius, coincident, concentric, fix, midpoint, pointOnLine, pointOnCircle, pointLineDistance, lineDistance, tangent, symmetric.` },
  { id: 'curves', title: 'Curves, lofts and sweeps', body: `# Curves, lofts and sweeps

- \`loft(profiles, heights)\` — blends sketches at increasing heights.
- \`sweep(profile, path, { up })\` — path may be a Curve3D, a Route or an array of points. Profiles with holes stay hollow.
- \`variableSweep(spine, [{ t, profile }])\`
- \`Curve.Line(a, b)\`, \`Curve.Arc({ start, end, tangent | center | through })\`, \`Curve.Nurbs(points, { degree, weights, knots, closed })\`, \`Curve.Fit(points, { closed })\`, \`Curve.Blend(start, end)\`, \`Curve.Bridge({ from, to })\`, \`Curve.Trim\`, \`Curve.Reverse\`, \`Curve.closestParameter\`, \`Curve.placeOnXY/XZ/YZ/Plane\`.
- \`Curve.Helix.path({ radius, pitch, turns | height })\`, \`Curve.Helix.coil({ radius, pitch, turns, wireRadius })\` → solid.
- \`Curve.Route.fromPolyline(points, { cornerRadius })\` → route with \`start\`/\`end\` ports.
- Curve3D methods: \`pointAt(t)\`, \`tangentAt(t)\`, \`sample(n)\`, \`length()\`, \`toPolyline()\`.
- Library: \`pipeRoute(points, radius, { bendRadius, wall })\`, \`elbow(r, bendR, angle)\`.

Exact NURBS surfacing (Surface.*, Curve.Intersect, Curve.ProjectOnSurface) needs the exact-geometry service and reports an error locally.` },
  { id: 'assembly', title: 'Assemblies, joints and simulation', body: `# Assemblies

\`\`\`js
const frame = box(100, 10, 80).withConnectors({ hinge: connector("hinge", { origin: [50, 0, 40], axis: [0, 0, 1], up: [1, 0, 0] }) });
const door = box(60, 4, 80).translate(30, 0, 0).withConnectors({ hinge: connector("hinge", { origin: [0, 0, 40], axis: [0, 0, -1], up: [1, 0, 0] }) });
return assembly("Door")
  .addPart("Frame", frame)
  .addPart("Door", door)
  .connect("Frame.hinge", "Door.hinge", { as: "swing", type: "revolute", min: 0, max: 110 });
\`\`\`

A connector is an origin, an axis and an up vector. Joining two connectors places them at the same point with **opposed axes** (like a plug and socket). A revolute joint turns about the parent connector's axis; a prismatic joint slides along it.

## Assembly
- \`addPart(name, shape | group | assembly, { transform, metadata: { qty, massKg, densityKgM3 }, sim, fea })\`
- \`withConnectors(partName, { name: connector(...) })\`
- \`connect("Parent.conn", "Child.conn", { as, type, min, max, default, unit, follows: { joint, ratio, offset }, driven, drive, along, effort, velocity, damping, friction })\` — types: fixed, revolute, prismatic, cylindrical, ball, universal, planar, and path joints with \`along\`.
- \`addPose(name, values)\`, \`addAnimation(name, { duration, loop, keyframes: [{ at, values | pose }] })\`, \`addMotionStudy(name, { joint, from, to, steps })\`, \`sweep(joint, { from, to, steps })\`
- \`addSpring(name, { from, to, spring: Spring.extension({...}) | Spring.compression({...}) })\`, \`addCable(name, { through: ["A.c", "B.c"], diameter })\`
- \`addContact(a, b)\`, \`probe(name, part, point)\`, \`withSimulation({ rootPart, profile, controllers, floating })\`
- \`solve(state | poseName)\` → SolvedAssembly: \`getTransform\`, \`getPart\`, \`jointLoad(name)\` (static gravity torque in N·m or force in N), \`jointLoads()\`, \`collisionReport()\`, \`minClearance(a, b)\`, \`spring(name)\`, \`cable(name)\`, \`probe(name)\`, \`bom()\`, \`toGroup()\`, \`warnings()\`.

Each joint becomes a slider under Inspect → Motion. Poses and animations play there too, and **Simulate** runs the assembly as rigid bodies (Dynamics, the default) or as a quick joint-space preview without contacts (Joint-space). After a dynamics run the panel shows whether the model settled, how far each part moved, contact penetration and peak drive effort. **Hold test** loads one joint and reports whether it gives.

## Dynamics
\`asm.simulate(options)\` (also \`Sim.run(asm, options)\`) runs rigid-body dynamics:

- Every part is a rigid body with mass and inertia from its mesh (\`metadata.massKg\`, \`densityKgM3\` or \`Sim.body({ massKg, material })\`). Parts joined by \`fixed\` joints move as one body.
- Joints are constraints between bodies, so a robot with a free base, a closed linkage or a part resting on another all work in one run. Revolute and prismatic joints honour \`min\`/\`max\`, \`Sim.drive.servo\` (tracks \`targets[joint]\`, \`drive.target\` or the start value within \`maxTorqueNm\` and \`maxSpeedRpm\`), \`velocity\`, \`torsionSpring\`, \`linearSpring\`, damping, friction and \`follows\` couplings. Assembly springs pull between their connectors.
- Colliders are convex hulls of each part by default; \`Sim.collider.boundingBox()\`, \`capsule(from, to, r)\`, \`hull(points)\`, \`pieces()\` / \`convexDecomposition()\` (one hull per solid piece) and \`none()\` change that. Jointed parent/child pairs never collide; add more with \`ignorePairs\`.
- Contacts carry friction (the larger \`staticFriction\` of the two \`Sim.material\`s) and restitution (their average). A ground plane sits under the lowest part unless \`ground: false\` or \`ground: { z, friction, restitution }\`.
- Root parts fall freely unless \`Sim.motion.static()\` (welded to the world) or \`kinematic()\` (moves only with \`bodyVelocities\`).

Options: \`duration\` (s, default 2), \`dt\` (s, default 0.002), \`gravity\` (m/s² magnitude or vector), \`targets\`, \`velocities\` (rpm for velocity drives), \`initial\` (joint values), \`bodyVelocities: { Part: { linear: [mm/s], angular: [deg/s] } }\`, \`loads: [{ part, force: [N], at: [mm] } | { joint, value }]\`, \`motion: { Part: "static" }\`, \`contacts: false\`.

The result has \`frames\` (60 per second: \`t\`, joint \`values\`, part \`transforms\`), \`final\` joint values, and \`summary\`: \`settled\`, \`maxPenetrationMm\`, \`kineticEnergyJ\`, \`parts[name]\` (\`displacementMm\`, \`rotationDeg\`, \`finalCenterMm\`, \`resting\`), \`drives[joint]\` (\`peakEffort\`, \`limit\`, \`saturatedS\`) and \`jointTravel\`.

\`\`\`js
const res = arm.simulate({ duration: 2, targets: { shoulder: 80 } });
verify.lessThan("reaches the target", Math.abs(res.final.shoulder - 80), 2);
verify.lessThan("servo stays within torque", res.summary.drives.shoulder.peakEffort, 2.5);
const drop = Sim.drop(bracket, { height: 300 });       // drop one part onto the floor
verify.that("lands upright", drop.summary.parts.Part.rotationDeg < 5);
const h = lidBox.holdTest({ joint: "open", load: 0.3, seconds: 2, maxTravel: 3 }); // control run subtracted
verify.that("lid holds 0.3 N·m", h.pass);
\`\`\`

It is a sequential-impulse solver with convex colliders, meant for design checks (does it fall over, does the servo hold, does the latch give). For contact-rich or high-fidelity work, export MJCF and run MuJoCo.

## Sim.*
\`Sim.material\`, \`Sim.body\`, \`Sim.collider.capsule/hull/convexHull/convexDecomposition/boundingBox/visualMesh/sdfMesh/none\`, \`Sim.motion.dynamic/kinematic/static\`, \`Sim.drive.passive/velocity/servo/torsionSpring/linearSpring\`, \`Sim.contact.wheelSurface/gripperSurface\`, \`Sim.profile.robotBodyRunnable/robotBodyIsaac\`, \`Sim.controller.diffDrive\`.

## Fea.* (strength)
Linear static finite element analysis. The part is meshed with box-shaped hexahedral elements (8-node bricks with incompatible modes, which bend accurately even with a few elements through the thickness) and solved with preconditioned conjugate gradients, locally in the browser, CLI or MCP server. Units are mm, N and MPa.

\`\`\`js
const shelf = box(60, 20, 4).add(box(4, 20, 40).translate(-28, 0, 4));
Fea.study.staticStress("Shelf load", {
  part: "bracket",                                  // omit to analyse the whole model
  material: Fea.materials.aluminum6061T6(),
  fixtures: [Fea.fix.fixed(Fea.region.side("xmin"))],
  loads: [Fea.load.force(Fea.region.face("bracket", "top"), { newtons: 200, direction: [0, 0, -1] })],
  target: Fea.target.minSafetyFactor(2),
  mesh: Fea.mesh.hex({ size: 1.5 }),               // or { targetElements: 20000 }
});
return { bracket: shelf };
\`\`\`

- **Regions**: \`Fea.region.face(part, face)\` (labels or top/bottom/left/right/front/back; \`face(name)\` alone for one-part models), \`Fea.region.plane(part, face, { offset })\`, \`Fea.region.side("xmin" | "xmax" | "ymin" | "ymax" | "zmin" | "zmax")\`, \`Fea.region.box(min, max)\`, \`Fea.region.sphere(center, radius)\`. Cylindrical face labels select the curved wall.
- **Fixtures**: \`Fea.fix.fixed(region)\`, \`Fea.fix.roller(region)\` (held along the face normal only), \`Fea.fix.dofs(region, ["x", "z"])\`.
- **Loads**: \`Fea.load.force(region, { newtons, direction })\` (spread by area), \`Fea.load.pressure(region, { mpa | kpa })\`, \`Fea.load.torque(region, { nm | nmm, axis, origin? })\`, \`Fea.load.gravity({ g? })\` (uses the material density).
- **Materials**: \`Fea.materials.isotropicPrintedPla/printedPla({ infillPercent })/petg/abs/nylon/aluminum6061T6/astmA36StructuralSteel/stainless304/titanium6Al4V/plywood\`, or \`Fea.material(name, { youngsModulusMPa, poissonRatio, yieldStrengthMPa, densityKgM3 })\`. Parts can carry one with \`addPart(name, shape, { fea: { material } })\`; assemblies also take \`withFeaStudy(study)\`.
- **Results**: \`maxVonMisesMPa\`, \`p99VonMisesMPa\` (steadier than the peak, which can be singular at sharp inside corners and fixture edges), \`maxDisplacementMm\`, \`safetyFactor\` (yield / max von Mises), \`pass\` against the target, applied load and reaction forces, element count, iterations and warnings.
- \`Fea.solve(shape, study)\` runs a study inside the script, so you can write \`verify.that("strong", Fea.solve(part, study).safetyFactor > 2)\`. Keep the mesh coarse there; it runs on every build.

Inspect → **Strength** lists the declared studies, runs a quick study (fixed face, loaded face, force, material) and colours the part by von Mises stress with an exaggerated deformed shape. Use **Fine** for final numbers. The MCP tool \`check_strength\` and the CLI command \`witness strength\` run the same solver.

## Exports
URDF, MJCF (MuJoCo) and SDF export the assembly's link tree with meshes, masses, inertias, limits and drives.` },
  { id: 'output', title: 'Output: BOM, dimensions, manufacturing, export', body: `# Output

- \`bom(quantity, description, { unit, material, process, dimensions, unitPrice, currency, priceSource, priceDate, notes, key })\` — rows with the same key add up.
- \`dim(a, b, { label, offset, color })\`, \`dim(face)\`, \`dim(faceA, faceB)\`, \`dim.radius(face)\`, \`dim.alongX/Y/Z(a, b)\` — shown in the viewport and in drawings.
- \`Manufacturing.print({ down })\`, \`printResin\`, \`printPowder\`, \`machine({ finish, tolerance })\`, \`cut\`, \`mold({ pull })\`, \`castUrethane\`, \`buy({ title, url, price })\`, \`other\`. Attach with \`shape.withMeta({ manufacturing: Manufacturing.machine({...}) })\`; the Make tab and the Process inspect mode group parts by it.
- \`sketchToSvg(sketch, { stroke, strokeWidth, fill, padding })\`, \`sketchToDxf(sketch, { layer, colorIndex })\`

## Export formats
Mesh: 3MF (recommended), STL, GLB, OBJ, PLY. CAD: STEP (AP214 exact B-rep: planes, cylinders, cones, spheres and tori come out as true surfaces, stretched shapes, text, sweeps, pipes and lofts as B-spline surfaces, with lines, circles and B-spline edges; anything the kernel cannot trace back to an exact surface, such as a hull, is written as flat facets). Simulation: USD, URDF, MJCF, SDF. Documents: part drawing (SVG), BOM (CSV), manufacturing package (zip with 3MF, STEP, per-part STL, drawing, BOM and check report).` },
  { id: 'viewport', title: 'Viewport and scene', body: `# Viewport and scene

- \`scene({ background, camera: { position, target, fov }, lights: [{ type, color, intensity, position }], fog, environment, ground, capture })\` — setting lights replaces the defaults; setting camera.position turns off auto-framing.
- \`cutPlane(name, normal, offset)\` adds a section plane.
- \`explodeView({ enabled, amountScale })\`
- \`Viewport.label(text, at, { color, background })\`, \`Viewport.highlight(target)\`
- \`mock(shape)\` shows a shape as context only: it is ghosted and left out of exports.
- \`compareWith(path)\` marks a reference file for the Compare mode.

## Inspect modes
Shaded, X-ray, Wireframe, Normals, Zebra, Mask, Colliders, Distance (click two points), Interference (assembly collisions in red), Thickness, Process. The View section also has Orbit, Home, Fit, the six view presets plus iso, Edges, and Perspective/Orthographic.` },
  { id: 'lib', title: 'Part library', body: `# Part library

- Stock: \`tube(ox, oy, oz, wall)\`, \`pipe(height, outerR, wall)\`, \`bracket(w, h, d, thick, holeDia)\`, \`holePattern(rows, cols, sx, sy, dia, depth)\`, \`tSlotExtrusion(length)\`, \`profile2020BSlot6(length)\`
- Fasteners: \`bolt(size, length, { head: socket|hex|button|flat, threaded })\`, \`nut(size)\`, \`washer(size)\`, \`thread(diameter, pitch, length)\`, \`fastenerSet(size, length)\`, \`boltPattern({ size, positions }).cut(shape, depth)\`, \`metric("M6")\` → diameter, pitch, tap drill and clearances
- Gears: \`spurGear({ module, teeth, faceWidth, pressureAngleDeg, backlash, boreDiameter, helixAngleDeg })\`, \`ringGear\`, \`rackGear\`, \`bevelGear\`, \`faceGear\`, \`sectorGear\`, \`gearPair\`, \`bevelGearPair\`, \`faceGearPair\`, \`gearRatio\`, \`rackRatio\`, \`planetaryRatio\`, \`gearBodies.disk/diskWithHub/spoked\`, \`driveWheel()\`
- Motion: \`beltDrive({ pulleys, pitch, beltWidth })\`, \`tangentLoop2d(circles)\`, \`pipeRoute\`, \`elbow\`, \`explode(items, { amount, mode })\`
- Wood: \`Wood.board\`, \`Wood.lumber("2x4", length)\`, \`Wood.plywood\`, \`Wood.tenon\`, \`Wood.mortise\`, \`Wood.dowelHole\`
- Sheet: \`Laser.sheet({ outline, thickness, kerf })\`, \`Laser.fingerJoint(length, { thickness })\`` },
  { id: 'agents', title: 'AI agents and MCP', body: `# AI agents and MCP

## In-app Agent
Open the Agent tab, add your Anthropic API key in Settings, and describe a change. The agent reads files, edits them, builds, checks \`verify.*\` results, looks at the viewport and repeats until done.

## MCP server
Witness CAD ships an MCP server so outside agents (Claude Code, Claude Desktop, others) use the same build-check-export loop.

\`\`\`bash
npm run mcp                 # stdio
npm run mcp -- --http 8787  # streamable HTTP at http://localhost:8787/mcp
claude mcp add witness-cad -- npx tsx mcp/server.ts
\`\`\`

Projects live in \`~/.witness-cad/projects\` (override with WITNESS_HOME).

Tools: read_docs, search_docs, list_projects, create_project, list_versions, create_draft, list_drafts, merge_draft, read_file, write_file, edit_file, save_version, build_model, build_variants, check_names, check_fit, check_assembly, check_joint_torque, check_strength, check_manufacturing, check_simready, simulate_model, check_hold, read_make_list, compare_versions, view_model, export_model, export_drawing, get_job.

Recommended loop: read the docs, pick or create a project, create a draft from a version, edit → build_model → checks → view_model until the acceptance criteria pass, then save_version (or merge_draft).` },
  { id: 'cli', title: 'Command line', body: `# Command line

\`\`\`bash
npm run cli -- build path/to/project            # build and print a summary
npm run cli -- export path/to/project --format 3mf --out model.3mf
npm run cli -- strength path/to/project          # run the first Fea study (or --study name); exit 1 below target
npm run cli -- strength part.forge.js --fix bottom --load top --newtons 500 --material aluminum6061T6
npm run cli -- check path/to/project            # exit code 1 when a verify check fails
npm run cli -- sim path/to/project --seconds 2   # rigid-body dynamics summary
npm run cli -- sim path/to/project --hold lid=0.3 --max-travel 3   # hold test, exit 1 if it gives
npm run cli -- params path/to/project --set Width=120
\`\`\`
A project path is a folder with \`main.forge.js\` (and any helper files) or a single \`.forge.js\` file.` },
];
