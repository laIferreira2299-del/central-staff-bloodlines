// Agenda de Reuniões (plano 06): #/agenda. Ver: agenda.ler ou agenda.gerenciar (todos os cargos, por padrão).
// Criar, editar e apagar: agenda.gerenciar (Head Staff e Direção, por padrão). Horário sempre de Brasília.
import { h, icon, toast } from '../dom.js';
import { confirmDialog } from '../modal.js';
import {
  DISCORD_LINK_PATTERN, MEETING_LIMITS, filterMeetings, formatMeetingDate, fromInputValue, isLive, toInputValue,
} from '../../core/agenda.js';
import { ROLE_LIST } from '../../core/permissions.js';
import { formField, showFieldErrors } from './gabarito.js';
import { renderMessage } from './message.js';

const FILTERS = Object.freeze([['proximas', 'Próximas'], ['passadas', 'Passadas'], ['todas', 'Todas']]);

export function renderAgenda(app) {
  const canRead = app.can('agenda.ler') || app.can('agenda.gerenciar');
  if (!app.feature('agenda') || !canRead) {
    renderMessage(app, { title: 'Acesso restrito', text: 'Seu cargo não abre a Agenda de Reuniões.' });
    return null;
  }
  const canManage = app.can('agenda.gerenciar');
  let alive = true;
  let meetings = [];
  let filter = 'proximas';
  const slot = h('div', {});
  const list = h('div', { class: 'agenda-list', id: 'agenda-list' }, h('p', { class: 'panel-text' }, 'Carregando…'));
  const chips = h('div', { class: 'agenda-filters', id: 'agenda-filters', role: 'group', 'aria-label': 'Filtrar reuniões' });

  app.els.main.replaceChildren(h('div', { class: 'main-inner agenda-page' }, slot));

  async function load() {
    const res = await app.adapter.listMeetings();
    if (!alive) return;
    if (res.error) { app.reportError(res.error, 'Não foi possível carregar a Agenda.'); return; }
    meetings = res.data;
    drawList();
  }

  /* ---------- lista ---------- */
  function drawList() {
    slot.replaceChildren(
      h('a', { class: 'back', href: '#/' }, icon('arrow-left'), 'Voltar para a lista'),
      h('header', { class: 'page-head' },
        h('h1', { class: 'page-title', tabindex: '-1' }, 'Agenda de Reuniões'),
        h('p', { class: 'page-sub' }, 'Reuniões e convocações da staff. Horários de Brasília.'),
        canManage && h('div', { class: 'page-head-actions' },
          h('button', { type: 'button', class: 'btn btn--primary', id: 'agenda-new', onclick: () => openForm(null) }, icon('plus'), 'Nova reunião'))),
      chips, list);
    drawChips();
    drawCards();
  }

  function drawChips() {
    chips.replaceChildren(...FILTERS.map(([value, label]) => h('button', {
      type: 'button', class: 'agenda-filter', 'aria-pressed': String(filter === value), dataset: { filter: value },
      onclick: () => { filter = value; drawChips(); drawCards(); },
    }, label)));
  }

  function drawCards() {
    const now = new Date();
    const rows = filterMeetings(meetings, filter, now);
    if (!rows.length) {
      list.replaceChildren(h('div', { class: 'agenda-empty', id: 'agenda-empty' },
        icon('calendar-off'),
        h('p', {}, filter === 'proximas' ? 'Nenhuma reunião agendada.' : filter === 'passadas' ? 'Nenhuma reunião passada.' : 'Nenhuma reunião cadastrada.'),
        canManage && filter !== 'passadas' && h('button', { type: 'button', class: 'btn btn--primary', onclick: () => openForm(null) }, icon('plus'), 'Agendar reunião')));
      return;
    }
    list.replaceChildren(...rows.map((m) => card(m, now)));
  }

  function card(m, now) {
    const when = formatMeetingDate(m.starts_at);
    const live = isLive(m.starts_at, now);
    const link = m.discord_link && DISCORD_LINK_PATTERN.test(m.discord_link) ? m.discord_link : null;
    return h('article', { class: `agenda-card${live ? ' agenda-card--live' : ''}`, dataset: { id: m.id } },
      h('div', { class: 'agenda-card-head' },
        h('div', { class: 'agenda-date', 'aria-hidden': 'true' }, h('span', { class: 'agenda-day' }, when.day), h('span', { class: 'agenda-month' }, when.month)),
        h('div', { class: 'agenda-info' },
          live && h('span', { class: 'agenda-live' }, '● AO VIVO'),
          h('h2', { class: 'agenda-title' }, m.title),
          h('p', { class: 'agenda-when' }, icon('clock'), ` ${when.weekdayDate} às ${when.time}`),
          m.description && h('p', { class: 'agenda-desc' }, m.description),
          m.participants.length > 0 && h('ul', { class: 'agenda-people', 'aria-label': 'Convocados' },
            m.participants.map((p) => h('li', { class: `agenda-person agenda-person--${p.kind}` },
              h('span', { class: 'agenda-person-kind' }, p.kind === 'role' ? 'Cargo' : 'Membro'), ' ', p.label))))),
      (link || canManage) && h('div', { class: 'agenda-actions' },
        link && h('a', { class: 'btn btn--primary', href: link, target: '_blank', rel: 'noopener noreferrer' }, icon('brand-discord'), 'Entrar na call'),
        canManage && h('button', { type: 'button', class: 'btn btn--sm', 'aria-label': `Editar ${m.title}`, onclick: () => openForm(m) }, icon('pencil'), 'Editar'),
        canManage && h('button', { type: 'button', class: 'btn btn--sm btn--danger', 'aria-label': `Apagar ${m.title}`, onclick: () => remove(m) }, icon('trash'), 'Apagar')));
  }

  /* ---------- criar e editar ---------- */
  async function openForm(meeting) {
    const names = await app.adapter.listStaffNames();
    if (!alive) return;
    if (names.error) { app.reportError(names.error, 'Não foi possível carregar a equipe.'); return; }
    const chosen = new Set((meeting?.participants ?? []).map((p) => `${p.kind}:${p.value}`));
    const checkbox = (kind, value, label) => h('label', { class: 'agenda-check' },
      h('input', { type: 'checkbox', name: 'participant', value: `${kind}:${value}`, checked: chosen.has(`${kind}:${value}`) }), ' ', label);
    const fields = {
      title: formField('agenda-title', 'Título *', h('input', { class: 'input', maxlength: MEETING_LIMITS.title, value: meeting?.title ?? '', autocomplete: 'off', placeholder: 'Ex.: Reunião semanal da Direção' })),
      starts_at: formField('agenda-starts', 'Data e horário * (Brasília)', h('input', { class: 'input', type: 'datetime-local', value: meeting ? toInputValue(meeting.starts_at) : '' })),
      description: formField('agenda-description', 'Pauta', h('textarea', { class: 'input textarea', rows: 4, maxlength: MEETING_LIMITS.description }, meeting?.description ?? ''),
        'Descreva o assunto ou o objetivo da reunião.'),
      discord_link: formField('agenda-link', 'Link da call no Discord', h('input', {
        class: 'input', type: 'url', maxlength: MEETING_LIMITS.link, value: meeting?.discord_link ?? '', autocomplete: 'off',
        placeholder: 'https://discord.gg/... ou https://discord.com/channels/...',
      }), 'Aparece como botão "Entrar na call" para toda a staff.'),
    };
    const peopleError = h('p', { class: 'field-error', id: 'agenda-people-err', hidden: true });
    const people = h('div', { class: 'field' },
      h('fieldset', { class: 'agenda-fieldset' },
        h('legend', { class: 'field-label' }, 'Convocar'),
        h('p', { class: 'field-hint' }, 'Marque cargos inteiros ou membros específicos.'),
        h('p', { class: 'agenda-fieldset-title' }, 'Cargos'),
        h('div', { class: 'agenda-checks', id: 'agenda-roles' }, ROLE_LIST.map((r) => checkbox('role', r.code, r.label))),
        h('p', { class: 'agenda-fieldset-title' }, 'Membros'),
        h('div', { class: 'agenda-checks', id: 'agenda-members' }, names.data.map((s) => checkbox('member', s.discord_id, s.display_name)))),
      peopleError);
    const general = h('p', { class: 'field-error form-general-error', role: 'alert', hidden: true });
    const form = h('form', { class: 'panel staff-form', id: 'agenda-form', novalidate: true },
      h('h2', { class: 'block-title' }, icon(meeting ? 'pencil' : 'plus'), meeting ? `Editar "${meeting.title}"` : 'Nova reunião'),
      h('div', { class: 'staff-form-grid' }, fields.title.el, fields.starts_at.el),
      fields.discord_link.el, fields.description.el, people, general,
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn btn--ghost', id: 'agenda-cancel', onclick: drawList }, 'Cancelar'),
        h('button', { type: 'submit', class: 'btn btn--primary', id: 'agenda-save', 'data-requires-online': '' },
          icon('device-floppy'), meeting ? 'Salvar alterações' : 'Agendar reunião')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const startsAt = fromInputValue(fields.starts_at.input.value);
      const participants = [...form.querySelectorAll('input[name="participant"]:checked')].map((i) => {
        const [kind, ...rest] = i.value.split(':');
        return { kind, value: rest.join(':') };
      });
      const res = await app.adapter.saveMeeting({
        ...(meeting ? { id: meeting.id } : {}),
        title: fields.title.input.value,
        starts_at: startsAt,
        description: fields.description.input.value,
        discord_link: fields.discord_link.input.value,
        participants,
      });
      showFieldErrors({ ...fields, participants: { error: peopleError } }, general, res.error);
      if (res.error) return;
      toast(meeting ? 'Reunião atualizada.' : 'Reunião agendada.');
      meetings = [...meetings.filter((m) => m.id !== res.data.id), res.data];
      drawList();
    });
    slot.replaceChildren(h('a', { class: 'back', href: '#/agenda', onclick: (e) => { e.preventDefault(); drawList(); } },
      icon('arrow-left'), 'Cancelar e voltar'), form);
    app.applyOnline();
    fields.title.input.focus();
  }

  async function remove(meeting) {
    const yes = await confirmDialog({
      title: 'Apagar reunião',
      message: `Apagar a reunião "${meeting.title}"? Esta ação não pode ser desfeita.`,
      confirmLabel: 'Apagar',
      danger: true,
    });
    if (!yes) return;
    const res = await app.adapter.deleteMeeting(meeting.id);
    if (res.error) { app.reportError(res.error, 'Não foi possível apagar a reunião.'); return; }
    toast('Reunião apagada.');
    meetings = meetings.filter((m) => m.id !== meeting.id);
    drawList();
  }

  load();
  return () => { alive = false; };
}
