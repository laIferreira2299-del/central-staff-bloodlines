// Áreas da Staff (plano 07, Fase 2): #/areas (Minhas Áreas) e #/areas/<slug> (Procedimentos, Equipe, Controle, Histórico).
// Só membros da área e quem tem areas.gerenciar leem o conteúdo (a RLS do 19_areas.sql é a barreira; aqui só some o que não vale).
import { h, icon, toast } from '../dom.js';
import { confirmDialog, openDialog } from '../modal.js';
import { formatDate } from '../components.js';
import {
  AREA_ERRORS, AREA_LIMITS, AREA_PROCEDURE_STATUS_LABELS, AREA_ROLE_LABELS, areaControlStats,
  areaProcedureAccess, describeAreaEvent, filterAreaProcedures, levelLabel, sortAreaProcedures,
} from '../../core/areas.js';
import { ROLE_LABELS, ROLE_LIST } from '../../core/permissions.js';
import { renderRichMarkdownInto } from '../../core/render-md.js';
import { attachFormDraft } from '../draft.js';
import { formField, showFieldErrors } from './gabarito.js';
import { renderMessage } from './message.js';

const HISTORY_PAGE = 20;
const TABS = Object.freeze([['procedimentos', 'Procedimentos'], ['equipe', 'Equipe'], ['controle', 'Controle'], ['historico', 'Histórico']]);

export const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(String(c)) ? c : '#8b0000');
export const safeIcon = (i) => (/^[a-z0-9-]{1,40}$/.test(String(i ?? '')) ? i : 'users-group');
export const errorText = (error) => error?.details?.errors?._ ?? Object.values(error?.details?.errors ?? {})[0] ?? error?.message ?? 'Algo deu errado.';

/** Elemento com a cor da área em --area-cor (valida o hex antes). */
export function colored(el, color) {
  el.style.setProperty('--area-cor', safeColor(color));
  return el;
}

export function unavailable(app) {
  renderMessage(app, { title: 'Áreas indisponíveis', text: 'O módulo de Áreas ainda não foi instalado no banco de dados.' });
  return null;
}

/* ------------------------------------------------------------------ Minhas Áreas */

