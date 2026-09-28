// Equipe (staff_members): admins adicionam, editam e removem membros.
// O banco confere tudo de novo (RLS + trigger em supabase/05_staff_admin.sql).
import { h, icon, toast } from '../dom.js';
import { confirmDialog } from '../modal.js';
import { ROLES, formatDate } from '../components.js';
import { STAFF_NAME_MAX, STAFF_ROLES, validateStaffMember } from '../../core/validate.js';
import { pickStaffMember } from '../../data/adapter.js';
import { renderMessage } from './message.js';
import { renderUser } from './layout.js';

const ROLE_BADGE = { suporte: 'badge--suporte', moderador: 'badge--moderador', admin: 'badge--ambos' };
const FIELDS = ['discord_id', 'display_name', 'role', 'active'];

const roleBadge = (role) => h('span', { class: `badge ${ROLE_BADGE[role] ?? ''}` }, ROLES[role] ?? role);
const statusBadge = (active) => h('span', { class: `badge ${active ? 'badge--status' : 'badge--revisar'}` }, active ? 'Ativo' : 'Inativo');

function field(id, label, control, hint) {
  if (hint) control.setAttribute('aria-describedby', `${id}-hint`);
  return h('div', { class: 'field' },
    h('label', { class: 'field-label', for: id }, label),
    control,
    hint && h('p', { class: 'field-hint', id: `${id}-hint` }, hint),
    h('p', { class: 'field-error', id: `${id}-err`, hidden: true }));
}

const roleSelect = (id, value, disabled) => h('select', { id, class: 'input', disabled },
  STAFF_ROLES.map((r) => h('option', { value: r, selected: r === value }, ROLES[r])));

const activeSelect = (id, value, disabled) => h('select', { id, class: 'input', disabled },
  h('option', { value: 'true', selected: value }, 'Ativo'),
  h('option', { value: 'false', selected: !value }, 'Inativo (sem acesso)'));

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
      first ??= input;
    } else {
      general.textContent = message;
      general.hidden = false;
      first ??= general;
    }
  }
  first?.focus();
}

const generalError = () => h('p', { class: 'field-error form-general-error', role: 'alert', tabindex: '-1', hidden: true });

export function renderStaff(app) {
  if (!app.can('admin')) {
    renderMessage(app, { title: 'Acesso restrito', text: 'Gerenciar a equipe é exclusivo de admins.' });
    return null;
  }

  const meId = app.state.staff.discord_id;
  let members = [];
  let editing = null;
  let alive = true;

  const listEl = h('ul', { class: 'staff-list', id: 'staff-list', 'aria-labelledby': 'staff-list-title' });
  const countEl = h('p', { class: 'panel-text', id: 'staff-count', 'aria-live': 'polite' }, 'Carregando…');

  /* ---------- adicionar ---------- */
  const addForm = h('form', { class: 'staff-form', id: 'staff-add', novalidate: true },
    h('div', { class: 'staff-form-grid' },
      field('new-discord_id', 'Discord ID',
        h('input', { id: 'new-discord_id', class: 'input input--mono', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', maxlength: 20 }),
        'No Discord: Configurações, Avançado, Modo Desenvolvedor. Depois clique com o botão direito no perfil e em Copiar ID.'),
      field('new-display_name', 'Nome', h('input', { id: 'new-display_name', class: 'input', autocomplete: 'off', maxlength: STAFF_NAME_MAX })),
      field('new-role', 'Cargo', roleSelect('new-role', 'suporte', false)),
      field('new-active', 'Situação', activeSelect('new-active', true, false))),
    generalError(),
    h('div', { class: 'panel-actions' },
      h('button', { type: 'submit', class: 'btn btn--primary', id: 'staff-add-submit', 'data-requires-online': '' }, icon('user-plus'), 'Adicionar membro')));

  const readForm = (form, prefix) => Object.fromEntries(FIELDS
    .filter((f) => form.querySelector(`#${prefix}-${f}`))
    .map((f) => {
      const value = form.querySelector(`#${prefix}-${f}`).value;
      return [f, f === 'active' ? value === 'true' : value];
    }));

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
    toast(`${result.data.display_name} adicionado(a) como ${ROLES[result.data.role]}.`, 3000);
    await load(result.data.discord_id);
    addForm.querySelector('#new-discord_id').focus();
  });

  /* ---------- lista ---------- */
  function viewRow(m) {
    const self = m.discord_id === meId;
    return h('li', { class: 'staff-row', dataset: { discordId: m.discord_id } },
      h('div', { class: 'staff-who' },
        h('p', { class: 'staff-name' }, m.display_name, self && h('span', { class: 'staff-you' }, ' (você)')),
        h('p', { class: 'staff-meta' },
          h('span', { class: 'sr-only' }, 'Discord ID: '), h('code', { class: 'staff-id' }, m.discord_id),
          m.created_at && ` · desde ${formatDate(m.created_at)}`)),
      h('div', { class: 'staff-tags' }, roleBadge(m.role), statusBadge(m.active)),
      h('div', { class: 'staff-actions' },
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
        field('edit-role', 'Cargo', roleSelect('edit-role', m.role, self), self ? 'Seu cargo só pode ser alterado por outro admin.' : null),
        field('edit-active', 'Situação', activeSelect('edit-active', m.active, self), self ? 'Sua conta só pode ser desativada por outro admin.' : null)),
      generalError(),
      h('div', { class: 'panel-actions' },
        h('button', { type: 'submit', class: 'btn btn--primary btn--sm', 'data-requires-online': '' }, icon('check'), 'Salvar'),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => stopEdit(m.discord_id) }, 'Cancelar')));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const changes = readForm(form, 'edit');
      if (self) { delete changes.role; delete changes.active; }
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
    listEl.replaceChildren(...members.map((m) => (m.discord_id === editing ? editRow(m) : viewRow(m))));
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
      h('p', { class: 'page-sub' }, 'Quem pode entrar na Central e com qual cargo. Exclusivo de admins.')),

    h('section', { class: 'panel', 'aria-labelledby': 'staff-add-title' },
      h('h2', { class: 'block-title', id: 'staff-add-title' }, icon('user-plus'), 'Adicionar membro'),
      addForm),

    h('section', { class: 'panel', 'aria-labelledby': 'staff-list-title' },
      h('h2', { class: 'block-title', id: 'staff-list-title' }, icon('users'), 'Membros'),
      countEl,
      listEl)));

  load();
  return () => { alive = false; };
}
