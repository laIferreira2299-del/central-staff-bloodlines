// Janelas de confirmação acessíveis com <dialog> (foco preso, Esc fecha).
// Nunca usar alert/confirm/prompt nativos.
import { h } from './dom.js';

/**
 * Abre uma janela e resolve com o `value` da ação escolhida (ou null se fechada com Esc).
 * @param {{ title: string, body?: Node|string, actions: Array<{ label: string, value: any, variant?: 'primary'|'danger'|'ghost', autofocus?: boolean }> }} opts
 */
export function openDialog({ title, body, actions }) {
  return new Promise((resolve) => {
    const titleId = `dlg-title-${Math.random().toString(36).slice(2)}`;
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': titleId },
      h('h2', { class: 'dialog-title', id: titleId }, title),
      body != null && h('div', { class: 'dialog-body' }, body),
      h('div', { class: 'dialog-actions' },
        actions.map((a) => h('button', {
          type: 'button',
          class: `btn ${a.variant === 'primary' ? 'btn--primary' : a.variant === 'danger' ? 'btn--danger-solid' : a.variant === 'ghost' ? 'btn--ghost' : ''}`,
          'data-autofocus': a.autofocus ? '' : null,
          onclick: () => finish(a.value),
        }, a.label))));

    let done = false;
    function finish(value) {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    }
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });

    document.body.append(dialog);
    dialog.showModal();
    (dialog.querySelector('[data-autofocus]') ?? dialog.querySelector('button'))?.focus();
  });
}

/** Confirmação simples. Resolve true/false. O foco começa no botão seguro (cancelar). */
export async function confirmDialog({ title, message, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false }) {
  const value = await openDialog({
    title,
    body: message,
    actions: [
      { label: cancelLabel, value: false, variant: 'ghost', autofocus: true },
      { label: confirmLabel, value: true, variant: danger ? 'danger' : 'primary' },
    ],
  });
  return value === true;
}
