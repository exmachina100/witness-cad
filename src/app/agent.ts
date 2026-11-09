// In-app Agent: a Claude tool-use loop that edits project files, builds, checks and looks at the model.
import { DOCS_INDEX, readDoc, searchDocs } from '../docs';

export interface AgentHost {
  listFiles(): string[];
  readFile(path: string): string | undefined;
  writeFile(path: string, content: string): void;
  build(): Promise<any>;
  screenshot(): string; // data URL png
  setParams(values: Record<string, any>): void;
  exportModel(format: string): Promise<string>;
  saveVersion(name: string): void;
}

export interface ChatMessage { role: 'user' | 'assistant'; content: any }
export interface AgentEvent { kind: 'text' | 'tool' | 'result' | 'error' | 'done'; text?: string; tool?: string; input?: any; output?: string; image?: string }

const TOOLS = [
  { name: 'list_files', description: 'List all files in the project.', input_schema: { type: 'object', properties: {} } },
  { name: 'read_file', description: 'Read a project file.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or overwrite a project file with the full content.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Replace one exact occurrence of old_string with new_string in a file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } },
  { name: 'build_model', description: 'Build the model. Returns errors, warnings, verify checks, params, objects with sizes and volumes, and BOM.', input_schema: { type: 'object', properties: {} } },
  { name: 'view_model', description: 'Render the current viewport as an image so you can look at the model.', input_schema: { type: 'object', properties: {} } },
  { name: 'set_params', description: 'Set parameter values (by name) and rebuild.', input_schema: { type: 'object', properties: { values: { type: 'object' } }, required: ['values'] } },
  { name: 'export_model', description: 'Export the model. format: 3mf, stl, glb, obj, step, usd, urdf, mjcf, sdf, drawing, bom, package.', input_schema: { type: 'object', properties: { format: { type: 'string' } }, required: ['format'] } },
  { name: 'save_version', description: 'Save the current files as a named version.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'read_docs', description: 'Read a Witness CAD documentation page. Pages: ' + DOCS_INDEX.map((d) => d.id).join(', '), input_schema: { type: 'object', properties: { page: { type: 'string' } }, required: ['page'] } },
  { name: 'search_docs', description: 'Search the Witness CAD docs.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
];

const SYSTEM = `You are the Witness CAD agent. You design parts and assemblies by editing JavaScript model files (*.forge.js) in the user's project.
Rules: units are millimetres and degrees, Z is up; box(w,d,h) is centred in XY and sits on z=0. API functions are globals (no imports). Use Param.* for dimensions the user may tweak. Scripts must end with a return of a shape, group, assembly, array or {name: shape} map. Add verify.* checks for requirements.
Loop: read the files, make focused edits, call build_model, fix any errors, call view_model to look at the result, and repeat until the request is met. Read docs when unsure of a signature. Finish with a short summary of what changed.`;

export function summarizeBuild(r: any) {
  if (!r) return 'no result';
  const lines: string[] = [];
  lines.push(r.ok ? `Built OK in ${Math.round(r.timeMs)} ms.` : `Build FAILED: ${r.error?.message}${r.error?.line ? ` (${r.error.file}:${r.error.line})` : ''}`);
  for (const w of r.warnings ?? []) lines.push(`warning: ${w}`);
  if (r.params?.length) lines.push('params: ' + r.params.map((p: any) => `${p.name}=${JSON.stringify(p.value)}`).join(', '));
  for (const o of r.objects ?? []) if (o.stats) {
    const s = o.stats.bbox.max.map((v: number, i: number) => (v - o.stats.bbox.min[i]).toFixed(2)).join(' x ');
    lines.push(`object "${o.name}": size ${s} mm, volume ${o.stats.volume.toFixed(1)} mm³${o.part ? `, part of ${o.assembly}` : ''}`);
  } else lines.push(`object "${o.name}" (${o.kind})`);
  for (const c of r.checks ?? []) lines.push(`${c.pass ? 'PASS' : 'FAIL'} ${c.label}${c.message ? ': ' + c.message : ''}`);
  for (const a of r.assemblies ?? []) lines.push(`assembly ${a.name}: joints ${a.joints.map((j: any) => `${j.name}(${j.type} ${j.min ?? ''}..${j.max ?? ''})`).join(', ')}${a.warnings.length ? '; warnings: ' + a.warnings.join('; ') : ''}`);
  if (r.bom?.length) lines.push('bom: ' + r.bom.map((b: any) => `${b.quantity} × ${b.description}`).join('; '));
  for (const l of (r.logs ?? []).slice(-20)) lines.push(`console.${l.level}: ${l.message}`);
  return lines.join('\n');
}

export async function runAgent(opts: { apiKey: string; model: string; history: ChatMessage[]; host: AgentHost; onEvent: (e: AgentEvent) => void; signal?: AbortSignal; maxTurns?: number }) {
  const messages: ChatMessage[] = [...opts.history];
  for (let turn = 0; turn < (opts.maxTurns ?? 24); turn++) {
    if (opts.signal?.aborted) break;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: opts.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: opts.model, max_tokens: 8000, system: SYSTEM, tools: TOOLS, messages }),
    });
    if (!res.ok) {
      const t = await res.text();
      opts.onEvent({ kind: 'error', text: `API error ${res.status}: ${t.slice(0, 400)}` });
      return messages;
    }
    const data = await res.json();
    messages.push({ role: 'assistant', content: data.content });
    const toolResults: any[] = [];
    for (const block of data.content) {
      if (block.type === 'text' && block.text.trim()) opts.onEvent({ kind: 'text', text: block.text });
      if (block.type === 'tool_use') {
        opts.onEvent({ kind: 'tool', tool: block.name, input: block.input });
        let content: any;
        try { content = await runTool(block.name, block.input, opts.host); }
        catch (e: any) { content = `error: ${e.message}`; }
        const text = typeof content === 'string' ? content : undefined;
        opts.onEvent({ kind: 'result', tool: block.name, output: text?.slice(0, 2000), image: typeof content === 'object' && content.image ? content.image : undefined });
        toolResults.push({
          type: 'tool_result', tool_use_id: block.id,
          content: typeof content === 'object' && content.image
            ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: content.image.split(',')[1] } }, { type: 'text', text: 'Current viewport.' }]
            : String(content),
        });
      }
    }
    if (data.stop_reason !== 'tool_use' || !toolResults.length) break;
    messages.push({ role: 'user', content: toolResults });
  }
  opts.onEvent({ kind: 'done' });
  return messages;
}

