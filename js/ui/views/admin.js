// Exportação e importação (SPEC 2.9). Só admin (o adapter também bloqueia).
import { downloadText, h, icon, toast } from '../dom.js';
import { confirmDialog } from '../modal.js';
import { exportToMarkdown } from '../../core/export-md.js';
import { renderMessage } from './message.js';

const today = () => new Date().toISOString().slice(0, 10);

export function renderAdmin(app) {
  if (!app.can('admin')) {
    renderMessage(app, { title: 'Acesso restrito', text: 'Exportar e importar é exclusivo de admins.' });
    return null;
  }

  const status = h('div', { class: 'import-status', id: 'import-status', 'aria-live': 'polite' });
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', id: 'import-file', class: 'input' });

  async function exportAs(format) {
    const result = await app.adapter.exportAll();
    if (result.error) { app.reportError(result.error); return; }
    if (format === 'json') {
      downloadText(`bloodlines-procedimentos-${today()}.json`, `${JSON.stringify(result.data, null, 2)}\n`, 'application/json');
    } else {
      downloadText(`bloodlines-procedimentos-${today()}.md`, exportToMarkdown(result.data), 'text/markdown;charset=utf-8');
    }
    toast(`${result.data.procedures.length} procedimentos exportados.`);
  }

  function showValidation(details) {
    const items = details?.items ?? [];
    status.replaceChildren(h('div', { class: 'banner banner--warn', role: 'alert' },
      icon('alert-triangle'),
      h('div', {},
        h('p', {}, details?.errors?.payload ?? `${items.length} procedimento(s) inválido(s). Nada foi importado.`),
        items.length > 0 && h('ul', { class: 'import-errors' }, items.slice(0, 20).map((it) => h('li', {},
          `Item ${it.index + 1}${it.slug ? ` (${it.slug})` : ''}: ${Object.values(it.errors).join(' ')}`))))));
  }

  async function onFile() {
    const file = fileInput.files?.[0];
    status.replaceChildren();
    if (!file) return;
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      status.replaceChildren(h('div', { class: 'banner banner--warn', role: 'alert' }, icon('alert-triangle'),
        h('p', {}, 'O arquivo não é um JSON válido.')));
      return;
    }
    const preview = await app.adapter.importAll(payload, { dryRun: true });
    if (preview.error) {
      if (preview.error.code === 'VALIDATION') showValidation(preview.error.details);
      else app.reportError(preview.error);
      return;
    }
    const { created, updated, unchanged } = preview.data;
    status.replaceChildren(h('div', { class: 'banner banner--info', id: 'import-preview' },
      icon('file-text'),
      h('div', {},
        h('p', { id: 'import-summary' }, `${created} novos, ${updated} atualizados, ${unchanged} sem mudança.`),
        h('p', { class: 'field-hint' }, 'Nada foi gravado ainda. Os atualizados ganham uma nova versão no histórico.')),
      h('div', { class: 'banner-actions' },
        h('button', {
          type: 'button', class: 'btn btn--primary btn--sm', id: 'import-confirm', 'data-requires-online': '',
          disabled: created + updated === 0,
          onclick: () => runImport(payload, preview.data),
        }, 'Confirmar importação'),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => { fileInput.value = ''; status.replaceChildren(); } }, 'Cancelar'))));
    app.applyOnline();
  }

  async function runImport(payload, summary) {
    const ok = await confirmDialog({
      title: 'Importar procedimentos?',
      message: `${summary.created} novos e ${summary.updated} atualizados serão gravados para toda a equipe.`,
      confirmLabel: 'Importar',
    });
    if (!ok) return;
    const result = await app.adapter.importAll(payload);
    if (result.error) {
      if (result.error.code === 'VALIDATION') showValidation(result.error.details);
      else app.reportError(result.error);
      return;
    }
    await app.reload();
    fileInput.value = '';
    status.replaceChildren(h('div', { class: 'banner banner--ok', role: 'status', id: 'import-done' }, icon('circle-check'),
      h('p', {}, `Importação concluída: ${result.data.created} novos, ${result.data.updated} atualizados.`)));
  }

  fileInput.addEventListener('change', onFile);

  app.els.main.replaceChildren(h('div', { class: 'main-inner admin-page' },
    h('a', { class: 'back', href: '#/' }, icon('arrow-left'), 'Voltar para a lista'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Exportar e importar'),
      h('p', { class: 'page-sub' }, 'Backup e carga em massa dos procedimentos. Exclusivo de admins.')),

    h('section', { class: 'panel', 'aria-labelledby': 'export-title' },
      h('h2', { class: 'block-title', id: 'export-title' }, icon('download'), 'Exportar'),
      h('p', { class: 'panel-text' }, 'Todos os procedimentos, inclusive os arquivados.'),
      h('div', { class: 'panel-actions' },
        h('button', { type: 'button', class: 'btn', id: 'export-json', onclick: () => exportAs('json') }, icon('file-text'), 'Backup completo (.json)'),
        h('button', { type: 'button', class: 'btn', id: 'export-md', onclick: () => exportAs('md') }, icon('file-text'), 'Markdown (.md)'))),

    h('section', { class: 'panel', 'aria-labelledby': 'import-title' },
      h('h2', { class: 'block-title', id: 'import-title' }, icon('upload'), 'Importar backup (.json)'),
      h('p', { class: 'panel-text' }, 'Atualiza pelo endereço (slug): procedimentos que já existem são atualizados, os outros são criados. Nada é apagado. Você vê uma prévia antes de confirmar.'),
      h('label', { class: 'field-label', for: 'import-file' }, 'Arquivo de backup'),
      fileInput,
      status),
  ));
  return null;
}
