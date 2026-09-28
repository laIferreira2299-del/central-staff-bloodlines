// Validação de procedimento (SPEC 2.3). Função pura; o banco repete as regras com constraints.
import { SLUG_MAX, SLUG_PATTERN } from './slug.js';

/** Lista controlada de categorias (aprovada no inventário, docs/INVENTARIO.md seção 2). */
export const CATEGORIES = Object.freeze([
  'Problemas técnicos',
  'Personagem e aparência',
  'Linhagens',
  'Reembolsos e compras',
  'Contas e acesso',
  'Atendimento e tickets',
  'Comandos da staff',
  'Allowlist e entrevistas',
  'Registros da staff',
]);

export const AUDIENCES = Object.freeze(['suporte', 'moderador', 'ambos', 'allowlist']);
export const STATUSES = Object.freeze(['ativo', 'revisar', 'arquivado']);

export const LIMITS = Object.freeze({
  title: { min: 3, max: 120 },
  summary: { max: 280 },
  whoHandles: { max: 200 },
  tag: { max: 40 },
  tags: { max: 20 },
  steps: { min: 1, max: 50 },
  stepTitle: { max: 120 },
  stepBody: { max: 5000 },
  commands: { max: 50 },
  command: { max: 200 },
  commandDescription: { max: 300 },
  readyMessage: { max: 4000 },
  notes: { max: 5000 },
  sourceUrl: { max: 500 },
});

const LABELS = {
  title: 'Título',
  slug: 'Slug',
  category: 'Categoria',
  audience: 'Público',
  tags: 'Tags',
  summary: 'Resumo',
  who_handles: 'Quem atende',
  steps: 'Passos',
  commands: 'Comandos',
  ready_message: 'Mensagem pronta',
  notes: 'Observações',
  source_url: 'Link da fonte',
  status: 'Status',
};

const isBlank = (v) => typeof v !== 'string' || v.trim() === '';
const len = (v) => (typeof v === 'string' ? v.trim().length : 0);

/**
 * Valida um procedimento.
 * @param {object} p
 * @returns {{ valid: boolean, errors: Record<string, string> }}
 *   `errors` usa o caminho do campo como chave (ex.: "title", "steps.0.title")
 *   e a mensagem em português começa pelo nome do campo.
 */
