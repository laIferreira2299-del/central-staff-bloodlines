// Etapa 2B · aprovação de procedimentos (documento 01, Decisão 2 e 10.3).
//   #/propostas        fila de quem aprova (procedimentos.aprovar) + "Minhas propostas" do autor
//   #/propostas/<id>   o que muda (antes e depois), prévia, aprovar, recusar com motivo, cancelar
import { h, icon, toast } from '../dom.js';
import { confirmDialog, openDialog } from '../modal.js';
import { AUDIENCES, STATUS_LABELS, formatDate } from '../components.js';
import { CONTENT_FIELDS, PROPOSAL_NOTE_MAX, PROPOSAL_STATUS_LABELS } from '../../core/workflow.js';
import { procedureBody } from './procedure.js';
import { renderMessage } from './message.js';

const FIELD_LABELS = {
  title: 'Título', slug: 'Endereço (slug)', category: 'Categoria', audience: 'Público', tags: 'Tags',
  summary: 'Resumo', who_handles: 'Quem atende', steps: 'Passos', commands: 'Comandos',
  ready_message: 'Mensagem pronta', notes: 'Observações', source_url: 'Link da fonte', status: 'Status',
};

/** Valor de um campo em texto simples (para a comparação antes e depois). */
function asText(field, value) {
  if (field === 'steps') return (value ?? []).map((s, i) => `${i + 1}. ${s.title}${s.body ? `\n${s.body}` : ''}`).join('\n\n');
  if (field === 'commands') return (value ?? []).map((c) => `${c.command}${c.description ? ` · ${c.description}` : ''}`).join('\n');
  if (field === 'tags') return (value ?? []).join(', ');
  if (field === 'audience') return AUDIENCES[value]?.label ?? value ?? '';
  if (field === 'status') return STATUS_LABELS[value] ?? value ?? '';
  return value ?? '';
}

const statusBadge = (status) => h('span', {
  class: `badge ${status === 'pendente' ? 'badge--revisar' : status === 'aprovada' ? 'badge--suporte' : 'badge--status'}`,
}, PROPOSAL_STATUS_LABELS[status] ?? status);

const canUse = (app) => app.feature('aprovacao') && (app.can('procedimentos.editar') || app.can('procedimentos.aprovar'));

function proposalRow(app, p) {
  const current = p.procedure_id ? app.state.procedures.find((x) => x.id === p.procedure_id) : null;
  return h('li', { class: 'staff-row', dataset: { proposalId: p.id } },
    h('div', { class: 'staff-who' },
      h('p', { class: 'staff-name' }, h('a', { class: 'staff-link', href: `#/propostas/${p.id}` }, p.data.title)),
      h('p', { class: 'staff-meta' },
        p.procedure_id ? `Edição${current && current.title !== p.data.title ? ` de "${current.title}"` : ''}` : 'Procedimento novo',
        ` · ${p.created_by_name ?? p.created_by} · ${formatDate(p.created_at, { time: true })}`)),
    h('div', { class: 'staff-tags' }, statusBadge(p.status)));
}

export function renderProposals(app) {
  if (!canUse(app)) {
    renderMessage(app, { title: 'Acesso restrito', text: 'Seu cargo não envia nem aprova procedimentos.' });
    return null;
  }
  let alive = true;
  const approver = app.can('procedimentos.aprovar');
  const me = app.state.staff.discord_id;
  const body = h('div', {}, h('p', { class: 'panel-text' }, 'Carregando…'));
  const empty = (text) => h('li', { class: 'staff-empty' }, text);

  app.els.main.replaceChildren(h('div', { class: 'main-inner proposals-page' },
    h('a', { class: 'back', href: '#/' }, icon('arrow-left'), 'Voltar para a lista'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, approver ? 'Aprovação de procedimentos' : 'Minhas propostas'),
      h('p', { class: 'page-sub' }, approver
        ? 'Procedimentos novos e edições enviados por quem não publica direto. Só aparecem para todos depois de aprovados; a versão publicada continua no ar até lá.'
        : 'O que você enviou para aprovação. Um Head Staff ou acima confere antes de aparecer para todos.')),
    body));

  (async () => {
    const result = await app.adapter.listProposals();
    if (!alive) return;
    if (result.error) { app.reportError(result.error, 'Não foi possível carregar as propostas.'); body.replaceChildren(); return; }
    const all = result.data;
    const pending = all.filter((p) => p.status === 'pendente').sort((a, b) => a.created_at.localeCompare(b.created_at));
    const reviewed = all.filter((p) => p.status === 'aprovada' || p.status === 'recusada').slice(0, 20);
    const mine = all.filter((p) => p.created_by === me);
    body.replaceChildren(...[
      approver && h('section', { class: 'panel', 'aria-labelledby': 'queue-title' },
        h('h2', { class: 'block-title', id: 'queue-title' }, icon('checklist'), `Aguardando aprovação (${pending.length})`),
        h('ul', { class: 'staff-list', id: 'proposal-queue' }, pending.length ? pending.map((p) => proposalRow(app, p)) : empty('Nenhuma proposta pendente.'))),
      (!approver || mine.length > 0) && h('section', { class: 'panel', 'aria-labelledby': 'mine-title' },
        h('h2', { class: 'block-title', id: 'mine-title' }, icon('send'), 'Minhas propostas'),
        h('ul', { class: 'staff-list', id: 'proposal-mine' }, mine.length ? mine.map((p) => proposalRow(app, p)) : empty('Você ainda não enviou propostas.'))),
      approver && h('section', { class: 'panel', 'aria-labelledby': 'done-title' },
        h('h2', { class: 'block-title', id: 'done-title' }, icon('history'), 'Analisadas recentemente'),
        h('ul', { class: 'staff-list', id: 'proposal-done' }, reviewed.length ? reviewed.map((p) => proposalRow(app, p)) : empty('Nenhuma proposta analisada ainda.'))),
    ].filter(Boolean));
  })();
  return () => { alive = false; };
}

