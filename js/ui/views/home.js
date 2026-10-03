// Tela inicial: Favoritos → Revisar → categorias; ou resultados da busca/filtros (SPEC 2.4, 4.3).
import { h, icon } from '../dom.js';
import { AUDIENCES, STATUS_LABELS, needsReview, procedureCard } from '../components.js';
import { CATEGORIES } from '../../core/validate.js';

const byTitle = (a, b) => a.title.localeCompare(b.title, 'pt-BR');

function filterBar(app) {
  const { filters } = app.state;
  const select = (id, label, value, options, onChange) => h('label', { class: 'filter', for: id },
    h('span', { class: 'filter-label' }, label),
    h('select', { id, class: 'input input--sm', onchange: (e) => onChange(e.target.value) },
      options.map(([v, text]) => h('option', { value: v, selected: v === value }, text))));

  return h('div', { class: 'filters', role: 'group', 'aria-label': 'Filtros' },
    select('flt-audience', 'Público', filters.audience, [
      ['', 'Todos'], ...Object.entries(AUDIENCES).map(([v, { label }]) => [v, label]),
    ], (v) => app.setFilters({ audience: v })),
    select('flt-status', 'Status', filters.status, [
      ['', 'Ativos e a revisar'], ...Object.entries(STATUS_LABELS).map(([v, label]) => [v, label]),
    ], (v) => app.setFilters({ status: v })),
    h('button', {
      type: 'button', class: 'chip-toggle', id: 'flt-favorites',
      'aria-pressed': String(filters.favoritesOnly),
      onclick: () => app.setFilters({ favoritesOnly: !filters.favoritesOnly }),
    }, h('span', { 'aria-hidden': 'true' }, filters.favoritesOnly ? '★' : '☆'), 'Só favoritos'),
    filters.category && h('button', {
      type: 'button', class: 'chip-toggle', 'aria-pressed': 'true',
      'aria-label': `Remover filtro de categoria ${filters.category}`,
      onclick: () => app.setFilters({ category: '' }),
    }, filters.category, h('span', { 'aria-hidden': 'true' }, ' ×')),
    app.hasFilters() && h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => app.clearFilters() },
      icon('filter-off'), 'Limpar filtros'));
}

function section(app, { id, title, sym, symClass, list, emptyText, query }) {
  return h('section', { class: 'home-section', id, 'aria-labelledby': `${id}-title` },
    h('div', { class: 'section-head' },
      h('h2', { class: 'section-title', id: `${id}-title` },
        sym && h('span', { class: `sym ${symClass ?? ''}`, 'aria-hidden': 'true' }, sym),
        title),
      h('span', { class: 'section-count' }, list.length)),
    list.length
      ? h('div', { class: 'card-grid' }, list.map((p) => procedureCard(p, {
        isFav: app.isFav(p), onToggleFav: app.toggleFavorite, section: id, query,
      })))
      : h('p', { class: 'empty' }, emptyText));
}

export function renderHome(app) {
  const { state } = app;
  const query = state.query.trim();
  const filtering = Boolean(query) || app.hasFilters();
  const visible = state.procedures.filter((p) => p.status !== 'arquivado');

  let body;
  if (filtering) {
    const results = app.results();
    const ruleRows = app.ruleResults();
    const rulesSection = ruleRows.length > 0 && h('section', { class: 'home-section', id: 'rules-results', 'aria-labelledby': 'rules-results-title' },
      h('div', { class: 'section-head' },
        h('h2', { class: 'section-title', id: 'rules-results-title' }, 'Livro de Regras'),
        h('span', { class: 'section-count', role: 'status' }, `${ruleRows.length} ${ruleRows.length === 1 ? 'regra' : 'regras'}`)),
      h('div', { class: 'card-grid' }, ruleRows.map((r) => h('article', { class: 'rule-card', dataset: { id: r.id } },
        h('a', { class: 'rule-card-link', href: `#/regras/${r.id}` },
          h('p', { class: 'rule-cat-tag' }, r.category),
          h('h3', { class: 'rule-card-title' }, r.title))))));
    body = [rulesSection, h('section', { class: 'home-section', 'aria-labelledby': 'results-title' },
      h('div', { class: 'section-head' },
        h('h2', { class: 'section-title', id: 'results-title' }, 'Resultados'),
        h('span', { class: 'section-count', role: 'status', id: 'results-count' },
          `${results.length} ${results.length === 1 ? 'procedimento' : 'procedimentos'}`)),
      results.length
        ? h('div', { class: 'card-grid' }, results.map((p) => procedureCard(p, {
          isFav: app.isFav(p), onToggleFav: app.toggleFavorite, section: 'results', query,
        })))
        : h('div', { class: 'empty empty--action', id: 'no-results' },
          query
            ? h('p', {}, 'Nenhum procedimento encontrado para ', h('em', {}, query), '.')
            : h('p', {}, 'Nenhum procedimento com esses filtros.'),
          query && app.can('procedimentos.editar')
            ? h('a', {
              class: 'btn btn--primary', href: '#/novo',
              onclick: () => { state.prefillTitle = query; },
            }, icon('plus'), 'Cadastrar este procedimento')
            : app.hasFilters() && h('button', { type: 'button', class: 'btn', onclick: () => app.clearFilters() }, icon('filter-off'), 'Limpar filtros')))];
  } else {
    const favorites = visible.filter((p) => app.isFav(p)).sort(byTitle);
    const review = visible.filter((p) => needsReview(p)).sort(byTitle);
    const groups = CATEGORIES
      .map((c) => [c, visible.filter((p) => p.category === c).sort(byTitle)])
      .filter(([, list]) => list.length);

    body = [
      section(app, {
        id: 'favoritos', title: 'Favoritos', sym: '★', symClass: 'sym--pink', list: favorites,
        emptyText: 'Nenhum favorito ainda. Use ☆ em qualquer procedimento para fixá-lo aqui.',
      }),
      review.length > 0 && section(app, { id: 'revisar', title: 'Revisar', sym: '⚠', symClass: 'sym--warn', list: review }),
      groups.map(([name, list], i) => section(app, { id: `cat-${i}`, title: name, list })),
      visible.length === 0 && h('div', { class: 'empty empty--action' },
        h('p', {}, 'Nenhum procedimento cadastrado ainda.'),
        app.can('procedimentos.editar') && h('a', { class: 'btn btn--primary', href: '#/novo' }, icon('plus'), 'Cadastrar o primeiro')),
    ];
  }

  const categoriesCount = new Set(visible.map((p) => p.category)).size;
  app.els.main.replaceChildren(h('div', { class: 'main-inner' },
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Procedimentos'),
      h('p', { class: 'page-sub' }, `${visible.length} procedimentos em ${categoriesCount} categorias`)),
    filterBar(app),
    body));
}
