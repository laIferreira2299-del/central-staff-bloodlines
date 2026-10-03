// Rascunho automático dos formulários: grava no navegador (localStorage, separado por conta) e oferece
// "Recuperar rascunho" ao reabrir. Mesmo padrão do formulário de procedimento (js/ui/views/form.js).
// Grava a cada 2 s, ao esconder a janela (minimizar, trocar de aba) e ao fechar a página, para não perder o
// que foi digitado nos últimos segundos. Só vai para o rascunho o que o usuário mudou em relação ao início.
import { h, icon, toast } from './dom.js';

const PREFIX = 'bloodlines-kb:draft:';
const SAVE_MS = 2000;
// Campos que nunca entram no rascunho: arquivos e senhas não cabem no navegador, e botões não têm valor.
const NEVER = new Set(['file', 'password', 'hidden', 'submit', 'button', 'reset', 'image']);

const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sem armazenamento */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* sem armazenamento */ } },
};

/**
 * Rascunho por estado: `read()` devolve um objeto simples (JSON) com o que vale guardar.
 * @param {object} app
 * @param {string} scope identifica o formulário (ex.: 'aviso:novo'); a conta entra na chave sozinha
 * @param {{ read: () => object, hasContent?: (data: object) => boolean, initial?: object }} options
 */
export function createDraft(app, scope, { read, hasContent = () => true, initial }) {
  const key = `${PREFIX}${app.state.session.user.id}:${scope}`;
  const current = JSON.stringify(read());
  // `initial`: como o formulário é "sem mexer" quando o estado já vem preenchido (ex.: mensagem que continua na memória).
  const baseline = initial === undefined ? current : JSON.stringify(initial);
  let last = baseline;
  let running = true;

  const saved = store.get(key);
  const stored = saved?.data && JSON.stringify(saved.data) !== baseline && JSON.stringify(saved.data) !== current && hasContent(saved.data) ? saved : null;

  function flush() {
    if (!running) return;
    const json = JSON.stringify(read());
    if (json === last) return;
    last = json;
    const data = JSON.parse(json);
    if (json === baseline || !hasContent(data)) store.remove(key);
    else store.set(key, { data, savedAt: new Date().toISOString() });
  }
  const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
  const timer = setInterval(flush, SAVE_MS);
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);

  return {
    /** Faixa "Há um rascunho não salvo", ou null se não há nada a recuperar. */
    banner(onRecover, { id = 'draft-banner' } = {}) {
      if (!stored) return null;
      const when = new Date(stored.savedAt).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      const el = h('div', { class: 'banner banner--info', id, role: 'status' },
        icon('device-floppy'),
        h('p', {}, `Há um rascunho não salvo de ${when}.`),
        h('div', { class: 'banner-actions' },
          h('button', {
            type: 'button', class: 'btn btn--sm btn--primary', id: `${id}-recover`,
            onclick: () => { el.remove(); onRecover(structuredClone(stored.data)); toast('Rascunho recuperado.'); },
          }, 'Recuperar rascunho'),
          h('button', {
            type: 'button', class: 'btn btn--sm btn--ghost', id: `${id}-discard`,
            onclick: () => { store.remove(key); el.remove(); },
          }, 'Descartar')));
      return el;
    },
    /** O usuário já mudou algo em relação ao início? */
    dirty: () => JSON.stringify(read()) !== baseline,
    /** Já foi salvo (ou descartado de propósito): apaga o rascunho e passa a comparar com o estado atual. */
    clear() {
      store.remove(key);
      last = JSON.stringify(read());
    },
    /** Sai da tela: grava o que faltava e para de vigiar. Não apaga o rascunho. */
    stop() {
      flush();
      running = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
    },
  };
}

/* ---------- por campos da tela ---------- */

const controlsOf = (root, skip) => [...root.querySelectorAll('input, select, textarea')]
  .filter((el) => el.id && !skip.includes(el.id) && !NEVER.has(el.type));
const isToggle = (el) => el.type === 'checkbox' || el.type === 'radio';

/** Valores dos campos com `id` (texto, lista, caixa de marcar), por id. */
export const readControls = (root, skip = []) => Object.fromEntries(
  controlsOf(root, skip).map((el) => [el.id, isToggle(el) ? el.checked : el.value]));

/** Devolve os valores aos campos e avisa a tela (eventos input e change) para contadores e regras reagirem. */
export function applyControls(root, data, skip = []) {
  for (const el of controlsOf(root, skip)) {
    if (!(el.id in data)) continue;
    const value = data[el.id];
    if (isToggle(el)) {
      if (el.checked === value) continue;
      el.checked = Boolean(value);
    } else {
      if (el.value === value) continue;
      if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === value)) continue;
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/**
 * Rascunho de um formulário montado com `h()`: guarda os campos com `id` de dentro de `root`.
 * A faixa de recuperação entra no começo de `root`. Devolve o mesmo objeto de createDraft.
 * @param {{ skip?: string[], hasContent?: (values: object) => boolean, bannerId?: string }} [options]
 */
export function attachFormDraft(app, scope, root, { skip = [], hasContent, bannerId } = {}) {
  const draft = createDraft(app, scope, { read: () => readControls(root, skip), hasContent });
  const banner = draft.banner((data) => applyControls(root, data, skip), { id: bannerId });
  if (banner) root.prepend(banner);
  return draft;
}
