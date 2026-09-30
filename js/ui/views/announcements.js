// Etapa 11 · avisos para a equipe (documento 01, seção 7).
//   Todos: lista dos avisos para o seu cargo, "Marcar como lido" e "Li e entendi".
//   avisos.enviar: criar, editar e apagar avisos, e o relatório de leitura (quem leu e quem não).
// Importante = faixa no topo até abrir; urgente = janela ao entrar (app.js).
// Decisão 11: quem cria pode também postar no Discord (webhook de finalidade Avisos, pela Edge
// Function enviar-discord). Opcional no formulário e botão "Enviar no Discord" em cada aviso.
// Item 1b do 03 (30/09): o canal marca os cargos cadastrados (SQL 14) e, se pedido, o bot manda
// no privado de cada membro ativo do público.
import { h, icon, toast } from '../dom.js';
import { confirmDialog, openDialog } from '../modal.js';
import { DISCORD_SEND_ERRORS, dmSummary } from '../../core/allowlist.js';
import { formatDate, roleBadge } from '../components.js';
import { ROLE_CODES, roleLabel } from '../../core/permissions.js';
import { ANNOUNCEMENT_LIMITS, PRIORITIES, isAnnouncementFor, priorityLabel, validateAnnouncement } from '../../core/workflow.js';
import { renderMarkdownInto } from '../../core/render-md.js';
import { toLocalInput } from './evaluations.js';
import { renderMessage } from './message.js';

const MENTION_HINT = 'Marca o cargo do público se o ID dele estiver cadastrado em Webhooks do Discord › Cargos no Discord.';
const DM_HINT = 'O bot manda a mesma mensagem no privado de cada membro ativo do público (pelo cargo no site). Quem fechou a DM não recebe.';
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
  let hooks = null; // webhooks ativos de Avisos (null = carregando)

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
    const discordIn = h('input', { type: 'checkbox', id: 'ann-discord', disabled: !hooks?.length });
    const dmIn = h('input', { type: 'checkbox', id: 'ann-dm' });
    const hookSel = hookSelect('ann-discord-webhook');
    // div em volta: .filter tem display próprio e ignoraria o hidden.
    const hookPick = h('div', { hidden: true },
      h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, 'Canal'), hookSel));
    discordIn.addEventListener('change', () => { hookPick.hidden = !discordIn.checked || hooks.length < 2; });
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
      h('div', { class: 'field' },
        h('label', { class: 'check' }, discordIn, a ? 'Enviar esta versão no canal do Discord' : 'Enviar no canal do Discord'),
        hookPick,
        h('p', { class: 'field-hint', id: 'ann-discord-hint' }, hooks == null ? 'Carregando canais…'
          : !hooks.length ? DISCORD_SEND_ERRORS.noWebhook
            : `${hooks.length === 1 ? `Canal: ${hookName(hooks[0])}. ` : ''}${MENTION_HINT}`),
        h('label', { class: 'check' }, dmIn, 'Enviar no privado (DM) de cada um'),
        h('p', { class: 'field-hint', id: 'ann-dm-hint' }, DM_HINT)),
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
      if (discordIn.checked || dmIn.checked) {
        await sendToDiscord(res.data.id, { channel: discordIn.checked, dm: dmIn.checked, webhookId: hookSel.value || hooks?.[0]?.id });
      }
      if (!alive) return;
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

  /* ---------- Discord (Decisão 11) ---------- */
  function hookName(w) { return w.channel_name ? `${w.name} (${w.channel_name})` : w.name; }
  function hookSelect(id) {
    return h('select', { class: 'input input--sm', id, 'aria-label': 'Enviar para qual canal?' },
      (hooks ?? []).map((w) => h('option', { value: w.id }, hookName(w))));
  }
  const siteUrl = () => `${location.origin}${location.pathname}`;

  /** Envia e mostra o resultado. O aviso já está salvo: uma falha aqui não desfaz nada. */
  async function sendToDiscord(id, { channel, dm, webhookId }) {
    const res = await app.adapter.sendAnnouncementToDiscord(id, { webhookId, channel, dm, siteUrl: siteUrl() });
    const ok = (label) => [{ label, value: true, variant: 'primary', autofocus: true }];
    if (res.error) {
      openDialog({ title: '✗ Não foi enviado ao Discord', body: res.error.details?.errors?._ ?? res.error.message ?? 'Tente de novo.', actions: ok('Entendi') });
      return false;
    }
    const parts = [channel && `Canal: ${res.data.discord_status.replace(/^enviado para /, '')}.`, res.data.dm && dmSummary(res.data.dm)].filter(Boolean);
    // Alguém ficou sem receber: janela, não só aviso no canto.
    if (res.data.dm?.failed?.length) {
      openDialog({ title: '⚠ Enviado, mas nem todos receberam no privado',
        body: `${parts.join(' ')} Quem não recebeu está com a DM fechada para o bot ou fora do servidor.`, actions: ok('Entendi') });
    } else toast(`✓ Enviado. ${parts.join(' ')}`, 5000);
    return true;
  }

  /** Botão do cartão: escolhe canal e/ou privado (e o canal, se houver mais de um) antes de enviar. */
  async function askAndSend(a) {
    const sel = hookSelect(`ann-send-${a.id}`);
    const chIn = h('input', { type: 'checkbox', id: `ann-send-ch-${a.id}`, checked: hooks.length > 0, disabled: !hooks.length });
    const dmIn = h('input', { type: 'checkbox', id: `ann-send-dm-${a.id}` });
    const body = h('div', {},
      h('p', {}, `Enviar "${a.title}":`),
      h('label', { class: 'check' }, chIn, hooks.length === 1 ? `No canal ${hookName(hooks[0])}` : 'No canal do Discord'),
      hooks.length > 1 && sel,
      h('p', { class: 'field-hint' }, hooks.length ? MENTION_HINT : DISCORD_SEND_ERRORS.noWebhook),
      h('label', { class: 'check' }, dmIn, 'No privado (DM) de cada um'),
      h('p', { class: 'field-hint' }, DM_HINT));
    const go = await openDialog({ title: 'Enviar no Discord?', body, actions: [
      { label: 'Cancelar', value: false, variant: 'ghost' },
      { label: 'Enviar', value: true, variant: 'primary', autofocus: true },
    ] });
    if (!go) return;
    if (!chIn.checked && !dmIn.checked) { toast(DISCORD_SEND_ERRORS.nothingToSend, 4000); return; }
    await sendToDiscord(a.id, { channel: chIn.checked, dm: dmIn.checked, webhookId: sel.value || hooks[0]?.id });
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
        sender && hooks != null && h('button', { type: 'button', class: 'btn btn--sm', 'data-requires-online': '', onclick: () => askAndSend(a) }, icon('brand-discord'), 'Enviar no Discord'),
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

  if (sender) {
    renderForm();
    // Só quem envia avisos vê os webhooks de Avisos (RLS do 10); sem nenhum, a opção fica desligada.
    app.adapter.listDiscordWebhooks({ purpose: 'avisos' }).then((r) => {
      if (!alive) return;
      hooks = (r.data ?? []).filter((w) => w.active && w.purpose === 'avisos');
      if (!editing) renderForm();
      load();
    });
  } else load();
  return () => { alive = false; };
}
