// Implementação em memória do contrato (js/data/adapter.js), com persistência opcional
// em localStorage. SIMULA as regras do banco: papéis (2.2), conflito de versão (2.7),
// revisões automáticas (2.8), arquivamento em vez de exclusão e auditoria pelo "servidor".
// Uso: desenvolvimento local (DATA_MODE = 'mock') e testes.
import {
  EDITABLE_FIELDS, EXPORT_FORMAT, PROCEDURE_DEFAULTS, fail, ok, pickEditable,
} from './adapter.js';
import { STATUSES, validateProcedure } from '../core/validate.js';

/** Usuários simulados. `role: null` = logado mas não cadastrado em staff_members. */
export const MOCK_USERS = Object.freeze({
  suporte: { id: 'mock-u-suporte', discord_id: '100000000000000001', name: 'Suporte Teste', role: 'suporte', active: true },
  moderador: { id: 'mock-u-moderador', discord_id: '100000000000000002', name: 'Moderador Teste', role: 'moderador', active: true },
  admin: { id: 'mock-u-admin', discord_id: '100000000000000003', name: 'Admin Teste', role: 'admin', active: true },
  inativo: { id: 'mock-u-inativo', discord_id: '100000000000000004', name: 'Ex-staff Teste', role: 'moderador', active: false },
  naostaff: { id: 'mock-u-naostaff', discord_id: '100000000000000009', name: 'Visitante Teste', role: null, active: false },
});

const STATE_VERSION = 1;
const clone = (v) => structuredClone(v);
const byTitle = (a, b) => a.title.localeCompare(b.title, 'pt-BR');
const uuid = () => globalThis.crypto.randomUUID();

function initialState(seed, adminId, nowIso) {
  const staff = Object.values(MOCK_USERS)
    .filter((u) => u.role)
    .map((u) => ({ discord_id: u.discord_id, display_name: u.name, role: u.role, active: u.active }));
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
  return { v: STATE_VERSION, staff, procedures, revisions: [], favorites: [] };
}

/**
 * @param {{
 *   seed?: object[],              procedimentos iniciais (campos editáveis + last_reviewed_at opcional)
 *   user?: keyof MOCK_USERS|null, usuário simulado inicial (padrão: nenhum = deslogado)
 *   storage?: Storage|null,       ex.: window.localStorage; null = só memória
 *   storageKey?: string,
 *   now?: () => Date,             relógio (injetável nos testes)
 * }} [options]
 */
