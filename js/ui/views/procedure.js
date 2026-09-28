// Página do procedimento (SPEC 4.3) e o corpo reutilizado na pré-visualização e no histórico.
import { h, icon, toast } from '../dom.js';
import { copyText } from '../clipboard.js';
import { confirmDialog } from '../modal.js';
import {
  archivedBadge, audienceBadge, copyButton, formatDate, needsReview, reviewBadge, starButton,
} from '../components.js';
import { renderMarkdownInto } from '../../core/render-md.js';
import { renderMessage } from './message.js';

/** Bloco de Markdown (passa SEMPRE por render-md.js). */
const markdown = (cls, text) => renderMarkdownInto(h('div', { class: `md ${cls}` }), text);

/**
 * Corpo do procedimento: selos, título, metadados, quando usar, passos, comandos,
 * mensagem pronta e observações.
 * @param {object} proc
 * @param {{ headingLevel?: 1|2, titleActions?: Node|null, idPrefix?: string }} [opts]
 */
export function procedureBody(proc, { headingLevel = 1, titleActions = null, idPrefix = 'p' } = {}) {
  const id = (name) => `${idPrefix}-${name}`;
  const reviewed = formatDate(proc.last_reviewed_at);
  const TitleTag = headingLevel === 1 ? 'h1' : 'h2';
  const steps = (proc.steps ?? []).filter((s) => s && (s.title || s.body));
  const commands = (proc.commands ?? []).filter((c) => c && c.command);

  return h('div', { class: 'proc-body' },
    h('div', { class: 'proc-badges' },
      audienceBadge(proc.audience),
      proc.status === 'arquivado' ? archivedBadge() : needsReview(proc) && reviewBadge(),
      h('span', { class: 'proc-cat' }, icon('folder'), proc.category || 'Sem categoria')),

    h('div', { class: 'proc-title-row' },
      h(TitleTag, { class: 'proc-title', tabindex: headingLevel === 1 ? '-1' : null }, proc.title || 'Sem título'),
      titleActions && h('div', { class: 'proc-title-actions' }, titleActions)),

    h('dl', { class: 'proc-meta' },
      h('div', {},
        h('dt', {}, icon('user-check'), 'Quem atende'),
        h('dd', {}, proc.who_handles || '[PREENCHER]')),
      h('div', {},
        h('dt', {}, icon('clock-check'), 'Última revisão'),
        h('dd', {}, reviewed ? [reviewed, proc.last_reviewed_by_name ? ` · ${proc.last_reviewed_by_name}` : ''] : 'Nunca revisado'))),

    h('section', { class: 'block', 'aria-labelledby': id('when') },
      h('h2', { class: 'block-title', id: id('when') }, icon('info-circle'), 'Quando usar'),
      h('p', { class: 'when' }, proc.summary || '[PREENCHER]')),

    h('section', { class: 'block', 'aria-labelledby': id('steps') },
      h('h2', { class: 'block-title', id: id('steps') }, icon('list-numbers'), 'Passo a passo'),
      steps.length
        ? h('ol', { class: 'steps' }, steps.map((s, i) => h('li', { class: 'step' },
          h('span', { class: 'step-num', 'aria-hidden': 'true' }, i + 1),
          h('div', { class: 'step-content' },
            h('h3', { class: 'step-title' }, h('span', { class: 'sr-only' }, `Passo ${i + 1}: `), s.title || 'Passo sem título'),
            s.body && markdown('step-body', s.body)))))
        : h('p', { class: 'empty' }, 'Nenhum passo cadastrado.')),

    commands.length > 0 && h('section', { class: 'block', 'aria-labelledby': id('cmds') },
      h('h2', { class: 'block-title', id: id('cmds') }, icon('terminal-2'), 'Comandos'),
      h('ul', { class: 'cmds' }, commands.map((c) => h('li', { class: 'cmd' },
        h('div', {},
          h('code', { class: 'cmd-code' }, c.command),
          c.description && h('p', { class: 'cmd-desc' }, c.description)),
        copyButton(() => c.command, { ariaLabel: `Copiar comando ${c.command}` }))))),

    proc.ready_message && h('section', { class: 'block', 'aria-labelledby': id('ready') },
      h('h2', { class: 'block-title', id: id('ready') }, icon('message-2'), 'Mensagem pronta'),
      h('div', { class: 'ready' },
        h('div', { class: 'ready-head' },
          h('span', { class: 'ready-label' }, 'Para colar no Discord'),
          copyButton(() => proc.ready_message, { ariaLabel: 'Copiar mensagem pronta' })),
        h('p', { class: 'ready-text' }, proc.ready_message))),

    proc.notes && h('aside', { class: 'callout', 'aria-labelledby': id('notes') },
      icon('alert-triangle'),
      h('div', {},
        h('h2', { class: 'callout-title', id: id('notes') }, 'Observações'),
        markdown('callout-body', proc.notes))),
  );
}

