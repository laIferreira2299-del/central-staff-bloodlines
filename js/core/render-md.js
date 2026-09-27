// ÚNICA porta de entrada de Markdown no projeto (SPEC 5.3).
// marked (Markdown → HTML) → DOMPurify com lista mínima de tags e protocolos.
// É o único arquivo autorizado a usar innerHTML com conteúdo digitado pela staff.
import { Marked } from 'marked';
import DOMPurify from 'dompurify';

export const ALLOWED_TAGS = Object.freeze(['p', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'a', 'br', 'blockquote']);
export const ALLOWED_ATTR = Object.freeze(['href']);
/** Só http, https e mailto (links relativos, javascript:, data: etc. são removidos). */
export const ALLOWED_URI = /^(?:https?:|mailto:)/i;

const marked = new Marked({ gfm: true, breaks: true, async: false });

/**
 * Cria o renderizador para uma janela (no navegador, `window`; nos testes, a janela do jsdom).
 * @param {Window} win
 */
export function createMarkdownRenderer(win) {
  const purify = DOMPurify(win);

  // Todo link sai com target/rel seguros; qualquer outro atributo já foi removido.
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      if (node.hasAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  });

  const config = {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR, 'target', 'rel'],
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    KEEP_CONTENT: true,
  };

  /**
   * Markdown → fragmento de DOM sanitizado.
   * Links cujo destino foi removido (javascript:, data:, relativos) viram texto simples.
   * @param {unknown} markdown
   * @returns {DocumentFragment}
   */
  function toFragment(markdown) {
    if (markdown == null || markdown === '') return win.document.createDocumentFragment();
    const html = marked.parse(String(markdown));
    const fragment = purify.sanitize(html, { ...config, RETURN_DOM_FRAGMENT: true });
    for (const a of fragment.querySelectorAll('a:not([href])')) a.replaceWith(...a.childNodes);
    return fragment;
  }

  /**
   * Markdown → HTML sanitizado (string).
   * @param {unknown} markdown
   * @returns {string}
   */
  function toSafeHtml(markdown) {
    const box = win.document.createElement('div');
    box.append(toFragment(markdown));
    return box.innerHTML;
  }

  /**
   * Renderiza o Markdown dentro do elemento (substitui o conteúdo) inserindo
   * diretamente o fragmento já sanitizado.
   * @param {Element} el
   * @param {unknown} markdown
   */
  function renderInto(el, markdown) {
    el.replaceChildren(toFragment(markdown));
    return el;
  }

  return { toSafeHtml, renderInto };
}

// No navegador, já exporta pronto para uso.
const browser = typeof window !== 'undefined' && window.document ? createMarkdownRenderer(window) : null;
export const toSafeHtml = (md) => browser.toSafeHtml(md);
export const renderMarkdownInto = (el, md) => browser.renderInto(el, md);
