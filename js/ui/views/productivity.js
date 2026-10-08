// Etapa 10 · painel de produtividade (documento 01, seção 5): #/controle. Só produtividade.ver
// (Head Staff e Direção; D12: só números e gráficos). Os totais vêm agrupados do banco.
import { downloadText, h, icon } from '../dom.js';
import { formatDate, roleBadge } from '../components.js';
import {
  PERIODS, allowlistRanking, fillDaily, interviewRanking, interviewTotal, percent, periodRange, productivityCsv,
} from '../../core/productivity.js';
import { errorText } from './allowlist.js';
import { renderMessage } from './message.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...children) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};
const dayLabel = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** Barras por dia (allowlists e entrevistas lado a lado). */
function dailyChart(series) {
  const max = Math.max(1, ...series.map((d) => Math.max(d.allowlists, d.entrevistas)));
  const n = Math.max(series.length, 1);
  const W = Math.max(24, Math.round(720 / n));
  const H = 120;
  const bw = Math.min(14, Math.round(W * 0.3));
  const gap = 2;
  const width = n * W;
  const bars = series.flatMap((d, i) => ['allowlists', 'entrevistas'].map((k, j) => {
    const v = d[k];
    const bh = v ? Math.max(2, Math.round((v / max) * H)) : 0;
    return svg('rect', { x: i * W + Math.round((W - 2 * bw - gap) / 2) + j * (bw + gap), y: H - bh, width: bw, height: bh, rx: 1, class: `bar bar--${k}` },
      svg('title', {}, `${dayLabel(d.day)}: ${v} ${k === 'allowlists' ? 'allowlists' : 'entrevistas'}`));
  }));
  // As datas ficam fora do SVG (em HTML), para o texto não esticar quando o gráfico muda de largura.
  const step = Math.ceil(series.length / 10);
  const labels = series.map((d, i) => (i % step === 0
    ? h('span', { class: 'bar-label', style: `left:${(((i + 0.5) / n) * 100).toFixed(3)}%` }, dayLabel(d.day)) : null)).filter(Boolean);
  const total = series.reduce((n2, d) => n2 + d.allowlists + d.entrevistas, 0);
  return h('figure', { class: 'prod-chart' },
    svg('svg', { viewBox: `0 0 ${width} ${H}`, role: 'img', 'aria-label': `Atividade por dia: ${total} registros em ${series.length} dias`, preserveAspectRatio: 'none' },
      svg('line', { x1: 0, y1: H, x2: width, y2: H, class: 'bar-axis' }), ...bars),
    h('div', { class: 'prod-axis', 'aria-hidden': 'true' }, labels),
    h('figcaption', { class: 'prod-legend' },
      h('span', { class: 'legend-dot legend-dot--allowlists' }), 'Allowlists ', h('span', { class: 'legend-dot legend-dot--entrevistas' }), 'Entrevistas'));
}

