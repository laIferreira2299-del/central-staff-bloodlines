// Normalização de texto para busca e slugs. Funções puras, sem DOM nem rede.

const MARKS = /\p{M}+/gu;
const NOT_WORD = /[^\p{L}\p{N}]+/gu;

/**
 * Remove acentos, passa para minúsculas, troca tudo que não é letra/número por espaço
 * (inclui emojis, pontuação e "/") e colapsa espaços.
 * @example normalizeText('  Mudança de GÊNERO ') === 'mudanca de genero'
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeText(value) {
  if (value == null) return '';
  return String(value)
    .normalize('NFD')
    .replace(MARKS, '')
    .toLowerCase()
    .replace(NOT_WORD, ' ')
    .trim();
}

/**
 * Quebra o texto normalizado em palavras.
 * @param {unknown} value
 * @returns {string[]}
 */
export function tokenize(value) {
  const text = normalizeText(value);
  return text ? text.split(' ') : [];
}

/**
 * Normaliza um único caractere (pode resultar em '' ou em mais de um caractere, ex.: 'ß' → 'ss').
 * Usado para mapear posições do texto normalizado de volta ao original (destaque da busca).
 * @param {string} ch
 */
export function normalizeChar(ch) {
  return ch.normalize('NFD').replace(MARKS, '').toLowerCase();
}
