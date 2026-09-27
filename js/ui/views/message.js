import { h, icon } from '../dom.js';

/** Página simples com título e texto (não encontrado, sem permissão, erro). */
export function renderMessage(app, { title, text, back = true }) {
  app.els.main.replaceChildren(h('div', { class: 'main-inner' },
    back && document.body.dataset.state === 'app' && h('a', { class: 'back', href: '#/' }, icon('arrow-left'), 'Voltar para a lista'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, title),
      h('p', { class: 'page-sub' }, text))));
}
