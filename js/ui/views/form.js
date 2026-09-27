// Cadastro e edição (SPEC 2.6) + conflito de edição (2.7).
import { h, icon, toast } from '../dom.js';
import { confirmDialog, openDialog } from '../modal.js';
import { AUDIENCES, STATUS_LABELS } from '../components.js';
import { CATEGORIES, LIMITS, validateProcedure } from '../../core/validate.js';
import { uniqueSlug } from '../../core/slug.js';
import { procedureBody } from './procedure.js';
import { renderMessage } from './message.js';

const DRAFT_PREFIX = 'bloodlines-kb:draft:';
const DRAFT_INTERVAL_MS = 2000;

const emptyDraft = (title = '') => ({
  title, slug: '', category: '', audience: '', status: 'ativo', tags: '',
  summary: '', who_handles: '', steps: [{ title: '', body: '' }], commands: [],
  ready_message: '', notes: '', source_url: '',
});

const toDraft = (p) => ({
  title: p.title, slug: p.slug, category: p.category, audience: p.audience, status: p.status,
  tags: (p.tags ?? []).join(', '), summary: p.summary ?? '', who_handles: p.who_handles ?? '',
  steps: structuredClone(p.steps?.length ? p.steps : [{ title: '', body: '' }]),
  commands: structuredClone(p.commands ?? []),
  ready_message: p.ready_message ?? '', notes: p.notes ?? '', source_url: p.source_url ?? '',
});

/** Rascunho do formulário → dados no formato do contrato. */
const toPayload = (d) => ({
  ...d,
  tags: d.tags.split(',').map((t) => t.trim()).filter(Boolean),
  steps: d.steps.map((s) => ({ title: s.title, body: s.body })),
  commands: d.commands.filter((c) => c.command.trim() || c.description.trim()),
});

const pathId = (path) => path.replace(/\./g, '-');

const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sem armazenamento */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* sem armazenamento */ } },
};

