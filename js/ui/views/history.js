// Histórico de revisões (SPEC 2.8): lista (data, autor), visualização somente leitura e restauração.
import { h, icon, toast } from '../dom.js';
import { confirmDialog } from '../modal.js';
import { formatDate } from '../components.js';
import { procedureBody } from './procedure.js';
import { renderMessage } from './message.js';

export function renderHistory(app, slug) {
  const proc = app.bySlug(slug);
  if (!proc) {
    renderMessage(app, { title: 'Procedimento não encontrado', text: 'Não há histórico para este endereço.' });
    return null;
  }

  let alive = true;
  const list = h('ol', { class: 'rev-list', id: 'rev-list', 'aria-label': 'Versões' },
    h('li', { class: 'loading', role: 'status' }, 'Carregando histórico…'));
  const viewer = h('section', { class: 'rev-view', id: 'rev-view', 'aria-live': 'polite' });

  app.els.main.replaceChildren(h('div', { class: 'history-page' },
    h('a', { class: 'back', href: `#/p/${proc.slug}` }, icon('arrow-left'), 'Voltar ao procedimento'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Histórico'),
      h('p', { class: 'page-sub' }, proc.title)),
    h('div', { class: 'history-layout' }, list, viewer)));

  (async () => {
    const result = await app.adapter.listRevisions(proc.id);
    if (!alive) return;
    if (result.error) {
      list.replaceChildren(h('li', { class: 'empty' }, 'Não foi possível carregar o histórico.'));
      app.reportError(result.error);
      return;
    }

    const entries = [
      { key: 'current', version: proc.version, when: proc.updated_at, who: proc.updated_by_name, snapshot: proc, current: true },
      ...result.data.map((r) => ({ key: r.id, id: r.id, version: r.version, when: r.changed_at, who: r.changed_by_name, snapshot: r.snapshot })),
    ];

    function select(entry) {
      for (const btn of list.querySelectorAll('.rev-item')) {
        btn.setAttribute('aria-current', String(btn.dataset.key === entry.key));
      }
      viewer.replaceChildren(
        h('div', { class: 'rev-view-head' },
          h('p', { class: 'rev-view-title' },
            entry.current ? `Versão ${entry.version} (atual)` : `Versão ${entry.version} · somente leitura`),
          !entry.current && app.can('restoreRevision') && h('button', {
            type: 'button', class: 'btn btn--sm', id: 'restore-revision', 'data-requires-online': '',
            onclick: () => restore(entry),
          }, icon('rotate-clockwise'), 'Restaurar esta versão')),
        procedureBody(entry.snapshot, { headingLevel: 2, idPrefix: `rev-${entry.version}` }));
      app.applyOnline();
    }

    async function restore(entry) {
      const ok = await confirmDialog({
        title: `Restaurar a versão ${entry.version}?`,
        message: 'O conteúdo desta versão vira uma nova edição. A versão atual continua guardada no histórico.',
        confirmLabel: 'Restaurar',
      });
      if (!ok) return;
      const restored = await app.adapter.restoreRevision(entry.id);
      if (restored.error) { app.reportError(restored.error); return; }
      await app.reload();
      toast(`Versão ${entry.version} restaurada.`);
      app.router.go(`#/p/${restored.data.slug}`);
    }

    list.replaceChildren(...entries.map((entry) => h('li', {},
      h('button', {
        type: 'button', class: 'rev-item', 'data-key': entry.key, 'aria-current': 'false',
        onclick: () => select(entry),
      },
      h('span', { class: 'rev-version' }, `Versão ${entry.version}`, entry.current && h('span', { class: 'badge badge--status' }, 'atual')),
      h('span', { class: 'rev-meta' }, formatDate(entry.when, { time: true }), entry.who ? ` · ${entry.who}` : '')))));
    if (entries.length === 1) list.append(h('li', { class: 'field-hint' }, 'Ainda não há versões anteriores.'));
    select(entries[0]);
  })();

  return () => { alive = false; };
}