export function renderAreas(app) {
  if (!app.feature('areas')) return unavailable(app);
  let alive = true;
  const warning = h('div', { class: 'areas-warning', id: 'areas-warning', role: 'status', hidden: true },
    icon('alert-triangle'), ' Escolha pelo menos 1 sub-área para ajudar a equipe.');
  const grid = h('div', { class: 'areas-grid', id: 'areas-grid' }, h('p', { class: 'panel-text' }, 'Carregando…'));

  app.els.main.replaceChildren(h('div', { class: 'main-inner areas-page' },
    h('header', { class: 'page-head areas-head' },
      h('div', {},
        h('h1', { class: 'page-title', tabindex: '-1' }, 'Minhas Áreas'),
        h('p', { class: 'page-sub' }, 'As equipes e sub-áreas da Staff de que você faz parte.')),
      h('button', { type: 'button', class: 'btn btn--primary', id: 'areas-choose', onclick: chooseAreas }, icon('list-check'), 'Escolher áreas')),
    warning, grid));

  async function load() {
    const res = await app.adapter.listMyAreas();
    if (!alive) return;
    if (res.error) { app.reportError(res.error, 'Não foi possível carregar as áreas.'); return; }
    warning.hidden = res.data.length > 0;
    grid.replaceChildren(...(res.data.length
      ? res.data.map(areaCard)
      : [h('p', { class: 'panel-text areas-empty' }, 'Você ainda não está em nenhuma área.')]));
  }

  function areaCard(a) {
    return colored(h('a', { class: 'areas-card', href: `#/areas/${a.slug}`, 'data-area': a.slug },
      h('span', { class: 'areas-card-icon' }, icon(safeIcon(a.icone))),
      h('span', { class: 'areas-card-body' },
        h('span', { class: 'areas-card-name' }, a.nome),
        a.descricao && h('span', { class: 'areas-card-desc' }, a.descricao),
        h('span', { class: 'areas-card-meta' },
          h('span', {}, `${a.membros} ${a.membros === 1 ? 'membro' : 'membros'}`),
          h('span', {}, `${a.procedimentos} ${a.procedimentos === 1 ? 'procedimento' : 'procedimentos'}`),
          a.papel === 'lider' && h('span', { class: 'areas-chip' }, 'Líder'),
          a.status === 'arquivada' && h('span', { class: 'areas-chip areas-chip--muted' }, 'Arquivada')))), a.cor);
  }

  async function chooseAreas() {
    const res = await app.adapter.listEligibleAreas();
    if (res.error) { app.reportError(res.error, 'Não foi possível listar as áreas.'); return; }
    const list = h('ul', { class: 'areas-choose', id: 'areas-choose-list' });
    const row = (a) => {
      const btn = h('button', { type: 'button', class: 'btn' }, a.ja_membro ? 'Sair' : 'Entrar');
      const paint = () => {
        btn.textContent = a.ja_membro ? 'Sair' : 'Entrar';
        btn.className = a.ja_membro ? 'btn' : 'btn btn--primary';
      };
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const r = a.ja_membro ? await app.adapter.leaveArea(a.id) : await app.adapter.joinArea(a.id);
        btn.disabled = false;
        if (r.error) { toast(errorText(r.error), 3500); return; }
        a.ja_membro = !a.ja_membro;
        paint();
        toast(a.ja_membro ? `Você entrou em ${a.nome}.` : `Você saiu de ${a.nome}.`);
      });
      paint();
      return colored(h('li', { class: 'areas-choose-row', 'data-area-name': a.nome },
        h('span', { class: 'areas-card-icon' }, icon(safeIcon(a.icone))),
        h('span', { class: 'areas-choose-info' },
          h('strong', {}, a.nome),
          a.descricao && h('span', { class: 'areas-card-desc' }, a.descricao),
          h('span', { class: 'areas-card-desc' }, levelLabel(a.nivel_minimo, ROLE_LIST))),
        btn), a.cor);
    };
    list.append(...(res.data.length ? res.data.map(row) : [h('li', { class: 'panel-text' }, 'Nenhuma área disponível para o seu cargo.')]));
    await openDialog({ title: 'Escolher áreas', body: list, actions: [{ label: 'Fechar', value: true, variant: 'ghost', autofocus: true }] });
    if (!alive) return;
    await load();
    app.refreshCounts();
  }

  load();
  return () => { alive = false; };
}

/* ------------------------------------------------------------------ Página da área */

