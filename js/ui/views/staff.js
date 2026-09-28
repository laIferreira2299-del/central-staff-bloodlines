// Equipe (staff_members): quem tem equipe.ver vê a lista; quem tem equipe.gerenciar
// adiciona, edita e remove membros de cargo abaixo do permitido (js/core/permissions.js).
// O banco confere tudo de novo (RLS + trigger em supabase/05_staff_admin.sql).
// Etapa 2: filtros (cargo, situação, equipe e busca), TAGs de equipe e link para a ficha.
import { h, icon, toast } from '../dom.js';
import { confirmDialog } from '../modal.js';
import { formatDate, roleBadge, statusBadge, teamBadge } from '../components.js';
import { STAFF_NAME_MAX, validateStaffMember } from '../../core/validate.js';
import { ROLE_CODES, TEAMS, TEAM_LABELS, assignableRoles, canManageRole, roleLabel } from '../../core/permissions.js';
import { normalizeText } from '../../core/normalize.js';
import { pickStaffMember } from '../../data/adapter.js';
import { renderMessage } from './message.js';
import { renderUser } from './layout.js';

const FIELDS = ['discord_id', 'display_name', 'role', 'active'];

function field(id, label, control, hint) {
  if (hint) control.setAttribute('aria-describedby', `${id}-hint`);
  return h('div', { class: 'field' },
    h('label', { class: 'field-label', for: id }, label),
    control,
    hint && h('p', { class: 'field-hint', id: `${id}-hint` }, hint),
    h('p', { class: 'field-error', id: `${id}-err`, hidden: true }));
}

/** Seletor de cargo: só os cargos que `options` permite (o atual aparece mesmo se não puder dar). */
function roleSelect(id, value, disabled, options) {
  const roles = options.includes(value) || !value ? options : [value, ...options];
  return h('select', { id, class: 'input', disabled },
    roles.map((r) => h('option', { value: r, selected: r === value }, roleLabel(r))));
}

const activeSelect = (id, value, disabled) => h('select', { id, class: 'input', disabled },
  h('option', { value: 'true', selected: value }, 'Ativo'),
  h('option', { value: 'false', selected: !value }, 'Inativo (sem acesso)'));

/** Caixinhas das TAGs de equipe (Decisão 1: opcionais, somam as permissões da equipe). */
function teamsField(prefix, value, disabled, hint) {
  const hintId = `${prefix}-teams-hint`;
  return h('fieldset', { class: 'field field--teams', id: `${prefix}-teams`, 'aria-describedby': hintId },
    h('legend', { class: 'field-label' }, 'Equipes (opcional)'),
    h('div', { class: 'check-row' },
      TEAMS.map((t) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', id: `${prefix}-team-${t}`, value: t, checked: value.includes(t), disabled }),
        TEAM_LABELS[t]))),
    h('p', { class: 'field-hint', id: hintId }, hint ?? 'Dá as permissões daquela equipe sem mudar o cargo. Ex.: um Suporte que também faz parte da equipe de Lore.'),
    h('p', { class: 'field-error', id: `${prefix}-teams-err`, hidden: true }));
}

