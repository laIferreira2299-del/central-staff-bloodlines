// Painel da staff (#/painel): todas as áreas de administração que a pessoa pode abrir, com
// contadores. No celular a barra lateral fica escondida; este painel é o caminho para tudo.
import { h, icon } from '../dom.js';
import { adminLinks } from './layout.js';
import { renderMessage } from './message.js';

export function renderPanel(app) {
  const links = adminLinks(app);
  if (app.feature('avisos') && !links.some((l) => l.href === '#/avisos')) {
    links.unshift({ href: '#/avisos', ico: 'bell', label: 'Avisos', count: app.state.counts.announcements, hint: 'Avisos da Direção para a equipe.' });
  }
  if (!links.length) {
    renderMessage(app, { title: 'Nada por aqui', text: 'Seu cargo não tem áreas de administração.' });
    return null;
  }
  app.els.main.replaceChildren(h('div', { class: 'main-inner panel-page' },
    h('a', { class: 'back', href: '#/' }, icon('arrow-left'), 'Voltar para a lista'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Painel da staff'),
      h('p', { class: 'page-sub' }, 'As áreas que o seu cargo pode abrir.')),
    h('ul', { class: 'hub-grid', id: 'panel-links' },
      links.map(({ href, ico, label, count, hint }) => h('li', {},
        h('a', { class: 'hub-card', href },
          h('span', { class: 'hub-icon', 'aria-hidden': 'true' }, icon(ico)),
          h('span', { class: 'hub-text' },
            h('span', { class: 'hub-title' }, label, count > 0 && h('span', { class: 'cat-count cat-count--alert' }, ` ${count}`)),
            hint && h('span', { class: 'hub-hint' }, hint))))))));
  return null;
}
