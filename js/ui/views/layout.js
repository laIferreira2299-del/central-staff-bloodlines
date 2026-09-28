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

  // replaceChildren escreveria "false" como texto: o filter tira os itens condicionais ausentes.
  app.els.user.replaceChildren(...[
    avatar,
    h('div', { class: 'user-info' },
      h('span', { class: 'user-name' }, name),
      h('span', { class: `role-badge role-badge--${staff?.role}` }, roleLabel(staff?.role))),
    app.can('equipe.ver') && h('a', { class: 'icon-btn', href: '#/equipe', id: 'nav-staff', 'aria-label': 'Equipe da staff', title: 'Equipe da staff' },
      icon('users')),
    app.can('procedimentos.backup') && h('a', { class: 'icon-btn', href: '#/admin', 'aria-label': 'Exportar e importar', title: 'Exportar e importar' },
      icon('database-export')),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Sair', title: 'Sair', onclick: () => app.signOut() },
      icon('logout')),
  ].filter(Boolean));
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

  const adminLinks = [
    app.can('equipe.ver') && ['#/equipe', 'users', 'Equipe da staff'],
    app.can('procedimentos.backup') && ['#/admin', 'database-export', 'Exportar e importar'],
  ].filter(Boolean);

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
    adminLinks.length > 0 && h('nav', { class: 'sidebar-tools', 'aria-labelledby': 'sidebar-admin-title' },
      h('h2', { class: 'sidebar-title', id: 'sidebar-admin-title' }, 'Administração'),
      adminLinks.map(([href, ico, label]) =>
        h('a', { class: 'cat-item', href, 'data-nav': '', 'aria-current': String(app.router.route.hash === href) },
          h('span', { class: 'cat-label' }, icon(ico), ' ', label)))),
  ].filter(Boolean));
}
