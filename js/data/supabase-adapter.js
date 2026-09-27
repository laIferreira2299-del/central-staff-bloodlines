// Implementação do contrato (js/data/adapter.js) sobre o Supabase.
// A segurança de verdade é a RLS do banco (supabase/03_rls.sql); as checagens aqui
// só dão respostas rápidas e mensagens claras, com os mesmos códigos do mock.
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config.js';
import { EDITABLE_FIELDS, EXPORT_FORMAT, PROCEDURE_DEFAULTS, fail, ok, pickEditable } from './adapter.js';
import { STATUSES, validateProcedure } from '../core/validate.js';

const byTitle = (a, b) => a.title.localeCompare(b.title, 'pt-BR');
const editableOf = (p) => Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, structuredClone(p[f])]));

/** JSON com chaves ordenadas: o jsonb do Postgres reordena as chaves dos objetos. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Traduz um erro do supabase-js/PostgREST/Postgres para o código do contrato.
 * @param {{ code?: string, message?: string, status?: number }|null} error
 */
export function mapError(error, status) {
  if (!error) return null;
  const code = error.code ?? '';
  const message = error.message ?? '';
  if (code === 'KB409') return { code: 'CONFLICT' };
  if (code === 'KB404' || code === 'PGRST116') return { code: 'NOT_FOUND' };
  if (code === '42501' || status === 403) return { code: 'FORBIDDEN' };
  if (status === 401 || code === 'PGRST301' || /JWT/i.test(message)) return { code: 'UNAUTHORIZED' };
  if (code === '23505') return { code: 'VALIDATION', details: { errors: { slug: 'Slug: já existe outro procedimento com este endereço.' } } };
  if (code === '23514' || code === '22P02' || code === '22023' || code === '23502') {
    return { code: 'VALIDATION', details: { errors: { _: `Dados recusados pelo banco: ${message}` } } };
  }
  if (!status || /fetch|network|Failed to/i.test(message)) return { code: 'NETWORK' };
  return { code: 'NETWORK', message: `Erro inesperado: ${message}` };
}

const failFrom = (error, status) => {
  const mapped = mapError(error, status);
  return fail(mapped.code, mapped.message, mapped.details);
};

/** Sessão do Supabase → formato do contrato. */
function toSession(session) {
  if (!session?.user) return null;
  const u = session.user;
  const discord = (u.identities ?? []).find((i) => i.provider === 'discord');
  const meta = u.user_metadata ?? {};
  return {
    user: {
      id: u.id,
      // Só para exibição; a autorização usa auth.identities no banco.
      discord_id: discord?.id ?? discord?.identity_data?.provider_id ?? discord?.identity_data?.sub ?? null,
      name: meta.full_name ?? meta.custom_claims?.global_name ?? meta.name ?? 'Staff',
      avatar_url: meta.avatar_url ?? null,
    },
  };
}

/**
 * @param {{ client?: import('@supabase/supabase-js').SupabaseClient, redirectTo?: string }} [options]
 */
