// Plain-text build summary shared by the in-app agent, MCP server and CLI.
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