/** Mostra os erros de validação ao lado de cada campo (prefixo = id do formulário). */
function showErrors(form, prefix, errors) {
  for (const el of form.querySelectorAll('.field-error')) { el.hidden = true; el.textContent = ''; }
  for (const el of form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
  const general = form.querySelector('.form-general-error');
  general.hidden = true;
  let first = null;
  for (const [key, message] of Object.entries(errors ?? {})) {
    const input = form.querySelector(`#${prefix}-${key}`);
    const err = form.querySelector(`#${prefix}-${key}-err`);
    if (input && err) {
      err.textContent = message;
      err.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      first ??= input.matches('fieldset') ? input.querySelector('input') : input;
    } else {
      general.textContent = message;
      general.hidden = false;
      first ??= general;
    }
  }
  first?.focus();
}

const generalError = () => h('p', { class: 'field-error form-general-error', role: 'alert', tabindex: '-1', hidden: true });

const EMPTY_FILTERS = Object.freeze({ q: '', role: '', status: '', team: '' });

/** Aplica os filtros da tela (busca por nome ou Discord ID, cargo, situação e equipe). */
export function filterMembers(members, { q = '', role = '', status = '', team = '' } = {}) {
  const term = normalizeText(q.trim());
  return members.filter((m) => (!role || m.role === role)
    && (!status || String(m.active) === String(status === 'ativo'))
    && (!team || (team === 'nenhuma' ? !(m.teams ?? []).length : (m.teams ?? []).includes(team)))
    && (!term || normalizeText(m.display_name).includes(term) || m.discord_id.includes(term)));
}

export function renderStaff(app) {
  if (!app.can('equipe.ver')) {
    renderMessage(app, { title: 'Acesso restrito', text: 'Seu cargo não permite ver a equipe.' });
    return null;
  }

  const meId = app.state.staff.discord_id;
  const myRole = app.state.staff.role;
  const manages = app.can('equipe.gerenciar');
  const assignable = manages ? assignableRoles(myRole) : [];
  const canTouch = (m) => manages && (m.discord_id === meId || canManageRole(myRole, m.role));
  let members = [];
  let editing = null;
  let alive = true;
  const filters = { ...EMPTY_FILTERS };

  const listEl = h('ul', { class: 'staff-list', id: 'staff-list', 'aria-labelledby': 'staff-list-title' });
  const countEl = h('p', { class: 'panel-text', id: 'staff-count', 'aria-live': 'polite' }, 'Carregando…');
  const shownEl = h('p', { class: 'panel-text', id: 'staff-shown', 'aria-live': 'polite', hidden: true });

  /* ---------- filtros ---------- */
  const filterSelect = (key, label, options) => h('label', { class: 'filter' },
    h('span', { class: 'filter-label' }, label),
    h('select', {
      id: `staff-filter-${key}`, class: 'input input--sm',
      onchange: (e) => { filters[key] = e.target.value; renderList(); },
    }, options.map(([value, text]) => h('option', { value }, text))));

  const searchInput = h('input', {
    id: 'staff-search', class: 'input input--sm', type: 'search', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Nome ou Discord ID', 'aria-label': 'Buscar membro por nome ou Discord ID',
    oninput: (e) => { filters.q = e.target.value; renderList(); },
  });
  const clearBtn = h('button', {
    type: 'button', class: 'btn btn--ghost btn--sm', id: 'staff-filter-clear', hidden: true,
    onclick: () => {
      Object.assign(filters, EMPTY_FILTERS);
      searchInput.value = '';
      for (const sel of filtersEl.querySelectorAll('select')) sel.value = '';
      renderList();
      searchInput.focus();
    },
  }, 'Limpar filtros');
  const filtersEl = h('div', { class: 'staff-filters', role: 'search', 'aria-label': 'Filtrar membros' },
    searchInput,
    filterSelect('role', 'Cargo', [['', 'Todos'], ...ROLE_CODES.map((r) => [r, roleLabel(r)])]),
    filterSelect('status', 'Situação', [['', 'Todas'], ['ativo', 'Ativos'], ['inativo', 'Inativos']]),
    filterSelect('team', 'Equipe', [['', 'Todas'], ...TEAMS.map((t) => [t, TEAM_LABELS[t]]), ['nenhuma', 'Sem equipe']]),
    clearBtn);

  /* ---------- adicionar ---------- */
  const addForm = h('form', { class: 'staff-form', id: 'staff-add', novalidate: true },
    h('div', { class: 'staff-form-grid' },
      field('new-discord_id', 'Discord ID',
        h('input', { id: 'new-discord_id', class: 'input input--mono', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', maxlength: 20 }),
        'No Discord: Configurações, Avançado, Modo Desenvolvedor. Depois clique com o botão direito no perfil e em Copiar ID.'),
      field('new-display_name', 'Nome', h('input', { id: 'new-display_name', class: 'input', autocomplete: 'off', maxlength: STAFF_NAME_MAX })),
      field('new-role', 'Cargo', roleSelect('new-role', assignable.includes('suporte') ? 'suporte' : assignable[0], false, assignable)),
      field('new-active', 'Situação', activeSelect('new-active', true, false)),
      teamsField('new', [], false)),
    generalError(),
    h('div', { class: 'panel-actions' },
      h('button', { type: 'submit', class: 'btn btn--primary', id: 'staff-add-submit', 'data-requires-online': '' }, icon('user-plus'), 'Adicionar membro')));

  const readForm = (form, prefix) => {
    const out = Object.fromEntries(FIELDS
      .filter((f) => form.querySelector(`#${prefix}-${f}`))
      .map((f) => {
        const value = form.querySelector(`#${prefix}-${f}`).value;
        return [f, f === 'active' ? value === 'true' : value];
      }));
    out.teams = TEAMS.filter((t) => form.querySelector(`#${prefix}-team-${t}`)?.checked);
    return out;
  };

  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = pickStaffMember(readForm(addForm, 'new'));
    const { valid, errors } = validateStaffMember(data);
    if (!valid) { showErrors(addForm, 'new', errors); return; }
    const submit = addForm.querySelector('#staff-add-submit');
    submit.disabled = true;
    const result = await app.adapter.createStaffMember(data);
    submit.disabled = !app.state.online;
    if (!alive) return;
    if (result.error) {
      if (result.error.code === 'VALIDATION') showErrors(addForm, 'new', result.error.details?.errors);
      else app.reportError(result.error, 'Não foi possível adicionar o membro.');
      return;
    }
    showErrors(addForm, 'new', {});
    addForm.reset();
    toast(`${result.data.display_name} adicionado(a) como ${roleLabel(result.data.role)}.`, 3000);
    await load(result.data.discord_id);
    addForm.querySelector('#new-discord_id').focus();
  });

  /* ---------- lista ---------- */
  function viewRow(m) {
    const self = m.discord_id === meId;
    return h('li', { class: 'staff-row', dataset: { discordId: m.discord_id } },
      h('div', { class: 'staff-who' },
        h('p', { class: 'staff-name' },
          h('a', { class: 'staff-link', href: `#/equipe/${m.discord_id}`, 'aria-label': `Ficha de ${m.display_name}` }, m.display_name),
          self && h('span', { class: 'staff-you' }, ' (você)')),
        h('p', { class: 'staff-meta' },
          h('span', { class: 'sr-only' }, 'Discord ID: '), h('code', { class: 'staff-id' }, m.discord_id),
          m.created_at && ` · desde ${formatDate(m.created_at)}`)),
      h('div', { class: 'staff-tags' }, roleBadge(m.role), (m.teams ?? []).map(teamBadge), statusBadge(m.active)),
      canTouch(m) && h('div', { class: 'staff-actions' },
        h('button', {
          type: 'button', class: 'btn btn--sm', 'data-requires-online': '', 'data-focus-key': `edit-${m.discord_id}`,
          'aria-label': `Editar ${m.display_name}`, onclick: () => startEdit(m.discord_id),
        }, icon('pencil'), 'Editar'),
        !self && h('button', {
          type: 'button', class: 'btn btn--sm btn--danger', 'data-requires-online': '',
          'aria-label': `Remover ${m.display_name}`, onclick: () => remove(m),
        }, icon('trash'), 'Remover')));
  }

  function editRow(m) {
    const self = m.discord_id === meId;
    const form = h('form', { class: 'staff-form staff-edit', id: 'staff-edit', novalidate: true },
      h('p', { class: 'staff-meta' }, 'Discord ID ', h('code', { class: 'staff-id' }, m.discord_id), ' (não muda; para trocar, remova e cadastre de novo)'),
      h('div', { class: 'staff-form-grid' },
        field('edit-display_name', 'Nome', h('input', { id: 'edit-display_name', class: 'input', value: m.display_name, autocomplete: 'off', maxlength: STAFF_NAME_MAX })),
        field('edit-role', 'Cargo', roleSelect('edit-role', m.role, self, assignable), self ? 'Seu cargo só pode ser alterado por outra pessoa da Direção.' : null),
        field('edit-active', 'Situação', activeSelect('edit-active', m.active, self), self ? 'Sua conta só pode ser desativada por outra pessoa da Direção.' : null),
        teamsField('edit', m.teams ?? [], self, self ? 'Suas equipes só podem ser alteradas por outra pessoa da Direção.' : null)),
      generalError(),
      h('div', { class: 'panel-actions' },
        h('button', { type: 'submit', class: 'btn btn--primary btn--sm', 'data-requires-online': '' }, icon('check'), 'Salvar'),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => stopEdit(m.discord_id) }, 'Cancelar')));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const changes = readForm(form, 'edit');
      if (self) { delete changes.role; delete changes.active; delete changes.teams; }
      const { valid, errors } = validateStaffMember(pickStaffMember({ ...m, ...changes }));
      if (!valid) { showErrors(form, 'edit', errors); return; }
      const result = await app.adapter.updateStaffMember(m.discord_id, changes);
      if (!alive) return;
      if (result.error) {
        if (result.error.code === 'VALIDATION') showErrors(form, 'edit', result.error.details?.errors);
        else app.reportError(result.error, 'Não foi possível salvar.');
        return;
      }
      toast(`${result.data.display_name}: alterações salvas.`);
      if (self) { app.state.staff = { ...app.state.staff, display_name: result.data.display_name }; renderUser(app); }
      editing = null;
      await load(m.discord_id);
    });
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); stopEdit(m.discord_id); } });

    return h('li', { class: 'staff-row staff-row--editing', dataset: { discordId: m.discord_id } },
      h('p', { class: 'staff-name' }, `Editando ${m.display_name}`, self && h('span', { class: 'staff-you' }, ' (você)')),
      form);
  }

  function renderList(focusId) {
    const active = members.filter((m) => m.active).length;
    countEl.textContent = `${members.length} ${members.length === 1 ? 'membro' : 'membros'} · ${active} ${active === 1 ? 'ativo' : 'ativos'}`;
    const filtered = Object.entries(filters).some(([k, v]) => v !== EMPTY_FILTERS[k]);
    const shown = filtered ? filterMembers(members, filters) : members;
    shownEl.hidden = !filtered;
    shownEl.textContent = filtered ? `Mostrando ${shown.length} de ${members.length}` : '';
    clearBtn.hidden = !filtered;
    // O membro em edição continua na tela mesmo que o filtro o esconda.
    const rows = shown.some((m) => m.discord_id === editing) ? shown : [...shown, ...members.filter((m) => m.discord_id === editing)];
    listEl.replaceChildren(...(rows.length
      ? rows.map((m) => (m.discord_id === editing ? editRow(m) : viewRow(m)))
      : [h('li', { class: 'staff-empty' }, 'Nenhum membro com esses filtros.')]));
    app.applyOnline();
    if (editing) listEl.querySelector('#edit-display_name')?.focus();
    else if (focusId) listEl.querySelector(`[data-focus-key="edit-${CSS.escape(focusId)}"]`)?.focus();
  }

  function startEdit(id) { editing = id; renderList(); }
  function stopEdit(id) { editing = null; renderList(id); }

  async function remove(m) {
    const confirmed = await confirmDialog({
      title: `Remover ${m.display_name}?`,
      message: `${m.display_name} perde o acesso à Central na hora. Os procedimentos que essa pessoa editou continuam, mas o nome dela deixa de aparecer no histórico. Para só bloquear o acesso e manter o nome, use Editar e escolha Inativo.`,
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!confirmed || !alive) return;
    const result = await app.adapter.deleteStaffMember(m.discord_id);
    if (!alive) return;
    if (result.error) {
      if (result.error.code === 'VALIDATION') toast(result.error.details?.errors?._ ?? result.error.message, 4000);
      else app.reportError(result.error, 'Não foi possível remover.');
      return;
    }
    toast(`${m.display_name} foi removido(a) da staff.`);
    await load();
    listEl.closest('.staff-page')?.querySelector('h1')?.focus();
  }

  async function load(focusId) {
    const result = await app.adapter.listStaff();
    if (!alive) return;
    if (result.error) {
      app.reportError(result.error, 'Não foi possível carregar a equipe.');
      countEl.textContent = 'Não foi possível carregar a equipe.';
      return;
    }
    members = result.data;
    if (editing && !members.some((m) => m.discord_id === editing)) editing = null;
    renderList(focusId);
  }

  app.els.main.replaceChildren(h('div', { class: 'main-inner staff-page' },
    h('a', { class: 'back', href: '#/' }, icon('arrow-left'), 'Voltar para a lista'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Equipe da staff'),
      h('p', { class: 'page-sub' }, manages
        ? 'Quem pode entrar na Central e com qual cargo. Você gerencia os cargos abaixo do seu; Administradores, Managers e CEOs só o CEO gerencia.'
        : 'Quem pode entrar na Central e com qual cargo.'),
      app.can('permissoes.editar') && h('p', { class: 'page-head-actions' },
        h('a', { class: 'btn btn--sm', href: '#/permissoes', id: 'staff-to-permissions' }, icon('shield-lock'), 'Permissões dos cargos'))),

    manages && h('section', { class: 'panel', 'aria-labelledby': 'staff-add-title' },
      h('h2', { class: 'block-title', id: 'staff-add-title' }, icon('user-plus'), 'Adicionar membro'),
      addForm),

    h('section', { class: 'panel', 'aria-labelledby': 'staff-list-title' },
      h('h2', { class: 'block-title', id: 'staff-list-title' }, icon('users'), 'Membros'),
      countEl,
      filtersEl,
      shownEl,
      listEl)));

  load();
  return () => { alive = false; };
}
