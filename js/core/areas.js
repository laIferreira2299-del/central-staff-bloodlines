// Áreas e equipes da Staff (plano 07): funções puras. A tela, o mock e o banco (19_areas.sql) usam as mesmas regras.
// Mensagens das travas IGUAIS às do SQL (tests/db/banco.test.mjs confere).
import { NO_EMOJI_MESSAGE, hasEmoji } from './workflow.js';
import { normalizeName } from './allowlist.js';
import { slugify } from './slug.js';

export const AREA_LIMITS = Object.freeze({ title: 150, content: 20000, name: 80, description: 300 });

/** Slugs que já são rotas de #/areas/<slug>. */
export const RESERVED_AREA_SLUGS = Object.freeze(['gerenciar']);

export const AREA_PROCEDURE_STATUSES = Object.freeze(['rascunho', 'publicado', 'arquivado']);
export const AREA_PROCEDURE_STATUS_LABELS = Object.freeze({ rascunho: 'Rascunho', publicado: 'Publicado', arquivado: 'Arquivado' });
export const AREA_ROLES = Object.freeze(['membro', 'lider']);
export const AREA_ROLE_LABELS = Object.freeze({ membro: 'Membro', lider: 'Líder' });

/** Campos que o cliente pode definir num procedimento de área (o resto é do servidor). */
export const AREA_PROCEDURE_FIELDS = Object.freeze(['titulo', 'conteudo', 'status', 'tags']);

/** Mensagens das travas. IGUAIS às de supabase/19_areas.sql. */
export const AREA_ERRORS = Object.freeze({
  notEligible: 'Seu cargo não tem nível para entrar nesta área.',
  archivedArea: 'Esta área está arquivada: só leitura.',
  archiveRestricted: 'Só o líder da área ou a gestão arquiva procedimentos.',
  foreignTag: 'Tag de outra área.',
  notFound: 'Área não encontrada ou sem acesso.',
});

export const AREA_FIELD_ERRORS = Object.freeze({
  required: 'Campo obrigatório.',
  max: (n) => `Até ${n} caracteres.`,
  status: 'Situação inválida.',
});

const clean = (v) => String(v ?? '').trim();

function text(errors, field, value, max, { required = false } = {}) {
  if (required && !value) errors[field] = AREA_FIELD_ERRORS.required;
  else if (value.length > max) errors[field] = AREA_FIELD_ERRORS.max(max);
  else if (hasEmoji(value)) errors[field] = NO_EMOJI_MESSAGE;
}

