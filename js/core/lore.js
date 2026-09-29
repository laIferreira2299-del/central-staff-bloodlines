// Etapas 8 e 9: gabarito, checklist, nomes proibidos e personagens em uso (documento 02, seções
// 4.3, 12.2 a 12.4). Funções puras: a tela, o mock e o banco (12_lore.sql) usam as mesmas regras.
// Mensagens das travas IGUAIS às do SQL (tests/db/banco.test.mjs confere).
import { NO_EMOJI_MESSAGE, hasEmoji } from './workflow.js';
import { QUESTION_KINDS, QUESTION_SECTIONS } from './allowlist.js';

export const NAME_KINDS = Object.freeze({ nome: 'Nome completo', sobrenome: 'Sobrenome' });
export const NAME_REASONS = Object.freeze({ serie: 'Personagem de série', em_uso: 'Em uso na cidade', outro: 'Outro' });
export const NAME_MODES = Object.freeze({ bloqueia: 'Bloqueia', alerta: 'Só alerta' });

/** Situação do personagem (seção 12.3). Liberado = o nome fica livre de novo. */
export const CHARACTER_STATUSES = Object.freeze({ ativo: 'Ativo', inativo: 'Inativo', liberado: 'Liberado' });
export const NOTE_ABOUT = Object.freeze({ personagem: 'Personagem', player: 'Player' });

/** Foto do personagem: bucket privado character-photos. */
export const PHOTO_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

export const LORE_LIMITS = Object.freeze({
  question: 500, answer: 2000, extra_note: 2000, stage_title: 80, text: 300, hint: 300,
  name: 100, series: 80, reason_text: 300, character_name: 100, discord_name: 100, note: 2000,
});

/** Mensagens das travas. IGUAIS às de supabase/12_lore.sql. */
export const LORE_ERRORS = Object.freeze({
  duplicateCharacter: 'Já existe um personagem cadastrado com este nome.',
  duplicateCityId: 'Já existe um personagem cadastrado com este ID da Cidade.',
  photoFolder: 'A foto precisa ficar na pasta do próprio personagem.',
});

export const LORE_FIELD_ERRORS = Object.freeze({
  required: 'Campo obrigatório.',
  max: (n) => `Até ${n} caracteres.`,
  section: 'Escolha a seção.',
  questionKind: 'Escolha o tipo.',
  position: 'Ordem: número inteiro de 0 a 9999.',
  stage: 'Etapa: de 1 a 4.',
  nameKind: 'Escolha Nome completo ou Sobrenome.',
  reason: 'Escolha Personagem de série ou Outro (os nomes em uso vêm da tela de Personagens).',
  series: 'Informe a série.',
  reasonText: 'Explique o motivo.',
  mode: 'Escolha Bloqueia ou Só alerta.',
  characterName: 'Nome e sobrenome do personagem (até 100 caracteres).',
  discordId: 'Discord ID: só números, de 17 a 20 dígitos.',
  cityId: 'ID da Cidade: só números, até 10 dígitos.',
  status: 'Situação inválida.',
  about: 'Escolha Personagem ou Player.',
  photoType: 'A foto precisa ser PNG, JPG ou WEBP.',
  photoSize: 'A foto pode ter até 2 MB.',
});

const DISCORD_ID = /^[0-9]{17,20}$/;
const CITY_ID = /^[0-9]{1,10}$/;
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const result = (errors) => ({ valid: Object.keys(errors).length === 0, errors });

/** Texto obrigatório (ou não), com limite e sem emoji. */
function text(errors, key, value, max, { required = false } = {}) {
  const v = String(value ?? '');
  if (required && !v.trim()) errors[key] = LORE_FIELD_ERRORS.required;
  else if (v.length > max) errors[key] = LORE_FIELD_ERRORS.max(max);
  else if (hasEmoji(v)) errors[key] = NO_EMOJI_MESSAGE;
}
const badPosition = (p) => !(Number.isInteger(p) && p >= 0 && p <= 9999);

/** Pergunta do gabarito (#/gabarito). */
export function validateQuestion(q = {}) {
  const errors = {};
  if (!QUESTION_SECTIONS.includes(q.section)) errors.section = LORE_FIELD_ERRORS.section;
  if (!(q.kind in QUESTION_KINDS)) errors.kind = LORE_FIELD_ERRORS.questionKind;
  text(errors, 'question', q.question, LORE_LIMITS.question, { required: true });
  text(errors, 'answer', q.answer, LORE_LIMITS.answer);
  text(errors, 'extra_note', q.extra_note, LORE_LIMITS.extra_note);
  if (badPosition(q.position)) errors.position = LORE_FIELD_ERRORS.position;
  return result(errors);
}

