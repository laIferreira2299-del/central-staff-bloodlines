// Tela de permissões (#/permissoes · documento 01, seção 3): grade cargo x permissão.
// Quem tem permissoes.editar (o CEO, ou quem ele autorizar) liga e desliga as células,
// confere o resumo do que muda e salva tudo de uma vez (setPermissions, tudo ou nada).
// Travas: a coluna do CEO não muda (ele tem todas); as permissões "só CEO" só o CEO altera.
import { h, icon, toast } from '../dom.js';
import { confirmDialog } from '../modal.js';
import { CEO, ROLE_CODES, describePermissionChange, gridChanges, roleLabel } from '../../core/permissions.js';
import { renderMessage } from './message.js';

const ROLES = ROLE_CODES.filter((r) => r !== CEO);
const cellId = (role, code) => `perm-${role}-${code.replace(/[^a-z_]/g, '-')}`;

export function renderPermissions(app) {
  if (!app.can('permissoes.editar')) {
    renderMessage(app, { title: 'Acesso restrito', text: 'Só o CEO, ou quem ele autorizar, altera as permissões dos cargos.' });
    return null;
  }

  const isCeo = app.state.staff.role === CEO;
  let alive = true;
  let permissions = [];
  let saved = {};
  let draft = {};
  let saving = false;

  const locked = (p) => p.ceo_only && !isCeo;
  const pending = () => gridChanges(saved, draft);

  const wrap = h('div', { class: 'perm-grid-wrap', tabindex: '0', 'aria-label': 'Grade de permissões (role para o lado no celular)' },
    h('p', { class: 'panel-text' }, 'Carregando…'));
  const statusEl = h('p', { class: 'perm-status', id: 'perm-status', 'aria-live': 'polite' });
  const saveBtn = h('button', { type: 'button', class: 'btn btn--primary', id: 'perm-save', onclick: save }, icon('check'), 'Salvar alterações');
  const discardBtn = h('button', { type: 'button', class: 'btn btn--ghost', id: 'perm-discard', onclick: discard }, 'Descartar');
  const defaultsBtn = h('button', { type: 'button', class: 'btn', id: 'perm-defaults', onclick: loadDefaults }, icon('restore'), 'Restaurar padrão');

  /* ---------- grade ---------- */
  function renderGrid() {
    const table = h('table', { class: 'perm-grid', id: 'perm-grid' },
      h('caption', { class: 'sr-only' }, 'Permissões por cargo. Cada caixinha liga ou desliga a permissão para o cargo.'),
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', class: 'perm-col-name' }, 'Permissão'),
        ROLES.map((r) => h('th', { scope: 'col' }, roleLabel(r))),
        h('th', { scope: 'col' }, roleLabel(CEO)))),
      h('tbody', {}, permissions.map((p) => h('tr', { class: locked(p) ? 'perm-row--locked' : null },
        h('th', { scope: 'row', class: 'perm-col-name' },
          h('span', { class: 'perm-desc' }, p.description),
          h('code', { class: 'perm-code' }, p.code),
          p.ceo_only && h('span', { class: 'perm-note' }, icon('lock'), ' Só o CEO altera')),
        ROLES.map((r) => {
          const changed = draft[r][p.code] !== saved[r][p.code];
          return h('td', { class: changed ? 'perm-cell perm-cell--changed' : 'perm-cell' },
            h('input', {
              type: 'checkbox', id: cellId(r, p.code), class: 'perm-check',
              checked: draft[r][p.code], disabled: locked(p) || saving,
              'aria-label': `${roleLabel(r)}: ${p.description}`,
              onchange: (e) => { draft[r][p.code] = e.target.checked; update(cellId(r, p.code)); },
            }));
        }),
        h('td', { class: 'perm-cell perm-cell--ceo' },
          h('span', { 'aria-label': 'CEO: sempre tem', title: 'O CEO tem todas as permissões, sempre.' }, icon('lock'), ' ✓'))))));
    wrap.replaceChildren(table);
  }

  /** Atualiza destaque, contador e botões; mantém o foco na caixinha que mudou. */
  function update(focusId) {
    renderGrid();
    const n = pending().length;
    statusEl.textContent = n ? `${n} ${n === 1 ? 'alteração não salva' : 'alterações não salvas'}` : 'Nenhuma alteração pendente.';
    statusEl.classList.toggle('perm-status--dirty', n > 0);
    saveBtn.disabled = n === 0 || saving || !app.state.online;
    discardBtn.disabled = n === 0 || saving;
    defaultsBtn.disabled = saving;
    if (n) app.router.setGuard(leaveGuard); else app.router.clearGuard();
    if (focusId) wrap.querySelector(`#${CSS.escape(focusId)}`)?.focus();
  }

  async function leaveGuard() {
    if (!pending().length) return true;
    return confirmDialog({
      title: 'Sair sem salvar?',
      message: 'As alterações nas permissões ainda não foram salvas e serão perdidas.',
      confirmLabel: 'Sair sem salvar',
      cancelLabel: 'Continuar editando',
      danger: true,
    });
  }

  function discard() {
    draft = structuredClone(saved);
    update();
    toast('Alterações descartadas.');
  }

  /** Coloca na grade o padrão do documento (não salva: a pessoa confere e clica em Salvar). */
  function loadDefaults() {
    for (const p of permissions) {
      if (locked(p)) continue;
      for (const r of ROLES) draft[r][p.code] = p.default_roles.includes(r);
    }
    update();
    const n = pending().length;
    toast(n ? `Padrão carregado: ${n} ${n === 1 ? 'alteração' : 'alterações'}. Confira e clique em Salvar alterações.` : 'A grade já está no padrão.', 4000);
    (n ? saveBtn : defaultsBtn).focus();
  }

  async function save() {
    const changes = pending();
    if (!changes.length) return;
    const ok = await confirmDialog({
      title: `Salvar ${changes.length} ${changes.length === 1 ? 'alteração' : 'alterações'}?`,
      message: h('div', { class: 'perm-confirm' },
        h('ul', { class: 'perm-confirm-list' }, changes.map((c) => h('li', {}, describePermissionChange(c)))),
        h('p', {}, 'Vale na hora para todos os membros desses cargos.')),
      confirmLabel: 'Salvar alterações',
    });
    if (!ok || !alive) return;
    saving = true;
    update();
    const result = await app.adapter.setPermissions(changes);
    saving = false;
    if (!alive) return;
    if (result.error) {
      if (result.error.code === 'VALIDATION') toast(result.error.details?.errors?._ ?? result.error.message, 5000);
      else app.reportError(result.error, 'Não foi possível salvar as permissões.');
      update();
      return;
    }
    apply(result.data);
    toast('Permissões salvas.');
    saveBtn.focus();
    // Quem salvou pode ter mudado as próprias permissões (ex.: um Administrador autorizado).
    await app.refreshStaff();
  }

  function apply(data) {
    permissions = data.permissions;
    saved = data.grid;
    draft = structuredClone(saved);
    update();
  }

  app.els.main.replaceChildren(h('div', { class: 'main-inner perm-page' },
    h('a', { class: 'back', href: '#/equipe' }, icon('arrow-left'), 'Voltar para a equipe'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Permissões dos cargos'),
      h('p', { class: 'page-sub' },
        'Ligue ou desligue o que cada cargo pode fazer. O banco confere cada ação, então a mudança vale na hora, mesmo para quem já está com o site aberto. ',
        'O CEO tem todas as permissões, sempre.'),
      !isCeo && h('p', { class: 'banner banner--info' }, 'Você recebeu do CEO a permissão de alterar esta grade. As linhas com cadeado só o CEO altera.')),
    h('section', { class: 'panel', 'aria-labelledby': 'perm-title' },
      h('h2', { class: 'block-title', id: 'perm-title' }, icon('shield-lock'), 'Grade'),
      wrap),
    h('div', { class: 'perm-actions', role: 'region', 'aria-label': 'Salvar permissões' },
      statusEl,
      h('div', { class: 'panel-actions' }, saveBtn, discardBtn, defaultsBtn))));

  (async () => {
    const result = await app.adapter.listPermissionGrid();
    if (!alive) return;
    if (result.error) {
      app.reportError(result.error, 'Não foi possível carregar as permissões.');
      wrap.replaceChildren(h('p', { class: 'panel-text' }, result.error.message ?? 'Não foi possível carregar as permissões.'));
      saveBtn.disabled = true; discardBtn.disabled = true; defaultsBtn.disabled = true;
      return;
    }
    apply(result.data);
  })();

  return () => { alive = false; app.router.clearGuard(); };
}
