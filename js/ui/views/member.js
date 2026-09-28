// Ficha do membro (#/equipe/<discord_id>): dados, cargo, equipes, data de entrada e o que a
// pessoa pode fazer na Central (permissões efetivas pela grade atual).
// Produtividade (Etapa 10), avaliações (Etapa 3, só Direção) e histórico de cargos (Etapa 11)
// entram aqui quando esses módulos existirem.
import { h, icon } from '../dom.js';
import { formatDate, roleBadge, statusBadge, teamBadge } from '../components.js';
import { CEO, PERMISSIONS, permissionsOf, roleLevel } from '../../core/permissions.js';
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

    // Sem a grade (banco antigo), usa o padrão: a lista é só informativa, quem decide é o banco.
    const perms = new Set(permissionsOf(m, grid.error ? undefined : grid.data.grid));
    const self = m.discord_id === app.state.staff.discord_id;

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

      h('section', { class: 'panel', 'aria-labelledby': 'member-next-title' },
        h('h2', { class: 'block-title', id: 'member-next-title' }, icon('clock'), 'Em breve nesta ficha'),
        h('p', { class: 'panel-text' },
          'Produtividade (análises de allowlist e entrevistas), avaliações recebidas (só a Direção vê) e histórico de mudanças de cargo aparecem aqui quando esses módulos entrarem no ar.')));
  })();

  return () => { alive = false; };
}