/** Item do checklist da entrevista (#/gabarito). */
export function validateChecklistItem(c = {}) {
  const errors = {};
  if (!(Number.isInteger(c.stage) && c.stage >= 1 && c.stage <= 4)) errors.stage = LORE_FIELD_ERRORS.stage;
  text(errors, 'stage_title', c.stage_title, LORE_LIMITS.stage_title, { required: true });
  text(errors, 'text', c.text, LORE_LIMITS.text, { required: true });
  text(errors, 'hint', c.hint, LORE_LIMITS.hint);
  if (badPosition(c.position)) errors.position = LORE_FIELD_ERRORS.position;
  return result(errors);
}

/** Nome proibido cadastrado à mão (#/lore/nomes). "Em uso" só pela tela de Personagens. */
export function validateBlockedName(n = {}) {
  const errors = {};
  text(errors, 'name', clean(n.name), LORE_LIMITS.name, { required: true });
  if (!(n.kind in NAME_KINDS)) errors.kind = LORE_FIELD_ERRORS.nameKind;
  if (!['serie', 'outro'].includes(n.reason)) errors.reason = LORE_FIELD_ERRORS.reason;
  if (n.reason === 'serie' && !clean(n.series)) errors.series = LORE_FIELD_ERRORS.series;
  else text(errors, 'series', n.series, LORE_LIMITS.series);
  if (n.reason === 'outro' && !clean(n.reason_text)) errors.reason_text = LORE_FIELD_ERRORS.reasonText;
  else text(errors, 'reason_text', n.reason_text, LORE_LIMITS.reason_text);
  if (!(n.mode in NAME_MODES)) errors.mode = LORE_FIELD_ERRORS.mode;
  return result(errors);
}

/** Personagem em uso (#/lore/personagens). Nome e sobrenome; ID da Cidade só números (Decisão 17). */
export function validateCharacter(c = {}) {
  const errors = {};
  const name = clean(c.character_name);
  if (!name || name.length > LORE_LIMITS.character_name || !name.includes(' ')) errors.character_name = LORE_FIELD_ERRORS.characterName;
  else if (hasEmoji(name)) errors.character_name = NO_EMOJI_MESSAGE;
  text(errors, 'discord_name', clean(c.discord_name), LORE_LIMITS.discord_name, { required: true });
  if (!DISCORD_ID.test(clean(c.discord_id))) errors.discord_id = LORE_FIELD_ERRORS.discordId;
  if (!CITY_ID.test(clean(c.city_id))) errors.city_id = LORE_FIELD_ERRORS.cityId;
  if (!(c.status in CHARACTER_STATUSES)) errors.status = LORE_FIELD_ERRORS.status;
  return result(errors);
}

/** Anotação da administração (só Direção). */
export function validateCharacterNote(n = {}) {
  const errors = {};
  if (!(n.about in NOTE_ABOUT)) errors.about = LORE_FIELD_ERRORS.about;
  text(errors, 'body', n.body, LORE_LIMITS.note, { required: true });
  return result(errors);
}

/** Foto do personagem antes do envio. Devolve a mensagem de erro ou null. */
export function photoError(file) {
  if (!PHOTO_MIMES.includes(file?.type)) return LORE_FIELD_ERRORS.photoType;
  if (!(file.size >= 1 && file.size <= MAX_PHOTO_BYTES)) return LORE_FIELD_ERRORS.photoSize;
  return null;
}

/** Campos do personagem que o cliente define (textos aparados). */
export function pickCharacter(data = {}) {
  const out = {};
  for (const f of ['character_name', 'discord_name', 'discord_id', 'city_id', 'status']) if (f in data) out[f] = clean(data[f]);
  return out;
}

/** Campos que o cliente define em cada cadastro (o resto é do servidor). */
export const QUESTION_FIELDS = Object.freeze(['section', 'kind', 'question', 'answer', 'extra_note', 'position', 'active']);
export const CHECKLIST_FIELDS = Object.freeze(['stage', 'stage_title', 'text', 'hint', 'position', 'active']);
export const BLOCKED_NAME_FIELDS = Object.freeze(['name', 'kind', 'reason', 'series', 'reason_text', 'mode', 'active']);

/** Só os campos indicados: textos aparados, stage/position como número, active como booleano. */
export function pickFields(data = {}, fields = []) {
  const src = data && typeof data === 'object' ? data : {};
  const out = {};
  for (const f of fields) {
    if (!(f in src)) continue;
    if (f === 'active') out[f] = Boolean(src[f]);
    else if (f === 'stage' || f === 'position') out[f] = src[f] === '' || src[f] == null ? NaN : Number(src[f]);
    else if (f === 'name') out[f] = clean(src[f]);
    else out[f] = String(src[f] ?? '').trim();
  }
  return out;
}