export function renderProposal(app, id) {
  if (!canUse(app)) {
    renderMessage(app, { title: 'Acesso restrito', text: 'Seu cargo não envia nem aprova procedimentos.' });
    return null;
  }
  let alive = true;
  const title = h('h1', { class: 'page-title', tabindex: '-1' }, 'Proposta');
  const body = h('div', {}, h('p', { class: 'panel-text' }, 'Carregando…'));
  app.els.main.replaceChildren(h('div', { class: 'main-inner proposal-page' },
    h('a', { class: 'back', href: '#/propostas' }, icon('arrow-left'), 'Voltar para as propostas'),
    h('header', { class: 'page-head' }, title),
    body));

  async function load() {
    const result = await app.adapter.listProposals();
    if (!alive) return;
    if (result.error) { app.reportError(result.error); return; }
    const p = result.data.find((x) => x.id === id);
    if (!p) {
      title.textContent = 'Proposta não encontrada';
      body.replaceChildren(h('p', { class: 'panel-text' }, 'Ela pode ser de outra pessoa ou ter sido removida.'));
      return;
    }
    render(p);
  }

  function render(p) {
    const current = p.procedure_id ? app.state.procedures.find((x) => x.id === p.procedure_id) : null;
    const pending = p.status === 'pendente';
    const approver = app.can('procedimentos.aprovar');
    const mine = p.created_by === app.state.staff.discord_id;
    title.textContent = p.data.title;

    const changes = current
      ? [...CONTENT_FIELDS, 'status'].filter((f) => asText(f, current[f]) !== asText(f, p.data[f]))
      : [];
    const outdated = pending && current && current.version !== p.base_version;

    body.replaceChildren(...[
      h('div', { class: 'proc-badges', id: 'proposal-badges' }, statusBadge(p.status),
        h('span', { class: 'badge badge--status' }, p.procedure_id ? 'Edição' : 'Procedimento novo')),
      h('p', { class: 'staff-meta', id: 'proposal-meta' },
        `Enviada por ${p.created_by_name ?? p.created_by} em ${formatDate(p.created_at, { time: true })}.`,
        current && [' Procedimento: ', h('a', { href: `#/p/${current.slug}` }, current.title), ` (versão ${p.base_version} quando a proposta foi feita).`]),
      p.reviewed_at && h('div', { class: `banner ${p.status === 'recusada' ? 'banner--warn' : 'banner--ok'}`, id: 'proposal-review' },
        icon(p.status === 'recusada' ? 'x' : 'check'),
        h('p', {}, `${PROPOSAL_STATUS_LABELS[p.status]} por ${p.reviewed_by_name ?? p.reviewed_by} em ${formatDate(p.reviewed_at, { time: true })}.`,
          p.review_note && [h('br'), h('strong', {}, 'Motivo: '), p.review_note])),
      outdated && h('div', { class: 'banner banner--warn', id: 'proposal-outdated' }, icon('alert-triangle'),
        h('p', {}, `⚠ O procedimento mudou depois desta proposta (agora está na versão ${current.version}). Aprovar substitui o conteúdo atual pelo da proposta; confira as diferenças abaixo.`)),
      pending && h('div', { class: 'panel-actions', id: 'proposal-actions' },
        approver && h('button', { type: 'button', class: 'btn btn--primary', id: 'proposal-approve', 'data-requires-online': '', onclick: () => approve(p) }, icon('check'), 'Aprovar e publicar'),
        approver && h('button', { type: 'button', class: 'btn btn--danger', id: 'proposal-reject', 'data-requires-online': '', onclick: () => reject(p) }, icon('x'), 'Recusar'),
        mine && h('button', { type: 'button', class: 'btn btn--ghost', id: 'proposal-cancel', 'data-requires-online': '', onclick: () => cancel(p) }, 'Cancelar proposta')),
      current && h('section', { class: 'panel', 'aria-labelledby': 'diff-title' },
        h('h2', { class: 'block-title', id: 'diff-title' }, icon('arrows-diff'), changes.length ? `O que muda (${changes.length})` : 'O que muda'),
        changes.length
          ? h('dl', { class: 'diff-list', id: 'proposal-diff' }, changes.map((f) => h('div', { class: 'diff-item' },
            h('dt', {}, FIELD_LABELS[f] ?? f),
            h('dd', { class: 'diff-before' }, h('span', { class: 'diff-tag' }, 'Antes'), h('pre', {}, asText(f, current[f]) || '(vazio)')),
            h('dd', { class: 'diff-after' }, h('span', { class: 'diff-tag' }, 'Depois'), h('pre', {}, asText(f, p.data[f]) || '(vazio)')))))
          : h('p', { class: 'panel-text' }, 'O conteúdo proposto é igual ao publicado agora.')),
      h('section', { class: 'panel', 'aria-labelledby': 'p-preview-title' },
        h('h2', { class: 'block-title', id: 'p-preview-title' }, icon('eye'), 'Como vai ficar'),
        h('div', { class: 'proposal-preview' }, procedureBody({ ...p.data, last_reviewed_at: null }, { headingLevel: 2, idPrefix: 'prop' }))),
    ].filter(Boolean));
    app.applyOnline();
  }

  async function approve(p) {
    const ok = await confirmDialog({
      title: 'Aprovar e publicar?',
      message: p.procedure_id ? 'A edição passa a valer para todos agora (a versão anterior fica no histórico).' : 'O procedimento passa a aparecer para todos agora.',
      confirmLabel: 'Aprovar e publicar',
    });
    if (!ok || !alive) return;
    const r = await app.adapter.reviewProposal(p.id, { approve: true });
    if (r.error) {
      if (r.error.code === 'VALIDATION') toast(r.error.details?.errors?._ ?? Object.values(r.error.details?.errors ?? {})[0] ?? r.error.message, 5000);
      else app.reportError(r.error, 'Não foi possível aprovar.');
      return;
    }
    await app.reload();
    toast('Proposta aprovada e publicada.');
    const proc = app.state.procedures.find((x) => x.id === r.data.procedure_id);
    app.router.go(proc ? `#/p/${proc.slug}` : '#/propostas');
  }

  async function reject(p) {
    const note = h('textarea', { class: 'input', id: 'reject-note', rows: 4, maxlength: PROPOSAL_NOTE_MAX, 'aria-describedby': 'reject-hint' });
    const choice = await openDialog({
      title: 'Recusar proposta',
      body: h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'reject-note' }, 'Motivo (o autor vai ler) *'),
        note,
        h('p', { class: 'field-hint', id: 'reject-hint' }, `Explique o que precisa mudar. Até ${PROPOSAL_NOTE_MAX} caracteres.`)),
      actions: [
        { label: 'Cancelar', value: false, variant: 'ghost' },
        { label: 'Recusar proposta', value: true, variant: 'danger' },
      ],
    });
    if (!choice || !alive) return;
    const text = note.value.trim();
    if (!text) { toast('Escreva o motivo da recusa (o autor vai ler).', 4000); return; }
    const r = await app.adapter.reviewProposal(p.id, { approve: false, note: text });
    if (r.error) { app.reportError(r.error, 'Não foi possível recusar.'); return; }
    toast('Proposta recusada. O autor vai ver o motivo.');
    await app.refreshCounts();
    await load();
  }

  async function cancel(p) {
    const ok = await confirmDialog({ title: 'Cancelar a proposta?', message: 'Ela sai da fila de aprovação.', confirmLabel: 'Cancelar proposta', cancelLabel: 'Voltar', danger: true });
    if (!ok || !alive) return;
    const r = await app.adapter.cancelProposal(p.id);
    if (r.error) { app.reportError(r.error, 'Não foi possível cancelar.'); return; }
    toast('Proposta cancelada.');
    await load();
  }

  load();
  return () => { alive = false; };
}
