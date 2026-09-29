// Topo (usuário logado) e barra lateral (categorias e atalhos).
import { h, icon } from '../dom.js';
import { roleLabel } from '../../core/permissions.js';
import { CATEGORIES } from '../../core/validate.js';

export function renderUser(app) {
  const { staff, session } = app.state;
  const name = staff?.display_name ?? session?.user?.name ?? '';
  const initials = name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  const avatar = session?.user?.avatar_url
    ? h('img', { class: 'avatar', src: session.user.avatar_url, alt: '', width: 34, height: 34, referrerpolicy: 'no-referrer' })
    : h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials);

  const unread = app.state.counts?.announcements ?? 0;
  const pending = (app.state.counts?.proposals ?? 0) + (app.state.counts?.evaluations ?? 0);

  // replaceChildren escreveria "false" como texto: o filter tira os itens condicionais ausentes.
  app.els.user.replaceChildren(...[
    avatar,
    h('div', { class: 'user-info' },
      h('span', { class: 'user-name' }, name),
      h('span', { class: `role-badge role-badge--${staff?.role}` }, roleLabel(staff?.role))),
    app.feature('avisos') && h('a', {
      class: 'icon-btn icon-btn--count', href: '#/avisos', id: 'nav-announcements',
      'aria-label': unread ? `Avisos (${unread} não lidos)` : 'Avisos', title: 'Avisos',
    }, icon('bell'), unread > 0 && h('span', { class: 'count-dot', 'aria-hidden': 'true' }, String(unread))),
    adminLinks(app).length > 0 && h('a', {
      class: 'icon-btn icon-btn--count', href: '#/painel', id: 'nav-panel', 'aria-label': 'Painel da staff', title: 'Painel da staff',
    }, icon('layout-grid'), pending > 0 && h('span', { class: 'count-dot', 'aria-hidden': 'true' }, String(pending))),
    app.can('equipe.ver') && h('a', { class: 'icon-btn', href: '#/equipe', id: 'nav-staff', 'aria-label': 'Equipe da staff', title: 'Equipe da staff' },
      icon('users')),
    app.can('procedimentos.backup') && h('a', { class: 'icon-btn', href: '#/admin', 'aria-label': 'Exportar e importar', title: 'Exportar e importar' },
      icon('database-export')),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Sair', title: 'Sair', onclick: () => app.signOut() },
      icon('logout')),
  ].filter(Boolean));
}

/**
 * Áreas de administração que a pessoa pode abrir (barra lateral e #/painel), com contadores.
 * Cada módulo só aparece quando o banco já tem o SQL dele (app.feature).
 */
export function adminLinks(app) {
  const c = app.state.counts ?? {};
  const evaluations = app.can('avaliacoes.criar') || app.can('avaliacoes.ler') || app.can('avaliacoes.gerenciar');
  return [
    app.feature('aprovacao') && (app.can('procedimentos.editar') || app.can('procedimentos.aprovar'))
      && { href: '#/propostas', ico: 'checklist', label: app.can('procedimentos.aprovar') ? 'Aprovações' : 'Minhas propostas', count: c.proposals, hint: 'Procedimentos novos e edições enviados por Suporte e Moderação.' },
    app.feature('avaliacoes') && evaluations
      && { href: '#/avaliacoes-equipe', ico: 'star', label: 'Avaliações da equipe', count: c.evaluations, hint: 'Avaliações do Head Staff e caixa da Direção.' },
    app.feature('avisos') && app.can('avisos.enviar')
      && { href: '#/avisos', ico: 'speakerphone', label: 'Avisos', count: 0, hint: 'Criar avisos e ver quem já leu.' },
    app.can('equipe.ver') && { href: '#/equipe', ico: 'users', label: 'Equipe da staff', hint: 'Membros, cargos, equipes e fichas.' },
    app.feature('produtividade') && app.can('produtividade.ver') && { href: '#/controle', ico: 'chart-bar', label: 'Produtividade', hint: 'Quem mais lê allowlist e faz entrevista.' },
    app.feature('allowlist') && app.can('webhooks.gerenciar') && { href: '#/configuracoes/webhooks', ico: 'webhook', label: 'Webhooks do Discord', hint: 'Canais que recebem os resultados de allowlist e entrevistas.' },
    app.can('permissoes.editar') && { href: '#/permissoes', ico: 'shield-lock', label: 'Permissões dos cargos', hint: 'O que cada cargo pode fazer.' },
    app.feature('auditoria') && app.can('auditoria.ver') && { href: '#/auditoria', ico: 'history', label: 'Auditoria', hint: 'Registro das ações sensíveis.' },
    app.can('procedimentos.backup') && { href: '#/admin', ico: 'database-export', label: 'Exportar e importar', hint: 'Backup completo dos procedimentos.' },
  ].filter(Boolean);
}

