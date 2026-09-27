// Exportação em Markdown: um único .md com todos os procedimentos (decisão em DECISIONS.md).
// Função pura: recebe os dados do exportAll().

const AUDIENCE_LABELS = { suporte: 'Suporte', moderador: 'Moderação', ambos: 'Suporte + Moderação', allowlist: 'Allowlist' };
const STATUS_LABELS = { ativo: 'Ativo', revisar: 'Revisar', arquivado: 'Arquivado' };

/** Cerca de código que não colide com crases do próprio texto. */
function fence(text) {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
}

const indent = (text, spaces) => String(text).split('\n').map((l) => (l ? ' '.repeat(spaces) + l : l)).join('\n');
const date = (iso) => (iso ? iso.slice(0, 10) : null);

export function procedureToMarkdown(p) {
  const lines = [`# ${p.title}`, ''];
  const meta = [
    ['Categoria', p.category],
    ['Público', AUDIENCE_LABELS[p.audience] ?? p.audience],
    ['Status', STATUS_LABELS[p.status] ?? p.status],
    ['Tags', (p.tags ?? []).join(', ')],
    ['Quem atende', p.who_handles],
    ['Fonte', p.source_url],
    ['Última revisão', date(p.last_reviewed_at)],
    ['Endereço', `#/p/${p.slug}`],
  ].filter(([, v]) => v);
  for (const [k, v] of meta) lines.push(`- **${k}:** ${v}`);

  lines.push('', '## Quando usar', '', p.summary ?? '', '', '## Passo a passo', '');
  (p.steps ?? []).forEach((s, i) => {
    lines.push(`${i + 1}. **${s.title}**`);
    if (s.body) lines.push('', indent(s.body, 3));
    lines.push('');
  });

  if (p.commands?.length) {
    lines.push('## Comandos', '');
    for (const c of p.commands) lines.push(`- \`${c.command}\`${c.description ? `: ${c.description}` : ''}`);
    lines.push('');
  }
  if (p.ready_message) {
    const f = fence(p.ready_message);
    lines.push('## Mensagem pronta', '', `${f}text`, p.ready_message, f, '');
  }
  if (p.notes) lines.push('## Observações', '', p.notes, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * @param {{ exported_at: string, procedures: object[] }} payload
 */
export function exportToMarkdown(payload) {
  const procs = payload.procedures ?? [];
  const header = [
    '# Central de Procedimentos da Staff · Bloodlines RP',
    '',
    `Exportado em ${date(payload.exported_at) ?? ''} · ${procs.length} ${procs.length === 1 ? 'procedimento' : 'procedimentos'}.`,
    '',
  ].join('\n');
  return [header, ...procs.map(procedureToMarkdown)].join('\n---\n\n');
}
