// Regras das Etapas 2B, 3 e 11 (documento 01): aprovação de procedimentos, avaliações da
// equipe e avisos. Fonte única no JavaScript: o mock simula o banco com estas regras e a
// interface usa para mensagens e botões. Quem garante de verdade é o banco
// (supabase/07, 08 e 09); tests/db/banco.test.mjs confere que as mensagens são iguais.
import { roleLevel } from './permissions.js';

/* ======================= Etapa 2B · propostas de procedimentos ======================= */
export const PROPOSAL_ERRORS = Object.freeze({
  direct: 'Seu cargo envia procedimentos para aprovação. Use Enviar para aprovação.',
  reviewed: 'Esta proposta já foi analisada.',
  rejectNote: 'Escreva o motivo da recusa (o autor vai ler).',
  noteMax: 'O motivo pode ter até 500 caracteres.',
  archived: 'O procedimento foi arquivado depois da proposta. Recuse ou restaure o procedimento antes.',
});
export const PROPOSAL_NOTE_MAX = 500;
export const PROPOSAL_STATUS_LABELS = Object.freeze({
  pendente: 'Aguardando aprovação', aprovada: 'Aprovada', recusada: 'Recusada', cancelada: 'Cancelada',
});

/** Campos de conteúdo: mudar qualquer um deles sem procedimentos.aprovar vira proposta. */
export const CONTENT_FIELDS = Object.freeze([
  'slug', 'title', 'category', 'audience', 'tags', 'summary', 'who_handles',
  'steps', 'commands', 'ready_message', 'notes', 'source_url',
]);

/** O conteúdo de `next` é diferente do de `current`? (comparação estável de JSON) */
export function contentChanged(current, next) {
  const pick = (p) => JSON.stringify(CONTENT_FIELDS.map((f) => p?.[f] ?? null));
  return pick(current) !== pick(next);
}

/** Situação que a proposta aplica ao ser aprovada (arquivar nunca vem por proposta). */
export const proposalStatus = (data) => (['ativo', 'revisar'].includes(data?.status) ? data.status : 'ativo');

/* ======================= Etapa 3 · avaliações da equipe ======================= */
export const EVALUATION_ERRORS = Object.freeze({
  noPeriod: 'Não há período de avaliação aberto.',
  below: 'Você só pode avaliar membros de cargo abaixo do seu.',
  self: 'Ninguém avalia a si mesmo.',
  inactive: 'Membro não encontrado ou inativo.',
  duplicate: 'Você já avaliou este membro neste período.',
  incomplete: 'Preencha todas as notas, a nota geral e a recomendação antes de enviar.',
  deadline: 'O prazo de 24 horas para editar esta avaliação terminou.',
  archived: 'Avaliação arquivada não pode ser editada.',
  backToDraft: 'Avaliação enviada não volta para rascunho.',
  locked: 'Depois de enviada, o membro e o período não mudam.',
  archiveOnly: 'Só a Direção arquiva avaliações.',
});

export const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const PERIOD_DEFAULT_DAYS = 7;

export const RECOMMENDATIONS = Object.freeze([
  Object.freeze({ code: 'manter', label: 'Manter' }),
  Object.freeze({ code: 'acompanhar', label: 'Acompanhar de perto' }),
  Object.freeze({ code: 'promover', label: 'Promover' }),
  Object.freeze({ code: 'advertencia', label: 'Advertência' }),
  Object.freeze({ code: 'desligamento', label: 'Desligamento' }),
]);
export const recommendationLabel = (code) => RECOMMENDATIONS.find((r) => r.code === code)?.label ?? '';

export const EVALUATION_LIMITS = Object.freeze({ strengths: 2000, improvements: 2000, feedback: 5000, label: 80, title: 80 });

const time = (v) => (v ? new Date(v).getTime() : NaN);

/** O período está aberto agora? */
export const isPeriodOpen = (period, now = Date.now()) =>
  Boolean(period) && time(period.starts_at) <= now && now < time(period.ends_at);

/** O autor ainda pode editar esta avaliação enviada? (24 horas depois do primeiro envio) */
export const withinEditWindow = (evaluation, now = Date.now()) =>
  evaluation?.status === 'enviada' && now - time(evaluation.submitted_at) < EDIT_WINDOW_MS;

