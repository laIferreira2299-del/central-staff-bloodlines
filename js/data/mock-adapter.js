// Implementação em memória do contrato (js/data/adapter.js), com persistência opcional
// em localStorage. SIMULA as regras do banco: cargos e permissões (js/core/permissions.js),
// público visível por cargo, travas da equipe, conflito de versão (2.7), revisões
// automáticas (2.8), arquivamento em vez de exclusão e auditoria pelo "servidor".
// Uso: desenvolvimento local (DATA_MODE = 'mock') e testes.
import {
  EDITABLE_FIELDS, EXPORT_FORMAT, FEATURES, PROCEDURE_DEFAULTS, byStaffName, fail, ok, pickEditable, pickStaffMember,
  AL_DEFAULTS, WEBHOOK_COLUMNS, pickAlAnswers, pickAlEvaluation, pickAlParticipants, pickWebhook,
} from './adapter.js';
import {
  ALLOWLIST_ERRORS, DISCORD_SEND_ERRORS, MAX_PRINTS, normalizeName, printError, sentStatus, validateAlEvaluation,
  validateAlExtras, validateWebhook,
} from '../core/allowlist.js';
import { STATUSES, validateProcedure, validateStaffMember } from '../core/validate.js';
import {
  PROPOSAL_ERRORS, contentChanged, proposalStatus, EVALUATION_ERRORS, evaluationChangeError, validateEvaluation,
  isPeriodOpen, validateAnnouncement, isAnnouncementFor, PROPOSAL_NOTE_MAX,
} from '../core/workflow.js';
import {
  CEO, PERMISSIONS, canReadAudience, defaultGrid, permissionChangesError, permissionsOf, roleLevel, staffChangeError,
} from '../core/permissions.js';

/**
 * Usuários simulados: um por cargo (a chave é o código do cargo), mais um staff inativo e um
 * logado não cadastrado (`role: null`).
 */
export const MOCK_USERS = Object.freeze({
  allowlist: { id: 'mock-u-allowlist', discord_id: '100000000000000005', name: 'Allowlist Teste', role: 'allowlist', active: true },
  lore: { id: 'mock-u-lore', discord_id: '100000000000000006', name: 'Lore Teste', role: 'lore', active: true },
  suporte: { id: 'mock-u-suporte', discord_id: '100000000000000001', name: 'Suporte Teste', role: 'suporte', active: true },
  moderador: { id: 'mock-u-moderador', discord_id: '100000000000000002', name: 'Moderador Teste', role: 'moderador', active: true },
  head_staff: { id: 'mock-u-head', discord_id: '100000000000000007', name: 'Head Staff Teste', role: 'head_staff', active: true },
  admin: { id: 'mock-u-admin', discord_id: '100000000000000003', name: 'Admin Teste', role: 'admin', active: true },
  manager: { id: 'mock-u-manager', discord_id: '100000000000000008', name: 'Manager Teste', role: 'manager', active: true },
  ceo: { id: 'mock-u-ceo', discord_id: '100000000000000010', name: 'CEO Teste', role: 'ceo', active: true },
  inativo: { id: 'mock-u-inativo', discord_id: '100000000000000004', name: 'Ex-staff Teste', role: 'moderador', active: false },
  naostaff: { id: 'mock-u-naostaff', discord_id: '100000000000000009', name: 'Visitante Teste', role: null, active: false },
});

const STATE_VERSION = 3;
/** Os 6 critérios iniciais das avaliações (documento 01, seção 6.2; os mesmos do 08). */
const INITIAL_CRITERIA = Object.freeze([
  'Postura e respeito no atendimento', 'Conhecimento das regras e da lore', 'Comunicação com players e equipe',
  'Atividade e assiduidade', 'Trabalho em equipe', 'Qualidade dos registros (entrevistas, allowlists, tickets)',
]);
const clone = (v) => structuredClone(v);
const byTitle = (a, b) => a.title.localeCompare(b.title, 'pt-BR');
const uuid = () => globalThis.crypto.randomUUID();

function initialState(seed, adminId, nowIso) {
  const staff = Object.values(MOCK_USERS)
    .filter((u) => u.role)
    .map((u) => ({ discord_id: u.discord_id, display_name: u.name, role: u.role, teams: [], active: u.active, created_at: nowIso }));
  const procedures = seed.map((item) => ({
    id: uuid(),
    ...PROCEDURE_DEFAULTS,
    ...pickEditable(item),
    last_reviewed_at: item.last_reviewed_at ?? null,
    last_reviewed_by: item.last_reviewed_at ? adminId : null,
    version: 1,
    created_by: adminId, created_at: nowIso,
    updated_by: adminId, updated_at: nowIso,
  }));
  const criteria = INITIAL_CRITERIA.map((label, i) => ({ id: uuid(), label, sort_order: i + 1, active: true, created_at: nowIso }));
  return {
    v: STATE_VERSION, staff, procedures, revisions: [], favorites: [], grid: defaultGrid(),
    proposals: [], periods: [], criteria, evaluations: [], announcements: [], reads: [], audit: [],
  };
}

/** Etapa 5: dados do módulo de Allowlist (data/allowlist-seed.json), como o 11_allowlist_seed.sql. */
function allowlistState(seed, nowIso) {
  const meta = { active: true, created_by: 'sistema', created_at: nowIso, updated_by: 'sistema', updated_at: nowIso };
  return {
    questions: (seed?.questions ?? []).map((q) => ({ id: uuid(), ...q, extra_note: q.extra_note ?? '', ...meta })),
    checklistItems: (seed?.checklist ?? []).map((c) => ({ id: uuid(), ...c, hint: c.hint ?? '', ...meta })),
    blockedNames: (seed?.blocked_names ?? []).map((n) => ({
      id: uuid(), name: n.name, name_norm: normalizeName(n.name), kind: n.kind, reason: 'serie', series: n.series,
      character_id: null, reason_text: '', mode: n.mode ?? 'bloqueia', ...meta,
    })),
    alEvaluations: [], alParticipants: [], alAnswers: [], alAttachments: [], webhooks: [],
  };
}

/**
 * @param {{
 *   seed?: object[],              procedimentos iniciais (campos editáveis + last_reviewed_at opcional)
 *   user?: keyof MOCK_USERS|null, usuário simulado inicial (padrão: nenhum = deslogado)
 *   storage?: Storage|null,       ex.: window.localStorage; null = só memória
 *   storageKey?: string,
 *   now?: () => Date,             relógio (injetável nos testes)
 *   allowlistSeed?: object,       data/allowlist-seed.json (perguntas, checklist e nomes proibidos)
 * }} [options]
 */
