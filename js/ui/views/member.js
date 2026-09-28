// Ficha do membro (#/equipe/<discord_id>): dados, cargo, equipes, data de entrada e o que a
// pessoa pode fazer na Central (permissões efetivas pela grade atual).
// Avaliações recebidas (Etapa 3): só quem tem avaliacoes.ler, e nunca a própria.
// Histórico de mudanças de cargo (Etapa 11): da auditoria, para quem tem auditoria.ver.
// Produtividade (Etapa 10) entra quando o módulo de Allowlist existir.
import { h, icon } from '../dom.js';
import { formatDate, roleBadge, statusBadge, teamBadge } from '../components.js';
import { CEO, PERMISSIONS, permissionsOf, roleLevel } from '../../core/permissions.js';
import { recommendationLabel, stars } from '../../core/workflow.js';
import { describeAudit } from './audit.js';
import { renderMessage } from './message.js';

export function renderMember(app, discordId) {
  if (!app.can('equipe.ver')) {
    renderMessage(app, { title: 'Acesso restrito', text: 'Seu cargo não permite ver a equipe.' });
    return null;
  }

  let alive = true;
  const body = h('div', { class: 'member-body', 'aria-live': 'polite' }, h('p', { class: 'panel-text' }, 'Carregando…'));
  const title = h('h1', { class: 'page-title', tabindex: '-1' }, 'Ficha do membro');

  app.els.main.replaceChildren(h('div', { class: 'main-inner member-page' },
    h('a', { class: 'back', href: '#/equipe' }, icon('arrow-left'), 'Voltar para a equipe'),
    h('header', { class: 'page-head' }, title),
    body));

  (async () => {
    const [staff, grid] = await Promise.all([app.adapter.listStaff(), app.adapter.listPermissionGrid()]);
    if (!alive) return;
    if (staff.error) { app.reportError(staff.error, 'Não foi possível carregar a ficha.'); body.replaceChildren(h('p', { class: 'panel-text' }, 'Não foi possível carregar a ficha.')); return; }
    const m = staff.data.find((s) => s.discord_id === discordId);
    if (!m) {
      title.textContent = 'Membro não encontrado';
      body.replaceChildren(h('p', { class: 'panel-text' }, 'Este Discord ID não está cadastrado na equipe. A pessoa pode ter sido removida.'));
      return;
    }
    title.textContent = m.display_name;

    // Se a grade não carregar, usa o padrão: a lista é só informativa, quem decide é o banco.
    const perms = new Set(permissionsOf(m, grid.error ? undefined : grid.data.grid));
    const self = m.discord_id === app.state.staff.discord_id;

    const evaluationsHost = h('div', {});
    const historyHost = h('div', {});
    const row = (label, ...value) => h('div', { class: 'member-row' }, h('dt', {}, label), h('dd', {}, ...value));
    body.replaceChildren(
      h('section', { class: 'panel', 'aria-labelledby': 'member-data-title' },
        h('h2', { class: 'block-title', id: 'member-data-title' }, icon('id-badge-2'), 'Dados'),
        h('dl', { class: 'member-data' },
          row('Nome', m.display_name, self && h('span', { class: 'staff-you' }, ' (você)')),
          row('Discord ID', h('code', { class: 'staff-id' }, m.discord_id)),
          row('Cargo', roleBadge(m.role), ` nível ${roleLevel(m.role)} de 8`),
          row('Equipes', (m.teams ?? []).length ? h('span', { class: 'staff-tags' }, m.teams.map(teamBadge)) : 'Nenhuma'),
          row('Situação', statusBadge(m.active)),
          row('Na staff desde', m.created_at ? formatDate(m.created_at) : 'Sem registro'))),

      h('section', { class: 'panel', 'aria-labelledby': 'member-perms-title' },
        h('h2', { class: 'block-title', id: 'member-perms-title' }, icon('shield-check'), 'O que pode fazer na Central'),
        h('p', { class: 'panel-text' }, m.role === CEO
          ? 'O CEO tem todas as permissões, sempre.'
          : 'Permissões do cargo somadas às das equipes, pela grade atual.'),
        !m.active && h('p', { class: 'banner banner--warn' }, '⚠ Conta inativa: sem acesso à Central enquanto estiver assim.'),
        h('ul', { class: 'perm-list', id: 'member-perms' },
          PERMISSIONS.map((p) => {
            const has = perms.has(p.code);
            return h('li', { class: `perm-item ${has ? 'perm-item--on' : 'perm-item--off'}` },
              h('span', { class: 'perm-mark', 'aria-hidden': 'true' }, has ? '✓' : '✗'),
              h('span', { class: 'sr-only' }, has ? 'Pode: ' : 'Não pode: '),
              p.description);
          }))),

      evaluationsHost,
      historyHost,
      h('section', { class: 'panel', 'aria-labelledby': 'member-next-title' },
        h('h2', { class: 'block-title', id: 'member-next-title' }, icon('clock'), 'Em breve nesta ficha'),
        h('p', { class: 'panel-text' },
          'Produtividade (análises de allowlist e entrevistas) aparece aqui quando o módulo de Allowlist entrar no ar.')));

    const nameOf = (id) => staff.data.find((s) => s.discord_id === id)?.display_name ?? id;
    const [evals, audit] = await Promise.all([
      !self && app.feature('avaliacoes') && app.can('avaliacoes.ler') ? app.adapter.listEvaluations() : null,
      app.feature('auditoria') && app.can('auditoria.ver') ? app.adapter.listAudit({ entity: 'membro', entityId: m.discord_id, limit: 50 }) : null,
    ]);
    if (!alive) return;
    if (evals && !evals.error) {
      const mine = evals.data.filter((e) => e.evaluated_id === m.discord_id && e.status !== 'rascunho')
        .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
      evaluationsHost.replaceChildren(h('section', { class: 'panel', 'aria-labelledby': 'member-evals-title' },
        h('h2', { class: 'block-title', id: 'member-evals-title' }, icon('star'), 'Avaliações recebidas'),
        h('p', { class: 'panel-text' }, 'Só a Direção vê. A nota geral de cada avaliação, da mais antiga para a mais recente:'),
        mine.length
          ? h('ol', { class: 'eval-history', id: 'member-evals' }, mine.map((e) => h('li', { class: 'eval-history-item' },
            h('span', { class: `eval-bar eval-bar--${e.overall}`, 'aria-hidden': 'true' }),
            h('a', { href: `#/avaliacoes-equipe/${e.id}` }, formatDate(e.submitted_at)),
            h('span', { class: 'stars', 'aria-label': `Nota ${e.overall} de 5` }, ` ${stars(e.overall)} `),
            h('span', { class: 'staff-meta' }, `${recommendationLabel(e.recommendation)} · por ${e.evaluator_name ?? e.evaluator_id}${e.status === 'arquivada' ? ' · arquivada' : ''}`))))
          : h('p', { class: 'panel-text' }, 'Nenhuma avaliação recebida ainda.')));
    }
    if (audit && !audit.error) {
      historyHost.replaceChildren(h('section', { class: 'panel', 'aria-labelledby': 'member-history-title' },
        h('h2', { class: 'block-title', id: 'member-history-title' }, icon('history'), 'Histórico de mudanças'),
        audit.data.length
          ? h('ol', { class: 'audit-list', id: 'member-history' }, audit.data.map((e) => h('li', { class: 'audit-item' },
            h('time', { class: 'audit-when', datetime: e.at }, formatDate(e.at, { time: true })),
            h('p', { class: 'audit-what' }, h('strong', {}, e.actor_name ?? nameOf(e.actor)), ' · ', describeAudit(e, nameOf)))))
          : h('p', { class: 'panel-text' }, 'Nenhuma mudança registrada desde que a auditoria entrou no ar.')));
    }
  })();

  return () => { alive = false; };
}
