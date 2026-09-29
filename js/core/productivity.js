// Etapa 10: painel de produtividade (documento 01, seção 5). Funções puras.
// O banco faz a mesma conta em public.staff_productivity (supabase/13_produtividade.sql):
//   allowlist   crédito para quem fez a análise (responsável);
//   entrevista  crédito para o responsável e cada entrevistador; o acompanhante conta
//               no ranking numa coluna à parte (Decisão 6 do 01 e Decisão 18 do 02).
// Datas no fuso de Brasília (UTC-3, sem horário de verão desde 2019).

/** Mensagens das travas. IGUAIS às de supabase/13_produtividade.sql. */
export const PRODUCTIVITY_ERRORS = Object.freeze({
  forbidden: 'Seu cargo não permite ver o painel de produtividade.',
  period: 'Período inválido: a data final precisa ser depois da inicial (até 400 dias).',
});

export const PERIODS = Object.freeze({
  hoje: 'Hoje', '7d': '7 dias', '30d': '30 dias', mes: 'Este mês', mes_passado: 'Mês passado', personalizado: 'Personalizado',
});
const OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Dia (AAAA-MM-DD) em Brasília de uma data. */
export const brDay = (date) => new Date(new Date(date).getTime() - OFFSET_MS).toISOString().slice(0, 10);
/** Meia-noite de Brasília do dia AAAA-MM-DD, como Date. */
const midnight = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + OFFSET_MS);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Intervalo do período: { from, to } em ISO (to exclusivo) e os dias (AAAA-MM-DD) incluídos.
 * personalizado usa custom.from e custom.to (AAAA-MM-DD, inclusivos). Inválido = null.
 */
export function periodRange(key, now = new Date(), custom = {}) {
  const today = brDay(now);
  let first;
  let last = today;
  if (key === 'hoje') first = today;
  else if (key === '7d') first = addDays(today, -6);
  else if (key === '30d') first = addDays(today, -29);
  else if (key === 'mes') first = `${today.slice(0, 8)}01`;
  else if (key === 'mes_passado') {
    last = addDays(`${today.slice(0, 8)}01`, -1);
    first = `${last.slice(0, 8)}01`;
  } else if (key === 'personalizado') {
    const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '') && !Number.isNaN(Date.parse(d));
    if (!ok(custom.from) || !ok(custom.to) || custom.from > custom.to) return null;
    first = custom.from;
    last = custom.to;
  } else return null;
  const days = [];
  for (let d = first; d <= last && days.length < 400; d = addDays(d, 1)) days.push(d);
  return { from: midnight(first).toISOString(), to: midnight(addDays(last, 1)).toISOString(), days };
}

const emptyMember = (m) => ({
  discord_id: m.discord_id, display_name: m.display_name ?? null, role: m.role ?? null, active: m.active ?? false,
  allowlists: 0, allowlists_aprovadas: 0, entrevistas: 0, acompanhamentos: 0, entrevistas_aprovadas: 0, last_at: null,
});

/**
 * Totais do período (mesma conta do banco).
 * @param {{ evaluations: Array<{ id: string, kind: string, status: string, created_by: string, created_at: string }>,
 *   participants: Array<{ evaluation_id: string, discord_id: string, role: string }>,
 *   staff: Array<{ discord_id: string, display_name: string, role: string, active: boolean }>,
 *   from: string, to: string }} input
 */
export function aggregateProductivity({ evaluations = [], participants = [], staff = [], from, to }) {
  const inPeriod = evaluations.filter((e) => e.created_at >= from && e.created_at < to);
  const byId = new Map(staff.map((s) => [s.discord_id, emptyMember(s)]));
  const member = (id) => {
    if (!byId.has(id)) byId.set(id, emptyMember({ discord_id: id }));
    return byId.get(id);
  };
  const seen = (m, at) => { if (!m.last_at || at > m.last_at) m.last_at = at; };
  const daily = new Map();
  const totals = { allowlists: 0, allowlists_aprovadas: 0, entrevistas: 0, entrevistas_aprovadas: 0 };
  for (const e of inPeriod) {
    const day = brDay(e.created_at);
    if (!daily.has(day)) daily.set(day, { day, allowlists: 0, entrevistas: 0 });
    const ok = e.status === 'aprovado' ? 1 : 0;
    if (e.kind === 'allowlist') {
      totals.allowlists++; totals.allowlists_aprovadas += ok; daily.get(day).allowlists++;
      const m = member(e.created_by);
      m.allowlists++; m.allowlists_aprovadas += ok; seen(m, e.created_at);
    } else {
      totals.entrevistas++; totals.entrevistas_aprovadas += ok; daily.get(day).entrevistas++;
      const people = participants.filter((p) => p.evaluation_id === e.id);
      if (!people.some((p) => p.discord_id === e.created_by)) people.push({ discord_id: e.created_by, role: 'responsavel' });
      for (const p of people) {
        const m = member(p.discord_id);
        if (p.role === 'acompanhante') m.acompanhamentos++; else m.entrevistas++;
        m.entrevistas_aprovadas += ok;
        seen(m, e.created_at);
      }
    }
  }
  const members = [...byId.values()].sort((a, b) => (a.display_name ?? a.discord_id).localeCompare(b.display_name ?? b.discord_id, 'pt-BR'));
  const busy = (m) => m.allowlists + m.entrevistas + m.acompanhamentos > 0;
  return {
    totals: { ...totals, membros_ativos: members.filter(busy).length },
    members: members.filter(busy),
    inactive: members.filter((m) => m.active && !busy(m)),
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

/** Ranking de allowlists (maior primeiro; empate: nome). */
export const allowlistRanking = (members) => members.filter((m) => m.allowlists > 0)
  .sort((a, b) => b.allowlists - a.allowlists || String(a.display_name).localeCompare(String(b.display_name), 'pt-BR'));

/** Ranking de entrevistas: entrevistou + acompanhou (Decisão 18). */
export const interviewTotal = (m) => m.entrevistas + m.acompanhamentos;
export const interviewRanking = (members) => members.filter((m) => interviewTotal(m) > 0)
  .sort((a, b) => interviewTotal(b) - interviewTotal(a) || b.entrevistas - a.entrevistas
    || String(a.display_name).localeCompare(String(b.display_name), 'pt-BR'));

/** Porcentagem inteira (0 quando não há total). */
export const percent = (part, total) => (total > 0 ? Math.round((part / total) * 100) : 0);

/** Série diária completa (dias sem atividade com zero). */
export const fillDaily = (days, daily) => {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  return days.map((day) => byDay.get(day) ?? { day, allowlists: 0, entrevistas: 0 });
};

/** CSV do ranking (separador ";" para abrir direto no Excel em português). */
export function productivityCsv(members) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['Membro', 'Discord ID', 'Cargo', 'Allowlists', '% aprovadas (allowlist)', 'Entrevistas', 'Acompanhamentos',
    '% aprovadas (entrevista)', 'Última atividade'];
  const rows = members.map((m) => [m.display_name ?? '', m.discord_id, m.role ?? '', m.allowlists, percent(m.allowlists_aprovadas, m.allowlists),
    m.entrevistas, m.acompanhamentos, percent(m.entrevistas_aprovadas, interviewTotal(m)), m.last_at ? brDay(m.last_at) : '']);
  return [head, ...rows].map((r) => r.map(esc).join(';')).join('\r\n');
}