async function runTool(name: string, input: any, host: AgentHost): Promise<any> {
  switch (name) {
    case 'list_files': return host.listFiles().join('\n');
    case 'read_file': { const c = host.readFile(input.path); if (c == null) throw new Error(`no file ${input.path}`); return c; }
    case 'write_file': host.writeFile(input.path, input.content); return `wrote ${input.path} (${input.content.length} chars)`;
    case 'edit_file': {
      const c = host.readFile(input.path);
      if (c == null) throw new Error(`no file ${input.path}`);
      const n = c.split(input.old_string).length - 1;
      if (n !== 1) throw new Error(`old_string must occur exactly once (found ${n})`);
      host.writeFile(input.path, c.replace(input.old_string, input.new_string));
      return `edited ${input.path}`;
    }
    case 'build_model': return summarizeBuild(await host.build());
    case 'view_model': return { image: host.screenshot() };
    case 'set_params': host.setParams(input.values); return summarizeBuild(await host.build());
    case 'export_model': return host.exportModel(input.format);
    case 'save_version': host.saveVersion(input.name); return `saved version "${input.name}"`;
    case 'read_docs': return readDoc(input.page) ?? `no page "${input.page}"`;
    case 'search_docs': return searchDocs(input.query).map((h) => `${h.page}: ${h.snippet}`).join('\n') || 'no matches';
    default: throw new Error(`unknown tool ${name}`);
  }
}
