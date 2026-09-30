// Livro de Regras (plano 05): #/regras (lista por categoria) e #/regras/<id> (leitura de uma regra).
// Ler: regras.ler ou regras.editar. Criar, editar e apagar: regras.editar (Direção por padrão).
// Markdown só pelo renderizador do projeto (renderRichMarkdownInto: títulos e tabelas liberados).
import { h, icon, toast } from '../dom.js';
import { confirmDialog } from '../modal.js';
import { renderRichMarkdownInto } from '../../core/render-md.js';
import { RULE_LIMITS, categoriesOf, filterRules, groupByCategory } from '../../core/rules.js';
import { formField, showFieldErrors } from './gabarito.js';
import { renderMessage } from './message.js';

export function renderRules(app, id) {
  const canRead = app.can('regras.ler') || app.can('regras.editar');
  if (!app.feature('regras') || !canRead) {
    renderMessage(app, { title: 'Acesso restrito', text: 'Seu cargo não abre o Livro de Regras.' });
    return null;
  }
  const canEdit = app.can('regras.editar');
  let alive = true;
  let rules = [];
  const f = { q: '', category: '' };
  const slot = h('div', {});
  const chips = h('div', { class: 'rules-cats', id: 'rules-cats', role: 'group', 'aria-label': 'Filtrar por categoria' });
  const list = h('div', { class: 'rules-list', id: 'rules-list' }, h('p', { class: 'panel-text' }, 'Carregando…'));
  const count = h('p', { class: 'panel-text', id: 'rules-count', 'aria-live': 'polite' });

  app.els.main.replaceChildren(h('div', { class: 'main-inner rules-page' }, slot));

  async function load() {
    const res = await app.adapter.listRules();
    if (!alive) return;
    if (res.error) { app.reportError(res.error, 'Não foi possível carregar o Livro de Regras.'); return; }
    rules = res.data;
    show();
  }

  function show() {
    const rule = id ? rules.find((r) => r.id === id) : null;
    if (id && !rule) {
      slot.replaceChildren(
        h('a', { class: 'back', href: '#/regras' }, icon('arrow-left'), 'Voltar ao Livro de Regras'),
        h('h1', { class: 'page-title', tabindex: '-1' }, 'Regra não encontrada'),
        h('p', { class: 'panel-text', id: 'rules-missing' }, 'Ela pode ter sido apagada.'));
      return;
    }
    if (rule) drawDetail(rule); else drawList();
  }

  /* ---------- lista ---------- */
  function drawList() {
    slot.replaceChildren(
      h('a', { class: 'back', href: '#/' }, icon('arrow-left'), 'Voltar para a lista'),
      h('header', { class: 'page-head' },
        h('h1', { class: 'page-title', tabindex: '-1' }, 'Livro de Regras'),
        h('p', { class: 'page-sub' }, 'Bloodlines RP · diretrizes oficiais do servidor.'),
        canEdit && h('div', { class: 'page-head-actions' },
          h('button', { type: 'button', class: 'btn btn--primary', id: 'rules-new', onclick: () => openForm(null) }, icon('plus'), 'Nova regra'))),
      h('div', { class: 'staff-filters' },
        h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, 'Buscar'),
          h('input', {
            class: 'input input--sm', id: 'rules-q', type: 'search', placeholder: 'Título ou trecho da regra', autocomplete: 'off',
            value: f.q, oninput: (e) => { f.q = e.target.value; drawCards(); },
          }))),
      chips, count, list);
    drawChips();
    drawCards();
  }

  function drawChips() {
    const chip = (value, label) => h('button', {
      type: 'button', class: 'rules-cat', 'aria-pressed': String(f.category === value), dataset: { category: value },
      onclick: () => { f.category = value; drawChips(); drawCards(); },
    }, label);
    chips.replaceChildren(chip('', 'Todas'), ...categoriesOf(rules).map((c) => chip(c, c)));
  }

  function drawCards() {
    const rows = filterRules(rules, { query: f.q, category: f.category });
    count.textContent = `${rows.length} de ${rules.length} regras`;
    if (!rows.length) {
      list.replaceChildren(h('p', { class: 'panel-text', id: 'rules-empty' },
        rules.length ? 'Nenhuma regra encontrada.' : 'Ainda não há regras cadastradas.'));
      return;
    }
    list.replaceChildren(...groupByCategory(rows).map(([category, group]) => h('section', { class: 'rules-group', 'aria-label': category },
      h('h2', { class: 'rules-group-title' }, category),
      h('div', { class: 'rules-cards' }, group.map((r) => h('article', { class: 'rule-card', dataset: { id: r.id } },
        h('a', { class: 'rule-card-link', href: `#/regras/${r.id}` }, h('h3', { class: 'rule-card-title' }, r.title)),
        canEdit && h('div', { class: 'rule-card-actions' },
          h('button', { type: 'button', class: 'btn btn--sm', 'aria-label': `Editar ${r.title}`, onclick: () => openForm(r) }, icon('pencil'), 'Editar'),
          h('button', { type: 'button', class: 'btn btn--sm btn--danger', 'aria-label': `Apagar ${r.title}`, onclick: () => remove(r) }, icon('trash'), 'Apagar'))))))));
  }

  /* ---------- leitura ---------- */
  function drawDetail(rule) {
    const body = renderRichMarkdownInto(h('div', { class: 'md rule-body', id: 'rule-body' }), rule.content);
    slot.replaceChildren(
      h('a', { class: 'back', href: '#/regras' }, icon('arrow-left'), 'Voltar ao Livro de Regras'),
      h('header', { class: 'page-head' },
        h('p', { class: 'rule-cat-tag' }, rule.category),
        h('h1', { class: 'page-title', tabindex: '-1' }, rule.title),
        rule.updated_by_name && h('p', { class: 'page-sub' }, `Atualizada por ${rule.updated_by_name}`),
        canEdit && h('div', { class: 'page-head-actions panel-actions' },
          h('button', { type: 'button', class: 'btn', id: 'rule-edit', onclick: () => openForm(rule) }, icon('pencil'), 'Editar esta regra'),
          h('button', { type: 'button', class: 'btn btn--danger', id: 'rule-delete', onclick: () => remove(rule) }, icon('trash'), 'Apagar'))),
      h('div', { class: 'panel rule-panel' }, body));
  }

  /* ---------- criar e editar ---------- */
  function openForm(rule) {
    const fields = {
      title: formField('rule-title', 'Título *', h('input', { class: 'input', maxlength: RULE_LIMITS.title, value: rule?.title ?? '', autocomplete: 'off' })),
      category: formField('rule-category', 'Categoria *', h('input', {
        class: 'input', maxlength: RULE_LIMITS.category, value: rule?.category ?? '', list: 'rule-categories', autocomplete: 'off',
        placeholder: 'Ex.: Regras Gerais de RP',
      })),
      position: formField('rule-position', 'Ordem', h('input', { class: 'input', type: 'number', min: 0, max: RULE_LIMITS.order, value: rule?.position ?? 0 }),
        'Número menor aparece primeiro dentro da categoria.'),
      content: formField('rule-content', 'Conteúdo (Markdown) *', h('textarea', { class: 'input textarea', rows: 16, maxlength: RULE_LIMITS.content }, rule?.content ?? ''),
        'Use ## para títulos, ** para negrito e - para listas.'),
    };
    const general = h('p', { class: 'field-error form-general-error', role: 'alert', hidden: true });
    const form = h('form', { class: 'panel staff-form', id: 'rules-form', novalidate: true },
      h('h2', { class: 'block-title' }, icon(rule ? 'pencil' : 'plus'), rule ? `Editar "${rule.title}"` : 'Nova regra'),
      h('datalist', { id: 'rule-categories' }, categoriesOf(rules).map((c) => h('option', { value: c }))),
      h('div', { class: 'staff-form-grid' }, fields.title.el, fields.category.el, fields.position.el),
      fields.content.el, general,
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn btn--ghost', id: 'rules-cancel', onclick: show }, 'Cancelar'),
        h('button', { type: 'submit', class: 'btn btn--primary', id: 'rules-save', 'data-requires-online': '' },
          icon('device-floppy'), rule ? 'Salvar alterações' : 'Publicar regra')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await app.adapter.saveRule({
        ...(rule ? { id: rule.id } : {}),
        title: fields.title.input.value,
        category: fields.category.input.value,
        content: fields.content.input.value,
        position: Number.parseInt(fields.position.input.value || '0', 10),
      });
      showFieldErrors(fields, general, res.error);
      if (res.error) return;
      toast(rule ? 'Regra atualizada.' : 'Regra publicada.');
      rules = [...rules.filter((r) => r.id !== res.data.id), res.data];
      show();
    });
    slot.replaceChildren(h('a', { class: 'back', href: '#/regras', onclick: (e) => { e.preventDefault(); show(); } },
      icon('arrow-left'), 'Cancelar e voltar'), form);
    app.applyOnline();
    fields.title.input.focus();
  }

  async function remove(rule) {
    const yes = await confirmDialog({
      title: 'Apagar regra',
      message: `Apagar a regra "${rule.title}"? Esta ação não pode ser desfeita.`,
      confirmLabel: 'Apagar',
      danger: true,
    });
    if (!yes) return;
    const res = await app.adapter.deleteRule(rule.id);
    if (res.error) { app.reportError(res.error, 'Não foi possível apagar a regra.'); return; }
    toast('Regra apagada.');
    rules = rules.filter((r) => r.id !== rule.id);
    if (id) { app.router.go('#/regras'); return; }
    show();
  }

  load();
  return () => { alive = false; };
}