export function renderProductivity(app) {
  if (!app.feature('produtividade') || !app.can('produtividade.ver')) {
    renderMessage(app, { title: 'Acesso restrito', text: 'O painel de produtividade é do Head Staff e da Direção.' });
    return null;
  }
  let alive = true;
  let period = '30d';
  let last = null;
  const custom = { from: '', to: '' };
  const body = h('div', { id: 'prod-body' }, h('p', { class: 'panel-text' }, 'Carregando…'));
  const periodBtns = Object.entries(PERIODS).map(([k, t]) => h('button', {
    type: 'button', class: 'btn btn--sm', 'aria-pressed': String(k === period), dataset: { period: k },
    onclick: () => { period = k; customBox.hidden = k !== 'personalizado'; for (const b of periodBtns) b.setAttribute('aria-pressed', String(b.dataset.period === k)); if (k !== 'personalizado') load(); },
  }, t));
  const dateIn = (key, label) => h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, label),
    h('input', { class: 'input input--sm', type: 'date', id: `prod-${key}`, onchange: (e) => { custom[key] = e.target.value; } }));
  const customBox = h('div', { class: 'staff-filters', hidden: true }, dateIn('from', 'De'), dateIn('to', 'Até'),
    h('button', { type: 'button', class: 'btn btn--sm btn--primary', id: 'prod-apply', onclick: () => load() }, 'Aplicar'));
  const csvBtn = h('button', { type: 'button', class: 'btn', id: 'prod-csv', disabled: true, onclick: () => {
    if (last) downloadText(`produtividade-${last.range.days[0]}-a-${last.range.days.at(-1)}.csv`, String.fromCharCode(0xFEFF) + productivityCsv(last.data.members), 'text/csv;charset=utf-8');
  } }, icon('file-spreadsheet'), 'Exportar CSV');

  app.els.main.replaceChildren(h('div', { class: 'main-inner productivity-page' },
    h('a', { class: 'back', href: '#/painel' }, icon('arrow-left'), 'Início'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Produtividade da staff'),
      h('p', { class: 'page-sub' }, 'Quem mais lê allowlist e faz entrevista. Conta a partir do dia em que o módulo de Allowlist entrou no site. Datas no horário de Brasília.'),
      h('div', { class: 'page-head-actions' }, csvBtn)),
    h('div', { class: 'prod-periods', role: 'group', 'aria-label': 'Período' }, periodBtns),
    customBox, body));

  async function load() {
    const range = periodRange(period, new Date(), custom);
    if (!range) { body.replaceChildren(h('p', { class: 'field-error', role: 'alert' }, 'Escolha as duas datas (a primeira antes da segunda).')); return; }
    const res = await app.adapter.getProductivity({ from: range.from, to: range.to });
    if (!alive) return;
    if (res.error) { body.replaceChildren(h('p', { class: 'field-error', role: 'alert' }, errorText(res.error))); return; }
    last = { range, data: res.data };
    csvBtn.disabled = res.data.members.length === 0;
    draw(range, res.data);
  }

  const who = (m) => (app.can('equipe.ver') && m.display_name
    ? h('a', { href: `#/equipe/${m.discord_id}` }, m.display_name)
    : m.display_name ?? m.discord_id);
  const when = (m) => (m.last_at ? formatDate(m.last_at, { time: true }) : '-');

  function table(id, caption, head, rows) {
    return h('div', { class: 'table-wrap' }, h('table', { class: 'prod-table', id },
      h('caption', { class: 'sr-only' }, caption),
      h('thead', {}, h('tr', {}, head.map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: head.length }, 'Ninguém no período.')))));
  }

  function draw(range, d) {
    const t = d.totals;
    const done = t.allowlists + t.entrevistas;
    const tile = (label, value, sub) => h('div', { class: 'stat' }, h('span', { class: 'stat-value' }, String(value)), h('span', { class: 'stat-label' }, label), sub && h('span', { class: 'stat-sub' }, sub));
    const al = allowlistRanking(d.members);
    const iv = interviewRanking(d.members);
    body.replaceChildren(
      h('div', { class: 'stat-row', id: 'prod-totals' },
        tile('Allowlists analisadas', t.allowlists, `${t.allowlists_aprovadas} aprovadas · ${t.allowlists - t.allowlists_aprovadas} reprovadas`),
        tile('Entrevistas', t.entrevistas, `${t.entrevistas_aprovadas} aprovadas · ${t.entrevistas - t.entrevistas_aprovadas} reprovadas`),
        tile('Membros ativos', t.membros_ativos, `de ${t.membros_ativos + d.inactive.length} na equipe`),
        tile('Média por dia', (done / range.days.length).toFixed(1).replace('.', ','), `${range.days.length} ${range.days.length === 1 ? 'dia' : 'dias'}`)),
      h('section', { class: 'panel', 'aria-labelledby': 'prod-chart-title' },
        h('h2', { class: 'block-title', id: 'prod-chart-title' }, icon('chart-bar'), 'Por dia'),
        dailyChart(fillDaily(range.days, d.daily))),
      h('section', { class: 'panel', 'aria-labelledby': 'prod-al-title' },
        h('h2', { class: 'block-title', id: 'prod-al-title' }, icon('file-check'), 'Quem mais lê allowlist'),
        table('prod-rank-al', 'Ranking de allowlists', ['#', 'Membro', 'Cargo', 'Allowlists', '% aprovadas', 'Última atividade'],
          al.map((m, i) => h('tr', {}, h('td', {}, String(i + 1)), h('td', {}, who(m)), h('td', {}, m.role ? roleBadge(m.role) : '-'),
            h('td', {}, String(m.allowlists)), h('td', {}, `${percent(m.allowlists_aprovadas, m.allowlists)}%`), h('td', {}, when(m)))))),
      h('section', { class: 'panel', 'aria-labelledby': 'prod-iv-title' },
        h('h2', { class: 'block-title', id: 'prod-iv-title' }, icon('microphone'), 'Quem mais faz entrevista'),
        h('p', { class: 'panel-text' }, 'Total = entrevistou (responsável ou entrevistador) + acompanhou.'),
        table('prod-rank-iv', 'Ranking de entrevistas', ['#', 'Membro', 'Cargo', 'Total', 'Entrevistou', 'Acompanhou', '% aprovadas', 'Última atividade'],
          iv.map((m, i) => h('tr', {}, h('td', {}, String(i + 1)), h('td', {}, who(m)), h('td', {}, m.role ? roleBadge(m.role) : '-'),
            h('td', {}, String(interviewTotal(m))), h('td', {}, String(m.entrevistas)), h('td', {}, String(m.acompanhamentos)),
            h('td', {}, `${percent(m.entrevistas_aprovadas, interviewTotal(m))}%`), h('td', {}, when(m)))))),
      h('section', { class: 'panel', 'aria-labelledby': 'prod-idle-title' },
        h('h2', { class: 'block-title', id: 'prod-idle-title' }, icon('user-off'), 'Sem atividade no período'),
        d.inactive.length
          ? h('ul', { class: 'prod-idle', id: 'prod-idle' }, d.inactive.map((m) => h('li', {}, who(m), ' ', m.role ? roleBadge(m.role) : '')))
          : h('p', { class: 'panel-text' }, 'Todos os membros ativos registraram algo no período.')));
  }

  load();
  return () => { alive = false; };
}