export function renderProcedurePage(app, slug) {
  const proc = app.bySlug(slug);
  if (!proc) {
    renderMessage(app, { title: 'Procedimento não encontrado', text: 'O link pode estar errado ou o procedimento foi renomeado.' });
    return null;
  }
  const archived = proc.status === 'arquivado';

  const run = async (action, success) => {
    const result = await action();
    if (result.error) { app.reportError(result.error); return; }
    await app.reload();
    toast(success);
    return result.data;
  };

  const archive = async () => {
    const ok = await confirmDialog({
      title: 'Arquivar procedimento?',
      message: `"${proc.title}" sai da lista da equipe. Moderadores e admins podem restaurá-lo depois.`,
      confirmLabel: 'Arquivar', danger: true,
    });
    if (!ok) return;
    if (await run(() => app.adapter.setStatus(proc.id, 'arquivado'), 'Procedimento arquivado.')) app.router.go('#/');
  };

  const unarchive = async () => {
    if (await run(() => app.adapter.setStatus(proc.id, 'ativo'), 'Procedimento restaurado.')) app.render();
  };

  const markReviewed = async () => {
    if (await run(() => app.adapter.markReviewed(proc.id), 'Marcado como revisado hoje.')) app.render();
  };

  const titleActions = [
    starButton(proc, app.isFav(proc), app.toggleFavorite),
    h('button', {
      type: 'button', class: 'icon-btn', 'aria-label': 'Copiar link do procedimento', title: 'Copiar link',
      onclick: async () => {
        const url = `${location.origin}${location.pathname}#/p/${proc.slug}`;
        toast((await copyText(url)) ? 'Link copiado!' : 'Não foi possível copiar o link.');
      },
    }, icon('link')),
  ];

  app.els.main.replaceChildren(h('article', { class: 'proc' },
    h('a', { class: 'back', href: '#/' }, icon('arrow-left'), 'Voltar para a lista'),
    archived && h('div', { class: 'banner banner--muted', role: 'note' }, icon('archive'),
      'Este procedimento está arquivado e não aparece na lista da equipe.'),
    procedureBody(proc, { titleActions }),

    h('footer', { class: 'proc-foot' },
      h('div', { class: 'proc-foot-info' },
        h('span', {}, icon('external-link'), 'Fonte: ',
          proc.source_url
            ? h('a', { class: 'link', href: proc.source_url, target: '_blank', rel: 'noopener noreferrer' }, 'post original no #faq')
            : '[PREENCHER]'),
        h('span', {}, icon('pencil'), `Versão ${proc.version} · editado em ${formatDate(proc.updated_at)}`,
          proc.updated_by_name ? ` por ${proc.updated_by_name}` : '')),
      h('div', { class: 'proc-actions' },
        app.can('procedimentos.editar') && (!archived || app.can('procedimentos.arquivar'))
          && h('a', { class: 'btn', href: `#/editar/${proc.slug}` }, icon('pencil'), 'Editar'),
        h('a', { class: 'btn', href: `#/historico/${proc.slug}` }, icon('history'), 'Histórico'),
        !archived && app.can('procedimentos.favoritar') && h('button', { type: 'button', class: 'btn', 'data-requires-online': '', onclick: markReviewed },
          icon('circle-check'), 'Marcar como revisado hoje'),
        app.can('procedimentos.arquivar') && app.can('procedimentos.editar') && (archived
          ? h('button', { type: 'button', class: 'btn', 'data-requires-online': '', onclick: unarchive }, icon('rotate-clockwise'), 'Restaurar')
          : h('button', { type: 'button', class: 'btn btn--danger', 'data-requires-online': '', onclick: archive }, icon('archive'), 'Arquivar')))),
  ));
  return null;
}
