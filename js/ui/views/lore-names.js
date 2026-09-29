// Etapas 8 e 9 · nomes e sobrenomes proibidos (documento 02, seção 12.2): #/lore/nomes.
// Consulta: quem avalia e lore.consultar. Cadastrar, editar e desativar: lore.gerenciar.
// "Em uso na cidade" vem da tela de Personagens (o nome leva ao personagem).
import { h, icon, toast } from '../dom.js';
import { statusBadge } from '../components.js';
import { normalizeName } from '../../core/allowlist.js';
import { LORE_LIMITS, NAME_KINDS, NAME_MODES, NAME_REASONS } from '../../core/lore.js';
import { formField, showFieldErrors } from './gabarito.js';
import { renderMessage } from './message.js';

const select = (id, options, value, { all } = {}) => h('select', { class: 'input input--sm', id },
  all && h('option', { value: '' }, all),
  Object.entries(options).map(([v, t]) => h('option', { value: v, selected: value === v }, t)));

export function renderLoreNames(app) {
  const canRead = app.can('lore.consultar') || app.can('lore.gerenciar') || app.can('allowlist.avaliar');
  if (!app.feature('allowlist') || !canRead) {
    renderMessage(app, { title: 'Acesso restrito', text: 'Seu cargo não consulta os nomes proibidos.' });
    return null;
  }
  const canEdit = app.can('lore.gerenciar');
  let alive = true;
  let names = [];
  const f = { q: '', kind: '', reason: '', mode: '', off: false };
  const list = h('ul', { class: 'staff-list', id: 'names-list' }, h('li', { class: 'staff-empty' }, 'Carregando…'));
  const count = h('p', { class: 'panel-text', id: 'names-count', 'aria-live': 'polite' });
  const formSlot = h('div', {});
  const on = (key) => (e) => { f[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; draw(); };

  app.els.main.replaceChildren(h('div', { class: 'main-inner names-page' },
    h('a', { class: 'back', href: '#/' }, icon('arrow-left'), 'Voltar para a lista'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Nomes proibidos'),
      h('p', { class: 'page-sub' }, 'Nomes e sobrenomes que a análise de allowlist confere sozinha. "Bloqueia" mostra aviso vermelho; "Só alerta", laranja. Desative em vez de apagar.'),
      canEdit && h('div', { class: 'page-head-actions' },
        h('button', { type: 'button', class: 'btn btn--primary', id: 'names-new', onclick: () => openForm(null) }, icon('plus'), 'Adicionar nome'))),
    formSlot,
    h('section', { class: 'panel', 'aria-labelledby': 'names-title' },
      h('h2', { class: 'block-title', id: 'names-title' }, icon('ban'), 'Lista'),
      h('div', { class: 'staff-filters' },
        h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, 'Buscar'),
          h('input', { class: 'input input--sm', id: 'names-q', type: 'search', placeholder: 'Nome ou série', oninput: on('q') })),
        h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, 'Tipo'), select('names-kind', NAME_KINDS, '', { all: 'Todos' })),
        h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, 'Motivo'), select('names-reason', NAME_REASONS, '', { all: 'Todos' })),
        h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, 'Modo'), select('names-mode', NAME_MODES, '', { all: 'Todos' })),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'names-off', onchange: on('off') }), 'Mostrar os desativados')),
      count, list)));
  for (const k of ['kind', 'reason', 'mode']) app.els.main.querySelector(`#names-${k}`).addEventListener('change', on(k));

  async function load() {
    const res = await app.adapter.listBlockedNames({ includeInactive: true });
    if (!alive) return;
    if (res.error) { app.reportError(res.error, 'Não foi possível carregar os nomes.'); return; }
    names = res.data;
    draw();
  }

  function draw() {
    const q = normalizeName(f.q);
    const rows = names.filter((n) => (f.off || n.active) && (!f.kind || n.kind === f.kind) && (!f.reason || n.reason === f.reason)
      && (!f.mode || n.mode === f.mode) && (!q || normalizeName(`${n.name} ${n.series} ${n.reason_text}`).includes(q)));
    count.textContent = `${rows.length} de ${names.length} nomes`;
    const shown = rows.slice(0, 300);
    list.replaceChildren(...(shown.length ? shown.map((n) => h('li', { class: `staff-row${n.active ? '' : ' staff-row--off'}`, dataset: { id: n.id } },
      h('div', { class: 'staff-who' },
        h('p', { class: 'staff-name' }, n.name),
        h('p', { class: 'staff-meta' }, [NAME_KINDS[n.kind], NAME_REASONS[n.reason], n.series, n.reason_text].filter(Boolean).join(' · '))),
      h('div', { class: 'staff-tags' },
        h('span', { class: `badge ${n.mode === 'bloqueia' ? 'badge--urgent' : 'badge--revisar'}` }, n.mode === 'bloqueia' ? '✗ Bloqueia' : '⚠ Só alerta'),
        statusBadge(n.active)),
      h('div', { class: 'staff-actions' },
        n.reason === 'em_uso' && n.character_id && app.feature('lore')
          ? h('a', { class: 'btn btn--sm', href: `#/lore/personagens/${n.character_id}` }, icon('user'), 'Ver personagem')
          : canEdit && n.reason !== 'em_uso' && h('button', { type: 'button', class: 'btn btn--sm', 'aria-label': `Editar ${n.name}`, onclick: () => openForm(n) }, icon('pencil'), 'Editar'))))
      : [h('li', { class: 'staff-empty' }, 'Nenhum nome encontrado.')]),
    ...[rows.length > shown.length && h('li', { class: 'staff-empty' }, `Mostrando 300 de ${rows.length}. Use a busca para achar os outros.`)].filter(Boolean));
  }

  function openForm(n) {
    const reason = select('nm-reason', { serie: NAME_REASONS.serie, outro: NAME_REASONS.outro }, n?.reason ?? 'serie');
    reason.className = 'input';
    const fields = {
      name: formField('nm-name', 'Nome ou sobrenome *', h('input', { class: 'input', maxlength: LORE_LIMITS.name, value: n?.name ?? '', autocomplete: 'off' })),
      kind: formField('nm-kind', 'Tipo *', Object.assign(select('nm-kind', NAME_KINDS, n?.kind ?? 'sobrenome'), { className: 'input' })),
      reason: formField('nm-reason', 'Motivo *', reason),
      series: formField('nm-series', 'Série', h('input', { class: 'input', maxlength: LORE_LIMITS.series, value: n?.series ?? '', placeholder: 'The Originals' })),
      reason_text: formField('nm-reason-text', 'Explique o motivo', h('input', { class: 'input', maxlength: LORE_LIMITS.reason_text, value: n?.reason_text ?? '' })),
      mode: formField('nm-mode', 'Modo *', Object.assign(select('nm-mode', NAME_MODES, n?.mode ?? 'bloqueia'), { className: 'input' })),
    };
    const syncReason = () => {
      fields.series.el.hidden = reason.value !== 'serie';
      fields.reason_text.el.hidden = reason.value !== 'outro';
    };
    reason.addEventListener('change', syncReason);
    syncReason();
    const active = h('input', { type: 'checkbox', id: 'nm-active', checked: n ? n.active : true });
    const general = h('p', { class: 'field-error form-general-error', role: 'alert', hidden: true });
    const form = h('form', { class: 'panel staff-form', id: 'names-form', novalidate: true },
      h('h2', { class: 'block-title' }, icon(n ? 'pencil' : 'plus'), n ? `Editar "${n.name}"` : 'Adicionar nome'),
      h('div', { class: 'staff-form-grid' }, Object.values(fields).map((x) => x.el)),
      h('label', { class: 'check' }, active, 'Ativo (entra na checagem da allowlist)'),
      general,
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => formSlot.replaceChildren() }, 'Cancelar'),
        h('button', { type: 'submit', class: 'btn btn--primary', id: 'names-save', 'data-requires-online': '' }, icon('device-floppy'), 'Salvar')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(Object.entries(fields).map(([k, x]) => [k, x.input.value]));
      if (v.reason === 'serie') v.reason_text = ''; else v.series = '';
      const res = await app.adapter.saveBlockedName({ ...(n ? { id: n.id } : {}), ...v, active: active.checked });
      showFieldErrors(fields, general, res.error);
      if (res.error) return;
      toast(n ? 'Nome atualizado.' : 'Nome adicionado.');
      formSlot.replaceChildren();
      load();
    });
    formSlot.replaceChildren(form);
    app.applyOnline();
    fields.name.input.focus();
  }

  load();
  return () => { alive = false; };
}