/** @returns {{ valid: boolean, errors: Record<string, string> }} */
export function validateAreaProcedure(p = {}) {
  const errors = {};
  text(errors, 'titulo', clean(p.titulo), AREA_LIMITS.title, { required: true });
  text(errors, 'conteudo', String(p.conteudo ?? ''), AREA_LIMITS.content);
  if (!AREA_PROCEDURE_STATUSES.includes(p.status)) errors.status = AREA_FIELD_ERRORS.status;
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Só os campos editáveis, com texto aparado. */
export function pickAreaProcedure(data = {}) {
  const src = data && typeof data === 'object' ? data : {};
  const out = {};
  for (const f of AREA_PROCEDURE_FIELDS) {
    if (!(f in src)) continue;
    if (f === 'titulo' || f === 'status') out[f] = clean(src[f]);
    else if (f === 'tags') out[f] = Array.isArray(src[f]) ? [...new Set(src[f].map(String))] : [];
    else out[f] = String(src[f] ?? '');
  }
  return out;
}

/** Quem pode o quê dentro da área. `papel` = null para quem só vê por ser gestor. */
export function areaProcedureAccess({ papel = null, manager = false, areaActive = true, authorId = null, myId = null }) {
  const leader = papel === 'lider';
  const member = papel !== null;
  const privileged = leader || manager;
  return {
    create: areaActive && (member || manager),
    edit: areaActive && (privileged || (member && authorId !== null && authorId === myId)),
    archive: areaActive && privileged,
    remove: areaActive && privileged,
    seeControl: privileged,
    seeHistory: privileged,
  };
}

/** Nível mínimo da área em texto: "Suporte ou acima". */
export function levelLabel(level, roles) {
  const r = roles.find((x) => x.level === level);
  return r ? (level > 1 ? `${r.label} ou acima` : 'Todos os cargos') : `Nível ${level}`;
}

/** Busca sem acento nem maiúscula (título e conteúdo), com filtro de tag e de situação. */
export function filterAreaProcedures(list, { query = '', tag = '', status = '' } = {}) {
  const q = normalizeName(query);
  return list.filter((p) => {
    if (status && p.status !== status) return false;
    if (tag && !(p.tags ?? []).includes(tag)) return false;
    return !q || normalizeName(`${p.titulo} ${p.conteudo}`).includes(q);
  });
}

/** Ordem da lista: atualizados por último primeiro. */
export const sortAreaProcedures = (list) => [...list].sort((a, b) => String(b.atualizado_em).localeCompare(String(a.atualizado_em)));

/** Contadores da aba Controle. */
export function areaControlStats(procedures, team) {
  const by = { rascunho: 0, publicado: 0, arquivado: 0 };
  for (const p of procedures) by[p.status] += 1;
  const recent = sortAreaProcedures(procedures).slice(0, 5);
  return { ...by, total: procedures.length, members: team.length, leaders: team.filter((m) => m.papel === 'lider').length, recent,
    drafts: sortAreaProcedures(procedures.filter((p) => p.status === 'rascunho')) };
}

/* ------------------------------------------------------------------ Painel de gestão (Fase 3) */

export const AREA_STATUSES = Object.freeze(['ativa', 'arquivada']);
export const AREA_STATUS_LABELS = Object.freeze({ ativa: 'Ativa', arquivada: 'Arquivada' });
export const AREA_TAG_LIMITS = Object.freeze({ name: 40 });
export const DEFAULT_AREA_COLOR = '#8b0000';
export const DEFAULT_TAG_COLOR = '#555555';
/** Mesmos padrões dos CHECKs do 19_areas.sql. */
export const AREA_COLOR = /^#[0-9a-fA-F]{6}$/;
export const AREA_ICON = /^[a-z0-9-]{1,40}$/;
export const AREA_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const AREA_SLUG_MAX = 60;
export const AREA_DISCORD_ID = /^[0-9]{17,20}$/;

/** Mensagens só do site (o banco recusa as mesmas coisas pelos CHECKs, com texto próprio). */
export const AREA_MANAGE_ERRORS = Object.freeze({
  slug: 'Endereço: só letras minúsculas, números e hifens (até 60).',
  slugReserved: 'Este endereço é reservado.',
  slugTaken: 'Já existe uma área com este endereço.',
  tagTaken: 'Já existe uma tag com este nome nesta área.',
  color: 'Cor: use o formato #RRGGBB.',
  icon: 'Ícone: só letras minúsculas, números e hifens.',
  level: 'Escolha um cargo para o nível mínimo.',
  order: 'Ordem: número inteiro.',
  discordId: 'ID do Discord: só números, de 17 a 20 dígitos.',
  role: 'Papel inválido.',
  member: 'Escolha uma pessoa da staff.',
  alreadyMember: 'Esta pessoa já está nesta área.',
  confirmName: 'Digite o nome da área exatamente como está para confirmar.',
});

/** Campos que o cliente pode definir numa área. */
export const AREA_FIELDS = Object.freeze(['nome', 'slug', 'descricao', 'icone', 'cor', 'nivel_minimo', 'status', 'discord_role_id', 'discord_canal_id', 'ordem']);
export const AREA_TAG_FIELDS = Object.freeze(['nome', 'cor', 'discord_role_id']);

/** Endereço da área a partir do nome, sem repetir os já usados nem os reservados. */
export function areaSlug(nome, existing = []) {
  const taken = new Set([...existing, ...RESERVED_AREA_SLUGS]);
  const base = slugify(nome).slice(0, AREA_SLUG_MAX).replace(/-+$/, '') || 'area';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, AREA_SLUG_MAX - suffix.length).replace(/-+$/, '') + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

const optionalId = (errors, field, value) => {
  if (value && !AREA_DISCORD_ID.test(value)) errors[field] = AREA_MANAGE_ERRORS.discordId;
};

/** @returns {{ valid: boolean, errors: Record<string, string> }} */
export function validateArea(a = {}) {
  const errors = {};
  text(errors, 'nome', clean(a.nome), AREA_LIMITS.name, { required: true });
  text(errors, 'descricao', clean(a.descricao), AREA_LIMITS.description);
  const slug = clean(a.slug);
  if (!slug || slug.length > AREA_SLUG_MAX || !AREA_SLUG.test(slug)) errors.slug = AREA_MANAGE_ERRORS.slug;
  else if (RESERVED_AREA_SLUGS.includes(slug)) errors.slug = AREA_MANAGE_ERRORS.slugReserved;
  if (clean(a.icone) && !AREA_ICON.test(clean(a.icone))) errors.icone = AREA_MANAGE_ERRORS.icon;
  if (!AREA_COLOR.test(clean(a.cor))) errors.cor = AREA_MANAGE_ERRORS.color;
  if (!Number.isInteger(a.nivel_minimo) || a.nivel_minimo < 1 || a.nivel_minimo > 8) errors.nivel_minimo = AREA_MANAGE_ERRORS.level;
  if (!AREA_STATUSES.includes(a.status)) errors.status = AREA_FIELD_ERRORS.status;
  if (!Number.isInteger(a.ordem)) errors.ordem = AREA_MANAGE_ERRORS.order;
  optionalId(errors, 'discord_role_id', clean(a.discord_role_id));
  optionalId(errors, 'discord_canal_id', clean(a.discord_canal_id));
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Só os campos editáveis, com texto aparado e números de verdade. */
export function pickArea(data = {}) {
  const src = data && typeof data === 'object' ? data : {};
  const out = {};
  for (const f of AREA_FIELDS) {
    if (!(f in src)) continue;
    if (f === 'nivel_minimo' || f === 'ordem') out[f] = src[f] === '' || src[f] == null ? NaN : Number(src[f]);
    else if (f === 'descricao' || f === 'icone' || f === 'discord_role_id' || f === 'discord_canal_id') out[f] = clean(src[f]) || null;
    else out[f] = clean(src[f]);
  }
  return out;
}

export function validateAreaTag(t = {}) {
  const errors = {};
  text(errors, 'nome', clean(t.nome), AREA_TAG_LIMITS.name, { required: true });
  if (!AREA_COLOR.test(clean(t.cor))) errors.cor = AREA_MANAGE_ERRORS.color;
  optionalId(errors, 'discord_role_id', clean(t.discord_role_id));
  return { valid: Object.keys(errors).length === 0, errors };
}

export function pickAreaTag(data = {}) {
  const src = data && typeof data === 'object' ? data : {};
  const out = {};
  for (const f of AREA_TAG_FIELDS) {
    if (!(f in src)) continue;
    out[f] = f === 'discord_role_id' ? clean(src[f]) || null : clean(src[f]);
  }
  return out;
}

/** Nome do cargo (nivel_minimo) para o select do formulário. */
export const levelOptions = (roles) => roles.map((r) => ({ value: r.level, label: r.level > 1 ? `${r.label} ou acima` : `${r.label} (todos os cargos)` }));

/** Nova ordem depois de mover uma área uma posição (-1 sobe, +1 desce). Devolve os ids na ordem final, ou null se não mexe. */
export function moveInOrder(ids, id, direction) {
  const from = ids.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const out = [...ids];
  [out[from], out[to]] = [out[to], out[from]];
  return out;
}

/** Apagar exige digitar o nome (sem diferenciar maiúsculas nem acentos, como a busca). */
export const confirmsAreaName = (area, typed) => normalizeName(typed) !== '' && normalizeName(typed) === normalizeName(area?.nome);

/** Filtros do histórico global (os mesmos no mock e no banco). Período: datas AAAA-MM-DD; `to` inclusivo. */
export function historyRange({ from = '', to = '' } = {}) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const start = day.test(from) ? `${from}T00:00:00-03:00` : null;
  const end = day.test(to) ? new Date(new Date(`${to}T00:00:00-03:00`).getTime() + 86_400_000).toISOString() : null;
  return { start: start && new Date(start).toISOString(), end };
}

/** Rótulos do histórico. */
export const AREA_ACTION_LABELS = Object.freeze({
  insert: 'Criou', update: 'Alterou', delete: 'Apagou',
  enviou_canal: 'Enviou mensagem no canal', enviou_dm: 'Enviou mensagem privada', alinhamento: 'Chamou para alinhamento',
});
export const AREA_ENTITY_LABELS = Object.freeze({
  areas: 'Área', areas_membros: 'Membro', areas_tags: 'Tag', areas_procedimentos: 'Procedimento', comunicacao: 'Mensagem',
});

/** Nome do item de um registro do histórico (procedimento, área, tag...), ou ''. */
export const areaEventName = (e) => e.detalhes?.depois?.titulo ?? e.detalhes?.titulo ?? e.detalhes?.nome ?? e.detalhes?.depois?.nome ?? '';

/** Frase do registro, sem o autor: `criou Procedimento "X"`, `enviou mensagem no canal`. */
export function describeAreaEvent(e) {
  const action = (AREA_ACTION_LABELS[e.acao] ?? e.acao).toLowerCase();
  if (e.entidade === 'comunicacao') return action;
  const name = areaEventName(e);
  return `${action} ${AREA_ENTITY_LABELS[e.entidade] ?? e.entidade}${name ? ` "${name}"` : ''}`;
}