export function renderArea(app, slug) {
  if (!app.feature('areas')) return unavailable(app);
  let alive = true;
  let draft = null; // rascunho automático do editor aberto
  const ctx = { area: null, procedures: [], team: [], tags: [], tab: 'procedimentos', editing: null, history: null, historyPage: 0 };
  const view = { query: '', tag: '', status: 'ativos' };
  const panel = h('div', { class: 'areas-panel', id: 'areas-panel' });
  const tabs = h('div', { class: 'areas-tabs', role: 'tablist', 'aria-label': 'Seções da área' });
  const head = h('header', { class: 'page-head areas-area-head' });
  const root = h('div', { class: 'main-inner areas-page' }, h('p', { class: 'panel-text' }, 'Carregando…'));
  app.els.main.replaceChildren(root);

  const access = (authorId = null) => areaProcedureAccess({
    papel: ctx.area.papel, manager: app.can('areas.gerenciar'), areaActive: ctx.area.status === 'ativa', authorId, myId: app.state.staff?.discord_id,
  });
  const tagById = (id) => ctx.tags.find((t) => t.id === id);

  async function load() {
    const found = await app.adapter.getArea(slug);
    if (!alive) return;
    if (found.error) {
      renderMessage(app, { title: 'Área não encontrada ou sem acesso', text: AREA_ERRORS.notFound });
      return;
    }
    ctx.area = found.data;
    const [procs, team, tags] = await Promise.all([
      app.adapter.listAreaProcedures(ctx.area.id), app.adapter.listAreaTeam(ctx.area.id), app.adapter.listAreaTags(ctx.area.id),
    ]);
    if (!alive) return;
    for (const r of [procs, team, tags]) if (r.error) { app.reportError(r.error, 'Não foi possível carregar a área.'); return; }
    Object.assign(ctx, { procedures: procs.data, team: team.data, tags: tags.data });
    drawShell();
  }

  function visibleTabs() {
    const a = access();
    return TABS.filter(([key]) => (key === 'controle' ? a.seeControl : key === 'historico' ? a.seeHistory : true));
  }

  function drawShell() {
    const a = ctx.area;
    head.replaceChildren(
      h('a', { class: 'back', href: '#/areas' }, icon('arrow-left'), 'Minhas Áreas'),
      colored(h('div', { class: 'areas-title-row' },
        h('span', { class: 'areas-card-icon' }, icon(safeIcon(a.icone))),
        h('div', {},
          h('h1', { class: 'page-title', tabindex: '-1' }, a.nome, ' ',
            a.status === 'arquivada' && h('span', { class: 'areas-chip areas-chip--muted', id: 'areas-archived' }, 'Arquivada')),
          a.descricao && h('p', { class: 'page-sub' }, a.descricao))), a.cor));
    drawTabs();
    root.replaceChildren(head, tabs, panel);
    drawPanel();
  }

  function drawTabs() {
    tabs.replaceChildren(...visibleTabs().map(([key, label]) => h('button', {
      type: 'button', class: 'areas-tab', role: 'tab', id: `areas-tab-${key}`, 'aria-selected': String(ctx.tab === key),
      onclick: () => { ctx.tab = key; ctx.editing = null; drawTabs(); drawPanel(); },
    }, label)));
  }

  function drawPanel() {
    draft?.stop();
    draft = null;
    if (ctx.tab === 'procedimentos') return ctx.editing ? drawEditor() : drawProcedures();
    if (ctx.tab === 'equipe') return drawTeam();
    if (ctx.tab === 'controle') return drawControl();
    return drawHistory();
  }

  /* ----- Procedimentos ----- */
  function filtered() {
    const pool = view.status === 'ativos' ? ctx.procedures.filter((p) => p.status !== 'arquivado')
      : view.status === 'todos' ? ctx.procedures : ctx.procedures.filter((p) => p.status === view.status);
    return sortAreaProcedures(filterAreaProcedures(pool, { query: view.query, tag: view.tag }));
  }

  function drawProcedures() {
    const a = access();
    const list = h('div', { class: 'areas-list', id: 'areas-list' });
    const draw = () => {
      const items = filtered();
      list.replaceChildren(...(items.length ? items.map(procedureCard)
        : [h('p', { class: 'panel-text areas-empty' }, ctx.procedures.length ? 'Nenhum procedimento com esses filtros.' : 'Esta área ainda não tem procedimentos.')]));
    };
    const search = h('input', {
      type: 'search', class: 'input', id: 'areas-search', placeholder: 'Buscar procedimento', 'aria-label': 'Buscar procedimento', value: view.query,
      oninput: (e) => { view.query = e.target.value; draw(); },
    });
    const tagSelect = h('select', { class: 'input', id: 'areas-filter-tag', 'aria-label': 'Filtrar por tag', onchange: (e) => { view.tag = e.target.value; draw(); } },
      h('option', { value: '' }, 'Todas as tags'),
      ctx.tags.map((t) => h('option', { value: t.id, selected: view.tag === t.id }, t.nome)));
    const statusSelect = h('select', { class: 'input', id: 'areas-filter-status', 'aria-label': 'Filtrar por situação', onchange: (e) => { view.status = e.target.value; draw(); } },
      [['ativos', 'Publicados e rascunhos'], ['publicado', 'Publicados'], ['rascunho', 'Rascunhos'], ['arquivado', 'Arquivados'], ['todos', 'Todos']]
        .map(([v, t]) => h('option', { value: v, selected: view.status === v }, t)));
    panel.replaceChildren(
      h('div', { class: 'areas-toolbar' }, search, tagSelect, statusSelect,
        a.create && h('button', { type: 'button', class: 'btn btn--primary', id: 'areas-new', onclick: () => { ctx.editing = {}; drawPanel(); } }, icon('plus'), 'Novo procedimento')),
      ctx.area.status !== 'ativa' && h('p', { class: 'panel-text areas-readonly' }, AREA_ERRORS.archivedArea),
      list);
    draw();
  }

  function procedureCard(p) {
    const a = access(p.criado_por);
    const body = h('div', { class: 'md areas-proc-body' });
    const details = h('details', { class: 'areas-proc' },
      h('summary', {},
        h('span', { class: 'areas-proc-title' }, p.titulo),
        h('span', { class: `areas-chip${p.status === 'publicado' ? '' : ' areas-chip--muted'}`, 'data-status': p.status }, AREA_PROCEDURE_STATUS_LABELS[p.status]),
        (p.tags ?? []).map(tagById).filter(Boolean).map((t) => colored(h('span', { class: 'areas-tag' }, t.nome), t.cor))),
      body,
      h('p', { class: 'areas-proc-meta' },
        `Criado por ${p.criado_por_name ?? 'alguém da equipe'} em ${formatDate(p.criado_em)}`,
        p.atualizado_em !== p.criado_em ? ` · atualizado por ${p.atualizado_por_name ?? 'alguém da equipe'} em ${formatDate(p.atualizado_em, { time: true })}` : ''),
      (a.edit || a.archive || a.remove) && h('div', { class: 'areas-proc-actions' },
        a.edit && h('button', { type: 'button', class: 'btn', 'data-act': 'edit', onclick: () => { ctx.editing = p; drawPanel(); } }, icon('pencil'), 'Editar'),
        a.archive && h('button', { type: 'button', class: 'btn', 'data-act': 'archive', onclick: () => setStatus(p, p.status === 'arquivado' ? 'publicado' : 'arquivado') },
          icon(p.status === 'arquivado' ? 'archive-off' : 'archive'), p.status === 'arquivado' ? 'Restaurar' : 'Arquivar'),
        a.remove && h('button', { type: 'button', class: 'btn btn--danger', 'data-act': 'delete', onclick: () => remove(p) }, icon('trash'), 'Apagar')));
    details.addEventListener('toggle', () => { if (details.open && !body.hasChildNodes()) renderRichMarkdownInto(body, p.conteudo || '_Sem conteúdo._'); });
    return details;
  }

  async function setStatus(p, status) {
    const res = await app.adapter.saveAreaProcedure(ctx.area.id, { id: p.id, status });
    if (res.error) { toast(errorText(res.error), 3500); return; }
    Object.assign(p, res.data);
    ctx.history = null;
    toast(status === 'arquivado' ? 'Procedimento arquivado.' : 'Procedimento restaurado.');
    drawPanel();
  }

  async function remove(p) {
    const yes = await confirmDialog({
      title: 'Apagar procedimento', message: `Apagar "${p.titulo}"? Isso não pode ser desfeito (o histórico guarda o registro).`,
      confirmLabel: 'Apagar', danger: true,
    });
    if (!yes || !alive) return;
    const res = await app.adapter.deleteAreaProcedure(p.id);
    if (res.error) { toast(errorText(res.error), 3500); return; }
    ctx.procedures = ctx.procedures.filter((x) => x.id !== p.id);
    ctx.history = null;
    toast('Procedimento apagado.');
    drawPanel();
  }

  /* ----- Editor ----- */
  function drawEditor() {
    const p = ctx.editing;
    const a = access(p.criado_por ?? null);
    const privileged = a.archive;
    const fields = {
      titulo: formField('areas-f-titulo', 'Título *', h('input', { class: 'input', type: 'text', maxlength: AREA_LIMITS.title, value: p.titulo ?? '' })),
      status: formField('areas-f-status', 'Situação', h('select', { class: 'input' },
        Object.entries(AREA_PROCEDURE_STATUS_LABELS).filter(([v]) => privileged || v !== 'arquivado')
          .map(([v, t]) => h('option', { value: v, selected: (p.status ?? 'publicado') === v }, t)))),
      conteudo: formField('areas-f-conteudo', 'Conteúdo (Markdown)', h('textarea', { class: 'input textarea', rows: 14, maxlength: AREA_LIMITS.content }, p.conteudo ?? '')),
    };
    const picked = new Set(p.tags ?? []);
    const tagBox = ctx.tags.length > 0 && h('fieldset', { class: 'areas-tagbox' }, h('legend', { class: 'field-label' }, 'Tags'),
      ctx.tags.map((t) => h('label', { class: 'areas-tagpick' },
        h('input', { type: 'checkbox', id: `areas-f-tag-${t.id}`, checked: picked.has(t.id), onchange: (e) => { if (e.target.checked) picked.add(t.id); else picked.delete(t.id); } }), ' ', t.nome)));
    const preview = h('div', { class: 'md areas-preview', id: 'areas-preview', hidden: true });
    const general = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const previewBtn = h('button', { type: 'button', class: 'btn btn--ghost', id: 'areas-preview-btn' }, icon('eye'), 'Pré-visualizar');
    previewBtn.addEventListener('click', () => {
      const show = preview.hidden;
      if (show) renderRichMarkdownInto(preview, fields.conteudo.input.value || '_Sem conteúdo._');
      preview.hidden = !show;
      fields.conteudo.input.hidden = show;
      previewBtn.replaceChildren(icon(show ? 'pencil' : 'eye'), show ? 'Voltar a editar' : 'Pré-visualizar');
    });
    const save = h('button', { type: 'submit', class: 'btn btn--primary', id: 'areas-save' }, 'Salvar');
    const form = h('form', { class: 'areas-editor', novalidate: true },
      h('h2', { class: 'areas-editor-title' }, p.id ? 'Editar procedimento' : 'Novo procedimento'),
      fields.titulo.el, fields.status.el, tagBox,
      fields.conteudo.el, preview, general,
      h('div', { class: 'areas-editor-actions' }, previewBtn,
        h('button', { type: 'button', class: 'btn btn--ghost', id: 'areas-cancel', onclick: () => { draft?.clear(); ctx.editing = null; drawPanel(); } }, 'Cancelar'), save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      const res = await app.adapter.saveAreaProcedure(ctx.area.id, {
        id: p.id, titulo: fields.titulo.input.value, status: fields.status.input.value, conteudo: fields.conteudo.input.value, tags: [...picked],
      });
      save.disabled = false;
      if (!alive) return;
      if (res.error) { showFieldErrors(fields, general, res.error); return; }
      draft?.clear();
      const at = ctx.procedures.findIndex((x) => x.id === res.data.id);
      if (at >= 0) ctx.procedures[at] = res.data; else ctx.procedures.push(res.data);
      ctx.editing = null;
      ctx.history = null;
      toast(p.id ? 'Procedimento salvo.' : 'Procedimento criado.');
      drawPanel();
    });
    panel.replaceChildren(form);
    draft = attachFormDraft(app, `area-proc:${ctx.area.id}:${p.id ?? 'novo'}`, form, { bannerId: 'areas-draft-banner' });
    fields.titulo.input.focus();
  }

  /* ----- Equipe ----- */
  function drawTeam() {
    panel.replaceChildren(ctx.team.length
      ? h('ul', { class: 'areas-team', id: 'areas-team' }, ctx.team.map((m) => h('li', { class: 'areas-team-row', 'data-discord': m.discord_id },
        h('strong', {}, m.display_name),
        h('span', { class: 'areas-card-desc' }, ROLE_LABELS[m.role] ?? m.role),
        h('span', { class: `areas-chip${m.papel === 'lider' ? '' : ' areas-chip--muted'}` }, AREA_ROLE_LABELS[m.papel]),
        h('span', { class: 'areas-card-desc' }, `desde ${formatDate(m.entrou_em)}`))))
      : h('p', { class: 'panel-text areas-empty' }, 'Esta área ainda não tem equipe.'));
  }

  /* ----- Controle ----- */
  function drawControl() {
    const s = areaControlStats(ctx.procedures, ctx.team);
    const stat = (label, value, id) => h('div', { class: 'areas-stat', id }, h('span', { class: 'areas-stat-value' }, String(value)), h('span', { class: 'areas-stat-label' }, label));
    const mini = (p) => h('li', {}, h('strong', {}, p.titulo), ' ', h('span', { class: 'areas-card-desc' }, `${AREA_PROCEDURE_STATUS_LABELS[p.status]} · ${formatDate(p.atualizado_em, { time: true })}`));
    panel.replaceChildren(
      h('div', { class: 'areas-stats' },
        stat('Publicados', s.publicado, 'areas-stat-publicado'), stat('Rascunhos', s.rascunho, 'areas-stat-rascunho'),
        stat('Arquivados', s.arquivado, 'areas-stat-arquivado'), stat('Membros', s.members, 'areas-stat-membros'), stat('Líderes', s.leaders, 'areas-stat-lideres')),
      h('section', { class: 'areas-block' }, h('h2', { class: 'areas-block-title' }, 'Atualizados recentemente'),
        s.recent.length ? h('ul', { class: 'areas-mini' }, s.recent.map(mini)) : h('p', { class: 'panel-text' }, 'Nada ainda.')),
      h('section', { class: 'areas-block' }, h('h2', { class: 'areas-block-title' }, 'Em rascunho'),
        s.drafts.length ? h('ul', { class: 'areas-mini', id: 'areas-drafts' }, s.drafts.map(mini)) : h('p', { class: 'panel-text' }, 'Nenhum rascunho.')));
  }

  /* ----- Histórico ----- */
  async function drawHistory() {
    panel.replaceChildren(h('p', { class: 'panel-text' }, 'Carregando…'));
    const page = ctx.historyPage;
    const res = await app.adapter.listAreaHistory(ctx.area.id, { limit: HISTORY_PAGE, offset: page * HISTORY_PAGE });
    if (!alive || ctx.tab !== 'historico') return;
    if (res.error) { app.reportError(res.error, 'Não foi possível carregar o histórico.'); return; }
    const { items, total } = res.data;
    const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE));
    const diff = (e) => {
      const text = JSON.stringify(e.detalhes ?? {}, null, 2);
      return h('details', { class: 'areas-diff' }, h('summary', {}, 'Ver detalhes'), h('pre', {}, text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text));
    };
    panel.replaceChildren(
      items.length
        ? h('ul', { class: 'areas-history', id: 'areas-history' }, items.map((e) => h('li', { class: 'areas-history-row' },
          h('p', {}, h('strong', {}, e.ator_nome ?? 'Sistema'), ` ${describeAreaEvent(e)}`),
          h('p', { class: 'areas-card-desc' }, formatDate(e.criado_em, { time: true })), diff(e))))
        : h('p', { class: 'panel-text areas-empty' }, 'Nenhum registro ainda.'),
      h('div', { class: 'areas-pager' },
        h('button', { type: 'button', class: 'btn', id: 'areas-prev', disabled: page === 0, onclick: () => { ctx.historyPage -= 1; drawHistory(); } }, 'Mais recentes'),
        h('span', { class: 'areas-card-desc' }, `Página ${page + 1} de ${pages}`),
        h('button', { type: 'button', class: 'btn', id: 'areas-next', disabled: page + 1 >= pages, onclick: () => { ctx.historyPage += 1; drawHistory(); } }, 'Mais antigos')));
  }

  load();
  return () => { alive = false; draft?.stop(); };
}
