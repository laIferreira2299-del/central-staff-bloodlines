// Etapa 7 · webhooks do Discord pela Direção (documento 02, seção 13.4): #/configuracoes/webhooks.
// A url só entra (campo de senha); nunca aparece na tela nem volta do banco. Testar posta uma
// mensagem simples pelo servidor (Edge Function enviar-discord).
// Item 1b do 03 (30/09): IDs dos cargos no Discord, para os avisos marcarem o cargo (SQL 14).
import { h, icon, toast } from '../dom.js';
import { confirmDialog, openDialog } from '../modal.js';
import { formatDate, statusBadge } from '../components.js';
import { AL_LIMITS, WEBHOOK_PURPOSES, validateDiscordRoleIds } from '../../core/allowlist.js';
import { ROLE_CODES, roleLabel } from '../../core/permissions.js';
import { errorText } from './allowlist.js';
import { renderMessage } from './message.js';

export const PURPOSE_LABELS = Object.freeze({ allowlist: 'Allowlist', entrevista: 'Entrevista', avisos: 'Avisos', outro: 'Outro' });

export function renderWebhooks(app) {
  if (!app.feature('allowlist') || !app.can('webhooks.gerenciar')) {
    renderMessage(app, { title: 'Acesso restrito', text: 'Só a Direção cadastra os webhooks do Discord.' });
    return null;
  }
  let alive = true;
  let editing = null;
  const names = new Map();
  const list = h('ul', { class: 'staff-list', id: 'wh-list' }, h('li', { class: 'staff-empty' }, 'Carregando…'));
  const formSlot = h('div', {});
  const rolesSlot = h('div', {});
  app.els.main.replaceChildren(h('div', { class: 'main-inner webhooks-page' },
    h('a', { class: 'back', href: '#/painel' }, icon('arrow-left'), 'Início'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Webhooks do Discord'),
      h('p', { class: 'page-sub' }, 'Canais para onde a Central envia os resultados de allowlist e entrevistas. O endereço do webhook fica guardado no banco e nunca aparece na tela.'),
      h('div', { class: 'page-head-actions' }, h('button', { type: 'button', class: 'btn btn--primary', id: 'wh-new', onclick: () => openForm(null) }, icon('plus'), 'Novo webhook'))),
    formSlot,
    h('section', { class: 'panel', 'aria-labelledby': 'wh-list-title' }, h('h2', { class: 'block-title', id: 'wh-list-title' }, icon('webhook'), 'Cadastrados'), list),
    rolesSlot));

  async function load() {
    const [hooks, staff] = await Promise.all([
      app.adapter.listDiscordWebhooks(),
      app.can('equipe.ver') ? app.adapter.listStaff() : Promise.resolve({ data: [] }),
    ]);
    if (!alive) return;
    if (hooks.error) { app.reportError(hooks.error, 'Não foi possível carregar os webhooks.'); return; }
    for (const m of staff.data ?? []) names.set(m.discord_id, m.display_name);
    draw(hooks.data);
  }

  function draw(hooks) {
    list.replaceChildren(...(hooks.length ? hooks.map((w) => h('li', { class: `staff-row${w.active ? '' : ' staff-row--off'}`, dataset: { id: w.id } },
      h('div', { class: 'staff-who' },
        h('p', { class: 'staff-name' }, w.name),
        h('p', { class: 'staff-meta' }, [PURPOSE_LABELS[w.purpose], w.channel_name, w.sender_name && `remetente: ${w.sender_name}`].filter(Boolean).join(' · '),
          ` · cadastrado por ${names.get(w.created_by) ?? w.created_by} em ${formatDate(w.created_at)}`)),
      h('div', { class: 'staff-tags' }, statusBadge(w.active)),
      h('div', { class: 'staff-actions' },
        h('button', { type: 'button', class: 'btn btn--sm', 'aria-label': `Editar ${w.name}`, onclick: () => openForm(w) }, icon('pencil'), 'Editar'),
        h('button', { type: 'button', class: 'btn btn--sm', 'data-requires-online': '', 'aria-label': `Testar ${w.name}`, onclick: (e) => test(w, e.currentTarget) }, icon('send'), 'Testar'),
        h('button', { type: 'button', class: 'btn btn--sm btn--ghost btn--danger', 'data-requires-online': '', 'aria-label': `Remover ${w.name}`, onclick: () => remove(w) }, icon('trash'), 'Remover'))))
      : [h('li', { class: 'staff-empty' }, 'Nenhum webhook cadastrado. Clique em "Novo webhook".')]));
    app.applyOnline();
  }

  async function test(w, btn) {
    btn.disabled = true;
    const res = await app.adapter.testDiscordWebhook(w.id);
    btn.disabled = false;
    if (!res.error) { toast(`✓ Mensagem de teste enviada para "${w.name}". Confira no canal.`, 5000); return; }
    openDialog({ title: '✗ O teste falhou', body: errorText(res.error), actions: [{ label: 'Entendi', value: true, variant: 'primary', autofocus: true }] });
  }

  async function remove(w) {
    const ok = await confirmDialog({ title: `Remover "${w.name}"?`, message: 'Some das opções de envio. A remoção fica registrada na auditoria.', confirmLabel: 'Remover', danger: true });
    if (!ok) return;
    const res = await app.adapter.deleteDiscordWebhook(w.id);
    if (res.error) { app.reportError(res.error); return; }
    toast('Webhook removido.');
    if (editing?.id === w.id) closeForm();
    load();
  }

  function closeForm() { editing = null; formSlot.replaceChildren(); }

  function openForm(w) {
    editing = w;
    const input = (key, label, { type = 'text', value = w?.[key] ?? '', hint = '', max = AL_LIMITS[key] ?? 80, placeholder = '' } = {}) => {
      const el = h('input', { class: 'input', id: `wh-${key}`, name: key, type, value, maxlength: max, placeholder, autocomplete: type === 'password' ? 'new-password' : 'off' });
      return h('div', { class: 'field' }, h('label', { class: 'field-label', for: `wh-${key}` }, label), el,
        hint && h('p', { class: 'field-hint' }, hint), h('p', { class: 'field-error', id: `wh-err-${key}`, hidden: true }));
    };
    const purpose = h('select', { class: 'input', id: 'wh-purpose', name: 'purpose' },
      WEBHOOK_PURPOSES.map((p) => h('option', { value: p, selected: (w?.purpose ?? 'allowlist') === p }, PURPOSE_LABELS[p])));
    const active = h('input', { type: 'checkbox', id: 'wh-active', checked: w ? w.active : true });
    const errorEl = h('p', { class: 'field-error form-general-error', role: 'alert', hidden: true });
    const form = h('form', { class: 'panel staff-form', id: 'wh-form', novalidate: true },
      h('h2', { class: 'block-title' }, icon(w ? 'pencil' : 'plus'), w ? `Editar "${w.name}"` : 'Novo webhook'),
      h('div', { class: 'staff-form-grid' },
        input('name', 'Nome *', { placeholder: 'Canal de Allowlist', value: w?.name ?? '' }),
        input('url', w ? 'Novo endereço do webhook' : 'Endereço do webhook *', {
          type: 'password', value: '', max: 300, placeholder: 'https://discord.com/api/webhooks/...',
          hint: w ? 'Deixe vazio para manter o endereço atual.' : 'No Discord: canal › Editar › Integrações › Webhooks › Copiar URL.',
        }),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'wh-purpose' }, 'Finalidade *'), purpose),
        input('channel_name', 'Canal (só para identificar)', { placeholder: '#allowlist-registros' }),
        input('sender_name', 'Nome do remetente', { placeholder: 'Bloodlines RP · Allowlist', hint: 'Vazio = o nome padrão de cada envio.' }),
        input('sender_avatar_url', 'Foto do remetente (endereço https://)', { max: AL_LIMITS.sender_avatar_url })),
      h('label', { class: 'check' }, active, 'Ativo (aparece nas opções de envio)'),
      errorEl,
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn btn--ghost', onclick: closeForm }, 'Cancelar'),
        h('button', { type: 'submit', class: 'btn btn--primary', id: 'wh-save', 'data-requires-online': '' }, icon('device-floppy'), 'Salvar')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(['name', 'url', 'channel_name', 'sender_name', 'sender_avatar_url'].map((k) => [k, form.querySelector(`#wh-${k}`).value]));
      const res = await app.adapter.saveDiscordWebhook({ ...(w ? { id: w.id } : {}), ...data, purpose: purpose.value, active: active.checked });
      for (const el of form.querySelectorAll('[id^="wh-err-"]')) el.hidden = true;
      if (res.error) {
        for (const [k, msg] of Object.entries(res.error.details?.errors ?? {})) {
          const el = form.querySelector(`#wh-err-${k}`);
          if (el) { el.textContent = msg; el.hidden = false; }
        }
        errorEl.textContent = errorText(res.error);
        errorEl.hidden = false;
        return;
      }
      toast(w ? 'Webhook atualizado.' : 'Webhook cadastrado. Use "Testar" para conferir o canal.');
      closeForm();
      load();
    });
    formSlot.replaceChildren(form);
    app.applyOnline();
    form.querySelector('#wh-name').focus();
  }

  /* ---------- IDs dos cargos no Discord (só depois do SQL 14) ---------- */
  async function loadRoles() {
    if (!app.feature('discord_cargos')) return;
    const res = await app.adapter.listDiscordRoleIds();
    if (!alive) return;
    if (res.error) { app.reportError(res.error, 'Não foi possível carregar os cargos do Discord.'); return; }
    const current = Object.fromEntries(res.data.map((r) => [r.role, r.discord_role_id]));
    const rows = ROLE_CODES.map((role) => h('div', { class: 'field' },
      h('label', { class: 'field-label', for: `dr-${role}` }, roleLabel(role)),
      h('input', { class: 'input', id: `dr-${role}`, inputmode: 'numeric', maxlength: 20, placeholder: 'só números', value: current[role] ?? '' }),
      h('p', { class: 'field-error', id: `dr-err-${role}`, hidden: true })));
    const form = h('form', { class: 'panel staff-form', id: 'dr-form', novalidate: true, 'aria-labelledby': 'dr-title' },
      h('h2', { class: 'block-title', id: 'dr-title' }, icon('at'), 'Cargos no Discord'),
      h('p', { class: 'panel-text' }, 'Com o ID cadastrado, o aviso enviado no canal marca o cargo do público (Toda a equipe marca todos). Vazio = não marca aquele cargo.'),
      h('p', { class: 'field-hint' }, 'No Discord (com o Modo Desenvolvedor ligado): Configurações do servidor › Cargos › botão direito no cargo › Copiar ID do cargo. Se a marcação não notificar, ligue no cargo a opção "Permitir que qualquer pessoa @mencione este cargo".'),
      h('div', { class: 'staff-form-grid' }, rows),
      h('div', { class: 'panel-actions' },
        h('button', { type: 'submit', class: 'btn btn--primary', id: 'dr-save', 'data-requires-online': '' }, icon('device-floppy'), 'Salvar cargos')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const map = Object.fromEntries(ROLE_CODES.map((role) => [role, form.querySelector(`#dr-${role}`).value.trim()]));
      for (const el of form.querySelectorAll('[id^="dr-err-"]')) el.hidden = true;
      const shown = (errors) => {
        for (const [role, msg] of Object.entries(errors)) {
          const el = form.querySelector(`#dr-err-${role}`);
          if (el) { el.textContent = msg; el.hidden = false; }
        }
        form.querySelector('.field-error:not([hidden])')?.previousElementSibling?.focus();
      };
      const { valid, errors } = validateDiscordRoleIds(map);
      if (!valid) { shown(errors); return; }
      const saved = await app.adapter.saveDiscordRoleIds(map);
      if (saved.error) { if (saved.error.details?.errors) shown(saved.error.details.errors); else app.reportError(saved.error); return; }
      toast('✓ Cargos do Discord salvos.');
    });
    rolesSlot.replaceChildren(form);
    app.applyOnline();
  }

  load();
  loadRoles();
  return () => { alive = false; };
}