/** Etapa 6: seção "Allowlist" do menu (só com o módulo no banco). */
export function allowlistLinks(app) {
  if (!app.feature('allowlist')) return [];
  return [
    app.can('allowlist.avaliar') && { href: '#/allowlist', ico: 'file-check', label: 'Nova análise' },
    app.can('allowlist.avaliar') && { href: '#/entrevista', ico: 'microphone', label: 'Nova entrevista' },
    (app.can('allowlist.avaliar') || app.can('allowlist.historico')) && { href: '#/avaliacoes', ico: 'history', label: 'Histórico' },
    app.can('lore.gerenciar') && { href: '#/gabarito', ico: 'list-check', label: 'Gabarito e checklist' },
  ].filter(Boolean);
}

/** Etapas 8 e 9: seção "Lore" do menu (nomes proibidos com o módulo de allowlist; personagens com o 12_lore.sql). */
export function loreLinks(app) {
  const sees = app.can('lore.consultar') || app.can('lore.gerenciar');
  if (!sees || !app.feature('allowlist')) return [];
  return [
    app.feature('lore') && { href: '#/lore/personagens', ico: 'users-group', label: 'Personagens' },
    { href: '#/lore/nomes', ico: 'ban', label: 'Nomes proibidos' },
  ].filter(Boolean);
}

export function renderSidebar(app) {
  const { procedures, filters } = app.state;
  const visible = procedures.filter((p) => p.status !== 'arquivado');
  const counts = new Map();
  for (const p of visible) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  const categories = CATEGORIES.filter((c) => counts.has(c));
  const archivedCount = procedures.length - visible.length;

  const item = (value, label, count) => h('li', {},
    h('button', {
      type: 'button', class: 'cat-item',
      'aria-current': String(filters.category === value),
      onclick: () => app.setFilters({ category: value }),
    },
    h('span', { class: 'cat-label' }, label),
    h('span', { class: 'cat-count' }, h('span', { class: 'sr-only' }, ', '), count, h('span', { class: 'sr-only' }, ' procedimentos'))));

  const links = adminLinks(app);
  const al = allowlistLinks(app);
  const lore = loreLinks(app);
  const navLink = ({ href, ico, label, count }) =>
    h('a', { class: 'cat-item', href, 'data-nav': '', 'aria-current': String(app.router.route.hash === href) },
      h('span', { class: 'cat-label' }, icon(ico), ' ', label),
      count > 0 && h('span', { class: 'cat-count cat-count--alert' }, h('span', { class: 'sr-only' }, ', '), count, h('span', { class: 'sr-only' }, ' novos')));

  app.els.sidebar.replaceChildren(...[
    app.can('procedimentos.editar') && h('a', { class: 'btn btn--primary btn--block sidebar-new', href: '#/novo' }, icon('plus'), 'Novo procedimento'),
    h('nav', { 'aria-labelledby': 'sidebar-title' },
      h('h2', { class: 'sidebar-title', id: 'sidebar-title' }, 'Categorias'),
      h('ul', { class: 'cat-list' },
        item('', 'Todas', visible.length),
        categories.map((c) => item(c, c, counts.get(c))))),
    app.can('procedimentos.arquivar') && archivedCount > 0 && h('div', { class: 'sidebar-tools' },
      h('h2', { class: 'sidebar-title' }, 'Atalhos'),
      h('button', {
        type: 'button', class: 'cat-item',
        'aria-current': String(filters.status === 'arquivado'),
        onclick: () => app.setFilters({ status: filters.status === 'arquivado' ? '' : 'arquivado' }),
      }, h('span', { class: 'cat-label' }, 'Arquivados'), h('span', { class: 'cat-count' }, archivedCount))),
    al.length > 0 && h('nav', { class: 'sidebar-tools', id: 'sidebar-allowlist', 'aria-labelledby': 'sidebar-al-title' },
      h('h2', { class: 'sidebar-title', id: 'sidebar-al-title' }, 'Allowlist'),
      al.map(navLink)),
    lore.length > 0 && h('nav', { class: 'sidebar-tools', id: 'sidebar-lore', 'aria-labelledby': 'sidebar-lore-title' },
      h('h2', { class: 'sidebar-title', id: 'sidebar-lore-title' }, 'Lore'),
      lore.map(navLink)),
    links.length > 0 && h('nav', { class: 'sidebar-tools', 'aria-labelledby': 'sidebar-admin-title' },
      h('h2', { class: 'sidebar-title', id: 'sidebar-admin-title' }, 'Administração'),
      links.map(navLink)),
  ].filter(Boolean));
}