export function createSupabaseAdapter({ client, redirectTo } = {}) {
  const sb = client ?? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  });

  let staffCache = { userId: null, staff: undefined };
  let names = new Map();

  async function session() {
    const { data, error } = await sb.auth.getSession();
    if (error) return null;
    return data.session ?? null;
  }

  async function currentStaff() {
    const s = await session();
    if (!s) return { error: fail('UNAUTHORIZED') };
    if (staffCache.userId === s.user.id && staffCache.staff !== undefined) return { staff: staffCache.staff };
    const { data, error, status } = await sb.from('staff_members')
      .select('discord_id, display_name, role').eq('active', true).maybeSingle();
    if (error) return { error: failFrom(error, status) };
    staffCache = { userId: s.user.id, staff: data ?? null };
    return { staff: data ?? null };
  }

  /** Garante sessão e (opcionalmente) papel. Devolve { staff } ou { error }. */
  async function guard(level = 'staff') {
    const { staff, error } = await currentStaff();
    if (error) return { error };
    if (!staff) return { error: fail('FORBIDDEN') };
    if (level === 'moderate' && !['moderador', 'admin'].includes(staff.role)) return { error: fail('FORBIDDEN') };
    if (level === 'admin' && staff.role !== 'admin') return { error: fail('FORBIDDEN') };
    return { staff };
  }

  async function loadNames() {
    const { data } = await sb.rpc('staff_names');
    if (Array.isArray(data)) names = new Map(data.map((r) => [r.discord_id, r.display_name]));
  }
  const nameOf = (id) => (id ? names.get(id) ?? null : null);
  const present = (p) => ({
    ...p,
    tags: p.tags ?? [],
    created_by_name: nameOf(p.created_by),
    updated_by_name: nameOf(p.updated_by),
    last_reviewed_by_name: nameOf(p.last_reviewed_by),
  });

  async function fetchById(id) {
    const { data, error, status } = await sb.from('procedures').select('*').eq('id', id).maybeSingle();
    if (error) return { error: failFrom(error, status) };
    if (!data) return { error: fail('NOT_FOUND', 'Procedimento não encontrado.') };
    return { proc: data };
  }

  async function conflict(id) {
    await loadNames();
    const { proc } = await fetchById(id);
    const who = nameOf(proc?.updated_by);
    return fail('CONFLICT', `Este procedimento foi alterado por ${who ?? 'outra pessoa'} enquanto você editava.`, {
      current: proc ? present(proc) : null,
      updated_by_name: who,
    });
  }

  const validation = (errors) => fail('VALIDATION', undefined, { errors });

  const adapter = {
    async getSession() {
      return ok(toSession(await session()));
    },

    async signIn() {
      const target = redirectTo ?? `${location.origin}${location.pathname}${location.hash}`;
      const { error, status } = await sb.auth.signInWithOAuth({ provider: 'discord', options: { redirectTo: target } });
      return error ? failFrom(error, status) : ok(null);
    },

    async signOut() {
      staffCache = { userId: null, staff: undefined };
      names = new Map();
      await sb.auth.signOut();
      return ok(null);
    },

    onAuthChange(cb) {
      const { data } = sb.auth.onAuthStateChange((event, s) => {
        if (event === 'TOKEN_REFRESHED') return;
        staffCache = { userId: null, staff: undefined };
        cb(toSession(s));
      });
      return { data: { unsubscribe: () => data.subscription.unsubscribe() }, error: null };
    },

    async getCurrentStaff() {
      const { staff, error } = await currentStaff();
      return error ?? ok(staff ? { ...staff } : null);
    },

    async listProcedures({ includeArchived = false } = {}) {
      const { error: authError } = await currentStaff();
      if (authError) return authError;
      let query = sb.from('procedures').select('*');
      if (!includeArchived) query = query.neq('status', 'arquivado');
      const [{ data, error, status }] = await Promise.all([query, loadNames()]);
      if (error) return failFrom(error, status);
      return ok(data.map(present).sort(byTitle));
    },

    async getProcedure(slug) {
      const { error: authError } = await currentStaff();
      if (authError) return authError;
      const { data, error, status } = await sb.from('procedures').select('*').eq('slug', slug).maybeSingle();
      if (error) return failFrom(error, status);
      if (!data) return fail('NOT_FOUND', 'Procedimento não encontrado.');
      await loadNames();
      return ok(present(data));
    },

    async createProcedure(data) {
      const { staff, error: g } = await guard();
      if (g) return g;
      const next = { ...PROCEDURE_DEFAULTS, ...pickEditable(data) };
      if (next.status === 'arquivado' && !['moderador', 'admin'].includes(staff.role)) return fail('FORBIDDEN');
      const { valid, errors } = validateProcedure(next);
      if (!valid) return validation(errors);
      const { data: row, error, status } = await sb.from('procedures').insert(editableOf(next)).select('*').single();
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(present(row));
    },

    async updateProcedure(id, data, expectedVersion) {
      const { staff, error: g } = await guard();
      if (g) return g;
      const { proc: old, error: e } = await fetchById(id);
      if (e) return e;
      const next = { ...editableOf(old), ...pickEditable(data) };
      const touchesArchive = old.status === 'arquivado' || next.status === 'arquivado';
      if (touchesArchive && !['moderador', 'admin'].includes(staff.role)) return fail('FORBIDDEN');
      if (!Number.isInteger(expectedVersion)) return validation({ version: 'Versão: informe a versão que você estava editando.' });
      if (expectedVersion !== old.version) return conflict(id);
      const { valid, errors } = validateProcedure(next);
      if (!valid) return validation(errors);
      const { data: row, error, status } = await sb.from('procedures')
        .update({ ...editableOf(next), version: expectedVersion }).eq('id', id).select('*').single();
      if (error) return error.code === 'KB409' ? conflict(id) : failFrom(error, status);
      await loadNames();
      return ok(present(row));
    },

    async setStatus(id, statusValue) {
      const { staff, error: g } = await guard();
      if (g) return g;
      const { proc: old, error: e } = await fetchById(id);
      if (e) return e;
      if (!STATUSES.includes(statusValue)) return validation({ status: 'Status: use ativo, revisar ou arquivado.' });
      if ((old.status === 'arquivado' || statusValue === 'arquivado') && !['moderador', 'admin'].includes(staff.role)) return fail('FORBIDDEN');
      const { data: row, error, status } = await sb.from('procedures')
        .update({ status: statusValue, version: old.version }).eq('id', id).select('*').single();
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(present(row));
    },

    async markReviewed(id) {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.rpc('mark_reviewed', { p_id: id }).single();
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(present(data));
    },

    async listRevisions(procedureId) {
      const { error: authError } = await currentStaff();
      if (authError) return authError;
      const { data, error, status } = await sb.from('procedure_revisions')
        .select('*').eq('procedure_id', procedureId).order('version', { ascending: false });
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map((r) => ({ ...r, snapshot: present(r.snapshot), changed_by_name: nameOf(r.changed_by) })));
    },

    async restoreRevision(revisionId) {
      const { error: g } = await guard('moderate');
      if (g) return g;
      const { data, error, status } = await sb.rpc('restore_revision', { p_revision_id: revisionId }).single();
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(present(data));
    },

    async listFavorites() {
      const { error: authError } = await currentStaff();
      if (authError) return authError;
      const { data, error, status } = await sb.from('favorites').select('procedure_id');
      if (error) return failFrom(error, status);
      return ok(data.map((r) => r.procedure_id));
    },

    async addFavorite(procedureId) {
      const { error: g } = await guard();
      if (g) return g;
      const { proc, error: e } = await fetchById(procedureId);
      if (e || !proc) return e ?? fail('NOT_FOUND');
      const { error, status } = await sb.from('favorites')
        .upsert({ procedure_id: procedureId }, { onConflict: 'user_id,procedure_id', ignoreDuplicates: true });
      return error ? failFrom(error, status) : ok(null);
    },

    async removeFavorite(procedureId) {
      const { error: g } = await guard();
      if (g) return g;
      const { error, status } = await sb.from('favorites').delete().eq('procedure_id', procedureId);
      return error ? failFrom(error, status) : ok(null);
    },

    async exportAll() {
      const { error: g } = await guard('admin');
      if (g) return g;
      const { data, error, status } = await sb.from('procedures').select('*');
      if (error) return failFrom(error, status);
      return ok({ format: EXPORT_FORMAT, version: 1, exported_at: new Date().toISOString(), procedures: data.sort(byTitle) });
    },

    async importAll(payload, { dryRun = false } = {}) {
      const { error: g } = await guard('admin');
      if (g) return g;
      if (!payload || payload.format !== EXPORT_FORMAT || !Array.isArray(payload.procedures)) {
        return validation({ payload: `Arquivo: formato inválido (esperado "${EXPORT_FORMAT}" com a lista de procedimentos).` });
      }
      const items = [];
      const seen = new Set();
      const plan = [];
      payload.procedures.forEach((raw, index) => {
        const next = { ...PROCEDURE_DEFAULTS, ...pickEditable(raw) };
        const { errors } = validateProcedure(next);
        if (next.slug && seen.has(next.slug)) errors.slug = 'Slug: repetido no arquivo.';
        seen.add(next.slug);
        if (Object.keys(errors).length) items.push({ index, slug: next.slug ?? null, errors });
        else plan.push(editableOf(next));
      });
      if (items.length) return fail('VALIDATION', `${items.length} procedimento(s) inválido(s) no arquivo.`, { items });

      if (dryRun) {
        const { data, error, status } = await sb.from('procedures').select('*');
        if (error) return failFrom(error, status);
        const bySlug = new Map(data.map((p) => [p.slug, editableOf({ ...p, tags: p.tags ?? [] })]));
        const summary = { created: 0, updated: 0, unchanged: 0 };
        for (const next of plan) {
          const existing = bySlug.get(next.slug);
          if (!existing) summary.created++;
          else if (stableStringify(existing) === stableStringify(next)) summary.unchanged++;
          else summary.updated++;
        }
        return ok(summary);
      }
      const { data, error, status } = await sb.rpc('import_procedures', { items: plan });
      if (error) return failFrom(error, status);
      return ok({ created: data.created, updated: data.updated, unchanged: data.unchanged });
    },
  };

  return adapter;
}
