# ForgeCAD parity audit (2026-11-24)

Source: every page indexed by forgecad.io/llms.txt (core, sketch, curves, assembly, output, lib,
sheet-metal, wood, viewport, concepts, the AI/agent pages, hosted outputs, and the seven guides).
Each documented identifier was probed against the Witness CAD runtime with `scripts/probe.ts`.
Top-level names already resolved before this pass; the gaps were in the classes those calls return,
and in workflow features described by the guides.

Status: [ ] open, [x] done, [~] done with a documented difference.

## A. Core API
- [x] Shape.materialProps, rotateAround, trimBySurface, onFace
- [x] ShapeRef (shape.ref(path)): path, resolve, kind, cardinality, status, faces/face, edges/edge, points/point, toJSON
- [x] ShapeSplitResult (split → inside/outside), ShapeSurfaceSplitResult (splitBySurface → positive/negative)
- [x] Transform instances: mul, translate, rotateAxis, rotateX/Y/Z, inverse, point, vector, toArray; Transform.scale
- [x] Path2DParamValue.closed/toStroke; Spline2DParamValue closed/degree/nodes/toPolyline/toCurveOnYZ/toCurveSegmentsOn*/toPathOnXY/toPathOnYZ
- [ ] Param number auto step (1/100 of range) and combination indexing; `{ combination: false }`

## B. Sketch API
- [x] Point2D, Line2D (+ statics), Circle2D, Rectangle2D (+ statics, side, vertex, diagonals, toSketch, extrude)
- [x] Sketch.cross

## C. Curves and surfaces
- [x] Curve3D props (points, tension); NurbsCurve3D props (controlPoints, weights, knots, degree); helix props (radius, pitch, turns, height, startAngle, clockwise, ports)
- [x] Sheet: edges and curves, curveAlong*/pathAlong*, pointAt/normalAt/frameAt/framePerpendicularTo*, curvatureAt, thickenInsideBy, matchEdge, surface (NurbsSurface)
- [x] NurbsSurface: controlGrid, weightsGrid, knots, degrees, nU/nV, domain, pointAt, normalAt, derivativesAt
- [x] CurveNetBuilder (Surface.Net/BoundaryNet builder form), MatchEdgeBuilder (toG0/1/2), Curve.Bridge builder (bulge, g0/g1/g2)
- [x] SurfaceComplexBuilder (patch, join, bridge, parts, toGroup, surfaceParts, toSurfaceGroup, toSolid, toSewnSolid, report)
- [x] Sculpt control cage: faces, movePoint, setPoint, editPoints, toShape
- [x] Product builders: skin(name).axis().stations().build(), station(name).oval()/superEllipse()/roundedRect()/circle()/custom(), panel(name) builder, ribbon(name) builder, Product.profiles.*
- [x] Carriers: Carrier.cylinder/plane builders (diameter, height, size, anchor, path, pointAt, frameAt, mirror*, bounds, offset); ProductSkinCarrier side transitions
- [x] SurfaceBody(name) builder: carrier, member (plate/band/at/size/path/section/cap/slot/cutout/anchorAt/features/profile/mirrorOf), join, autoJoinAtSharedAnchors, build, buildWithDiagnostics, buildDebug; SurfaceMembers.counterbore/roundedSlot builders
- [x] Loft.pathOnXz

## D. Assemblies and mechanisms
- [x] SolvedAssembly.bomCsv (documented as removed: throws)
- [ ] Assembly steps: removal-direction check (ASSEMBLY.STEP.PASSES_THROUGH, ASSEMBLY.NO_STEPS) in check_assembly; explode along steps; build guide (instructions PDF in the manufacturing package)
- [ ] `sim mechanism` CLI: DOF, static hold load per driven joint, effort margin (--min-torque-margin-pct)

## E. Library / fabrication
- [x] TangentLoop2D class (circles, mode, segments, straightSpans, wraps, wrapByPulley, length, toJointPath, toSketch, toProfile, offsetBand)
- [x] FlatPart class (Laser.panel/part) and LaserKit getters; Laser.kit() with no options
- [x] WoodBoard class (shape, width, height, thickness, grain, species, material, cut, transforms)

## F. Viewport and scenes
- [ ] scene(): views, journeys, environment presets, fog, capture, jointOverlay, postProcessing accepted (inactive, as in ForgeCAD)
- [ ] Named views and journeys in the viewer

## G. Variants
- [ ] Combination index over all params: `run --combination N`, `check combinations` (all ≤100, else pairwise + last + 20 random), `check variants`
- [ ] `?variant=` URL selection; Combination control in the Params panel

## H. Agent / MCP / hosted API
- [ ] maxCredits / maxDurationSeconds / creditsUsed on checks (local: duration cap, credits reported as 0)
- [ ] requestId idempotency on create_draft/save_version; create_draft fromDraftId; MCP command history
- [ ] generate_image_asset (procedural texture generator when no image model is configured)
- [ ] Hosted HTTP API (/api/v1): capabilities, openapi.json, output-quotes, output-runs (+items, cancel), artifact download, capture/video quotes, upload sessions