/** Média das notas (1 a 5), arredondada, para sugerir a nota geral. null se faltar nota. */
export function suggestedOverall(criteria = []) {
  const scores = criteria.map((c) => c.score);
  if (!scores.length || scores.some((s) => !Number.isInteger(s))) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

/** Estrelas de texto (sem emoji): 3 → "★★★☆☆". */
export const stars = (n) => (Number.isInteger(n) ? '★'.repeat(n) + '☆'.repeat(5 - n) : '☆☆☆☆☆');

/** Valida formato e limites dos campos de uma avaliação (não as regras de quem pode). */
export function validateEvaluation(e) {
  const errors = {};
  if (!e?.period_id) errors.period_id = 'Período: obrigatório.';
  if (!/^[0-9]{17,20}$/.test(e?.evaluated_id ?? '')) errors.evaluated_id = 'Membro avaliado: escolha na lista.';
  if (!['rascunho', 'enviada'].includes(e?.status)) errors.status = 'Situação inválida.';
  if (!Array.isArray(e?.criteria) || e.criteria.length > 30
      || e.criteria.some((c) => !c || typeof c.id !== 'string' || !c.label || (c.score !== null && !(Number.isInteger(c.score) && c.score >= 1 && c.score <= 5)))) {
    errors.criteria = 'Notas: de 1 a 5 em cada critério.';
  }
  if (e?.overall != null && !(Number.isInteger(e.overall) && e.overall >= 1 && e.overall <= 5)) errors.overall = 'Nota geral: de 1 a 5.';
  if (e?.recommendation != null && !RECOMMENDATIONS.some((r) => r.code === e.recommendation)) errors.recommendation = 'Recomendação inválida.';
  for (const f of ['strengths', 'improvements', 'feedback']) {
    if ((e?.[f] ?? '').length > EVALUATION_LIMITS[f]) errors[f] = `Até ${EVALUATION_LIMITS[f]} caracteres.`;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Travas da avaliação (as mesmas do trigger kb_staff_evaluations_guard). Devolve a mensagem ou null.
 * @param {{ discord_id: string, role: string }} actor
 * @param {object|null} before  avaliação atual (null = nova)
 * @param {object} after        como vai ficar
 * @param {{ period: object|null, target: { role: string, active: boolean }|null, others: object[], now?: number }} ctx
 */
export function evaluationChangeError(actor, before, after, { period, target, others = [], now = Date.now() }) {
  if (before) {
    if (before.status === 'arquivada') return EVALUATION_ERRORS.archived;
    if (before.status === 'enviada' && after.status === 'rascunho') return EVALUATION_ERRORS.backToDraft;
    if (before.status === 'enviada' && !withinEditWindow(before, now)) return EVALUATION_ERRORS.deadline;
    if (before.status === 'enviada' && (after.period_id !== before.period_id || after.evaluated_id !== before.evaluated_id)) {
      return EVALUATION_ERRORS.locked;
    }
  }
  if (after.status === 'arquivada') return EVALUATION_ERRORS.archiveOnly;
  if (after.evaluated_id === actor.discord_id) return EVALUATION_ERRORS.self;
  if (!target?.active) return EVALUATION_ERRORS.inactive;
  if (roleLevel(target.role) >= roleLevel(actor.role)) return EVALUATION_ERRORS.below;
  if ((!before || before.status === 'rascunho') && !isPeriodOpen(period, now)) return EVALUATION_ERRORS.noPeriod;
  if (others.some((o) => o.id !== before?.id && o.period_id === after.period_id && o.evaluator_id === actor.discord_id
      && o.evaluated_id === after.evaluated_id && o.status !== 'arquivada')) return EVALUATION_ERRORS.duplicate;
  if (after.status === 'enviada' && (after.overall == null || !after.recommendation || !after.criteria.length
      || after.criteria.some((c) => !Number.isInteger(c.score)))) return EVALUATION_ERRORS.incomplete;
  return null;
}

/* ======================= Etapa 11 · avisos ======================= */
export const PRIORITIES = Object.freeze([
  Object.freeze({ code: 'normal', label: 'Normal' }),
  Object.freeze({ code: 'importante', label: 'Importante' }),
  Object.freeze({ code: 'urgente', label: 'Urgente' }),
]);
export const priorityLabel = (code) => PRIORITIES.find((p) => p.code === code)?.label ?? code;
export const ANNOUNCEMENT_LIMITS = Object.freeze({ title: 120, body: 4000 });
export const NO_EMOJI_MESSAGE = 'Use apenas símbolos, sem emojis.';

// Mesma faixa de tests/unit/no-emoji.test.mjs e de kb_no_emoji() no 09.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2705}\u{274C}\u{274E}\u{2753}-\u{2757}\u{26A1}\u{2728}\u{2B50}\u{2B55}\u{FE0F}\u{20E3}]/u;
export const hasEmoji = (text) => EMOJI.test(String(text ?? ''));

export function validateAnnouncement(a) {
  const errors = {};
  const title = (a?.title ?? '').trim();
  if (!title) errors.title = 'Título: obrigatório.';
  else if (title.length > ANNOUNCEMENT_LIMITS.title) errors.title = `Título: até ${ANNOUNCEMENT_LIMITS.title} caracteres.`;
  else if (hasEmoji(title)) errors.title = NO_EMOJI_MESSAGE;
  if ((a?.body ?? '').length > ANNOUNCEMENT_LIMITS.body) errors.body = `Mensagem: até ${ANNOUNCEMENT_LIMITS.body} caracteres.`;
  else if (hasEmoji(a?.body)) errors.body = NO_EMOJI_MESSAGE;
  if (!PRIORITIES.some((p) => p.code === a?.priority)) errors.priority = 'Prioridade inválida.';
  if (!Array.isArray(a?.audience_roles) || a.audience_roles.some((r) => !roleLevel(r))) errors.audience_roles = 'Público inválido.';
  if (!a?.starts_at || Number.isNaN(time(a.starts_at))) errors.starts_at = 'Início: data inválida.';
  if (a?.ends_at && !(time(a.ends_at) > time(a.starts_at))) errors.ends_at = 'Fim: precisa ser depois do início.';
  return { valid: Object.keys(errors).length === 0, errors };
}

/** O aviso é para esta pessoa agora? (no ar e no público) */
export const isAnnouncementFor = (a, staff, now = Date.now()) =>
  Boolean(staff) && time(a.starts_at) <= now && (!a.ends_at || now < time(a.ends_at))
  && (!a.audience_roles?.length || a.audience_roles.includes(staff.role));
