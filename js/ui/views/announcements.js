// Etapa 11 · avisos para a equipe (documento 01, seção 7).
//   Todos: lista dos avisos para o seu cargo, "Marcar como lido" e "Li e entendi".
//   avisos.enviar: criar, editar e apagar avisos, e o relatório de leitura (quem leu e quem não).
// Importante = faixa no topo até abrir; urgente = janela ao entrar (app.js).
// Envio para o Discord: Etapa 7 (Decisão 11 / 10.3).
import { h, icon, toast } from '../dom.js';
import { confirmDialog } from '../modal.js';
import { formatDate, roleBadge } from '../components.js';
import { ROLE_CODES, roleLabel } from '../../core/permissions.js';
import { ANNOUNCEMENT_LIMITS, PRIORITIES, isAnnouncementFor, priorityLabel, validateAnnouncement } from '../../core/workflow.js';
import { renderMarkdownInto } from '../../core/render-md.js';
import { toLocalInput } from './evaluations.js';
import { renderMessage } from './message.js';

const PRIORITY_CLASS = { normal: 'badge--status', importante: 'badge--revisar', urgente: 'badge--urgent' };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

export function renderAnnouncements(app) {
  if (!app.feature('avisos')) {
    renderMessage(app, { title: 'Avisos', text: 'Os avisos aparecem aqui depois da atualização do banco.' });
    return null;
  }
  const sender = app.can('avisos.enviar');
  let alive = true;
  let editing = null; // aviso sendo editado (null = novo)
  const listEl = h('div', { class: 'ann-list', id: 'ann-list' }, h('p', { class: 'panel-text' }, 'Carregando…'));
  const formHost = h('div', {});

  app.els.main.replaceChildren(h('div', { class: 'main-inner ann-page' },
    h('a', { class: 'back', href: '#/' }, icon('arrow-left'), 'Voltar para a lista'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Avisos'),
      h('p', { class: 'page-sub' }, sender
        ? 'Crie avisos para toda a equipe ou para cargos escolhidos e acompanhe quem já leu.'
        : 'Avisos da Direção para a sua equipe.')),
    sender && formHost,
    h('section', { class: 'panel', 'aria-labelledby': 'ann-list-title' },
      h('h2', { class: 'block-title', id: 'ann-list-title' }, icon('bell'), sender ? 'Todos os avisos' : 'Para você'),
      listEl)));

  /* ---------- formulário (avisos.enviar) ---------- */
  function renderForm() {
    const a = editing;
    const now = new Date();
    const titleIn = h('input', { class: 'input', id: 'ann-title', maxlength: ANNOUNCEMENT_LIMITS.title, value: a?.title ?? '' });
    const bodyIn = h('textarea', { class: 'input', id: 'ann-body', rows: 5, maxlength: ANNOUNCEMENT_LIMITS.body }, a?.body ?? '');
    const prioritySel = h('select', { class: 'input', id: 'ann-priority' },
      PRIORITIES.map((p) => h('option', { value: p.code, selected: p.code === (a?.priority ?? 'normal') }, p.label)));
    const allIn = h('input', { type: 'checkbox', id: 'ann-all', checked: !a?.audience_roles?.length });
    const roleBoxes = ROLE_CODES.map((r) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', value: r, id: `ann-role-${r}`, checked: a?.audience_roles?.includes(r) ?? false, disabled: !a?.audience_roles?.length }), roleLabel(r)));
    allIn.addEventListener('change', () => { for (const l of roleBoxes) l.querySelector('input').disabled = allIn.checked; });
    const startIn = h('input', { class: 'input', id: 'ann-start', type: 'datetime-local', value: toLocalInput(a?.starts_at ?? now.toISOString()) });
    const endIn = h('input', { class: 'input', id: 'ann-end', type: 'datetime-local', value: a?.ends_at ? toLocalInput(a.ends_at) : '' });
    const ackIn = h('input', { type: 'checkbox', id: 'ann-ack', checked: a?.requires_ack ?? false });
    const errorEl = h('p', { class: 'field-error form-general-error', role: 'alert', tabindex: '-1', hidden: true });
    const errs = {};
    const fieldErr = (key) => { errs[key] = h('p', { class: 'field-error', id: `ann-${key}-err`, hidden: true }); return errs[key]; };

    const form = h('form', { class: 'staff-form', id: 'ann-form', novalidate: true },
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'ann-title' }, 'Título *'), titleIn, fieldErr('title')),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'ann-body' }, 'Mensagem'), bodyIn,
        h('p', { class: 'field-hint' }, 'Aceita formatação simples (**negrito**, listas, links). Sem emojis: use símbolos como ✓ ✗ ★ ⚠ ●.'), fieldErr('body')),
      h('div', { class: 'staff-form-grid' },
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'ann-priority' }, 'Prioridade'), prioritySel,
          h('p', { class: 'field-hint' }, 'Importante: faixa no topo até a pessoa abrir. Urgente: janela ao entrar no site.')),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'ann-start' }, 'Começa em'), startIn),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'ann-end' }, 'Termina em (opcional)'), endIn, fieldErr('ends_at'))),
      h('fieldset', { class: 'field field--teams' },
        h('legend', { class: 'field-label' }, 'Para quem'),
        h('label', { class: 'check' }, allIn, 'Toda a equipe'),
        h('div', { class: 'check-row' }, roleBoxes)),
      h('label', { class: 'check' }, ackIn, 'Exigir "Li e entendi"'),
      errorEl,
      h('div', { class: 'panel-actions' },
        h('button', { type: 'submit', class: 'btn btn--primary', id: 'ann-save', 'data-requires-online': '' }, icon('send'), a ? 'Salvar aviso' : 'Publicar aviso'),
        a && h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => { editing = null; renderForm(); } }, 'Cancelar edição')));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = {
        id: a?.id, title: titleIn.value, body: bodyIn.value, priority: prioritySel.value,
        audience_roles: allIn.checked ? [] : roleBoxes.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value),
        starts_at: fromLocalInput(startIn.value) ?? new Date().toISOString(), ends_at: fromLocalInput(endIn.value), requires_ack: ackIn.checked,
      };
      for (const el of Object.values(errs)) el.hidden = true;
      errorEl.hidden = true;
      if (!allIn.checked && !data.audience_roles.length) { errorEl.textContent = 'Escolha pelo menos um cargo ou marque Toda a equipe.'; errorEl.hidden = false; return; }
      const { valid, errors } = validateAnnouncement(data);
      const show = (errors2) => {
        let first = null;
        for (const [k, msg] of Object.entries(errors2)) {
          const el = errs[k] ?? errorEl;
          el.textContent = msg; el.hidden = false; first ??= el;
        }
        first?.focus?.();
      };
      if (!valid) { show(errors); (errors.title ? titleIn : errors.body ? bodyIn : errorEl).focus(); return; }
      const res = await app.adapter.saveAnnouncement(data);
      if (!alive) return;
      if (res.error) { if (res.error.code === 'VALIDATION') show(res.error.details?.errors ?? { _: res.error.message }); else app.reportError(res.error); return; }
      toast(a ? 'Aviso salvo.' : 'Aviso publicado.');
      editing = null;
      renderForm();
      await load();
      app.refreshCounts();
    });

    formHost.replaceChildren(h('section', { class: 'panel', 'aria-labelledby': 'ann-form-title' },
      h('h2', { class: 'block-title', id: 'ann-form-title' }, icon(a ? 'pencil' : 'speakerphone'), a ? 'Editar aviso' : 'Novo aviso'),
      form));
    app.applyOnline();
  }

  /* ---------- lista ---------- */
  async function report(a, host, btn) {
    if (!host.hidden) { host.hidden = true; btn.setAttribute('aria-expanded', 'false'); return; }
    const res = await app.adapter.getAnnouncementReport(a.id);
    if (res.error) { app.reportError(res.error); return; }
    const read = res.data.filter((r) => r.read_at);
    host.replaceChildren(
      h('p', { class: 'panel-text' }, `${read.length} de ${res.data.length} leram${a.requires_ack ? ` · ${res.data.filter((r) => r.acknowledged_at).length} confirmaram "Li e entendi"` : ''}.`),
      h('ul', { class: 'plain-list report-list' }, res.data.map((r) => h('li', { class: r.read_at ? 'report-read' : 'report-unread' },
        h('span', { 'aria-hidden': 'true' }, r.read_at ? '✓ ' : '○ '), r.display_name, ' ', roleBadge(r.role),
        h('span', { class: 'staff-meta' }, r.read_at
          ? ` leu em ${formatDate(r.read_at, { time: true })}${r.acknowledged_at ? ' · Li e entendi' : ''}`
          : ' ainda não leu')))));
    host.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }

  function card(a) {
    const forMe = isAnnouncementFor(a, app.state.staff);
    const scheduled = new Date(a.starts_at) > new Date();
    const ended = a.ends_at && new Date(a.ends_at) <= new Date();
    const md = renderMarkdownInto(h('div', { class: 'md ann-body' }), a.body || '');
    const reportHost = h('div', { class: 'ann-report', hidden: true, id: `ann-report-${a.id}` });
    const reportBtn = h('button', { type: 'button', class: 'btn btn--sm', 'aria-expanded': 'false', 'aria-controls': `ann-report-${a.id}`, onclick: () => report(a, reportHost, reportBtn) }, icon('users'), 'Quem leu');
    return h('article', { class: `ann-card ann-card--${a.priority}${forMe && !a.my_read_at ? ' ann-card--unread' : ''}`, id: `aviso-${a.id}`, dataset: { id: a.id } },
      h('header', { class: 'ann-head' },
        h('h3', { class: 'ann-title' }, forMe && !a.my_read_at && h('span', { class: 'unread-dot', 'aria-label': 'Não lido' }, '● '), a.title),
        h('div', { class: 'staff-tags' },
          h('span', { class: `badge ${PRIORITY_CLASS[a.priority]}` }, priorityLabel(a.priority)),
          a.audience_roles.length ? a.audience_roles.map((r) => roleBadge(r)) : h('span', { class: 'badge badge--status' }, 'Toda a equipe'),
          scheduled && h('span', { class: 'badge badge--status' }, 'Agendado'),
          ended && h('span', { class: 'badge badge--status' }, 'Encerrado'))),
      h('p', { class: 'staff-meta' }, `${a.created_by_name ?? a.created_by} · ${formatDate(a.starts_at, { time: true })}`, a.ends_at && ` até ${formatDate(a.ends_at, { time: true })}`),
      md,
      h('div', { class: 'panel-actions' }, ...[
        forMe && !a.my_read_at && h('button', { type: 'button', class: 'btn btn--sm btn--primary', 'data-requires-online': '', onclick: async () => { if (await app.readAnnouncement(a.id, { ack: a.requires_ack })) load(); } },
          icon('check'), a.requires_ack ? 'Li e entendi' : 'Marcar como lido'),
        forMe && a.my_read_at && a.requires_ack && !a.my_acknowledged_at && h('button', { type: 'button', class: 'btn btn--sm btn--primary', 'data-requires-online': '', onclick: async () => { if (await app.readAnnouncement(a.id, { ack: true })) load(); } }, icon('check'), 'Li e entendi'),
        forMe && a.my_read_at && h('span', { class: 'staff-meta' }, `✓ Lido em ${formatDate(a.my_read_at, { time: true })}${a.my_acknowledged_at ? ' · Li e entendi' : ''}`),
        sender && reportBtn,
        sender && h('button', { type: 'button', class: 'btn btn--sm btn--ghost', 'data-requires-online': '', onclick: () => { editing = a; renderForm(); formHost.querySelector('#ann-title')?.focus(); } }, icon('pencil'), 'Editar'),
        sender && h('button', { type: 'button', class: 'btn btn--sm btn--danger', 'data-requires-online': '', 'aria-label': `Apagar ${a.title}`, onclick: async () => {
          const ok = await confirmDialog({ title: `Apagar "${a.title}"?`, message: 'O aviso some para todos, junto com o registro de leitura.', confirmLabel: 'Apagar', danger: true });
          if (!ok) return;
          const res = await app.adapter.deleteAnnouncement(a.id);
          if (res.error) { app.reportError(res.error); return; }
          toast('Aviso apagado.');
          load();
          app.refreshCounts();
        } }, icon('trash'), 'Apagar'),
      ].filter(Boolean)),
      sender && reportHost);
  }

  async function load() {
    const res = await app.adapter.listAnnouncements();
    if (!alive) return;
    if (res.error) { app.reportError(res.error, 'Não foi possível carregar os avisos.'); return; }
    listEl.replaceChildren(...(res.data.length ? res.data.map(card) : [h('p', { class: 'panel-text' }, 'Nenhum aviso por enquanto.')]));
    app.applyOnline();
    const target = location.hash.split('#aviso-')[1];
    if (target) listEl.querySelector(`#aviso-${CSS.escape(target)}`)?.scrollIntoView({ block: 'start' });
  }

  if (sender) renderForm();
  load();
  return () => { alive = false; };
}
