// Busca de procedimentos: indexação, filtros, ranqueamento e destaque. Funções puras.
import { normalizeChar, normalizeText, tokenize } from './normalize.js';

/** Peso de cada grupo de campos no ranqueamento (SPEC 2.4: título > tags > resumo > resto). */
export const WEIGHTS = Object.freeze({ title: 1000, tags: 100, summary: 10, rest: 1 });
/** Bônus quando a palavra do título começa com o termo (ex.: "reemb" em "Reembolso"). */
const PREFIX_BONUS = 500;

/**
 * Pré-calcula o texto normalizado de cada procedimento. Refaça o índice quando a lista mudar.
 * @param {Array<object>} procedures
 * @returns {Array<{ proc: object, title: string, titleWords: string[], tags: string, summary: string, rest: string }>}
 */
export function buildIndex(procedures) {
  return procedures.map((proc) => {
    const title = normalizeText(proc.title);
    const rest = [
      proc.category,
      ...(proc.steps ?? []).flatMap((s) => [s?.title, s?.body]),
      ...(proc.commands ?? []).flatMap((c) => [c?.command, c?.description]),
      proc.ready_message,
    ].map(normalizeText).filter(Boolean).join(' ');

    return {
      proc,
      title,
      titleWords: title.split(' '),
      tags: (proc.tags ?? []).map(normalizeText).join(' '),
      summary: normalizeText(proc.summary),
      rest,
    };
  });
}

/**
 * Filtro de público: "suporte" e "moderador" incluem os procedimentos de "ambos".
 * @param {string} procAudience
 * @param {string} [filter]
 */
export function matchesAudience(procAudience, filter) {
  if (!filter) return true;
  if (procAudience === filter) return true;
  return procAudience === 'ambos' && (filter === 'suporte' || filter === 'moderador');
}

function passesFilters(proc, { category, audience, status, favoritesOnly, favorites, includeArchived }) {
  if (category && proc.category !== category) return false;
  if (!matchesAudience(proc.audience, audience)) return false;
  if (status) {
    if (proc.status !== status) return false;
  } else if (!includeArchived && proc.status === 'arquivado') {
    return false;
  }
  if (favoritesOnly && !favorites?.has(proc.slug)) return false;
  return true;
}

/** Pontua uma palavra da busca; 0 = não encontrada em nenhum campo. */
function scoreToken(entry, token) {
  let score = 0;
  if (entry.title.includes(token)) {
    score += WEIGHTS.title;
    if (entry.titleWords.some((w) => w.startsWith(token))) score += PREFIX_BONUS;
  }
  if (entry.tags.includes(token)) score += WEIGHTS.tags;
  if (entry.summary.includes(token)) score += WEIGHTS.summary;
  if (entry.rest.includes(token)) score += WEIGHTS.rest;
  return score;
}

const byTitle = (a, b) => a.proc.title.localeCompare(b.proc.title, 'pt-BR');

/**
 * Busca com lógica AND: todas as palavras precisam aparecer (em qualquer campo).
 * Sem termo, devolve todos os que passam nos filtros, em ordem alfabética.
 *
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} query
 * @param {{
 *   category?: string, audience?: string, status?: string,
 *   favoritesOnly?: boolean, favorites?: Set<string>, includeArchived?: boolean
 * }} [filters] sem `status`, os arquivados ficam de fora (a menos que `includeArchived`)
 * @returns {Array<{ proc: object, score: number }>}
 */
export function search(index, query, filters = {}) {
  const tokens = [...new Set(tokenize(query))];
  const results = [];

  for (const entry of index) {
    if (!passesFilters(entry.proc, filters)) continue;
    let score = 0;
    let all = true;
    for (const token of tokens) {
      const s = scoreToken(entry, token);
      if (s === 0) { all = false; break; }
      score += s;
    }
    if (all) results.push({ entry, score });
  }

  results.sort((a, b) => b.score - a.score || byTitle(a.entry, b.entry));
  return results.map(({ entry, score }) => ({ proc: entry.proc, score }));
}

/**
 * Trechos do texto ORIGINAL que correspondem às palavras da busca, ignorando acentos e
 * maiúsculas. A interface usa as faixas para montar <mark> com textContent (sem innerHTML).
 * @param {string} text
 * @param {string} query
 * @returns {Array<{ start: number, end: number }>} faixas ordenadas e sem sobreposição
 */
export function highlightRanges(text, query) {
  const tokens = [...new Set(tokenize(query))];
  if (!text || tokens.length === 0) return [];

  // Texto normalizado caractere a caractere + mapa de cada posição para o índice original.
  let normalized = '';
  const map = [];
  const chars = Array.from(text);
  let offset = 0;
  for (const ch of chars) {
    const n = normalizeChar(ch);
    for (let i = 0; i < n.length; i++) map.push({ start: offset, end: offset + ch.length });
    normalized += n;
    offset += ch.length;
  }

  const ranges = [];
  for (const token of tokens) {
    let from = 0;
    while (from <= normalized.length - token.length) {
      const at = normalized.indexOf(token, from);
      if (at === -1) break;
      ranges.push({ start: map[at].start, end: map[at + token.length - 1].end });
      from = at + token.length;
    }
  }

  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}
