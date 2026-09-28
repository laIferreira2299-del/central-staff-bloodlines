// Implementação do contrato (js/data/adapter.js) sobre o Supabase.
// A segurança de verdade é a RLS do banco (supabase/03_rls.sql); as checagens aqui
// só dão respostas rápidas e mensagens claras, com os mesmos códigos do mock.
// As permissões de quem está logado vêm do banco (RPC current_staff_profile).
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config.js';
import {
  EDITABLE_FIELDS, EXPORT_FORMAT, PROCEDURE_DEFAULTS, byStaffName, fail, ok, pickEditable, pickStaffMember,
} from './adapter.js';
import { STATUSES, validateProcedure, validateStaffMember } from '../core/validate.js';
import {
  CEO, ROLE_CODES, canReadAudience, permissionChangesError, roleLevel, staffChangeError,
} from '../core/permissions.js';

const STAFF_COLUMNS = 'discord_id, display_name, role, teams, active, created_at';


/** Perfil do banco → formato do contrato. */
function toStaff(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    discord_id: profile.discord_id,
    display_name: profile.display_name,
    role: profile.role,
    level: profile.level ?? roleLevel(profile.role),
    teams: [...(profile.teams ?? [])],
    permissions: [...(profile.permissions ?? [])].sort(),
  };
}

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
  if (code === 'KB422') return { code: 'VALIDATION', details: { errors: { _: message } } };
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
      discord_id: discord?.provider_id ?? discord?.identity_data?.provider_id ?? discord?.identity_data?.sub ?? null,
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

  let names = new Map();
  const withTeams = (m) => (m ? { ...m, teams: [...(m.teams ?? [])] } : m);

  async function session() {
    const { data, error } = await sb.auth.getSession();
    if (error) return null;
    return data.session ?? null;
  }

  async function currentStaff() {
    const s = await session();
    if (!s) return { error: fail('UNAUTHORIZED') };
    const { data, error, status } = await sb.rpc('current_staff_profile');
    if (error) return { error: failFrom(error, status) };
    return { staff: toStaff(data) };
  }

  /**
   * Garante sessão, cadastro na staff e (opcionalmente) uma permissão.
   * Devolve { staff, can } ou { error }.
   */
  async function guard(need = 'staff') {
    const { staff, error } = await currentStaff();
    if (error) return { error };
    if (!staff) return { error: fail('FORBIDDEN') };
    const can = (code) => staff.permissions.includes(code);
    if (need !== 'staff' && !can(need)) return { error: fail('FORBIDDEN') };
    return { staff, can };
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
      names = new Map();
      const { error } = await sb.auth.signOut();
      return error ? failFrom(error, error.status) : ok(null);
    },

    onAuthChange(cb) {
      let active = true;
      const pending = new Set();
      const { data } = sb.auth.onAuthStateChange((event, s) => {
        if (event === 'TOKEN_REFRESHED') return;
        // Consultas de sessão devem ocorrer depois que o callback liberar o lock do Auth.
        const timer = setTimeout(() => {
          pending.delete(timer);
          if (active) cb(toSession(s));
        }, 0);
        pending.add(timer);
      });
      return { data: { unsubscribe: () => {
        active = false;
        for (const timer of pending) clearTimeout(timer);
        pending.clear();
        data.subscription.unsubscribe();
      } }, error: null };
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
      const { staff, can, error: g } = await guard('procedimentos.editar');
      if (g) return g;
      const next = { ...PROCEDURE_DEFAULTS, ...pickEditable(data) };
      if (next.status === 'arquivado' && !can('procedimentos.arquivar')) return fail('FORBIDDEN');
      const { valid, errors } = validateProcedure(next);
      if (!valid) return validation(errors);
      if (!canReadAudience(staff.permissions, next.audience)) return fail('FORBIDDEN');
      const { data: row, error, status } = await sb.from('procedures').insert(editableOf(next)).select('*').single();
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(present(row));
    },

    async updateProcedure(id, data, expectedVersion) {
      const { staff, can, error: g } = await guard();
      if (g) return g;
      const { proc: old, error: e } = await fetchById(id);
      if (e) return e;
      if (!can('procedimentos.editar')) return fail('FORBIDDEN');
      const next = { ...editableOf(old), ...pickEditable(data) };
      const touchesArchive = old.status === 'arquivado' || next.status === 'arquivado';
      if (touchesArchive && !can('procedimentos.arquivar')) return fail('FORBIDDEN');
      if (!Number.isInteger(expectedVersion)) return validation({ version: 'Versão: informe a versão que você estava editando.' });
      if (expectedVersion !== old.version) return conflict(id);
      const { valid, errors } = validateProcedure(next);
      if (!valid) return validation(errors);
      if (!canReadAudience(staff.permissions, next.audience)) return fail('FORBIDDEN');
      const { data: row, error, status } = await sb.from('procedures')
        .update({ ...editableOf(next), version: expectedVersion }).eq('id', id).select('*').single();
      if (error) return error.code === 'KB409' ? conflict(id) : failFrom(error, status);
      await loadNames();
      return ok(present(row));
    },

    async setStatus(id, statusValue) {
      const { can, error: g } = await guard();
      if (g) return g;
      const { proc: old, error: e } = await fetchById(id);
      if (e) return e;
      if (!can('procedimentos.editar')) return fail('FORBIDDEN');
      if (!STATUSES.includes(statusValue)) return validation({ status: 'Status: use ativo, revisar ou arquivado.' });
      if ((old.status === 'arquivado' || statusValue === 'arquivado') && !can('procedimentos.arquivar')) return fail('FORBIDDEN');
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
      const { error: g } = await guard('procedimentos.arquivar');
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
      const { can, error: g } = await guard();
      if (g) return g;
      const { proc, error: e } = await fetchById(procedureId);
      if (e || !proc) return e ?? fail('NOT_FOUND');
      if (!can('procedimentos.favoritar')) return fail('FORBIDDEN');
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
      const { error: g } = await guard('procedimentos.backup');
      if (g) return g;
      const { data, error, status } = await sb.from('procedures').select('*');
      if (error) return failFrom(error, status);
      return ok({ format: EXPORT_FORMAT, version: 1, exported_at: new Date().toISOString(), procedures: data.sort(byTitle) });
    },

    async importAll(payload, { dryRun = false } = {}) {
      const { can, error: g } = await guard('procedimentos.backup');
      if (g) return g;
      if (!can('procedimentos.editar')) return fail('FORBIDDEN');
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

    /* ----- equipe (staff_members; RLS e trigger em supabase/05_staff_admin.sql) ----- */
    async listStaff() {
      const { error: g } = await guard('equipe.ver');
      if (g) return g;
      const { data, error, status } = await sb.from('staff_members').select(STAFF_COLUMNS);
      if (error) return failFrom(error, status);
      return ok(data.map(withTeams).sort(byStaffName));
    },

    async createStaffMember(member) {
      const { staff, error: g } = await guard('equipe.gerenciar');
      if (g) return g;
      const next = pickStaffMember(member);
      const { valid, errors } = validateStaffMember(next);
      if (!valid) return validation(errors);
      // O último CEO só é conferido pelo banco (aqui não há a lista completa).
      const blocked = staffChangeError(staff, null, next);
      if (blocked) return validation({ _: blocked });
      const { data, error, status } = await sb.from('staff_members').insert(next).select(STAFF_COLUMNS).single();
      if (error?.code === '23505') return validation({ discord_id: 'Discord ID: já cadastrado na staff.' });
      if (error) return failFrom(error, status);
      names = new Map();
      return ok(withTeams(data));
    },

    async updateStaffMember(discordId, changes) {
      const { staff, error: g } = await guard('equipe.gerenciar');
      if (g) return g;
      const patch = pickStaffMember(changes, { partial: true });
      delete patch.discord_id;
      const { data: found, error: e, status: s } = await sb.from('staff_members')
        .select(STAFF_COLUMNS).eq('discord_id', discordId).maybeSingle();
      if (e) return failFrom(e, s);
      if (!found) return fail('NOT_FOUND', 'Membro não encontrado.');
      const old = withTeams(found);
      const next = { ...old, ...patch };
      const { valid, errors } = validateStaffMember(next);
      if (!valid) return validation(errors);
      const blocked = staffChangeError(staff, old, next);
      if (blocked) return validation({ _: blocked });
      const { data, error, status } = await sb.from('staff_members')
        .update(patch).eq('discord_id', discordId).select(STAFF_COLUMNS).single();
      if (error) return failFrom(error, status);
      names = new Map();
      return ok(withTeams(data));
    },

    async deleteStaffMember(discordId) {
      const { staff, error: g } = await guard('equipe.gerenciar');
      if (g) return g;
      const { data: found, error: e, status: s } = await sb.from('staff_members')
        .select(STAFF_COLUMNS).eq('discord_id', discordId).maybeSingle();
      if (e) return failFrom(e, s);
      if (!found) return fail('NOT_FOUND', 'Membro não encontrado.');
      const blocked = staffChangeError(staff, withTeams(found), 'delete');
      if (blocked) return validation({ _: blocked });
      const { data, error, status } = await sb.from('staff_members')
        .delete().eq('discord_id', discordId).select('discord_id');
      if (error) return failFrom(error, status);
      if (!data?.length) return fail('NOT_FOUND', 'Membro não encontrado.');
      names = new Map();
      return ok(null);
    },

    /* ----- grade de permissões (role_permissions; RLS no 03, travas e RPC no 02) ----- */
    async listPermissionGrid() {
      const { error: g } = await guard();
      if (g) return g;
      return readGrid();
    },

    async setPermissions(changes) {
      const { staff, error: g } = await guard('permissoes.editar');
      if (g) return g;
      const blocked = permissionChangesError(staff.role, changes);
      if (blocked) return validation({ _: blocked });
      if (changes.length) {
        // Uma chamada = uma transação no banco: tudo ou nada.
        const { error, status } = await sb.rpc('set_role_permissions', {
          p_changes: changes.map(({ role, permission, allowed }) => ({ role, permission, allowed })),
        });
        if (error) return failFrom(error, status);
      }
      return readGrid();
    },
  };

  async function readGrid() {
    const [perms, rows] = await Promise.all([
      sb.from('permissions').select('code, description, ceo_only, default_roles, sort_order').order('sort_order'),
      sb.from('role_permissions').select('role, permission, allowed'),
    ]);
    if (perms.error) return failFrom(perms.error, perms.status);
    if (rows.error) return failFrom(rows.error, rows.status);
    const grid = Object.fromEntries(ROLE_CODES.filter((r) => r !== CEO).map((r) => [r, {}]));
    for (const p of perms.data) for (const r of Object.keys(grid)) grid[r][p.code] = false;
    for (const row of rows.data) if (grid[row.role]) grid[row.role][row.permission] = row.allowed;
    return ok({
      permissions: perms.data.map((p) => ({
        code: p.code, description: p.description, ceo_only: p.ceo_only, default_roles: [...(p.default_roles ?? [])],
      })),
      grid,
    });
  }

  return adapter;
}
