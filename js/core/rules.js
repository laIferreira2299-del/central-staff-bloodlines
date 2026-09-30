// Livro de Regras (plano 05): funções puras. A tela, o mock e o banco (15_regras.sql) usam as mesmas regras.
// Mensagens das travas IGUAIS às do SQL (tests/db/banco.test.mjs confere).
import { NO_EMOJI_MESSAGE, hasEmoji } from './workflow.js';
import { normalizeName } from './allowlist.js';

export const RULE_LIMITS = Object.freeze({ title: 150, category: 80, content: 20000, order: 9999 });

/** Campos que o cliente pode definir numa regra (o resto é do servidor). */
export const RULE_FIELDS = Object.freeze(['title', 'category', 'content', 'position']);

/** Mensagem da trava de título repetido. IGUAL à de supabase/15_regras.sql. */
export const RULE_ERRORS = Object.freeze({
  duplicate: 'Já existe uma regra com este título nesta categoria.',
});

export const RULE_FIELD_ERRORS = Object.freeze({
  required: 'Campo obrigatório.',
  max: (n) => `Até ${n} caracteres.`,
  position: 'Ordem: número inteiro de 0 a 9999.',
});

const clean = (v) => String(v ?? '').trim();

function text(errors, field, value, max, { required = false } = {}) {
  if (required && !value) errors[field] = RULE_FIELD_ERRORS.required;
  else if (value.length > max) errors[field] = RULE_FIELD_ERRORS.max(max);
  else if (hasEmoji(value)) errors[field] = NO_EMOJI_MESSAGE;
}

/** @returns {{ valid: boolean, errors: Record<string, string> }} */
export function validateRule(r = {}) {
  const errors = {};
  text(errors, 'title', clean(r.title), RULE_LIMITS.title, { required: true });
  text(errors, 'category', clean(r.category), RULE_LIMITS.category, { required: true });
  text(errors, 'content', clean(r.content), RULE_LIMITS.content, { required: true });
  if (!Number.isInteger(r.position) || r.position < 0 || r.position > RULE_LIMITS.order) errors.position = RULE_FIELD_ERRORS.position;
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Só os campos editáveis, com texto aparado. */
export function pickRule(data = {}) {
  const src = data && typeof data === 'object' ? data : {};
  const out = {};
  for (const f of RULE_FIELDS) {
    if (!(f in src)) continue;
    out[f] = f === 'position' ? src[f] : clean(src[f]);
  }
  return out;
}

/** Ordem de exibição: categoria (A a Z), depois a ordem, depois o título. */
export function sortRules(rules) {
  return [...rules].sort((a, b) => a.category.localeCompare(b.category, 'pt-BR')
    || a.position - b.position || a.title.localeCompare(b.title, 'pt-BR'));
}

/** Categorias na ordem da lista, sem repetir. */
export const categoriesOf = (rules) => [...new Set(sortRules(rules).map((r) => r.category))];

/** Busca sem acento nem maiúscula, por título, categoria e conteúdo; filtro opcional de categoria. */
export function filterRules(rules, { query = '', category = '' } = {}) {
  const q = normalizeName(query);
  return sortRules(rules).filter((r) => (!category || r.category === category)
    && (!q || normalizeName(`${r.title} ${r.category} ${r.content}`).includes(q)));
}

/** Agrupa regras já ordenadas por categoria: [[categoria, regras[]], ...]. */
export function groupByCategory(rules) {
  const map = new Map();
  for (const r of rules) map.set(r.category, [...(map.get(r.category) ?? []), r]);
  return [...map.entries()];
}
