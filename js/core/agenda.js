// Agenda de Reuniões (plano 06): funções puras. A tela, o mock e o banco (17_agenda.sql) usam as mesmas regras.
// Mensagens das travas IGUAIS às do SQL (tests/db/banco.test.mjs confere).
// Horário sempre de Brasília (UTC-3, sem horário de verão desde 2019), igual para toda a staff.
import { NO_EMOJI_MESSAGE, hasEmoji } from './workflow.js';
import { ROLE_CODES } from './permissions.js';

export const MEETING_LIMITS = Object.freeze({ title: 150, description: 2000, link: 300, participants: 100 });

/** Campos que o cliente pode definir numa reunião (o resto é do servidor). */
export const MEETING_FIELDS = Object.freeze(['title', 'description', 'starts_at', 'discord_link', 'participants']);

/** Tipos de convocado: cargo inteiro ou membro específico (Discord ID). */
export const PARTICIPANT_KINDS = Object.freeze(['role', 'member']);

export const MEETING_FIELD_ERRORS = Object.freeze({
  required: 'Campo obrigatório.',
  max: (n) => `Até ${n} caracteres.`,
  date: 'Informe uma data e um horário válidos.',
  link: 'O link deve começar com https://discord.gg/, https://discord.com/channels/ ou https://discord.com/invite/.',
  participants: 'Lista de convocados inválida.',
});

/** Mesma expressão do CHECK de supabase/17_agenda.sql. */
export const DISCORD_LINK_PATTERN = /^https:\/\/(discord\.gg\/|discord\.com\/(channels|invite)\/)[^\s]+$/;

/** Minutos antes e depois do horário em que a reunião aparece como "ao vivo". */
export const LIVE_WINDOW_MIN = 30;

const clean = (v) => String(v ?? '').trim();
const DISCORD_ID = /^[0-9]{17,20}$/;

function text(errors, field, value, max, { required = false } = {}) {
  if (required && !value) errors[field] = MEETING_FIELD_ERRORS.required;
  else if (value.length > max) errors[field] = MEETING_FIELD_ERRORS.max(max);
  else if (hasEmoji(value)) errors[field] = NO_EMOJI_MESSAGE;
}

const validParticipant = (p) => p && typeof p === 'object'
  && ((p.kind === 'role' && ROLE_CODES.includes(p.value)) || (p.kind === 'member' && DISCORD_ID.test(String(p.value))));

/** @returns {{ valid: boolean, errors: Record<string, string> }} */
export function validateMeeting(m = {}) {
  const errors = {};
  text(errors, 'title', clean(m.title), MEETING_LIMITS.title, { required: true });
  text(errors, 'description', clean(m.description), MEETING_LIMITS.description);
  if (!m.starts_at || Number.isNaN(Date.parse(m.starts_at))) errors.starts_at = MEETING_FIELD_ERRORS.date;
  const link = clean(m.discord_link);
  if (link.length > MEETING_LIMITS.link) errors.discord_link = MEETING_FIELD_ERRORS.max(MEETING_LIMITS.link);
  else if (link && !DISCORD_LINK_PATTERN.test(link)) errors.discord_link = MEETING_FIELD_ERRORS.link;
  const list = m.participants ?? [];
  if (!Array.isArray(list) || list.length > MEETING_LIMITS.participants || !list.every(validParticipant)) {
    errors.participants = MEETING_FIELD_ERRORS.participants;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Convocados sem repetição, só com tipo e valor. */
export function pickParticipants(list) {
  const seen = new Set();
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || typeof p !== 'object') continue;
    const item = { kind: p.kind, value: String(p.value ?? '') };
    const key = `${item.kind}:${item.value}`;
    if (!seen.has(key)) { seen.add(key); out.push(item); }
  }
  return out;
}

/** Só os campos editáveis, com texto aparado ("" vira null em descrição e link, como no banco). */
export function pickMeeting(data = {}) {
  const src = data && typeof data === 'object' ? data : {};
  const out = {};
  for (const f of MEETING_FIELDS) {
    if (!(f in src)) continue;
    if (f === 'participants') out[f] = Array.isArray(src[f]) ? pickParticipants(src[f]) : src[f];
    else if (f === 'description' || f === 'discord_link') out[f] = clean(src[f]) || null;
    else out[f] = clean(src[f]);
  }
  return out;
}

/** A reunião está "ao vivo" (de 30 min antes a 30 min depois do horário). */
export function isLive(startsAt, now = new Date()) {
  const diffMin = (new Date(startsAt).getTime() - new Date(now).getTime()) / 60000;
  return diffMin >= -LIVE_WINDOW_MIN && diffMin <= LIVE_WINDOW_MIN;
}

/** Ainda não acabou: começa daqui para a frente ou está ao vivo. */
export const isUpcoming = (startsAt, now = new Date()) => new Date(startsAt).getTime() >= new Date(now).getTime() - LIVE_WINDOW_MIN * 60000;

/** Ordem da lista: por horário (mais cedo primeiro, desempate pelo título). */
export const sortMeetings = (list) => [...list].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) || a.title.localeCompare(b.title, 'pt-BR'));

/** Filtro 'proximas' (mais cedo primeiro), 'passadas' (mais recente primeiro) ou 'todas' (mais recente primeiro). */
export function filterMeetings(list, filter = 'proximas', now = new Date()) {
  const sorted = sortMeetings(list);
  if (filter === 'proximas') return sorted.filter((m) => isUpcoming(m.starts_at, now));
  if (filter === 'passadas') return sorted.filter((m) => !isUpcoming(m.starts_at, now)).reverse();
  return sorted.reverse();
}

/* ---------- horário de Brasília ---------- */
const BR = 'America/Sao_Paulo';
const part = (date, opts) => new Intl.DateTimeFormat('pt-BR', { timeZone: BR, ...opts }).format(date);

/** "2026-10-05T19:30" (valor de <input type="datetime-local">) → ISO, lido como horário de Brasília. */
export function fromInputValue(value) {
  const v = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  const d = new Date(`${v}:00-03:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ISO → "2026-10-05T19:30" em horário de Brasília. */
export function toInputValue(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: BR, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** { day: '05', month: 'OUT', weekdayDate: 'segunda-feira, 5 de outubro de 2026', time: '19:30' } */
export function formatMeetingDate(iso) {
  const d = new Date(iso);
  return {
    day: part(d, { day: '2-digit' }),
    month: part(d, { month: 'short' }).replace('.', '').toUpperCase(),
    weekdayDate: part(d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    time: part(d, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  };
}