export function validateProcedure(p) {
  const errors = {};
  const add = (path, label, msg) => { if (!errors[path]) errors[path] = `${label}: ${msg}`; };

  if (!p || typeof p !== 'object') {
    return { valid: false, errors: { _: 'Procedimento inválido.' } };
  }

  // Título
  if (isBlank(p.title)) add('title', LABELS.title, 'obrigatório.');
  else if (len(p.title) < LIMITS.title.min) add('title', LABELS.title, `mínimo de ${LIMITS.title.min} caracteres.`);
  else if (len(p.title) > LIMITS.title.max) add('title', LABELS.title, `máximo de ${LIMITS.title.max} caracteres.`);

  // Slug
  if (isBlank(p.slug)) add('slug', LABELS.slug, 'obrigatório.');
  else if (p.slug.length > SLUG_MAX) add('slug', LABELS.slug, `máximo de ${SLUG_MAX} caracteres.`);
  else if (!SLUG_PATTERN.test(p.slug)) add('slug', LABELS.slug, 'use só letras minúsculas sem acento, números e hífens.');

  // Categoria, público e status
  if (isBlank(p.category)) add('category', LABELS.category, 'obrigatória.');
  else if (!CATEGORIES.includes(p.category)) add('category', LABELS.category, 'escolha uma categoria da lista.');

  if (isBlank(p.audience)) add('audience', LABELS.audience, 'obrigatório.');
  else if (!AUDIENCES.includes(p.audience)) add('audience', LABELS.audience, 'use suporte, moderador, ambos ou allowlist.');

  if (isBlank(p.status)) add('status', LABELS.status, 'obrigatório.');
  else if (!STATUSES.includes(p.status)) add('status', LABELS.status, 'use ativo, revisar ou arquivado.');

  // Tags (opcional)
  if (p.tags != null) {
    if (!Array.isArray(p.tags)) add('tags', LABELS.tags, 'formato inválido.');
    else {
      if (p.tags.length > LIMITS.tags.max) add('tags', LABELS.tags, `máximo de ${LIMITS.tags.max} tags.`);
      const seen = new Set();
      p.tags.forEach((tag, i) => {
        const label = `${LABELS.tags} (${i + 1}ª)`;
        if (isBlank(tag)) add(`tags.${i}`, label, 'não pode ficar vazia.');
        else if (len(tag) > LIMITS.tag.max) add(`tags.${i}`, label, `máximo de ${LIMITS.tag.max} caracteres.`);
        else {
          const key = tag.trim().toLowerCase();
          if (seen.has(key)) add(`tags.${i}`, label, 'repetida.');
          seen.add(key);
        }
      });
    }
  }

  // Resumo
  if (isBlank(p.summary)) add('summary', LABELS.summary, 'obrigatório.');
  else if (len(p.summary) > LIMITS.summary.max) add('summary', LABELS.summary, `máximo de ${LIMITS.summary.max} caracteres.`);

  // Quem atende (opcional)
  if (p.who_handles != null && typeof p.who_handles !== 'string') add('who_handles', LABELS.who_handles, 'formato inválido.');
  else if (len(p.who_handles) > LIMITS.whoHandles.max) add('who_handles', LABELS.who_handles, `máximo de ${LIMITS.whoHandles.max} caracteres.`);

  // Passos (obrigatório, >= 1)
  if (!Array.isArray(p.steps) || p.steps.length < LIMITS.steps.min) {
    add('steps', LABELS.steps, 'inclua pelo menos 1 passo.');
  } else {
    if (p.steps.length > LIMITS.steps.max) add('steps', LABELS.steps, `máximo de ${LIMITS.steps.max} passos.`);
    p.steps.forEach((step, i) => {
      const label = `Passo ${i + 1}`;
      if (!step || typeof step !== 'object') { add(`steps.${i}`, label, 'formato inválido.'); return; }
      if (isBlank(step.title)) add(`steps.${i}.title`, `${label}, título`, 'obrigatório.');
      else if (len(step.title) > LIMITS.stepTitle.max) add(`steps.${i}.title`, `${label}, título`, `máximo de ${LIMITS.stepTitle.max} caracteres.`);
      if (step.body != null && typeof step.body !== 'string') add(`steps.${i}.body`, `${label}, texto`, 'formato inválido.');
      else if (len(step.body) > LIMITS.stepBody.max) add(`steps.${i}.body`, `${label}, texto`, `máximo de ${LIMITS.stepBody.max} caracteres.`);
    });
  }

  // Comandos (opcional)
  if (p.commands != null) {
    if (!Array.isArray(p.commands)) add('commands', LABELS.commands, 'formato inválido.');
    else {
      if (p.commands.length > LIMITS.commands.max) add('commands', LABELS.commands, `máximo de ${LIMITS.commands.max} comandos.`);
      p.commands.forEach((cmd, i) => {
        const label = `Comando ${i + 1}`;
        if (!cmd || typeof cmd !== 'object') { add(`commands.${i}`, label, 'formato inválido.'); return; }
        if (isBlank(cmd.command)) add(`commands.${i}.command`, label, 'obrigatório.');
        else if (len(cmd.command) > LIMITS.command.max) add(`commands.${i}.command`, label, `máximo de ${LIMITS.command.max} caracteres.`);
        if (cmd.description != null && typeof cmd.description !== 'string') add(`commands.${i}.description`, `${label}, descrição`, 'formato inválido.');
        else if (len(cmd.description) > LIMITS.commandDescription.max) add(`commands.${i}.description`, `${label}, descrição`, `máximo de ${LIMITS.commandDescription.max} caracteres.`);
      });
    }
  }

  // Textos longos opcionais
  for (const [field, limit] of [['ready_message', LIMITS.readyMessage.max], ['notes', LIMITS.notes.max]]) {
    if (p[field] != null && typeof p[field] !== 'string') add(field, LABELS[field], 'formato inválido.');
    else if (len(p[field]) > limit) add(field, LABELS[field], `máximo de ${limit} caracteres.`);
  }

  // Link da fonte (opcional, só https)
  if (p.source_url != null && p.source_url !== '') {
    if (typeof p.source_url !== 'string') add('source_url', LABELS.source_url, 'formato inválido.');
    else if (p.source_url.length > LIMITS.sourceUrl.max) add('source_url', LABELS.source_url, `máximo de ${LIMITS.sourceUrl.max} caracteres.`);
    else if (!isHttpsUrl(p.source_url)) add('source_url', LABELS.source_url, 'use um endereço completo começando com https://.');
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/** Papéis da staff (staff_members.role). */
export const STAFF_ROLES = Object.freeze(['suporte', 'moderador', 'admin']);
export const DISCORD_ID_PATTERN = /^[0-9]{17,20}$/;
export const STAFF_NAME_MAX = 80;

/**
 * Valida um membro da staff (mesmas regras dos CHECKs de staff_members).
 * @param {{ discord_id?: any, display_name?: any, role?: any, active?: any }} m
 * @returns {{ valid: boolean, errors: Record<string, string> }}
 */
export function validateStaffMember(m) {
  const errors = {};
  if (!m || typeof m !== 'object') return { valid: false, errors: { _: 'Membro inválido.' } };
  if (typeof m.discord_id !== 'string' || !DISCORD_ID_PATTERN.test(m.discord_id)) {
    errors.discord_id = 'Discord ID: use só números (17 a 20 dígitos). No Discord: Modo Desenvolvedor, clique no perfil, Copiar ID.';
  }
  if (isBlank(m.display_name)) errors.display_name = 'Nome: obrigatório.';
  else if (len(m.display_name) > STAFF_NAME_MAX) errors.display_name = `Nome: máximo de ${STAFF_NAME_MAX} caracteres.`;
  if (!STAFF_ROLES.includes(m.role)) errors.role = 'Cargo: use suporte, moderador ou admin.';
  if (typeof m.active !== 'boolean') errors.active = 'Situação: escolha ativo ou inativo.';
  return { valid: Object.keys(errors).length === 0, errors };
}

/** true só para URLs absolutas https:// com host (ex.: https://discord.com/channels/...). */
export function isHttpsUrl(value) {
  if (typeof value !== 'string' || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password;
  } catch {
    return false;
  }
}
