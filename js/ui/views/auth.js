// Telas sem acesso ao conteúdo: carregando, login e "Acesso restrito" (SPEC 2.1).
import { h, icon, toast } from '../dom.js';
import { ROLE_LIST } from '../../core/permissions.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Gota metade azul, metade rosa (a mesma marca do topo). */
function mark() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'auth-mark');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const [cls, d] of [['brand-mark-blue', 'M12 2C12 2 5 10 5 15a7 7 0 0 0 7 7Z'], ['brand-mark-pink', 'M12 2c0 0 7 8 7 13a7 7 0 0 1-7 7Z']]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', cls);
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const card = (...children) => h('section', { class: 'auth-card' },
  h('div', { class: 'auth-brand' }, mark(),
    h('p', { class: 'auth-name' }, 'Bloodlines'),
    h('p', { class: 'auth-sub' }, 'Central da Staff')),
  ...children);

export function renderLoading(app) {
  app.els.main.replaceChildren(h('div', { class: 'auth-wrap' },
    h('p', { class: 'loading', role: 'status' }, 'Carregando…')));
}

export function renderLogin(app) {
  const roleSelect = app.isMock && h('select', { id: 'mock-role', class: 'input' },
    [...ROLE_LIST].reverse().map((r) => h('option', { value: r.code, selected: r.code === 'admin' }, r.label)),
    h('option', { value: 'naostaff' }, 'Não cadastrado na staff'));

  const button = h('button', { type: 'button', class: 'btn btn--primary btn--lg btn--block', id: 'login-btn' },
    icon('brand-discord'), 'Entrar com Discord');
  button.addEventListener('click', async () => {
    button.disabled = true;
    const result = await app.adapter.signIn(app.isMock ? { as: roleSelect.value } : undefined);
    if (result.error) {
      button.disabled = false;
      toast(result.error.code === 'NETWORK' ? 'Sem conexão. Tente de novo.' : 'Não foi possível entrar.', 4000);
    }
  });

  app.els.main.replaceChildren(h('div', { class: 'auth-wrap' }, card(
    h('h1', { class: 'auth-title', tabindex: '-1' }, 'Entrar'),
    h('p', { class: 'auth-text' }, 'Acesso exclusivo da equipe de Suporte e Moderação do Bloodlines RP.'),
    button,
    app.isMock && h('div', { class: 'mock-box' },
      h('label', { class: 'field-label', for: 'mock-role' }, 'Modo de demonstração: entrar como'),
      roleSelect,
      h('p', { class: 'field-hint' }, 'O banco ainda não foi conectado: tudo o que você fizer aqui fica só neste navegador.')),
  )));
}

/** Logado, mas a consulta ao cadastro falhou: mostra o motivo e deixa tentar de novo ou sair. */
export function renderLoginError(app, error, retry) {
  const detail = [error?.code, error?.message].filter(Boolean).join(': ');
  app.els.main.replaceChildren(h('div', { class: 'auth-wrap' }, card(
    h('h1', { class: 'auth-title', tabindex: '-1' }, 'Não foi possível entrar'),
    h('p', { class: 'auth-text' }, error?.code === 'NETWORK'
      ? 'Sem resposta do servidor. Verifique a conexão e tente de novo.'
      : 'O login com o Discord funcionou, mas a Central não conseguiu confirmar seu cadastro na staff. Tente de novo; se continuar, envie o detalhe abaixo para um admin.'),
    detail && h('p', { class: 'field-hint', id: 'login-error-detail' }, `Detalhe: ${detail}`),
    h('button', { type: 'button', class: 'btn btn--primary btn--block', id: 'login-retry', onclick: retry }, icon('refresh'), 'Tentar de novo'),
    h('button', { type: 'button', class: 'btn btn--block', id: 'login-error-signout', onclick: () => app.signOut() }, icon('logout'), 'Sair'),
  )));
}

export function renderRestricted(app) {
  app.els.main.replaceChildren(h('div', { class: 'auth-wrap' }, card(
    h('h1', { class: 'auth-title', tabindex: '-1' }, 'Acesso restrito à staff do Bloodlines RP'),
    h('p', { class: 'auth-text' },
      'Sua conta do Discord não está cadastrada como membro ativo da staff. Se você faz parte da equipe, fale com um admin.'),
    h('button', { type: 'button', class: 'btn btn--block', id: 'restricted-signout', onclick: () => app.signOut() },
      icon('logout'), 'Sair'),
  )));
}
