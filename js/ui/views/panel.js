// Início (#/painel): os mesmos grupos da barra lateral, em cartões, com contadores.
// No celular a barra lateral fica escondida; esta tela é o caminho para tudo.
import { h, icon } from '../dom.js';
import { navGroups } from './layout.js';

export function renderPanel(app) {
  const groups = navGroups(app)
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.self) }))
    .filter((g) => g.items.length > 0);

  app.els.main.replaceChildren(h('div', { class: 'main-inner panel-page' },
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Início'),
      h('p', { class: 'page-sub' }, 'Tudo o que o seu cargo pode abrir, por assunto.')),
    h('div', { id: 'panel-links' }, groups.map((g) => h('section', { class: 'hub-group', 'aria-label': g.title },
      g.id !== 'inicio' && h('h2', { class: 'section-title', id: `hub-${g.id}` }, g.title),
      h('ul', { class: 'hub-grid' },
        g.items.map(({ href, ico, label, count, hint }) => h('li', {},
          h('a', { class: 'hub-card', href },
            h('span', { class: 'hub-icon', 'aria-hidden': 'true' }, icon(ico)),
            h('span', { class: 'hub-text' },
              h('span', { class: 'hub-title' }, label, count > 0 && h('span', { class: 'cat-count cat-count--alert' }, ` ${count}`)),
              hint && h('span', { class: 'hub-hint' }, hint)))))))))));
  return null;
}
