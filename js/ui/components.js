import { h, highlighted, icon, toast } from './dom.js';
import { copyText } from './clipboard.js';
import { highlightRanges } from '../core/search.js';

export const AUDIENCES = {
  suporte: { label: 'Suporte' },
  moderador: { label: 'Moderação' },
  ambos: { label: 'Suporte + Moderação' },
  allowlist: { label: 'Allowlist' },
};

export const ROLES = { suporte: 'Suporte', moderador: 'Moderador', admin: 'Admin' };
export const STATUS_LABELS = { ativo: 'Ativo', revisar: 'Revisar', arquivado: 'Arquivado' };

const REVIEW_MAX_DAYS = 90;
const DAY_MS = 86_400_000;

/** Selo "Revisar": status 'revisar' ou última revisão há mais de 90 dias (SPEC 2.10). */
export function needsReview(proc, now = Date.now()) {
  if (proc.status === 'revisar') return true;
  if (!proc.last_reviewed_at) return false;
  return now - new Date(proc.last_reviewed_at).getTime() > REVIEW_MAX_DAYS * DAY_MS;
}

export function formatDate(iso, { time = false } = {}) {
  if (!iso) return null;
  const opts = { day: '2-digit', month: 'short', year: 'numeric' };
  if (time) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return new Date(iso).toLocaleString('pt-BR', opts);
}

export function audienceBadge(audience) {
  const dot = (color) => h('span', { class: color ? `badge-dot badge-dot--${color}` : 'badge-dot', 'aria-hidden': 'true' });
  const dots = audience === 'ambos' ? h('span', { class: 'badge-dots' }, dot('blue'), dot('pink')) : dot();
  const known = AUDIENCES[audience];
  return h('span', { class: `badge badge--${known ? audience : 'allowlist'}`, title: 'Público' },
    dots, known?.label ?? 'Público não definido');
}

export const reviewBadge = () => h('span', { class: 'badge badge--revisar' }, '⚠ Revisar');
export const archivedBadge = () => h('span', { class: 'badge badge--status' }, 'Arquivado');

/**
 * Botão de favorito (estado controlado por quem chama).
 * `data-focus-key` permite devolver o foco ao mesmo botão depois de re-renderizar.
 */
export function starButton(proc, isFav, onToggle, { section = 'page' } = {}) {
  return h('button', {
    type: 'button',
    class: 'star',
    'aria-pressed': String(isFav),
    'aria-label': isFav ? `Remover "${proc.title}" dos favoritos` : `Favoritar "${proc.title}"`,
    title: isFav ? 'Remover dos favoritos' : 'Favoritar',
    'data-focus-key': `star:${section}:${proc.id}`,
    onclick: () => onToggle?.(proc),
  }, h('span', { 'aria-hidden': 'true' }, isFav ? '★' : '☆'));
}

/** Botão Copiar com feedback "Copiado!" por 2 s (SPEC 2.10). */
export function copyButton(getText, { label = 'Copiar', ariaLabel, size = 'sm' } = {}) {
  const ico = icon('copy');
  const text = h('span', {}, label);
  const btn = h('button', { type: 'button', class: `btn btn--${size}`, 'aria-label': ariaLabel ?? label }, ico, text);
  let timer;
  btn.addEventListener('click', async () => {
    const ok = await copyText(getText());
    clearTimeout(timer);
    btn.classList.toggle('is-copied', ok);
    ico.className = ok ? 'ti ti-check' : 'ti ti-copy';
    text.textContent = ok ? 'Copiado!' : 'Não foi possível copiar';
    if (ok) toast('Copiado!', 2000);
    timer = setTimeout(() => {
      btn.classList.remove('is-copied');
      ico.className = 'ti ti-copy';
      text.textContent = label;
    }, 2000);
  });
  return btn;
}

/**
 * Card de procedimento.
 * @param {object} proc
 * @param {{ isFav: boolean, onToggleFav: Function, section: string, query?: string }} opts
 */
export function procedureCard(proc, { isFav, onToggleFav, section, query = '' }) {
  const hl = (text) => (query ? highlighted(text, highlightRanges(text, query)) : text);
  return h('article', { class: 'card', 'data-focus-host': '', 'data-slug': proc.slug },
    h('div', { class: 'card-top' },
      h('div', { class: 'card-badges' },
        audienceBadge(proc.audience),
        proc.status === 'arquivado' ? archivedBadge() : needsReview(proc) && reviewBadge()),
      starButton(proc, isFav, onToggleFav, { section })),
    h('h3', { class: 'card-title' },
      h('a', { class: 'card-link', href: `#/p/${proc.slug}` }, hl(proc.title))),
    h('p', { class: 'card-summary' }, hl(proc.summary ?? '')),
    h('div', { class: 'card-foot' }, icon('folder'), proc.category));
}
