// Criação de elementos sem innerHTML: todo texto entra como nó de texto (SPEC 5.3).

/**
 * Cria um elemento. Strings e números viram nós de texto; nulos/false são ignorados.
 * @param {string} tag
 * @param {Record<string, any>} [props] atributos; `class`, `dataset` e `on<evento>` têm tratamento especial
 * @param {...any} children
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Ícone Tabler decorativo (escondido de leitores de tela). */
export const icon = (name) => h('i', { class: `ti ti-${name}`, 'aria-hidden': 'true' });

/** Mensagem curta no canto inferior; também anunciada por leitores de tela. */
export function toast(message, ms = 2400) {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const el = h('div', { class: 'toast' }, message);
  region.append(el);
  setTimeout(() => el.remove(), ms);
}

/**
 * Texto com os termos da busca destacados em <mark>, montado só com nós de texto
 * (sem innerHTML; seguro para conteúdo digitado pela staff).
 * @param {string} text
 * @param {Array<{ start: number, end: number }>} ranges faixas de highlightRanges()
 */
export function highlighted(text, ranges) {
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const { start, end } of ranges ?? []) {
    if (start > at) frag.append(text.slice(at, start));
    frag.append(h('mark', {}, text.slice(start, end)));
    at = end;
  }
  if (at < text.length) frag.append(text.slice(at));
  return frag;
}

export function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** Oferece um arquivo de texto para download. */
export function downloadText(filename, text, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename, class: 'sr-only' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