export function createMockAdapter({
  seed = [], user = null, storage = null, storageKey = 'bloodlines-kb:mock', now = () => new Date(),
} = {}) {
  const nowIso = () => now().toISOString();
  const adminId = MOCK_USERS.admin.discord_id;

  let state = load() ?? initialState(seed, adminId, nowIso());
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
      return parsed?.v === STATE_VERSION ? parsed : null;
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
  const canModerate = (staff) => staff?.role === 'moderador' || staff?.role === 'admin';

  function notify() {
    const session = sessionOf(currentUser());
    for (const cb of listeners) { try { cb(clone(session)); } catch { /* ouvinte com erro não derruba os outros */ } }
  }

  /**
   * Executa uma operação respeitando: rede, sessão e papel.
   * level: 'session' (só exige login) | 'staff' | 'moderate' | 'admin'
   * Para não-staff, `nonStaff` define a resposta (ex.: lista vazia, como a RLS faria).
   */
  async function run(method, level, fn, { nonStaff } = {}) {
    if (offline) return fail('NETWORK');
    const forced = pendingFailures.get(method);
    if (forced) { pendingFailures.delete(method); return fail(forced); }

    // Relê o armazenamento: outra aba pode ter gravado (simula um banco compartilhado).
    state = load() ?? state;

    const u = currentUser();
    if (!u) return fail('UNAUTHORIZED');
    const staff = staffOf(u);
    if (level !== 'session' && !staff) return nonStaff ? nonStaff() : fail('FORBIDDEN');
    if (level === 'moderate' && !canModerate(staff)) return fail('FORBIDDEN');
    if (level === 'admin' && staff.role !== 'admin') return fail('FORBIDDEN');
    try {
      return await fn({ user: u, staff });
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
        return ok(staff ? { discord_id: staff.discord_id, display_name: staff.display_name, role: staff.role } : null);
      });
    },

    /* ----- leitura ----- */
    async listProcedures({ includeArchived = false } = {}) {
      return run('listProcedures', 'staff', async () => ok(
        state.procedures
          .filter((p) => includeArchived || p.status !== 'arquivado')
          .sort(byTitle)
          .map(present),
      ), { nonStaff: () => ok([]) });
    },

    async getProcedure(slug) {
      return run('getProcedure', 'staff', async () => {
        const p = state.procedures.find((x) => x.slug === slug);
        return p ? ok(present(p)) : fail('NOT_FOUND', 'Procedimento não encontrado.');
      }, { nonStaff: () => fail('NOT_FOUND', 'Procedimento não encontrado.') });
    },

    /* ----- escrita ----- */
    async createProcedure(data) {
      return run('createProcedure', 'staff', async ({ staff }) => {
        const next = { ...PROCEDURE_DEFAULTS, ...pickEditable(data) };
        if (next.status === 'arquivado' && !canModerate(staff)) return fail('FORBIDDEN');
        const invalid = check(next);
        if (invalid) return invalid;
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
      return run('updateProcedure', 'staff', async ({ staff }) => {
        const old = findById(id);
        if (!old) return fail('NOT_FOUND', 'Procedimento não encontrado.');
        const next = { ...editableOf(old), ...pickEditable(data) };
        if (touchesArchive(old.status, next.status) && !canModerate(staff)) return fail('FORBIDDEN');
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
        return ok(present(commit(old, editableOf(next), staff)));
      });
    },

    async setStatus(id, status) {
      return run('setStatus', 'staff', async ({ staff }) => {
        const old = findById(id);
        if (!old) return fail('NOT_FOUND', 'Procedimento não encontrado.');
        if (!STATUSES.includes(status)) return validationError({ status: 'Status: use ativo, revisar ou arquivado.' });
        if (touchesArchive(old.status, status) && !canModerate(staff)) return fail('FORBIDDEN');
        return ok(present(commit(old, { status }, staff)));
      });
    },

    async markReviewed(id) {
      return run('markReviewed', 'staff', async ({ staff }) => {
        const old = findById(id);
        if (!old) return fail('NOT_FOUND', 'Procedimento não encontrado.');
        if (old.status === 'arquivado' && !canModerate(staff)) return fail('FORBIDDEN');
        return ok(present(commit(old, { last_reviewed_at: nowIso(), last_reviewed_by: staff.discord_id }, staff)));
      });
    },

    /* ----- histórico ----- */
    async listRevisions(procedureId) {
      return run('listRevisions', 'staff', async () => ok(
        state.revisions
          .filter((r) => r.procedure_id === procedureId)
          .sort((a, b) => b.version - a.version)
          .map((r) => ({ ...clone(r), snapshot: present(r.snapshot), changed_by_name: nameOf(r.changed_by) })),
      ), { nonStaff: () => ok([]) });
    },

    async restoreRevision(revisionId) {
      return run('restoreRevision', 'moderate', async ({ staff }) => {
        const rev = state.revisions.find((r) => r.id === revisionId);
        if (!rev) return fail('NOT_FOUND', 'Revisão não encontrada.');
        const old = findById(rev.procedure_id);
        if (!old) return fail('NOT_FOUND', 'Procedimento não encontrado.');
        const next = editableOf(rev.snapshot);
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
      return run('addFavorite', 'staff', async ({ user }) => {
        if (!findById(procedureId)) return fail('NOT_FOUND', 'Procedimento não encontrado.');
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
      return run('exportAll', 'admin', async () => ok({
        format: EXPORT_FORMAT,
        version: 1,
        exported_at: nowIso(),
        procedures: [...state.procedures].sort(byTitle).map(clone),
      }));
    },

    async importAll(payload, { dryRun = false } = {}) {
      return run('importAll', 'admin', async ({ staff }) => {
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
  };

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
      state = initialState(newSeed, adminId, nowIso());
      pendingFailures.clear();
      offline = false;
      save();
    },
    users: MOCK_USERS,
  };

  return Object.assign(adapter, { mock });
}
