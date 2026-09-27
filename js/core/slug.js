import { normalizeText } from './normalize.js';

export const SLUG_MAX = 80;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Gera o slug de URL a partir do título: sem acentos, minúsculo, palavras separadas por "-",
 * só [a-z0-9-], até 80 caracteres (corta na palavra inteira).
 * @example slugify('Mudança de Gênero') === 'mudanca-de-genero'
 * @param {string} title
 * @returns {string} '' quando o título não tem letras nem números
 */
export function slugify(title) {
  const words = normalizeText(title)
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]/g, '')
    .split(' ')
    .filter(Boolean);

  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > SLUG_MAX) break;
    slug = next;
  }
  // Uma única palavra maior que o limite é cortada.
  if (!slug && words.length) slug = words[0].slice(0, SLUG_MAX);
  return slug;
}

/**
 * Slug único: se já existir, acrescenta -2, -3, ...
 * @param {string} title
 * @param {Iterable<string>} existing slugs já usados
 * @param {string} [fallback] usado quando o título não gera slug
 */
export function uniqueSlug(title, existing, fallback = 'procedimento') {
  const taken = new Set(existing);
  const base = slugify(title) || fallback;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, SLUG_MAX - suffix.length).replace(/-$/, '') + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}
