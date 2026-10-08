// Perfil da staff (plano 09): funções puras. A tela, o mock e o banco (20_perfil.sql) usam as mesmas regras.
// Mensagens das travas IGUAIS às do SQL (tests/db/banco.test.mjs confere).
import { NO_EMOJI_MESSAGE, hasEmoji } from './workflow.js';

export const PROFILE_LIMITS = Object.freeze({ bio: 180 });
export const DEFAULT_BANNER = '#8b0000';

/** Cores prontas do banner (a pessoa também pode digitar um hex). */
export const BANNER_PALETTE = Object.freeze([
  '#8b0000', '#c0392b', '#e67e22', '#2980b9', '#27ae60', '#8e44ad', '#7f8c8d', '#1a1a1a',
]);

export const PROFILE_ERRORS = Object.freeze({
  bioMax: `Até ${PROFILE_LIMITS.bio} caracteres.`,
  banner: 'Use uma cor no formato #rrggbb.',
  notFound: 'Perfil não encontrado.',
  private: 'Este perfil é privado: só a própria pessoa e a gestão podem ver.',
  avatar: 'Endereço de avatar inválido.',
});

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** Só imagens do CDN do Discord (mesma regra do CHECK do banco). */
export const AVATAR_URL = /^https:\/\/cdn\.discordapp\.com\/[^\s]+$/;

export const safeBanner = (c) => (HEX_COLOR.test(String(c ?? '')) ? c : DEFAULT_BANNER);
export const safeAvatar = (u) => (AVATAR_URL.test(String(u ?? '')) && String(u).length <= 300 ? u : null);

/**
 * Valida o que a pessoa pode mudar no próprio perfil. Campos ausentes não mudam.
 * @returns {{ valid: boolean, errors: Record<string, string> }}
 */
export function validateProfileEdit(data = {}) {
  const errors = {};
  if ('bio' in data && data.bio != null) {
    const bio = String(data.bio).trim();
    if (bio.length > PROFILE_LIMITS.bio) errors.bio = PROFILE_ERRORS.bioMax;
    else if (hasEmoji(bio)) errors.bio = NO_EMOJI_MESSAGE;
  }
  if ('banner_color' in data && data.banner_color != null && !HEX_COLOR.test(String(data.banner_color))) {
    errors.banner_color = PROFILE_ERRORS.banner;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Só os campos editáveis, aparados. */
export function pickProfileEdit(data = {}) {
  const src = data && typeof data === 'object' ? data : {};
  const out = {};
  if ('bio' in src) out.bio = String(src.bio ?? '').trim();
  if ('banner_color' in src) out.banner_color = String(src.banner_color ?? '').trim().toLowerCase();
  if ('perfil_publico' in src) out.perfil_publico = Boolean(src.perfil_publico);
  return out;
}

/** Iniciais para o avatar quando não há foto (até 2 letras). */
export const initialsOf = (name) => String(name ?? '').split(/\s+/).filter(Boolean).map((w) => [...w][0]).slice(0, 2).join('').toUpperCase() || '?';

export const MEETING_KIND_LABELS = Object.freeze({ criada: 'Criou', convocado: 'Convocado' });

/** Quem pode ver este perfil (a mesma conta do banco): público, o próprio dono ou a gestão. */
export const canSeeProfile = ({ publico, self, manager }) => Boolean(publico || self || manager);
