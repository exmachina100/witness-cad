# Witness CAD

Witness CAD is a React rebuild of [ForgeCAD](https://forgecad.io/): agentic, code-first parametric CAD that runs in the browser.

Models are written as JavaScript/TypeScript code, evaluated by a geometry kernel built on [manifold-3d](https://github.com/elalish/manifold), and rendered with three.js in a React UI with a CodeMirror editor.

## Status

Early development. The geometry kernel (solids, sketches, curves, assemblies, library) lives in `src/kernel/`.

## Getting started

```bash
npm install
npm run dev        # start the Vite dev server
npm test           # run the test suite
npm run typecheck  # type-check the project
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the app in development mode |
| `npm run build` | Type-check and build for production |
| `npm run preview` | Preview the production build |
| `npm test` | Run tests with Vitest |
| `npm run mcp` | Start the MCP server for agent access |
| `npm run cli` | Run the `witness` command line tool |

## Workflow

All work is committed, pushed and merged into `main`.