export function createMockAdapter({
  seed = [], user = null, storage = null, storageKey = 'bloodlines-kb:mock', now = () => new Date(), allowlistSeed = null,
} = {}) {
  const nowIso = () => now().toISOString();
  const adminId = MOCK_USERS.admin.discord_id;
  const fresh = () => ({ ...initialState(seed, adminId, nowIso()), ...allowlistState(allowlistSeed, nowIso()) });
  /** Arquivos dos prints: só em memória (o armazenamento guarda só os dados). */
  const printFiles = new Map();

  let state = load() ?? fresh();
  let sessionKey = loadSession() ?? user;
  let offline = false;
  const pendingFailures = new Map();
  const listeners = new Set();
  save();

  /* ---------- persistência ---------- */
  function load() {
    try {
      const raw = storage?.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed?.v !== STATE_VERSION) return null;
      // Estado salvo antes da Etapa 5: ganha os dados da Allowlist sem perder o resto.
      if (!parsed.questions) Object.assign(parsed, allowlistState(allowlistSeed, nowIso()));
      return parsed;
    } catch { return null; }
  }
  function loadSession() {
    try {
      const key = storage?.getItem(`${storageKey}:session`);
      return key && MOCK_USERS[key] ? key : null;
    } catch { return null; }
  }
  function save() {
    try {
      storage?.setItem(storageKey, JSON.stringify(state));
      if (sessionKey) storage?.setItem(`${storageKey}:session`, sessionKey);
      else storage?.removeItem(`${storageKey}:session`);
    } catch { /* armazenamento indisponível: segue só em memória */ }
  }

  /* ---------- identidade e permissões ---------- */
  const currentUser = () => (sessionKey ? MOCK_USERS[sessionKey] : null);
  const sessionOf = (u) => (u ? { user: { id: u.id, discord_id: u.discord_id, name: u.name, avatar_url: null } } : null);
  const staffOf = (u) => (u ? state.staff.find((s) => s.discord_id === u.discord_id && s.active) ?? null : null);
  const nameOf = (discordId) => state.staff.find((s) => s.discord_id === discordId)?.display_name ?? null;
  const permsOf = (staff) => permissionsOf(staff, state.grid);

  function notify() {
    const session = sessionOf(currentUser());
    for (const cb of listeners) { try { cb(clone(session)); } catch { /* ouvinte com erro não derruba os outros */ } }
  }

  /**
   * Executa uma operação respeitando: rede, sessão e permissão.
   * need: 'session' (só exige login) | 'staff' | código de permissão (ex.: 'procedimentos.backup')
   * Para não-staff, `nonStaff` define a resposta (ex.: lista vazia, como a RLS faria).
   * `fn` recebe { user, staff, can(código), sees(procedimento) }.
   */
  async function run(method, need, fn, { nonStaff } = {}) {
    if (offline) return fail('NETWORK');
    const forced = pendingFailures.get(method);
    if (forced) { pendingFailures.delete(method); return fail(forced); }

    // Relê o armazenamento: outra aba pode ter gravado (simula um banco compartilhado).
    state = load() ?? state;

    const u = currentUser();
    if (!u) return fail('UNAUTHORIZED');
    const staff = staffOf(u);
    if (need !== 'session' && !staff) return nonStaff ? nonStaff() : fail('FORBIDDEN');
    const perms = permsOf(staff);
    const can = (code) => perms.includes(code);
    if (need !== 'session' && need !== 'staff' && !can(need)) return fail('FORBIDDEN');
    const sees = (p) => Boolean(p) && canReadAudience(perms, p.audience);
    try {
      return await fn({ user: u, staff, can, sees });
    } catch (err) {
      return fail('NETWORK', `Erro inesperado: ${err?.message ?? err}`);
    }
  }

  /* ---------- procedimentos ---------- */
  function present(p) {
    const out = clone(p);
    out.created_by_name = nameOf(p.created_by);
    out.updated_by_name = nameOf(p.updated_by);
    out.last_reviewed_by_name = p.last_reviewed_by ? nameOf(p.last_reviewed_by) : null;
    return out;
  }
  const editableOf = (p) => Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, clone(p[f])]));
  const presentStaff = (s) => ({
    discord_id: s.discord_id, display_name: s.display_name, role: s.role, teams: [...(s.teams ?? [])],
    active: s.active, created_at: s.created_at ?? null,
  });
  const notFound = () => fail('NOT_FOUND', 'Procedimento não encontrado.');
  const findById = (id) => state.procedures.find((p) => p.id === id);
  const slugTaken = (slug, exceptId) => state.procedures.some((p) => p.slug === slug && p.id !== exceptId);

  function validationError(errors) {
    return fail('VALIDATION', undefined, { errors });
  }

  /** Valida conteúdo e unicidade do slug. Devolve um erro ou null. */
  function check(next, exceptId) {
    const { valid, errors } = validateProcedure(next);
    if (!valid) return validationError(errors);
    if (slugTaken(next.slug, exceptId)) {
      return validationError({ slug: 'Slug: já existe outro procedimento com este endereço.' });
    }
    return null;
  }

  /** Grava uma nova versão (o "trigger": guarda o estado anterior em revisões). */
  function commit(old, changes, staff) {
    if ('status' in changes && (old.status === 'arquivado') !== (changes.status === 'arquivado')) {
      audit(staff, 'procedimento', old.id, changes.status === 'arquivado' ? 'arquivado' : 'restaurado',
        { status: old.status }, { status: changes.status, slug: changes.slug ?? old.slug, title: changes.title ?? old.title });
    }
    state.revisions.push({
      id: uuid(),
      procedure_id: old.id,
      version: old.version,
      snapshot: clone(old),
      changed_by: old.updated_by,
      changed_at: old.updated_at,
    });
    Object.assign(old, clone(changes), {
      version: old.version + 1,
      updated_by: staff.discord_id,
      updated_at: nowIso(),
    });
    save();
    return old;
  }

  const touchesArchive = (from, to) => from === 'arquivado' || to === 'arquivado';
  const staffAudit = (m) => ({ display_name: m.display_name, role: m.role, teams: [...(m.teams ?? [])], active: m.active });

  /** Registro de auditoria (no banco, feito por trigger; aqui, pelo "servidor" simulado). */
  function audit(actor, entity, entityId, action, before, after) {
    state.audit.push({
      id: state.audit.length + 1, at: nowIso(), actor: actor?.discord_id ?? 'sistema',
      entity, entity_id: String(entityId), action, before: before ?? null, after: after ?? null,
    });
  }

  const newestFirst = (a, b) => b.created_at.localeCompare(a.created_at);
  const seesEvaluations = (can) => can('avaliacoes.criar') || can('avaliacoes.ler') || can('avaliacoes.gerenciar');
  const presentProposal = (p) => ({ ...clone(p), created_by_name: nameOf(p.created_by), reviewed_by_name: p.reviewed_by ? nameOf(p.reviewed_by) : null });
  const presentEvaluation = (e) => {
    const { archived_by, archived_at, ...rest } = clone(e);
    return { ...rest, evaluated_name: nameOf(e.evaluated_id), evaluator_name: nameOf(e.evaluator_id) };
  };
  function presentAnnouncement(a, staff) {
    const r = state.reads.find((x) => x.announcement_id === a.id && x.discord_id === staff.discord_id);
    return { ...clone(a), created_by_name: nameOf(a.created_by), my_read_at: r?.read_at ?? null, my_acknowledged_at: r?.acknowledged_at ?? null };
  }

  const presentGrid = () => ({
    permissions: PERMISSIONS.map((p) => ({ code: p.code, description: p.description, ceo_only: p.ceoOnly, default_roles: [...p.roles] })),
    grid: clone(state.grid),
  });
  const otherActiveCeos = (discordId) => state.staff.filter((s) => s.role === CEO && s.active && s.discord_id !== discordId).length;

  const adapter = {
    /* ----- sessão ----- */
    async getSession() {
      return ok(clone(sessionOf(currentUser())));
    },

    /** No mock, `as` escolhe o usuário simulado (padrão: admin). */
    async signIn({ as = 'admin' } = {}) {
      if (offline) return fail('NETWORK');
      if (!MOCK_USERS[as]) return fail('VALIDATION', `Usuário simulado desconhecido: ${as}`);
      sessionKey = as;
      save();
      notify();
      return ok(clone(sessionOf(currentUser())));
    },

    async signOut() {
      sessionKey = null;
      save();
      notify();
      return ok(null);
    },

    onAuthChange(cb) {
      listeners.add(cb);
      return { data: { unsubscribe: () => listeners.delete(cb) }, error: null };
    },

    async getCurrentStaff() {
      return run('getCurrentStaff', 'session', async ({ user }) => {
        const staff = staffOf(user);
        return ok(staff ? {
          discord_id: staff.discord_id, display_name: staff.display_name, role: staff.role,
          level: roleLevel(staff.role), teams: [...(staff.teams ?? [])], permissions: permsOf(staff),
          features: [...FEATURES],
        } : null);
      });
    },

    /* ----- leitura ----- */
    async listProcedures({ includeArchived = false } = {}) {
      return run('listProcedures', 'staff', async ({ sees }) => ok(
        state.procedures
          .filter((p) => sees(p) && (includeArchived || p.status !== 'arquivado'))
          .sort(byTitle)
          .map(present),
      ), { nonStaff: () => ok([]) });
    },

    async getProcedure(slug) {
      return run('getProcedure', 'staff', async ({ sees }) => {
        const p = state.procedures.find((x) => x.slug === slug);
        return sees(p) ? ok(present(p)) : notFound();
      }, { nonStaff: notFound });
    },

    /* ----- escrita ----- */
    async createProcedure(data) {
      return run('createProcedure', 'procedimentos.editar', async ({ staff, can, sees }) => {
        if (!can('procedimentos.aprovar')) return fail('FORBIDDEN', PROPOSAL_ERRORS.direct);
        const next = { ...PROCEDURE_DEFAULTS, ...pickEditable(data) };
        if (next.status === 'arquivado' && !can('procedimentos.arquivar')) return fail('FORBIDDEN');
        const invalid = check(next);
        if (invalid) return invalid;
        if (!sees(next)) return fail('FORBIDDEN');
        const at = nowIso();
        const proc = {
          id: uuid(),
          ...editableOf(next),
          last_reviewed_at: null,
          last_reviewed_by: null,
          version: 1,
          created_by: staff.discord_id, created_at: at,
          updated_by: staff.discord_id, updated_at: at,
        };
        state.procedures.push(proc);
        save();
        return ok(present(proc));
      });
    },

    async updateProcedure(id, data, expectedVersion) {
      return run('updateProcedure', 'staff', async ({ staff, can, sees }) => {
        const old = findById(id);
        if (!sees(old)) return notFound();
        if (!can('procedimentos.editar')) return fail('FORBIDDEN');
        const next = { ...editableOf(old), ...pickEditable(data) };
        if (touchesArchive(old.status, next.status) && !can('procedimentos.arquivar')) return fail('FORBIDDEN');
        if (contentChanged(old, next) && !can('procedimentos.aprovar')) return fail('FORBIDDEN', PROPOSAL_ERRORS.direct);
        if (!Number.isInteger(expectedVersion)) {
          return validationError({ version: 'Versão: informe a versão que você estava editando.' });
        }
        if (expectedVersion !== old.version) {
          return fail('CONFLICT', `Este procedimento foi alterado por ${nameOf(old.updated_by) ?? 'outra pessoa'} enquanto você editava.`, {
            current: present(old),
            updated_by_name: nameOf(old.updated_by),
          });
        }
        const invalid = check(next, old.id);
        if (invalid) return invalid;
        if (!sees(next)) return fail('FORBIDDEN');
        return ok(present(commit(old, editableOf(next), staff)));
      });
    },

    async setStatus(id, status) {
      return run('setStatus', 'staff', async ({ staff, can, sees }) => {
        const old = findById(id);
        if (!sees(old)) return notFound();
        if (!can('procedimentos.editar')) return fail('FORBIDDEN');
        if (!STATUSES.includes(status)) return validationError({ status: 'Status: use ativo, revisar ou arquivado.' });
        if (touchesArchive(old.status, status) && !can('procedimentos.arquivar')) return fail('FORBIDDEN');
        return ok(present(commit(old, { status }, staff)));
      });
    },

    async markReviewed(id) {
      return run('markReviewed', 'staff', async ({ staff, can, sees }) => {
        const old = findById(id);
        if (!sees(old)) return notFound();
        if (!can('procedimentos.favoritar')) return fail('FORBIDDEN');
        if (old.status === 'arquivado' && !can('procedimentos.arquivar')) return fail('FORBIDDEN');
        return ok(present(commit(old, { last_reviewed_at: nowIso(), last_reviewed_by: staff.discord_id }, staff)));
      });
    },

    /* ----- histórico ----- */
    async listRevisions(procedureId) {
      return run('listRevisions', 'staff', async ({ sees }) => ok(
        state.revisions
          .filter((r) => r.procedure_id === procedureId && sees(findById(procedureId)) && sees(r.snapshot))
          .sort((a, b) => b.version - a.version)
          .map((r) => ({ ...clone(r), snapshot: present(r.snapshot), changed_by_name: nameOf(r.changed_by) })),
      ), { nonStaff: () => ok([]) });
    },

    async restoreRevision(revisionId) {
      return run('restoreRevision', 'procedimentos.arquivar', async ({ staff, can, sees }) => {
        const rev = state.revisions.find((r) => r.id === revisionId);
        if (!rev || !sees(rev.snapshot)) return fail('NOT_FOUND', 'Revisão não encontrada.');
        const old = findById(rev.procedure_id);
        if (!sees(old)) return notFound();
        if (!can('procedimentos.editar')) return fail('FORBIDDEN');
        const next = editableOf(rev.snapshot);
        if (contentChanged(old, next) && !can('procedimentos.aprovar')) return fail('FORBIDDEN', PROPOSAL_ERRORS.direct);
        const invalid = check(next, old.id);
        if (invalid) return invalid;
        return ok(present(commit(old, next, staff)));
      });
    },

    /* ----- favoritos ----- */
    async listFavorites() {
      return run('listFavorites', 'staff', async ({ user }) => ok(
        state.favorites.filter((f) => f.user_id === user.id).map((f) => f.procedure_id),
      ), { nonStaff: () => ok([]) });
    },

    async addFavorite(procedureId) {
      return run('addFavorite', 'staff', async ({ user, can, sees }) => {
        if (!sees(findById(procedureId))) return notFound();
        if (!can('procedimentos.favoritar')) return fail('FORBIDDEN');
        if (!state.favorites.some((f) => f.user_id === user.id && f.procedure_id === procedureId)) {
          state.favorites.push({ user_id: user.id, procedure_id: procedureId, created_at: nowIso() });
          save();
        }
        return ok(null);
      });
    },

    async removeFavorite(procedureId) {
      return run('removeFavorite', 'staff', async ({ user }) => {
        const before = state.favorites.length;
        state.favorites = state.favorites.filter((f) => !(f.user_id === user.id && f.procedure_id === procedureId));
        if (state.favorites.length !== before) save();
        return ok(null);
      });
    },

    /* ----- exportação / importação ----- */
    async exportAll() {
      return run('exportAll', 'procedimentos.backup', async () => ok({
        format: EXPORT_FORMAT,
        version: 1,
        exported_at: nowIso(),
        procedures: [...state.procedures].sort(byTitle).map(clone),
      }));
    },

    async importAll(payload, { dryRun = false } = {}) {
      return run('importAll', 'procedimentos.backup', async ({ staff, can }) => {
        if (!can('procedimentos.editar')) return fail('FORBIDDEN');
        if (!payload || payload.format !== EXPORT_FORMAT || !Array.isArray(payload.procedures)) {
          return validationError({ payload: `Arquivo: formato inválido (esperado "${EXPORT_FORMAT}" com a lista de procedimentos).` });
        }

        const items = [];
        const seen = new Set();
        const plan = [];
        payload.procedures.forEach((raw, index) => {
          const next = { ...PROCEDURE_DEFAULTS, ...pickEditable(raw) };
          const { errors } = validateProcedure(next);
          if (next.slug && seen.has(next.slug)) errors.slug = 'Slug: repetido no arquivo.';
          seen.add(next.slug);
          if (Object.keys(errors).length) { items.push({ index, slug: next.slug ?? null, errors }); return; }
          plan.push({ next: editableOf(next), existing: state.procedures.find((p) => p.slug === next.slug) });
        });
        if (items.length) return fail('VALIDATION', `${items.length} procedimento(s) inválido(s) no arquivo.`, { items });

        const summary = { created: 0, updated: 0, unchanged: 0 };
        for (const { next, existing } of plan) {
          if (!existing) summary.created++;
          else if (JSON.stringify(editableOf(existing)) === JSON.stringify(next)) summary.unchanged++;
          else summary.updated++;
        }
        if (dryRun) return ok(summary);
        if (summary.created + summary.updated > 0 && !can('procedimentos.aprovar')) return fail('FORBIDDEN', PROPOSAL_ERRORS.direct);

        for (const { next, existing } of plan) {
          if (!existing) {
            const at = nowIso();
            state.procedures.push({
              id: uuid(), ...next, last_reviewed_at: null, last_reviewed_by: null, version: 1,
              created_by: staff.discord_id, created_at: at, updated_by: staff.discord_id, updated_at: at,
            });
          } else if (JSON.stringify(editableOf(existing)) !== JSON.stringify(next)) {
            commit(existing, next, staff);
          }
        }
        save();
        return ok(summary);
      });
    },

    /* ----- equipe (staff_members) ----- */
    async listStaff() {
      return run('listStaff', 'equipe.ver', async () => ok([...state.staff].sort(byStaffName).map(presentStaff)));
    },

    async createStaffMember(data) {
      return run('createStaffMember', 'equipe.gerenciar', async ({ staff }) => {
        const next = pickStaffMember(data);
        const { valid, errors } = validateStaffMember(next);
        if (!valid) return validationError(errors);
        const blocked = staffChangeError(staff, null, next);
        if (blocked) return validationError({ _: blocked });
        if (state.staff.some((s) => s.discord_id === next.discord_id)) {
          return validationError({ discord_id: 'Discord ID: já cadastrado na staff.' });
        }
        const member = { ...next, created_at: nowIso() };
        state.staff.push(member);
        audit(staff, 'membro', member.discord_id, 'adicionado', null, staffAudit(member));
        save();
        return ok(presentStaff(member));
      });
    },

    async updateStaffMember(discordId, changes) {
      return run('updateStaffMember', 'equipe.gerenciar', async ({ staff }) => {
        const member = state.staff.find((s) => s.discord_id === discordId);
        if (!member) return fail('NOT_FOUND', 'Membro não encontrado.');
        const patch = pickStaffMember(changes, { partial: true });
        delete patch.discord_id;
        const next = { ...member, ...patch };
        const { valid, errors } = validateStaffMember(next);
        if (!valid) return validationError(errors);
        const blocked = staffChangeError(staff, member, next, otherActiveCeos(discordId));
        if (blocked) return validationError({ _: blocked });
        const before = staffAudit(member);
        Object.assign(member, patch);
        if (JSON.stringify(before) !== JSON.stringify(staffAudit(member))) audit(staff, 'membro', discordId, 'alterado', before, staffAudit(member));
        save();
        return ok(presentStaff(member));
      });
    },

    async deleteStaffMember(discordId) {
      return run('deleteStaffMember', 'equipe.gerenciar', async ({ staff }) => {
        const member = state.staff.find((s) => s.discord_id === discordId);
        if (!member) return fail('NOT_FOUND', 'Membro não encontrado.');
        const blocked = staffChangeError(staff, member, 'delete', otherActiveCeos(discordId));
        if (blocked) return validationError({ _: blocked });
        state.staff = state.staff.filter((s) => s.discord_id !== discordId);
        audit(staff, 'membro', discordId, 'removido', staffAudit(member), null);
        save();
        return ok(null);
      });
    },

    /* ----- grade de permissões (role_permissions) ----- */
    async listPermissionGrid() {
      return run('listPermissionGrid', 'staff', async () => ok(presentGrid()));
    },

    async setPermissions(changes) {
      return run('setPermissions', 'permissoes.editar', async ({ staff }) => {
        const blocked = permissionChangesError(staff.role, changes);
        if (blocked) return validationError({ _: blocked });
        for (const c of changes) {
          if (state.grid[c.role][c.permission] !== c.allowed) {
            audit(staff, 'permissao', `${c.role}:${c.permission}`, c.allowed ? 'ligada' : 'desligada', { allowed: !c.allowed }, { allowed: c.allowed });
          }
          state.grid[c.role][c.permission] = c.allowed;
        }
        save();
        return ok(presentGrid());
      });
    },

    /* ----- Etapa 2B: propostas de procedimentos ----- */
    async listProposals() {
      return run('listProposals', 'staff', async ({ staff, can }) => ok(state.proposals
        .filter((p) => p.created_by === staff.discord_id || can('procedimentos.aprovar'))
        .sort(newestFirst)
        .map(presentProposal)));
    },

    async createProposal({ procedure_id: procedureId = null, base_version: baseVersion = null, data } = {}) {
      return run('createProposal', 'procedimentos.editar', async ({ staff, sees }) => {
        let current = null;
        if (procedureId) {
          current = findById(procedureId);
          if (!sees(current)) return notFound();
          if (!Number.isInteger(baseVersion)) return validationError({ version: 'Versão: informe a versão que você estava editando.' });
        }
        const next = { ...PROCEDURE_DEFAULTS, ...(current ? editableOf(current) : {}), ...pickEditable(data) };
        next.status = proposalStatus(next);
        const invalid = check(next, current?.id);
        if (invalid) return invalid;
        if (!sees(next)) return fail('FORBIDDEN');
        const proposal = {
          id: uuid(), procedure_id: procedureId, base_version: procedureId ? baseVersion : null, data: editableOf(next),
          status: 'pendente', created_by: staff.discord_id, created_at: nowIso(),
          reviewed_by: null, reviewed_at: null, review_note: '',
        };
        state.proposals.push(proposal);
        save();
        return ok(presentProposal(proposal));
      });
    },

    async cancelProposal(id) {
      return run('cancelProposal', 'staff', async ({ staff }) => {
        const pr = state.proposals.find((p) => p.id === id && p.status === 'pendente' && p.created_by === staff.discord_id);
        if (!pr) return fail('NOT_FOUND', 'Proposta não encontrada ou já analisada.');
        pr.status = 'cancelada';
        save();
        return ok(null);
      });
    },

    async reviewProposal(id, { approve, note = '' } = {}) {
      return run('reviewProposal', 'procedimentos.aprovar', async ({ staff, can }) => {
        const pr = state.proposals.find((p) => p.id === id);
        if (!pr) return fail('NOT_FOUND', 'Proposta não encontrada.');
        if (pr.status !== 'pendente') return validationError({ _: PROPOSAL_ERRORS.reviewed });
        const text = String(note ?? '').trim();
        if (text.length > PROPOSAL_NOTE_MAX) return validationError({ _: PROPOSAL_ERRORS.noteMax });
        const done = (status, procedureId) => {
          Object.assign(pr, { status, procedure_id: procedureId, reviewed_by: staff.discord_id, reviewed_at: nowIso(), review_note: text });
          if (!pr.base_version) pr.base_version = 1;
          audit(staff, 'proposta', pr.id, status, null, { procedure_id: procedureId, author: pr.created_by, title: pr.data.title });
          save();
          return ok({ status, procedure_id: procedureId });
        };
        if (!approve) {
          if (!text) return validationError({ _: PROPOSAL_ERRORS.rejectNote });
          pr.base_version = pr.base_version ?? null;
          Object.assign(pr, { status: 'recusada', reviewed_by: staff.discord_id, reviewed_at: nowIso(), review_note: text });
          audit(staff, 'proposta', pr.id, 'recusada', null, { procedure_id: pr.procedure_id, author: pr.created_by, title: pr.data.title });
          save();
          return ok({ status: 'recusada', procedure_id: pr.procedure_id });
        }
        if (!can('procedimentos.editar')) return fail('FORBIDDEN');
        const data = { ...clone(pr.data), status: proposalStatus(pr.data) };
        if (!pr.procedure_id) {
          const invalid = check(data);
          if (invalid) return invalid;
          const at = nowIso();
          const proc = {
            id: uuid(), ...editableOf(data), last_reviewed_at: null, last_reviewed_by: null, version: 1,
            created_by: staff.discord_id, created_at: at, updated_by: staff.discord_id, updated_at: at,
          };
          state.procedures.push(proc);
          return done('aprovada', proc.id);
        }
        const cur = findById(pr.procedure_id);
        if (!cur) return fail('NOT_FOUND', 'Procedimento não encontrado.');
        if (cur.status === 'arquivado') return validationError({ _: PROPOSAL_ERRORS.archived });
        const invalid = check(data, cur.id);
        if (invalid) return invalid;
        commit(cur, editableOf(data), staff);
        return done('aprovada', cur.id);
      });
    },

    /* ----- Etapa 3: avaliações da equipe ----- */
    async listEvaluationPeriods() {
      return run('listEvaluationPeriods', 'staff', async ({ can }) => {
        if (!seesEvaluations(can)) return fail('FORBIDDEN');
        return ok([...state.periods].sort((a, b) => b.starts_at.localeCompare(a.starts_at)).map(clone));
      });
    },

    async saveEvaluationPeriod(period = {}) {
      return run('saveEvaluationPeriod', 'avaliacoes.gerenciar', async ({ staff }) => {
        const title = String(period.title ?? '').trim();
        const errors = {};
        if (!title || title.length > 80) errors.title = 'Nome do período: de 1 a 80 caracteres.';
        const startsAt = period.starts_at ?? nowIso();
        const endsAt = period.ends_at;
        if (!endsAt || !(new Date(endsAt) > new Date(startsAt))) errors.ends_at = 'Fim: precisa ser depois do início.';
        if (Object.keys(errors).length) return validationError(errors);
        let row = period.id ? state.periods.find((x) => x.id === period.id) : null;
        if (period.id && !row) return fail('NOT_FOUND', 'Período não encontrado.');
        const before = row ? { starts_at: row.starts_at, ends_at: row.ends_at } : null;
        if (!row) {
          row = { id: uuid(), created_by: staff.discord_id, created_at: nowIso() };
          state.periods.push(row);
        }
        Object.assign(row, { title, starts_at: new Date(startsAt).toISOString(), ends_at: new Date(endsAt).toISOString() });
        audit(staff, 'periodo', row.id, before ? 'alterado' : 'aberto', before, { title, starts_at: row.starts_at, ends_at: row.ends_at });
        save();
        return ok(clone(row));
      });
    },

    async listEvaluationCriteria() {
      return run('listEvaluationCriteria', 'staff', async ({ can }) => {
        if (!seesEvaluations(can)) return fail('FORBIDDEN');
        return ok([...state.criteria].sort((a, b) => a.sort_order - b.sort_order).map(({ created_at, ...c }) => clone(c)));
      });
    },

    async saveEvaluationCriterion(c = {}) {
      return run('saveEvaluationCriterion', 'avaliacoes.gerenciar', async () => {
        const label = String(c.label ?? '').trim();
        if (!label || label.length > 80) return validationError({ label: 'Critério: de 1 a 80 caracteres.' });
        let row = c.id ? state.criteria.find((x) => x.id === c.id) : null;
        if (c.id && !row) return fail('NOT_FOUND', 'Critério não encontrado.');
        if (!row) {
          row = { id: uuid(), created_at: nowIso(), sort_order: Math.max(0, ...state.criteria.map((x) => x.sort_order)) + 1, active: true };
          state.criteria.push(row);
        }
        Object.assign(row, { label, ...(Number.isInteger(c.sort_order) ? { sort_order: c.sort_order } : {}), ...(typeof c.active === 'boolean' ? { active: c.active } : {}) });
        save();
        const { created_at, ...out } = row;
        return ok(clone(out));
      });
    },

    async listEvaluableMembers() {
      return run('listEvaluableMembers', 'avaliacoes.criar', async ({ staff }) => ok(state.staff
        .filter((s) => s.active && s.discord_id !== staff.discord_id && roleLevel(s.role) < roleLevel(staff.role))
        .sort(byStaffName)
        .map((s) => ({ discord_id: s.discord_id, display_name: s.display_name, role: s.role }))));
    },

    async listEvaluations() {
      return run('listEvaluations', 'staff', async ({ staff, can }) => ok(state.evaluations
        .filter((e) => e.evaluator_id === staff.discord_id
          || (can('avaliacoes.ler') && e.status !== 'rascunho' && e.evaluated_id !== staff.discord_id))
        .sort((a, b) => (b.submitted_at ?? b.updated_at).localeCompare(a.submitted_at ?? a.updated_at))
        .map(presentEvaluation)));
    },

    async saveEvaluation(input = {}) {
      return run('saveEvaluation', 'avaliacoes.criar', async ({ staff }) => {
        const before = input.id ? state.evaluations.find((e) => e.id === input.id && e.evaluator_id === staff.discord_id) : null;
        if (input.id && !before) return fail('NOT_FOUND', 'Avaliação não encontrada.');
        const fields = ['period_id', 'evaluated_id', 'status', 'criteria', 'overall', 'strengths', 'improvements', 'feedback', 'recommendation'];
        const after = { ...(before ? clone(before) : { status: 'rascunho', criteria: [], overall: null, strengths: '', improvements: '', feedback: '', recommendation: null }) };
        for (const f of fields) if (f in input) after[f] = clone(input[f]);
        for (const f of ['strengths', 'improvements', 'feedback']) after[f] = String(after[f] ?? '');
        after.overall = after.overall ?? null;
        after.recommendation = after.recommendation || null;
        const { valid, errors } = validateEvaluation(after);
        if (!valid) return validationError(errors);
        const target = state.staff.find((m) => m.discord_id === after.evaluated_id) ?? null;
        const blocked = evaluationChangeError(staff, before, after, {
          period: state.periods.find((x) => x.id === after.period_id) ?? null, target, others: state.evaluations, now: now().getTime(),
        });
        if (blocked) return validationError({ _: blocked });
        const at = nowIso();
        let row = before;
        if (!row) {
          row = { id: uuid(), evaluator_id: staff.discord_id, created_at: at, submitted_at: null, read_by: null, read_at: null };
          state.evaluations.push(row);
        }
        const wasSent = row.status === 'enviada';
        Object.assign(row, after, { id: row.id, evaluator_id: row.evaluator_id, updated_at: at });
        if (row.status === 'enviada') {
          row.submitted_at = row.submitted_at ?? at;
          if (wasSent) { row.read_by = null; row.read_at = null; }
          if (!wasSent) audit(staff, 'avaliacao', row.id, 'enviada', null, { evaluated_id: row.evaluated_id, evaluator_id: row.evaluator_id, period_id: row.period_id });
        }
        save();
        return ok(presentEvaluation(row));
      });
    },

    async deleteEvaluation(id) {
      return run('deleteEvaluation', 'staff', async ({ staff }) => {
        const idx = state.evaluations.findIndex((e) => e.id === id && e.evaluator_id === staff.discord_id && e.status === 'rascunho');
        if (idx < 0) return fail('NOT_FOUND', 'Rascunho não encontrado.');
        state.evaluations.splice(idx, 1);
        save();
        return ok(null);
      });
    },

    async markEvaluationRead(id) {
      return run('markEvaluationRead', 'avaliacoes.ler', async ({ staff }) => {
        const e = state.evaluations.find((x) => x.id === id);
        if (e && e.status === 'enviada' && !e.read_at && e.evaluated_id !== staff.discord_id) {
          Object.assign(e, { read_by: staff.discord_id, read_at: nowIso() });
          save();
        }
        return ok(null);
      });
    },

    async archiveEvaluation(id) {
      return run('archiveEvaluation', 'avaliacoes.gerenciar', async ({ staff }) => {
        const e = state.evaluations.find((x) => x.id === id && x.status === 'enviada' && x.evaluated_id !== staff.discord_id);
        if (!e) return fail('NOT_FOUND', 'Avaliação não encontrada.');
        Object.assign(e, { status: 'arquivada', archived_by: staff.discord_id, archived_at: nowIso() });
        audit(staff, 'avaliacao', e.id, 'arquivada', null, { evaluated_id: e.evaluated_id, evaluator_id: e.evaluator_id, period_id: e.period_id });
        save();
        return ok(null);
      });
    },

    /* ----- Etapa 11: avisos ----- */
    async listAnnouncements() {
      return run('listAnnouncements', 'staff', async ({ staff, can }) => ok(state.announcements
        .filter((a) => can('avisos.enviar') || isAnnouncementFor(a, staff, now().getTime()))
        .sort((a, b) => b.starts_at.localeCompare(a.starts_at) || b.created_at.localeCompare(a.created_at))
        .map((a) => presentAnnouncement(a, staff))));
    },

    async saveAnnouncement(input = {}) {
      return run('saveAnnouncement', 'avisos.enviar', async ({ staff }) => {
        let row = input.id ? state.announcements.find((a) => a.id === input.id) : null;
        if (input.id && !row) return fail('NOT_FOUND', 'Aviso não encontrado.');
        const next = {
          title: String(input.title ?? row?.title ?? '').trim(), body: String(input.body ?? row?.body ?? ''),
          priority: input.priority ?? row?.priority ?? 'normal',
          audience_roles: [...new Set(input.audience_roles ?? row?.audience_roles ?? [])].sort(),
          starts_at: input.starts_at ?? row?.starts_at ?? nowIso(), ends_at: ('ends_at' in input ? input.ends_at : row?.ends_at) || null,
          requires_ack: Boolean(input.requires_ack ?? row?.requires_ack ?? false),
        };
        const { valid, errors } = validateAnnouncement(next);
        if (!valid) return validationError(errors);
        next.starts_at = new Date(next.starts_at).toISOString();
        if (next.ends_at) next.ends_at = new Date(next.ends_at).toISOString();
        if (!row) {
          row = { id: uuid(), created_by: staff.discord_id, created_at: nowIso() };
          state.announcements.push(row);
          audit(staff, 'aviso', row.id, 'criado', null, { title: next.title, priority: next.priority });
        }
        Object.assign(row, next, { updated_at: nowIso() });
        save();
        return ok(presentAnnouncement(row, staff));
      });
    },

    async deleteAnnouncement(id) {
      return run('deleteAnnouncement', 'avisos.enviar', async ({ staff }) => {
        const row = state.announcements.find((a) => a.id === id);
        if (!row) return fail('NOT_FOUND', 'Aviso não encontrado.');
        state.announcements = state.announcements.filter((a) => a.id !== id);
        state.reads = state.reads.filter((r) => r.announcement_id !== id);
        audit(staff, 'aviso', id, 'apagado', { title: row.title, priority: row.priority }, null);
        save();
        return ok(null);
      });
    },

    async markAnnouncementRead(id, { ack = false } = {}) {
      return run('markAnnouncementRead', 'staff', async ({ staff }) => {
        const a = state.announcements.find((x) => x.id === id);
        if (!a || !isAnnouncementFor(a, staff, now().getTime())) return fail('NOT_FOUND', 'Aviso não encontrado.');
        let r = state.reads.find((x) => x.announcement_id === id && x.discord_id === staff.discord_id);
        if (!r) { r = { announcement_id: id, discord_id: staff.discord_id, read_at: nowIso(), acknowledged_at: null }; state.reads.push(r); }
        if (ack && !r.acknowledged_at) r.acknowledged_at = nowIso();
        save();
        return ok(null);
      });
    },

    async getAnnouncementReport(id) {
      return run('getAnnouncementReport', 'avisos.enviar', async () => {
        const a = state.announcements.find((x) => x.id === id);
        if (!a) return fail('NOT_FOUND', 'Aviso não encontrado.');
        const rows = state.staff
          .filter((s) => s.active && (!a.audience_roles.length || a.audience_roles.includes(s.role)))
          .map((s) => {
            const r = state.reads.find((x) => x.announcement_id === id && x.discord_id === s.discord_id);
            return { discord_id: s.discord_id, display_name: s.display_name, role: s.role, read_at: r?.read_at ?? null, acknowledged_at: r?.acknowledged_at ?? null };
          })
          .sort((x, y) => (x.read_at ? 1 : 0) - (y.read_at ? 1 : 0) || byStaffName(x, y));
        return ok(rows);
      });
    },

    /* ----- Etapa 11: auditoria ----- */
    async listAudit({ entity = '', entityId = '', limit = 100, before = null } = {}) {
      return run('listAudit', 'auditoria.ver', async () => ok(state.audit
        .filter((a) => (!entity || a.entity === entity) && (!entityId || a.entity_id === entityId) && (before == null || a.id < before))
        .sort((a, b) => b.id - a.id)
        .slice(0, Math.min(Math.max(1, limit), 500))
        .map((a) => ({ ...clone(a), actor_name: nameOf(a.actor) }))));
    },

    /* ----- Etapa 5: gabarito, checklist e nomes proibidos ----- */
    async listInterviewQuestions({ includeInactive = false } = {}) {
      return run('listInterviewQuestions', 'staff', async ({ can }) => {
        if (!usesAllowlist(can)) return fail('FORBIDDEN', ALLOWLIST_ERRORS.forbidden);
        return ok(state.questions.filter((q) => includeInactive || q.active)
          .sort((a, b) => a.position - b.position).map(presentConfig));
      });
    },

    async listChecklistItems({ includeInactive = false } = {}) {
      return run('listChecklistItems', 'staff', async ({ can }) => {
        if (!usesAllowlist(can)) return fail('FORBIDDEN', ALLOWLIST_ERRORS.forbidden);
        return ok(state.checklistItems.filter((c) => includeInactive || c.active)
          .sort((a, b) => a.stage - b.stage || a.position - b.position).map(presentConfig));
      });
    },

    async listBlockedNames({ includeInactive = false } = {}) {
      return run('listBlockedNames', 'staff', async ({ can }) => {
        if (!usesAllowlist(can) && !can('lore.consultar')) return fail('FORBIDDEN');
        return ok(state.blockedNames.filter((n) => includeInactive || n.active)
          .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map(presentConfig));
      });
    },

    /* ----- Etapa 5: análises de allowlist e entrevistas ----- */
    async listAlEvaluations({ kind = '', status = '', createdBy = '', query = '', limit = 100, before = null } = {}) {
      return run('listAlEvaluations', 'staff', async ({ staff, can }) => {
        const q = normalizeName(query);
        const hit = (e) => !q || [e.author_handle, e.player_discord_id, e.character_name, e.al_id].some((v) => normalizeName(v).includes(q));
        // Invertida antes de ordenar: no mesmo milissegundo, a criada por último vem primeiro.
        return ok([...state.alEvaluations].reverse()
          .filter((e) => seesEval(e, staff, can) && (!kind || e.kind === kind) && (!status || e.status === status)
            && (!createdBy || e.created_by === createdBy) && (!before || e.created_at < before) && hit(e))
          .sort(newestFirst)
          .slice(0, Math.min(Math.max(1, limit), 200))
          .map(presentEval));
      });
    },

    async getAlEvaluation(id) {
      return run('getAlEvaluation', 'staff', async ({ staff, can }) => {
        const e = state.alEvaluations.find((x) => x.id === id);
        return e && seesEval(e, staff, can) ? ok(detailOf(e)) : evalNotFound();
      });
    },

    async saveAlEvaluation(input = {}) {
      return run('saveAlEvaluation', 'allowlist.avaliar', async ({ staff, can }) => {
        const before = input.id ? state.alEvaluations.find((x) => x.id === input.id) : null;
        if (input.id && (!before || !seesEval(before, staff, can))) return evalNotFound();
        if (before && before.created_by !== staff.discord_id) return fail('FORBIDDEN', ALLOWLIST_ERRORS.notAuthor);
        if (before?.sent_to_discord_at) return validationError({ _: ALLOWLIST_ERRORS.sent });
        const next = { ...(before ? clone(before) : { ...clone(AL_DEFAULTS), kind: input.kind }), ...pickAlEvaluation(input) };
        const { valid, errors } = validateAlEvaluation(next);
        const answers = Array.isArray(input.answers) ? pickAlAnswers(input.answers) : null;
        const participants = Array.isArray(input.participants) ? pickAlParticipants(input.participants, staff.discord_id) : null;
        const extras = validateAlExtras(next.kind, { answers, participants });
        if (!valid || !extras.valid) return validationError({ ...errors, ...extras.errors });
        const at = nowIso();
        let row = before;
        if (!row) {
          row = { id: uuid(), kind: next.kind, created_by: staff.discord_id, created_at: at, sent_to_discord_at: null, discord_status: '' };
          state.alEvaluations.push(row);
          state.alParticipants.push({ evaluation_id: row.id, discord_id: staff.discord_id, role: 'responsavel' });
        }
        Object.assign(row, pickAlEvaluation(next), { updated_at: at });
        if (answers) {
          state.alAnswers = state.alAnswers.filter((a) => a.evaluation_id !== row.id)
            .concat(answers.map((a) => ({ evaluation_id: row.id, ...a })));
        }
        if (participants) {
          state.alParticipants = state.alParticipants.filter((p) => p.evaluation_id !== row.id || p.role === 'responsavel')
            .concat(participants.map((p) => ({ evaluation_id: row.id, ...p })));
        }
        save();
        return ok(detailOf(row));
      });
    },

    async addAlPrint(evaluationId, file) {
      return run('addAlPrint', 'allowlist.avaliar', async ({ staff, can }) => {
        const e = state.alEvaluations.find((x) => x.id === evaluationId);
        if (!e || !seesEval(e, staff, can)) return evalNotFound();
        if (e.created_by !== staff.discord_id) return fail('FORBIDDEN', ALLOWLIST_ERRORS.notAuthor);
        if (e.sent_to_discord_at) return validationError({ _: ALLOWLIST_ERRORS.sent });
        const used = state.alAttachments.filter((a) => a.evaluation_id === e.id);
        const bad = printError(file, used.length);
        if (bad) return validationError({ file: bad });
        const id = uuid();
        const ext = file.type.split('/')[1].replace('jpeg', 'jpg');
        const position = [...Array(MAX_PRINTS).keys()].map((i) => i + 1).find((p) => !used.some((a) => a.position === p));
        const row = {
          id, evaluation_id: e.id, storage_path: `${e.id}/${id}.${ext}`, file_name: String(file.name ?? '').slice(0, 200),
          mime: file.type, size: file.size, position, created_by: staff.discord_id, created_at: nowIso(),
        };
        state.alAttachments.push(row);
        printFiles.set(row.storage_path, file);
        save();
        return ok(presentAttachment(row));
      });
    },

    async removeAlPrint(attachmentId) {
      return run('removeAlPrint', 'allowlist.avaliar', async ({ staff, can }) => {
        const a = state.alAttachments.find((x) => x.id === attachmentId);
        const e = a ? state.alEvaluations.find((x) => x.id === a.evaluation_id) : null;
        if (!e || !seesEval(e, staff, can)) return fail('NOT_FOUND', 'Print não encontrado.');
        if (e.created_by !== staff.discord_id) return fail('FORBIDDEN', ALLOWLIST_ERRORS.notAuthor);
        if (e.sent_to_discord_at) return validationError({ _: ALLOWLIST_ERRORS.sent });
        state.alAttachments = state.alAttachments.filter((x) => x.id !== attachmentId);
        printFiles.delete(a.storage_path);
        save();
        return ok(null);
      });
    },

    async getAlPrintUrls(evaluationId) {
      return run('getAlPrintUrls', 'staff', async ({ staff, can }) => {
        const e = state.alEvaluations.find((x) => x.id === evaluationId);
        if (!e || !seesEval(e, staff, can)) return evalNotFound();
        return ok(state.alAttachments.filter((a) => a.evaluation_id === e.id).sort((a, b) => a.position - b.position)
          .map((a) => {
            const blob = printFiles.get(a.storage_path);
            const url = blob && globalThis.URL?.createObjectURL ? URL.createObjectURL(blob) : `mock://al-prints/${a.storage_path}`;
            return { id: a.id, url };
          }));
      });
    },

    /* ----- Etapa 5: webhooks do Discord (a url nunca sai) ----- */
    async listDiscordWebhooks({ purpose = '' } = {}) {
      return run('listDiscordWebhooks', 'staff', async ({ can }) => ok(state.webhooks
        .filter((w) => seesWebhook(w, can) && (!purpose || w.purpose === purpose))
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
        .map(presentWebhook)));
    },

    async saveDiscordWebhook(input = {}) {
      return run('saveDiscordWebhook', 'webhooks.gerenciar', async ({ staff }) => {
        const row = input.id ? state.webhooks.find((w) => w.id === input.id) : null;
        if (input.id && !row) return fail('NOT_FOUND', 'Webhook não encontrado.');
        const patch = pickWebhook(input);
        const next = { channel_name: '', sender_name: '', sender_avatar_url: '', active: true, ...(row ? presentWebhook(row) : {}), ...patch };
        const { valid, errors } = validateWebhook(next, { creating: !row });
        if (!valid) return validationError(errors);
        const cols = ['name', 'purpose', 'channel_name', 'sender_name', 'active'];
        const snap = (w) => Object.fromEntries(cols.map((c) => [c, w[c]]));
        const before = row ? snap(row) : null;
        const at = nowIso();
        const target = row ?? { id: uuid(), created_by: staff.discord_id, created_at: at };
        const urlChanged = Boolean(row && next.url && next.url !== row.url);
        Object.assign(target, {
          name: next.name, url: next.url ?? row?.url, purpose: next.purpose, channel_name: next.channel_name,
          sender_name: next.sender_name, sender_avatar_url: next.sender_avatar_url, active: next.active,
          updated_by: staff.discord_id, updated_at: at,
        });
        if (!row) state.webhooks.push(target);
        const after = { ...snap(target), ...(urlChanged ? { endereco_trocado: true } : {}) };
        if (!row || JSON.stringify(before) !== JSON.stringify(after)) {
          audit(staff, 'webhook', target.id, !row ? 'cadastrado' : before.active !== target.active ? (target.active ? 'ativado' : 'desativado') : 'alterado', before, after);
        }
        save();
        return ok(presentWebhook(target));
      });
    },

    async deleteDiscordWebhook(id) {
      return run('deleteDiscordWebhook', 'webhooks.gerenciar', async ({ staff }) => {
        const row = state.webhooks.find((w) => w.id === id);
        if (!row) return fail('NOT_FOUND', 'Webhook não encontrado.');
        state.webhooks = state.webhooks.filter((w) => w.id !== id);
        audit(staff, 'webhook', id, 'removido', { name: row.name, purpose: row.purpose, channel_name: row.channel_name, sender_name: row.sender_name, active: row.active }, null);
        save();
        return ok(null);
      });
    },

    /* ----- Etapa 7: envio ao Discord (simulado; o de verdade é a Edge Function) ----- */
    async sendAlToDiscord(evaluationId, { webhookId, resend = false } = {}) {
      return run('sendAlToDiscord', 'allowlist.avaliar', async ({ staff, can }) => {
        const e = state.alEvaluations.find((x) => x.id === evaluationId);
        if (!e || !seesEval(e, staff, can)) return evalNotFound();
        if (e.created_by !== staff.discord_id) return fail('FORBIDDEN', ALLOWLIST_ERRORS.notAuthor);
        if (e.sent_to_discord_at && !resend) return validationError({ _: DISCORD_SEND_ERRORS.alreadySent });
        const w = state.webhooks.find((x) => x.id === webhookId);
        if (!w || !w.active || w.purpose !== e.kind) return validationError({ _: DISCORD_SEND_ERRORS.webhook });
        Object.assign(e, { sent_to_discord_at: nowIso(), discord_status: sentStatus(w.name) });
        save();
        return ok({ sent_to_discord_at: e.sent_to_discord_at, discord_status: e.discord_status });
      });
    },

    async testDiscordWebhook(webhookId) {
      return run('testDiscordWebhook', 'webhooks.gerenciar', async () => (
        state.webhooks.some((w) => w.id === webhookId) ? ok(null) : fail('NOT_FOUND', 'Webhook não encontrado.')));
    },
  };

  /* ---------- Etapa 5: apoio da Allowlist ---------- */
  function usesAllowlist(can) {
    return can('allowlist.avaliar') || can('allowlist.historico') || can('lore.gerenciar');
  }
  function seesEval(e, staff, can) {
    return can('allowlist.historico') || e.created_by === staff.discord_id
      || state.alParticipants.some((p) => p.evaluation_id === e.id && p.discord_id === staff.discord_id);
  }
  function seesWebhook(w, can) {
    return can('webhooks.gerenciar')
      || (w.active && ((['allowlist', 'entrevista'].includes(w.purpose) && can('allowlist.avaliar')) || (w.purpose === 'avisos' && can('avisos.enviar'))));
  }
  function evalNotFound() { return fail('NOT_FOUND', 'Análise não encontrada.'); }
  function presentConfig(row) { return clone(row); }
  function presentEval(e) { return { ...clone(e), created_by_name: nameOf(e.created_by) }; }
  function presentAttachment(a) {
    const { evaluation_id, created_by, ...rest } = clone(a);
    return rest;
  }
  function presentWebhook(w) { return Object.fromEntries(WEBHOOK_COLUMNS.map((c) => [c, clone(w[c])])); }
  function detailOf(e) {
    return {
      ...presentEval(e),
      participants: state.alParticipants.filter((p) => p.evaluation_id === e.id)
        .map(({ discord_id, role }) => ({ discord_id, role, display_name: nameOf(discord_id) }))
        .sort((a, b) => (a.role === 'responsavel' ? -1 : b.role === 'responsavel' ? 1 : 0)),
      answers: state.alAnswers.filter((a) => a.evaluation_id === e.id).sort((a, b) => a.position - b.position)
        .map(({ evaluation_id, ...a }) => clone(a)),
      attachments: state.alAttachments.filter((a) => a.evaluation_id === e.id).sort((a, b) => a.position - b.position)
        .map(presentAttachment),
    };
  }

  /** Controles só do mock (não fazem parte do contrato). */
  const mock = {
    /** Troca o usuário simulado (null = deslogado) e avisa os ouvintes de sessão. */
    setUser(key) {
      if (key !== null && !MOCK_USERS[key]) throw new Error(`Usuário simulado desconhecido: ${key}`);
      sessionKey = key;
      save();
      notify();
    },
    /** Simula queda de rede: toda operação que precisa do servidor devolve NETWORK. */
    setOffline(value) { offline = Boolean(value); },
    /** Simula a Edge Function do Discord (Etapa 7): marca a análise como enviada. */
    markSent(evaluationId, status = 'enviado') {
      const e = state.alEvaluations.find((x) => x.id === evaluationId);
      if (!e) throw new Error(`Análise desconhecida: ${evaluationId}`);
      Object.assign(e, { sent_to_discord_at: nowIso(), discord_status: status });
      save();
    },
    /** Faz a PRÓXIMA chamada do método falhar com o código indicado (ex.: testar reversão otimista). */
    failNext(method, code = 'NETWORK') { pendingFailures.set(method, code); },
    /**
     * Executa `fn(adapter)` como outro usuário, sem avisar os ouvintes de sessão
     * (simula outra pessoa editando ao mesmo tempo).
     */
    async actAs(key, fn) {
      if (!MOCK_USERS[key]) throw new Error(`Usuário simulado desconhecido: ${key}`);
      const previous = sessionKey;
      sessionKey = key;
      try { return await fn(adapter); } finally { sessionKey = previous; }
    },
    /** Volta ao estado inicial com o seed indicado. */
    reset(newSeed = seed) {
      state = { ...initialState(newSeed, adminId, nowIso()), ...allowlistState(allowlistSeed, nowIso()) };
      printFiles.clear();
      pendingFailures.clear();
      offline = false;
      save();
    },
    users: MOCK_USERS,
  };

  return Object.assign(adapter, { mock });
}
