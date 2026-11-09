# Witness CAD

Code-first parametric CAD in the browser. You write a model in JavaScript (`main.forge.js`), and Witness CAD builds it with a WASM solid kernel, shows it in a 3D viewport, checks it and exports it for printing, machining or robot simulation. AI agents use the same build-check-look loop through the built-in Agent panel or the MCP server.

```js
const w = Param.number("Width", 60, { min: 20, max: 200, unit: "mm" });
const plate = fillet(box(w, 40, 4), 2);
const holes = circularPattern(cylinder(5, 1.6).translate(w / 2 - 6, 0, -1), 4);
verify.greaterThan("wide enough", w, 30);
return plate.subtract(holes);
```

## Run it

```bash
npm install
npm run dev        # web app at http://localhost:5173
npm run build      # static site in dist/
npm test           # kernel, examples, renderer and store tests
```

Everything runs locally. Projects, versions, drafts and artifacts are kept in the browser (localStorage); Share creates a link that carries the whole project.

## What is in the app

- **Home**: projects, inbox (open drafts), shared, favorites, examples, trash; grid or list, search, sort; light, dark or system theme.
- **Workspace top bar**: project name, version and draft picker, file search (⌘P), auto-build, rebuild (⌘↵), Run tests, screenshot, turntable video, Export, Share, help.
- **Left rail**: Files (tree, root file, folders, import alias), Agent (Claude tool-use loop with your API key), Params (sliders, choices, joints, poses), 2D views (live slices and projections, SVG/DXF), Make (parts by process, BOM, drawings, manufacturing package), Artifacts (renders, videos, exports, uploads), Inspect (view presets, 11 inspect modes, section plane, objects, timeline, explode, animations, simulation, interference, joint torque) and a Strength tab (finite element studies with a von Mises stress plot and deformed shape).
- **Viewport**: orbit/pan/zoom, 3D or flat, view presets, edges, measure, section, selection card with size/volume/area, joint sliders.
- **Editor**: Monaco with API completions and inline build errors, tabs, console.

## Modelling API

Globals, no imports. Units are millimetres and degrees, Z is up, and `box()` is centred in XY and sits on z = 0.

- Solids: `box`, `roundedBox`, `cylinder`, `cone`, `sphere`, `torus`, `wedge`, `polyhedron`, `hull`, booleans, `fillet`, `chamfer`, `draft`, `shell`, `hole`, `pocket`, `boss`, patterns, mirror, split/trim, face and edge queries.
- Sketches: `rect`, `circle2d`, `roundedRect`, `polygon`, `ngon`, `slot`, `path()` builder, `constrainedSketch()` with a solver, `text2d`, offsets, extrude/revolve/loft/sweep.
- Curves: lines, arcs, NURBS, splines, helices, 3D routes and tubes.
- Assemblies: connectors, `assembly().addPart().connect()` with fixed, revolute, prismatic and other joints, coupled joints, poses, animations, springs, cables, collision and torque checks.
- Simulation and analysis: physical materials, mass properties, rigid-body dynamics (gravity, convex-hull contacts with friction and restitution, ground plane, joints as constraints with limits, servo/velocity/spring drives, free bases and closed loops), drop and hold tests, a joint-space preview, and linear static finite element analysis (`Fea.study.staticStress`: fixtures, force/pressure/torque/gravity loads, von Mises stress, displacement, safety factor). `npm run cli -- strength <project>` runs it from the command line.
- Output: `verify.*` checks, `bom()`, `dim()`, labels, cut planes, exploded views.
- Library: fasteners, gears (spur, ring, rack, bevel, face, planetary), pipes, T-slot extrusions, belt drives, wood joints, laser-cut parts.

Full reference: open **Docs** in the app.

## Export formats

3MF, STL (binary and ASCII), GLB, OBJ, PLY, STEP (exact B-rep), USD, URDF, MJCF (MuJoCo), SDF (Gazebo), part drawing SVG, BOM CSV and a manufacturing package zip.

## MCP server

```bash
npm run mcp                   # stdio
npm run mcp -- --http 8787    # streamable HTTP at http://localhost:8787/mcp
claude mcp add witness-cad -- npx tsx /path/to/witness-cad/mcp/server.ts
```

Projects live in `~/.witness-cad/projects` (set `WITNESS_HOME` to move them). Tools: `read_docs`, `search_docs`, `list_projects`, `create_project`, `list_versions`, `create_draft`, `list_drafts`, `merge_draft`, `read_file`, `write_file`, `edit_file`, `save_version`, `build_model`, `build_variants`, `check_names`, `check_fit`, `check_assembly`, `check_joint_torque`, `check_strength`, `check_manufacturing`, `check_simready` (includes a short dynamics run), `simulate_model`, `check_hold`, `read_make_list`, `compare_versions`, `view_model` (PNG from a headless renderer), `export_model`, `export_drawing`, `get_job`.

## Command line

```bash
npm run cli -- build path/to/project
npm run cli -- check path/to/project --set Width=120      # exit 1 on failed checks
npm run cli -- export path/to/project --format 3mf --out part.3mf
npm run cli -- render path/to/project --view iso --out part.png
npm run cli -- params path/to/project
npm run cli -- sim path/to/project --seconds 2 --target shoulder=80   # rigid-body dynamics
npm run cli -- sim path/to/project --hold open=-0.3 --max-travel 3    # hold test
```

## Limits

The kernel is mesh-based (Manifold). STEP export rebuilds exact surfaces for planes, cylinders, cones, spheres and tori (boxes, cylinders, spheres, holes, extrusions and revolves of sketches, and booleans of these), with exact lines and circles and fitted B-spline edges where two curved surfaces cross. Rounded boxes, whole-solid fillets and offsets come out as planes, cylinders and spheres; stretched (non-uniformly scaled) shapes as exact rational B-spline surfaces; curved sketch outlines and text as B-spline walls; sweeps, pipes and lofts as smooth B-spline patches through the swept sections. Hulls and anything else the exporter cannot trace are written as flat facets inside the same B-rep. Strength studies are a real linear static FEA on a voxel hexahedral mesh, so curved and sloped faces are approximated by steps of one element (refine with `Fea.mesh.hex({ size })`); there is no contact, plasticity or buckling. The rigid-body simulator uses convex-hull colliders (concave parts collide as their hull unless split with `Sim.collider.pieces()`), so treat it as a design check and use the MJCF export with MuJoCo for high-fidelity contact work.

## Layout

```
src/kernel   solid kernel, sketches, curves, assemblies, sim, params, runtime
src/export   mesh, CAD, robot and document exporters
src/render   headless PNG renderer
src/app      React app (store, worker, viewport, editor, agent, UI)
src/docs     in-app documentation
mcp          MCP server and on-disk project store
cli          command line
tests        vitest suites
```

## Workflow

All work is committed, pushed and merged into `main`.