export function renderForm(app, { slug } = {}) {
  const editing = Boolean(slug);
  const original = editing ? app.bySlug(slug) : null;
  if (editing && !original) {
    renderMessage(app, { title: 'Procedimento não encontrado', text: 'Não há o que editar neste endereço.' });
    return null;
  }
  if (editing && original.status === 'arquivado' && !app.can('archive')) {
    renderMessage(app, { title: 'Procedimento arquivado', text: 'Só moderadores e admins podem editar procedimentos arquivados.' });
    return null;
  }

  const draftKey = DRAFT_PREFIX + (editing ? original.id : 'novo');
  const existingSlugs = app.state.procedures.filter((p) => p.id !== original?.id).map((p) => p.slug);
  const initial = editing ? toDraft(original) : emptyDraft(app.state.prefillTitle);
  if (!editing && initial.title.trim()) initial.slug = uniqueSlug(initial.title, existingSlugs);
  app.state.prefillTitle = '';

  let draft = structuredClone(initial);
  let baseVersion = editing ? original.version : null;
  let slugTouched = editing;
  let dirty = false;
  let submitted = false;
  let saving = false;
  let lastStored = null;

  /* ---------- DOM ---------- */
  const errorSummary = h('div', { class: 'form-errors', id: 'form-errors', role: 'alert', tabindex: '-1', hidden: true });
  const draftBanner = h('div', { class: 'banner banner--info', id: 'draft-banner', hidden: true });
  const preview = h('div', { class: 'preview-body' });
  const form = h('form', { class: 'proc-form', novalidate: true, 'aria-labelledby': 'form-title' });
  const layout = h('div', { class: 'form-layout' },
    form,
    h('aside', { class: 'preview', 'aria-label': 'Pré-visualização' },
      h('p', { class: 'preview-label' }, icon('eye'), 'Pré-visualização'),
      preview));

  const tabs = h('div', { class: 'form-tabs', role: 'group', 'aria-label': 'Modo de visualização' },
    h('button', { type: 'button', class: 'chip-toggle', 'aria-pressed': 'true', id: 'tab-edit', onclick: () => showTab('edit') }, 'Editar'),
    h('button', { type: 'button', class: 'chip-toggle', 'aria-pressed': 'false', id: 'tab-preview', onclick: () => showTab('preview') }, 'Pré-visualizar'));

  function showTab(which) {
    layout.classList.toggle('show-preview', which === 'preview');
    tabs.querySelector('#tab-edit').setAttribute('aria-pressed', String(which === 'edit'));
    tabs.querySelector('#tab-preview').setAttribute('aria-pressed', String(which === 'preview'));
    if (which === 'preview') updatePreview();
  }

  /* ---------- campos ---------- */
  function field({ path, label, required, hint, control, counter }) {
    const id = `f-${pathId(path)}`;
    control.id = id;
    control.dataset.path = path;
    const describedBy = [hint && `${id}-hint`, `err-${pathId(path)}`].filter(Boolean).join(' ');
    control.setAttribute('aria-describedby', describedBy);
    if (required) control.setAttribute('aria-required', 'true');
    return h('div', { class: 'field' },
      h('label', { class: 'field-label', for: id }, label, required && h('span', { class: 'req', 'aria-hidden': 'true' }, ' *')),
      control,
      (hint || counter) && h('div', { class: 'field-foot' },
        hint && h('p', { class: 'field-hint', id: `${id}-hint` }, hint),
        counter && h('span', { class: 'counter', 'data-counter': path, 'aria-hidden': 'true' })),
      h('p', { class: 'field-error', id: `err-${pathId(path)}`, hidden: true }));
  }

  const input = (value, attrs = {}) => h('input', { class: 'input', type: 'text', value, ...attrs });
  const textarea = (value, attrs = {}) => {
    const el = h('textarea', { class: 'input textarea', ...attrs });
    el.value = value;
    return el;
  };
  const select = (value, options) => h('select', { class: 'input' },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));

  const stepsList = h('ol', { class: 'steps-edit', id: 'steps-edit' });
  const commandsList = h('ul', { class: 'cmds-edit', id: 'cmds-edit' });

  function renderSteps(focus) {
    const total = draft.steps.length;
    stepsList.replaceChildren(...draft.steps.map((step, i) => h('li', { class: 'step-edit' },
      h('div', { class: 'step-edit-head' },
        h('span', { class: 'step-num step-num--sm', 'aria-hidden': 'true' }, i + 1),
        h('span', { class: 'step-edit-label' }, `Passo ${i + 1}`),
        h('div', { class: 'step-edit-tools' },
          h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'data-action': 'up', 'data-index': i, disabled: i === 0, 'aria-label': `Mover passo ${i + 1} para cima` }, icon('arrow-up')),
          h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'data-action': 'down', 'data-index': i, disabled: i === total - 1, 'aria-label': `Mover passo ${i + 1} para baixo` }, icon('arrow-down')),
          h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'data-action': 'remove-step', 'data-index': i, disabled: total === 1, 'aria-label': `Remover passo ${i + 1}` }, icon('trash')))),
      field({ path: `steps.${i}.title`, label: 'Título do passo', required: true, control: input(step.title, { maxlength: LIMITS.stepTitle.max }) }),
      field({ path: `steps.${i}.body`, label: 'Detalhes', hint: 'Aceita **negrito**, `código`, listas e links.', control: textarea(step.body, { rows: 3 }) }))));
    if (focus) stepsList.querySelector(focus)?.focus();
    showErrors();
  }

  function renderCommands(focus) {
    commandsList.replaceChildren(...draft.commands.map((cmd, i) => h('li', { class: 'cmd-edit' },
      field({ path: `commands.${i}.command`, label: `Comando ${i + 1}`, required: true, control: input(cmd.command, { class: 'input input--mono', spellcheck: 'false' }) }),
      field({ path: `commands.${i}.description`, label: 'Descrição', control: input(cmd.description) }),
      h('button', { type: 'button', class: 'icon-btn', 'data-action': 'remove-cmd', 'data-index': i, 'aria-label': `Remover comando ${i + 1}` }, icon('trash')))));
    if (!draft.commands.length) commandsList.append(h('li', { class: 'field-hint' }, 'Nenhum comando. Opcional.'));
    if (focus) commandsList.querySelector(focus)?.focus();
    showErrors();
  }

  const statusOptions = Object.entries(STATUS_LABELS)
    .filter(([v]) => v !== 'arquivado' || app.can('archive') || draft.status === 'arquivado');

  function mount() {
    form.replaceChildren(
      errorSummary,
      h('fieldset', { class: 'fieldset' },
        h('legend', { class: 'legend' }, 'Identificação'),
        field({ path: 'title', label: 'Título', required: true, counter: true, control: input(draft.title, { maxlength: LIMITS.title.max, autocomplete: 'off' }) }),
        field({ path: 'slug', label: 'Endereço (link)', required: true, hint: 'Gerado pelo título. Só letras minúsculas, números e hífens.', control: input(draft.slug, { class: 'input input--mono', spellcheck: 'false', autocomplete: 'off' }) }),
        h('div', { class: 'field-row' },
          field({ path: 'category', label: 'Categoria', required: true, control: select(draft.category, [['', 'Escolha…'], ...CATEGORIES.map((c) => [c, c])]) }),
          field({ path: 'audience', label: 'Público', required: true, control: select(draft.audience, [['', 'Escolha…'], ...Object.entries(AUDIENCES).map(([v, a]) => [v, a.label])]) }),
          field({ path: 'status', label: 'Status', required: true, control: select(draft.status, statusOptions) })),
        field({ path: 'tags', label: 'Tags', hint: 'Palavras extras para a busca, separadas por vírgula. Ex.: ATEMP, caixa', control: input(draft.tags, { autocomplete: 'off' }) })),
      h('fieldset', { class: 'fieldset' },
        h('legend', { class: 'legend' }, 'Quando usar'),
        field({ path: 'summary', label: 'Resumo', required: true, counter: true, hint: 'Uma linha: quando este procedimento se aplica.', control: textarea(draft.summary, { rows: 2, maxlength: LIMITS.summary.max }) }),
        field({ path: 'who_handles', label: 'Quem atende', hint: 'Ex.: Inicial: Suporte · Finalização: Moderador', control: input(draft.who_handles) })),
      h('fieldset', { class: 'fieldset' },
        h('legend', { class: 'legend' }, 'Passo a passo'),
        h('p', { class: 'field-error', id: 'err-steps', hidden: true }),
        stepsList,
        h('button', { type: 'button', class: 'btn', 'data-action': 'add-step' }, icon('plus'), 'Adicionar passo')),
      h('fieldset', { class: 'fieldset' },
        h('legend', { class: 'legend' }, 'Comandos'),
        h('p', { class: 'field-error', id: 'err-commands', hidden: true }),
        commandsList,
        h('button', { type: 'button', class: 'btn', 'data-action': 'add-cmd' }, icon('plus'), 'Adicionar comando')),
      h('fieldset', { class: 'fieldset' },
        h('legend', { class: 'legend' }, 'Textos de apoio'),
        field({ path: 'ready_message', label: 'Mensagem pronta', hint: 'Texto para colar no Discord (ganha botão Copiar).', control: textarea(draft.ready_message, { rows: 4 }) }),
        field({ path: 'notes', label: 'Observações', hint: 'Avisos, exceções, o que não fazer. Aceita Markdown.', control: textarea(draft.notes, { rows: 3 }) }),
        field({ path: 'source_url', label: 'Link da fonte', hint: 'Link do post original no fórum #faq (https://…).', control: input(draft.source_url, { type: 'url', inputmode: 'url', spellcheck: 'false', placeholder: 'https://discord.com/channels/…' }) })),
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn btn--ghost', 'data-action': 'cancel' }, 'Cancelar'),
        h('button', { type: 'submit', class: 'btn btn--primary', id: 'save-btn', 'data-requires-online': '' }, icon('device-floppy'), 'Salvar')),
    );
    renderSteps();
    renderCommands();
    updateCounters();
    updatePreview();
    app.applyOnline();
  }

  /* ---------- estado e eventos ---------- */
  function setPath(path, value) {
    const parts = path.split('.');
    let target = draft;
    for (let i = 0; i < parts.length - 1; i++) target = target[parts[i]];
    target[parts.at(-1)] = value;
  }

  function markDirty() {
    dirty = JSON.stringify(draft) !== JSON.stringify(initial);
    schedulePreview();
    if (submitted) showErrors(validateProcedure(toPayload(draft)).errors);
  }

  function updateCounters() {
    for (const el of form.querySelectorAll('[data-counter]')) {
      const path = el.dataset.counter;
      const max = path === 'title' ? LIMITS.title.max : LIMITS.summary.max;
      el.textContent = `${draft[path].length}/${max}`;
    }
  }

  let previewTimer;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 120);
  }
  function updatePreview() {
    const data = toPayload(draft);
    preview.replaceChildren(procedureBody({
      ...data, id: original?.id ?? 'novo',
      last_reviewed_at: original?.last_reviewed_at ?? null,
      last_reviewed_by_name: original?.last_reviewed_by_name ?? null,
    }, { headingLevel: 2, idPrefix: 'pv' }));
  }

  form.addEventListener('input', (e) => {
    const path = e.target.dataset?.path;
    if (!path) return;
    setPath(path, e.target.value);
    if (path === 'title' && !slugTouched) {
      draft.slug = draft.title.trim() ? uniqueSlug(draft.title, existingSlugs) : '';
      const slugInput = form.querySelector('#f-slug');
      if (slugInput) slugInput.value = draft.slug;
    }
    if (path === 'slug') slugTouched = true;
    updateCounters();
    markDirty();
  });
  form.addEventListener('change', (e) => {
    if (e.target.tagName === 'SELECT' && e.target.dataset.path) {
      setPath(e.target.dataset.path, e.target.value);
      markDirty();
    }
  });

  form.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const i = Number(btn.dataset.index);
    const action = btn.dataset.action;
    if (action === 'add-step') {
      draft.steps.push({ title: '', body: '' });
      renderSteps(`#f-steps-${draft.steps.length - 1}-title`);
    } else if (action === 'remove-step') {
      draft.steps.splice(i, 1);
      renderSteps(`[data-action="remove-step"][data-index="${Math.min(i, draft.steps.length - 1)}"]:not([disabled])`);
    } else if (action === 'up' || action === 'down') {
      const j = action === 'up' ? i - 1 : i + 1;
      [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]];
      const stayOn = (action === 'up' && j === 0) || (action === 'down' && j === draft.steps.length - 1)
        ? (action === 'up' ? 'down' : 'up') : action;
      renderSteps(`[data-action="${stayOn}"][data-index="${j}"]`);
      toast(`Passo movido para a posição ${j + 1}.`, 1500);
    } else if (action === 'add-cmd') {
      draft.commands.push({ command: '', description: '' });
      renderCommands(`#f-commands-${draft.commands.length - 1}-command`);
    } else if (action === 'remove-cmd') {
      draft.commands.splice(i, 1);
      renderCommands();
    } else if (action === 'cancel') {
      app.router.go(editing ? `#/p/${original.slug}` : '#/');
      return;
    } else {
      return;
    }
    markDirty();
  });

  /* ---------- validação ---------- */
  function showErrors(errors = submitted ? validateProcedure(toPayload(draft)).errors : {}) {
    for (const el of form.querySelectorAll('.field-error')) { el.hidden = true; el.textContent = ''; }
    for (const el of form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');

    const entries = Object.entries(errors);
    for (const [path, message] of entries) {
      const key = path.startsWith('tags.') ? 'tags' : path;
      const errEl = form.querySelector(`#err-${pathId(key)}`);
      if (errEl) { errEl.textContent = message; errEl.hidden = false; }
      form.querySelector(`#f-${pathId(key)}`)?.setAttribute('aria-invalid', 'true');
    }

    if (!submitted || entries.length === 0) {
      errorSummary.hidden = true;
      errorSummary.replaceChildren();
      return;
    }
    errorSummary.hidden = false;
    errorSummary.replaceChildren(
      h('p', { class: 'form-errors-title' }, icon('alert-circle'),
        entries.length === 1 ? 'Corrija 1 campo antes de salvar:' : `Corrija ${entries.length} campos antes de salvar:`),
      h('ul', {}, entries.map(([path, message]) => {
        const key = path.startsWith('tags.') ? 'tags' : path;
        return h('li', {}, h('button', {
          type: 'button', class: 'link-btn',
          onclick: () => form.querySelector(`#f-${pathId(key)}`)?.focus(),
        }, message));
      })));
  }

  /* ---------- salvar ---------- */
  async function save({ overwrite = false } = {}) {
    if (saving || !app.state.online) return;
    submitted = true;
    const payload = toPayload(draft);
    const { valid, errors } = validateProcedure(payload);
    if (!valid) {
      showErrors(errors);
      errorSummary.focus();
      return;
    }
    showErrors({});

    saving = true;
    const saveBtn = form.querySelector('#save-btn');
    saveBtn.disabled = true;
    const result = editing
      ? await app.adapter.updateProcedure(original.id, payload, baseVersion)
      : await app.adapter.createProcedure(payload);
    saving = false;
    saveBtn.disabled = !app.state.online;

    if (result.error) {
      const { code, details } = result.error;
      if (code === 'VALIDATION' && details?.errors) {
        showErrors(details.errors);
        errorSummary.focus();
      } else if (code === 'CONFLICT' && !overwrite) {
        await handleConflict(details);
      } else {
        app.reportError(result.error, 'Não foi possível salvar.');
      }
      return;
    }

    storage.remove(draftKey);
    dirty = false;
    app.router.clearGuard();
    await app.reload();
    toast('Procedimento salvo.');
    app.router.go(`#/p/${result.data.slug}`);
  }

  async function handleConflict(details) {
    const who = details?.updated_by_name ?? 'outra pessoa';
    storeDraft(true);
    const choice = await openDialog({
      title: 'Conflito de edição',
      body: h('div', {},
        h('p', { id: 'conflict-message' }, `Este procedimento foi alterado por ${who} enquanto você editava.`),
        h('p', { class: 'dialog-hint' }, 'Seu texto foi guardado como rascunho neste navegador.')),
      actions: [
        { label: 'Continuar editando', value: 'stay', variant: 'ghost', autofocus: true },
        { label: 'Ver a versão atual', value: 'view' },
        { label: 'Sobrescrever mesmo assim', value: 'overwrite', variant: 'danger' },
      ],
    });
    if (choice === 'view') {
      dirty = false;
      app.router.clearGuard();
      await app.reload();
      app.router.go(`#/p/${details.current.slug}`);
      toast('Seu rascunho continua guardado: abra Editar para recuperá-lo.', 4000);
    } else if (choice === 'overwrite') {
      const sure = await confirmDialog({
        title: 'Sobrescrever a versão atual?',
        message: `As alterações feitas por ${who} serão substituídas pelas suas. Elas continuam no histórico.`,
        confirmLabel: 'Sobrescrever', danger: true,
      });
      if (!sure) return;
      baseVersion = details.current.version;
      await save({ overwrite: true });
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });

  /* ---------- rascunho automático ---------- */
  function storeDraft(force = false) {
    if (!dirty && !force) return;
    const json = JSON.stringify(draft);
    if (json === lastStored && !force) return;
    storage.set(draftKey, { draft, savedAt: new Date().toISOString(), baseVersion });
    lastStored = json;
  }
  const timer = setInterval(storeDraft, DRAFT_INTERVAL_MS);

  const stored = storage.get(draftKey);
  if (stored?.draft && JSON.stringify(stored.draft) !== JSON.stringify(initial)) {
    const when = new Date(stored.savedAt).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    draftBanner.hidden = false;
    draftBanner.replaceChildren(
      icon('device-floppy'),
      h('p', {}, `Há um rascunho não salvo de ${when}.`),
      h('div', { class: 'banner-actions' },
        h('button', {
          type: 'button', class: 'btn btn--sm btn--primary', id: 'recover-draft',
          onclick: () => {
            draft = { ...emptyDraft(), ...stored.draft };
            slugTouched = true;
            lastStored = JSON.stringify(draft);
            draftBanner.hidden = true;
            mount();
            markDirty();
            toast('Rascunho recuperado.');
          },
        }, 'Recuperar rascunho'),
        h('button', {
          type: 'button', class: 'btn btn--sm btn--ghost', id: 'discard-draft',
          onclick: () => { storage.remove(draftKey); draftBanner.hidden = true; },
        }, 'Descartar')));
  }

  /* ---------- sair sem salvar ---------- */
  app.router.setGuard(async () => {
    if (!dirty) return true;
    const discard = await confirmDialog({
      title: 'Descartar alterações?',
      message: 'As alterações que você fez neste formulário não foram salvas.',
      confirmLabel: 'Descartar', cancelLabel: 'Continuar editando', danger: true,
    });
    if (discard) storage.remove(draftKey);
    return discard;
  });

  /* ---------- montagem ---------- */
  app.els.main.replaceChildren(h('div', { class: 'form-page' },
    h('a', { class: 'back', href: editing ? `#/p/${original.slug}` : '#/' }, icon('arrow-left'), editing ? 'Voltar ao procedimento' : 'Voltar para a lista'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', id: 'form-title', tabindex: '-1' }, editing ? 'Editar procedimento' : 'Novo procedimento'),
      editing && h('p', { class: 'page-sub' }, `Editando a versão ${original.version}. Campos com * são obrigatórios.`),
      !editing && h('p', { class: 'page-sub' }, 'Campos com * são obrigatórios.')),
    draftBanner,
    tabs,
    layout));
  mount();

  return () => {
    clearInterval(timer);
    clearTimeout(previewTimer);
    app.router.clearGuard();
  };
}
