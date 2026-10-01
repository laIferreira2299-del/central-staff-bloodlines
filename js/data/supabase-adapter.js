// Implementação do contrato (js/data/adapter.js) sobre o Supabase.
// A segurança de verdade é a RLS do banco (supabase/03_rls.sql); as checagens aqui
// só dão respostas rápidas e mensagens claras, com os mesmos códigos do mock.
// As permissões de quem está logado vêm do banco (RPC current_staff_profile).
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config.js';
import {
  EDITABLE_FIELDS, EXPORT_FORMAT, PROCEDURE_DEFAULTS, byStaffName, fail, ok, pickEditable, pickStaffMember,
  AL_DEFAULTS, WEBHOOK_COLUMNS, pickAlAnswers, pickAlEvaluation, pickAlParticipants, pickWebhook,
} from './adapter.js';
import {
  ALLOWLIST_ERRORS, DISCORD_SEND_ERRORS, MAX_PRINTS, validateDiscordRoleIds, printError, validateAlEvaluation, validateAlExtras, validateWebhook,
} from '../core/allowlist.js';
import { STATUSES, validateProcedure, validateStaffMember } from '../core/validate.js';
import {
  BLOCKED_NAME_FIELDS, CHECKLIST_FIELDS, LORE_ERRORS, QUESTION_FIELDS, photoError, pickCharacter, pickFields,
  validateBlockedName, validateCharacter, validateCharacterNote, validateChecklistItem, validateQuestion,
} from '../core/lore.js';
import { PRODUCTIVITY_ERRORS } from '../core/productivity.js';
import { RULE_ERRORS, pickRule, validateRule } from '../core/rules.js';
import { CONFLICT_PREFIX, MEETING_STATUS_ERRORS, participantLabel, pickMeeting, validateMeeting } from '../core/agenda.js';
import {
  PROPOSAL_ERRORS, PROPOSAL_NOTE_MAX, proposalStatus, validateAnnouncement, validateEvaluation,
} from '../core/workflow.js';
import {
  CEO, ROLE_CODES, canReadAudience, permissionChangesError, roleLevel, staffChangeError,
} from '../core/permissions.js';

const STAFF_COLUMNS = 'discord_id, display_name, role, teams, active, created_at';
const EVALUATION_COLUMNS = 'id, period_id, evaluated_id, evaluator_id, status, criteria, overall, strengths, improvements, '
  + 'feedback, recommendation, created_at, updated_at, submitted_at, read_by, read_at';
/** Nunca inclui url: o site não tem privilégio de leitura nessa coluna (10_allowlist.sql). */
const WEBHOOK_SELECT = WEBHOOK_COLUMNS.join(', ');
const ATTACHMENT_COLUMNS = 'id, evaluation_id, storage_path, file_name, mime, size, position, created_at';
const PRINTS_BUCKET = 'al-prints';
const PHOTOS_BUCKET = 'character-photos';
// '*' (e não a lista): o campo status só existe depois do SQL 18; o site funciona com o banco antigo e com o novo.
const MEETING_COLUMNS = '*, meeting_participants (kind, value)';
const RULE_COLUMNS = 'id, title, category, content, position, created_by, created_at, updated_by, updated_at';
const CHARACTER_COLUMNS = 'id, character_name, discord_name, discord_id, city_id, photo_path, status, version, created_by, created_at, updated_by, updated_at';
const FUNCTION_NAME = 'enviar-discord';

/**
 * Busca do histórico → filtro "or" do PostgREST. Tira os caracteres que mudam a sintaxe
 * do filtro (vírgula, parênteses, aspas, curingas) e põe o valor entre aspas.
 */
export function alSearchFilter(query) {
  const q = String(query ?? '').replace(/[,()"\\%*:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!q) return null;
  return ['author_handle', 'player_discord_id', 'character_name', 'al_id'].map((c) => `${c}.ilike."%${q}%"`).join(',');
}

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
    features: [...(profile.features ?? [])].sort(),
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
  /* ---------- Etapas 8 e 9 ---------- */
  /** Erro KB422 com mensagem conhecida → erro no campo certo (o resto segue o mapError). */
  function fieldFail(error, status, byMessage) {
    const field = error?.code === 'KB422' ? byMessage[error.message] : null;
    return field ? validation({ [field]: error.message }) : failFrom(error, status);
  }

  /** Gabarito e checklist: cria (sem id) ou edita; autoria pelo banco. */
  async function saveConfigRow(table, input, fields, validate, defaults) {
    const { error: g } = await guard('lore.gerenciar');
    if (g) return g;
    let current = null;
    if (input.id) {
      const { data, error, status } = await sb.from(table).select('*').eq('id', input.id).maybeSingle();
      if (error) return failFrom(error, status);
      if (!data) return fail('NOT_FOUND', 'Registro não encontrado.');
      current = data;
    }
    const next = { ...defaults, ...(current ?? {}), ...pickFields(input, fields) };
    if (!Number.isInteger(next.position)) {
      if (current) next.position = current.position;
      else {
        const { data } = await sb.from(table).select('position').order('position', { ascending: false }).limit(1);
        next.position = (data?.[0]?.position ?? 0) + 1;
      }
    }
    const { valid, errors } = validate(next);
    if (!valid) return validation(errors);
    const row = Object.fromEntries(fields.map((f) => [f, next[f]]));
    const q = current ? sb.from(table).update(row).eq('id', current.id) : sb.from(table).insert(row);
    const { data, error, status } = await q.select('*').maybeSingle();
    if (error) return failFrom(error, status);
    return data ? ok(data) : fail('NOT_FOUND', 'Registro não encontrado.');
  }

  /** Links temporários (1 hora) das fotos dos personagens. */
  async function photoUrls(rows) {
    const paths = rows.map((c) => c.photo_path).filter(Boolean);
    if (!paths.length) return new Map();
    const signed = await sb.storage.from(PHOTOS_BUCKET).createSignedUrls(paths, 3600);
    return new Map((signed.data ?? []).filter((x) => x.signedUrl).map((x) => [x.path, x.signedUrl]));
  }
  const presentMeeting = ({ meeting_participants: list, ...m }) => ({
    ...m,
    participants: (list ?? []).map((p) => ({ kind: p.kind, value: p.value, label: participantLabel(p, nameOf) })),
    created_by_name: nameOf(m.created_by), updated_by_name: nameOf(m.updated_by),
  });
  const presentRule = (r) => ({ ...r, created_by_name: nameOf(r.created_by), updated_by_name: nameOf(r.updated_by) });
  const presentCharacter = (c, urls) => ({
    ...c, photo_url: c.photo_path ? urls.get(c.photo_path) ?? null : null,
    created_by_name: nameOf(c.created_by), updated_by_name: nameOf(c.updated_by),
  });

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

    /* ----- Etapa 2B: propostas (supabase/07_aprovacao.sql) ----- */
    async listProposals() {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.from('procedure_proposals').select('*').order('created_at', { ascending: false });
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map(presentProposal));
    },

    async createProposal({ procedure_id: procedureId = null, base_version: baseVersion = null, data } = {}) {
      const { error: g } = await guard('procedimentos.editar');
      if (g) return g;
      let current = null;
      if (procedureId) {
        const found = await fetchById(procedureId);
        if (found.error) return found.error;
        current = found.proc;
        if (!Number.isInteger(baseVersion)) return validation({ version: 'Versão: informe a versão que você estava editando.' });
      }
      const next = { ...PROCEDURE_DEFAULTS, ...(current ? editableOf(current) : {}), ...pickEditable(data) };
      next.status = proposalStatus(next);
      const { valid, errors } = validateProcedure(next);
      if (!valid) return validation(errors);
      const { data: taken } = await sb.from('procedures').select('id').eq('slug', next.slug);
      if (taken?.some((r) => r.id !== current?.id)) return validation({ slug: 'Slug: já existe outro procedimento com este endereço.' });
      const { data: row, error, status } = await sb.from('procedure_proposals')
        .insert({ procedure_id: procedureId, base_version: procedureId ? baseVersion : null, data: editableOf(next) })
        .select('*').single();
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(presentProposal(row));
    },

    async cancelProposal(id) {
      const { error: g } = await guard();
      if (g) return g;
      const { error, status } = await sb.rpc('cancel_procedure_proposal', { p_id: id });
      if (error) return error.code === 'KB404' ? fail('NOT_FOUND', 'Proposta não encontrada ou já analisada.') : failFrom(error, status);
      return ok(null);
    },

    async reviewProposal(id, { approve, note = '' } = {}) {
      const { error: g } = await guard('procedimentos.aprovar');
      if (g) return g;
      const text = String(note ?? '').trim();
      if (text.length > PROPOSAL_NOTE_MAX) return validation({ _: PROPOSAL_ERRORS.noteMax });
      if (!approve && !text) return validation({ _: PROPOSAL_ERRORS.rejectNote });
      const { data, error, status } = await sb.rpc('review_procedure_proposal', { p_id: id, p_approve: Boolean(approve), p_note: text });
      if (error) return failFrom(error, status);
      return ok({ status: data.status, procedure_id: data.procedure_id });
    },

    /* ----- Etapa 3: avaliações (supabase/08_avaliacoes.sql) ----- */
    async listEvaluationPeriods() {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!seesEvaluations(can)) return fail('FORBIDDEN');
      const { data, error, status } = await sb.from('staff_evaluation_periods').select('*').order('starts_at', { ascending: false });
      return error ? failFrom(error, status) : ok(data);
    },

    async saveEvaluationPeriod(period = {}) {
      const { error: g } = await guard('avaliacoes.gerenciar');
      if (g) return g;
      const title = String(period.title ?? '').trim();
      const errors = {};
      if (!title || title.length > 80) errors.title = 'Nome do período: de 1 a 80 caracteres.';
      const startsAt = period.starts_at ?? new Date().toISOString();
      if (!period.ends_at || !(new Date(period.ends_at) > new Date(startsAt))) errors.ends_at = 'Fim: precisa ser depois do início.';
      if (Object.keys(errors).length) return validation(errors);
      const row = { title, starts_at: startsAt, ends_at: period.ends_at };
      const q = period.id
        ? sb.from('staff_evaluation_periods').update(row).eq('id', period.id)
        : sb.from('staff_evaluation_periods').insert(row);
      const { data, error, status } = await q.select('*').maybeSingle();
      if (error) return failFrom(error, status);
      return data ? ok(data) : fail('NOT_FOUND', 'Período não encontrado.');
    },

    async listEvaluationCriteria() {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!seesEvaluations(can)) return fail('FORBIDDEN');
      const { data, error, status } = await sb.from('staff_evaluation_criteria').select('id, label, sort_order, active').order('sort_order');
      return error ? failFrom(error, status) : ok(data);
    },

    async saveEvaluationCriterion(c = {}) {
      const { error: g } = await guard('avaliacoes.gerenciar');
      if (g) return g;
      const label = String(c.label ?? '').trim();
      if (!label || label.length > 80) return validation({ label: 'Critério: de 1 a 80 caracteres.' });
      const row = { label };
      if (Number.isInteger(c.sort_order)) row.sort_order = c.sort_order;
      if (typeof c.active === 'boolean') row.active = c.active;
      if (!c.id && row.sort_order == null) {
        const { data: last } = await sb.from('staff_evaluation_criteria').select('sort_order').order('sort_order', { ascending: false }).limit(1);
        row.sort_order = (last?.[0]?.sort_order ?? 0) + 1;
      }
      const q = c.id ? sb.from('staff_evaluation_criteria').update(row).eq('id', c.id) : sb.from('staff_evaluation_criteria').insert(row);
      const { data, error, status } = await q.select('id, label, sort_order, active').maybeSingle();
      if (error) return failFrom(error, status);
      return data ? ok(data) : fail('NOT_FOUND', 'Critério não encontrado.');
    },

    async listEvaluableMembers() {
      const { error: g } = await guard('avaliacoes.criar');
      if (g) return g;
      const { data, error, status } = await sb.rpc('evaluable_members');
      return error ? failFrom(error, status) : ok(data ?? []);
    },

    async listEvaluations() {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.from('staff_evaluations').select(EVALUATION_COLUMNS);
      if (error) return failFrom(error, status);
      await loadNames();
      const when = (e) => e.submitted_at ?? e.updated_at;
      return ok(data.sort((a, b) => when(b).localeCompare(when(a))).map(presentEvaluation));
    },

    async saveEvaluation(input = {}) {
      const { error: g } = await guard('avaliacoes.criar');
      if (g) return g;
      let before = null;
      if (input.id) {
        const { data, error, status } = await sb.from('staff_evaluations').select(EVALUATION_COLUMNS).eq('id', input.id).maybeSingle();
        if (error) return failFrom(error, status);
        if (!data) return fail('NOT_FOUND', 'Avaliação não encontrada.');
        before = data;
      }
      const fields = ['period_id', 'evaluated_id', 'status', 'criteria', 'overall', 'strengths', 'improvements', 'feedback', 'recommendation'];
      const after = { ...(before ?? { status: 'rascunho', criteria: [], overall: null, strengths: '', improvements: '', feedback: '', recommendation: null }) };
      for (const f of fields) if (f in input) after[f] = structuredClone(input[f]);
      for (const f of ['strengths', 'improvements', 'feedback']) after[f] = String(after[f] ?? '');
      after.overall = after.overall ?? null;
      after.recommendation = after.recommendation || null;
      const { valid, errors } = validateEvaluation(after);
      if (!valid) return validation(errors);
      const row = Object.fromEntries(fields.map((f) => [f, after[f]]));
      const q = before
        ? sb.from('staff_evaluations').update(row).eq('id', before.id)
        : sb.from('staff_evaluations').insert(row);
      const { data, error, status } = await q.select(EVALUATION_COLUMNS).maybeSingle();
      if (error) return failFrom(error, status);
      if (!data) return fail('NOT_FOUND', 'Avaliação não encontrada.');
      await loadNames();
      return ok(presentEvaluation(data));
    },

    async deleteEvaluation(id) {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.from('staff_evaluations').delete().eq('id', id).eq('status', 'rascunho').select('id');
      if (error) return failFrom(error, status);
      return data?.length ? ok(null) : fail('NOT_FOUND', 'Rascunho não encontrado.');
    },

    async markEvaluationRead(id) {
      const { error: g } = await guard('avaliacoes.ler');
      if (g) return g;
      const { error, status } = await sb.rpc('mark_staff_evaluation_read', { p_id: id });
      return error ? failFrom(error, status) : ok(null);
    },

    async archiveEvaluation(id) {
      const { error: g } = await guard('avaliacoes.gerenciar');
      if (g) return g;
      const { error, status } = await sb.rpc('archive_staff_evaluation', { p_id: id });
      return error ? failFrom(error, status) : ok(null);
    },

    /* ----- Etapa 11: avisos (supabase/09_avisos_auditoria.sql) ----- */
    async listAnnouncements() {
      const { staff, error: g } = await guard();
      if (g) return g;
      const [list, reads] = await Promise.all([
        sb.from('announcements').select('*').order('starts_at', { ascending: false }),
        sb.from('announcement_reads').select('announcement_id, read_at, acknowledged_at').eq('discord_id', staff.discord_id),
      ]);
      if (list.error) return failFrom(list.error, list.status);
      if (reads.error) return failFrom(reads.error, reads.status);
      await loadNames();
      const mine = new Map(reads.data.map((r) => [r.announcement_id, r]));
      return ok(list.data.map((a) => ({
        ...a, audience_roles: [...(a.audience_roles ?? [])], created_by_name: nameOf(a.created_by),
        my_read_at: mine.get(a.id)?.read_at ?? null, my_acknowledged_at: mine.get(a.id)?.acknowledged_at ?? null,
      })));
    },

    async saveAnnouncement(input = {}) {
      const { error: g } = await guard('avisos.enviar');
      if (g) return g;
      const next = {
        title: String(input.title ?? '').trim(), body: String(input.body ?? ''), priority: input.priority ?? 'normal',
        audience_roles: [...new Set(input.audience_roles ?? [])].sort(), starts_at: input.starts_at ?? new Date().toISOString(),
        ends_at: input.ends_at || null, requires_ack: Boolean(input.requires_ack),
      };
      const { valid, errors } = validateAnnouncement(next);
      if (!valid) return validation(errors);
      const q = input.id ? sb.from('announcements').update(next).eq('id', input.id) : sb.from('announcements').insert(next);
      const { data, error, status } = await q.select('*').maybeSingle();
      if (error) return failFrom(error, status);
      if (!data) return fail('NOT_FOUND', 'Aviso não encontrado.');
      await loadNames();
      return ok({ ...data, created_by_name: nameOf(data.created_by), my_read_at: null, my_acknowledged_at: null });
    },

    async deleteAnnouncement(id) {
      const { error: g } = await guard('avisos.enviar');
      if (g) return g;
      const { data, error, status } = await sb.from('announcements').delete().eq('id', id).select('id');
      if (error) return failFrom(error, status);
      return data?.length ? ok(null) : fail('NOT_FOUND', 'Aviso não encontrado.');
    },

    async markAnnouncementRead(id, { ack = false } = {}) {
      const { error: g } = await guard();
      if (g) return g;
      const { error, status } = await sb.rpc('mark_announcement_read', { p_id: id, p_ack: Boolean(ack) });
      if (error) return error.code === 'KB404' ? fail('NOT_FOUND', 'Aviso não encontrado.') : failFrom(error, status);
      return ok(null);
    },

    async getAnnouncementReport(id) {
      const { error: g } = await guard('avisos.enviar');
      if (g) return g;
      const { data, error, status } = await sb.rpc('announcement_read_report', { p_id: id });
      return error ? failFrom(error, status) : ok(data ?? []);
    },

    /* ----- Etapa 11: auditoria ----- */
    async listAudit({ entity = '', entityId = '', limit = 100, before = null } = {}) {
      const { error: g } = await guard('auditoria.ver');
      if (g) return g;
      let q = sb.from('audit_log').select('*').order('id', { ascending: false }).limit(Math.min(Math.max(1, limit), 500));
      if (entity) q = q.eq('entity', entity);
      if (entityId) q = q.eq('entity_id', entityId);
      if (before != null) q = q.lt('id', before);
      const { data, error, status } = await q;
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map((a) => ({ ...a, actor_name: nameOf(a.actor) })));
    },

    /* ----- Etapa 5: gabarito, checklist e nomes proibidos (supabase/10_allowlist.sql) ----- */
    async listInterviewQuestions({ includeInactive = false } = {}) {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!usesAllowlist(can)) return fail('FORBIDDEN', ALLOWLIST_ERRORS.forbidden);
      let q = sb.from('interview_questions').select('*').order('position');
      if (!includeInactive) q = q.eq('active', true);
      const { data, error, status } = await q;
      return error ? failFrom(error, status) : ok(data);
    },

    async listChecklistItems({ includeInactive = false } = {}) {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!usesAllowlist(can)) return fail('FORBIDDEN', ALLOWLIST_ERRORS.forbidden);
      let q = sb.from('al_checklist_items').select('*').order('stage').order('position');
      if (!includeInactive) q = q.eq('active', true);
      const { data, error, status } = await q;
      return error ? failFrom(error, status) : ok(data);
    },

    async listBlockedNames({ includeInactive = false } = {}) {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!usesAllowlist(can) && !can('lore.consultar')) return fail('FORBIDDEN');
      let q = sb.from('blocked_names').select('*').order('name');
      if (!includeInactive) q = q.eq('active', true);
      const { data, error, status } = await q;
      return error ? failFrom(error, status) : ok(data.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')));
    },

    /* ----- Etapa 5: análises de allowlist e entrevistas ----- */
    async listAlEvaluations({ kind = '', status: st = '', createdBy = '', query = '', limit = 100, before = null } = {}) {
      const { error: g } = await guard();
      if (g) return g;
      let q = sb.from('al_evaluations').select('*').order('created_at', { ascending: false }).limit(Math.min(Math.max(1, limit), 200));
      if (kind) q = q.eq('kind', kind);
      if (st) q = q.eq('status', st);
      if (createdBy) q = q.eq('created_by', createdBy);
      if (before) q = q.lt('created_at', before);
      const search = alSearchFilter(query);
      if (search) q = q.or(search);
      const { data, error, status } = await q;
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map(presentAl));
    },

    async getAlEvaluation(id) {
      const { error: g } = await guard();
      if (g) return g;
      return alDetail(id);
    },

    async saveAlEvaluation(input = {}) {
      const { staff, error: g } = await guard('allowlist.avaliar');
      if (g) return g;
      let before = null;
      if (input.id) {
        const found = await fetchAl(input.id);
        if (found.error) return found.error;
        before = found.row;
        if (before.created_by !== staff.discord_id) return fail('FORBIDDEN', ALLOWLIST_ERRORS.notAuthor);
        if (before.sent_to_discord_at) return validation({ _: ALLOWLIST_ERRORS.sent });
      }
      const next = { ...(before ?? { ...structuredClone(AL_DEFAULTS), kind: input.kind }), ...pickAlEvaluation(input) };
      const { valid, errors } = validateAlEvaluation(next);
      const answers = Array.isArray(input.answers) ? pickAlAnswers(input.answers) : null;
      const participants = Array.isArray(input.participants) ? pickAlParticipants(input.participants, staff.discord_id) : null;
      const extras = validateAlExtras(next.kind, { answers, participants });
      if (!valid || !extras.valid) return validation({ ...errors, ...extras.errors });
      const fields = pickAlEvaluation(next);
      const q = before
        ? sb.from('al_evaluations').update(fields).eq('id', before.id)
        : sb.from('al_evaluations').insert({ kind: next.kind, ...fields });
      const { data: row, error, status } = await q.select('*').maybeSingle();
      if (error) return failFrom(error, status);
      if (!row) return fail('NOT_FOUND', 'Análise não encontrada.');
      // Respostas e participantes: substitui os atuais (se o passo falhar, a análise já está salva;
      // salvar de novo com o id completa).
      if (answers) {
        const del = await sb.from('al_evaluation_answers').delete().eq('evaluation_id', row.id);
        if (del.error) return failFrom(del.error, del.status);
        if (answers.length) {
          const ins = await sb.from('al_evaluation_answers').insert(answers.map((a) => ({ evaluation_id: row.id, ...a })));
          if (ins.error) return failFrom(ins.error, ins.status);
        }
      }
      if (participants) {
        const del = await sb.from('al_evaluation_participants').delete().eq('evaluation_id', row.id).neq('role', 'responsavel');
        if (del.error) return failFrom(del.error, del.status);
        if (participants.length) {
          const ins = await sb.from('al_evaluation_participants').insert(participants.map((p) => ({ evaluation_id: row.id, ...p })));
          if (ins.error) return failFrom(ins.error, ins.status);
        }
      }
      return alDetail(row.id);
    },

    async addAlPrint(evaluationId, file) {
      const { staff, error: g } = await guard('allowlist.avaliar');
      if (g) return g;
      const found = await fetchAl(evaluationId);
      if (found.error) return found.error;
      if (found.row.created_by !== staff.discord_id) return fail('FORBIDDEN', ALLOWLIST_ERRORS.notAuthor);
      if (found.row.sent_to_discord_at) return validation({ _: ALLOWLIST_ERRORS.sent });
      const used = await sb.from('al_attachments').select('position').eq('evaluation_id', evaluationId);
      if (used.error) return failFrom(used.error, used.status);
      const bad = printError(file, used.data.length);
      if (bad) return validation({ file: bad });
      const position = [...Array(MAX_PRINTS).keys()].map((i) => i + 1).find((p) => !used.data.some((a) => a.position === p));
      const path = `${evaluationId}/${globalThis.crypto.randomUUID()}.${file.type.split('/')[1].replace('jpeg', 'jpg')}`;
      const up = await sb.storage.from(PRINTS_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
      if (up.error) return failFrom(up.error, up.error.statusCode ?? up.error.status);
      const { data, error, status } = await sb.from('al_attachments').insert({
        evaluation_id: evaluationId, storage_path: path, file_name: String(file.name ?? '').slice(0, 200),
        mime: file.type, size: file.size, position,
      }).select(ATTACHMENT_COLUMNS).single();
      if (error) {
        await sb.storage.from(PRINTS_BUCKET).remove([path]);
        return failFrom(error, status);
      }
      return ok(presentAttachment(data));
    },

    async removeAlPrint(attachmentId) {
      const { staff, error: g } = await guard('allowlist.avaliar');
      if (g) return g;
      const { data: att, error: e, status: s } = await sb.from('al_attachments').select(ATTACHMENT_COLUMNS).eq('id', attachmentId).maybeSingle();
      if (e) return failFrom(e, s);
      if (!att) return fail('NOT_FOUND', 'Print não encontrado.');
      const found = await fetchAl(att.evaluation_id);
      if (found.error) return found.error;
      if (found.row.created_by !== staff.discord_id) return fail('FORBIDDEN', ALLOWLIST_ERRORS.notAuthor);
      if (found.row.sent_to_discord_at) return validation({ _: ALLOWLIST_ERRORS.sent });
      const { data, error, status } = await sb.from('al_attachments').delete().eq('id', attachmentId).select('id');
      if (error) return failFrom(error, status);
      if (!data?.length) return fail('NOT_FOUND', 'Print não encontrado.');
      // Se o arquivo não sair do Storage, sobra só o arquivo (a limpeza de 90 dias apaga).
      await sb.storage.from(PRINTS_BUCKET).remove([att.storage_path]);
      return ok(null);
    },

    async getAlPrintUrls(evaluationId) {
      const { error: g } = await guard();
      if (g) return g;
      const found = await fetchAl(evaluationId);
      if (found.error) return found.error;
      const { data, error, status } = await sb.from('al_attachments').select(ATTACHMENT_COLUMNS)
        .eq('evaluation_id', evaluationId).order('position');
      if (error) return failFrom(error, status);
      if (!data.length) return ok([]);
      const signed = await sb.storage.from(PRINTS_BUCKET).createSignedUrls(data.map((a) => a.storage_path), 3600);
      if (signed.error) return failFrom(signed.error, signed.error.statusCode ?? signed.error.status);
      const byPath = new Map((signed.data ?? []).map((x) => [x.path, x.signedUrl]));
      return ok(data.filter((a) => byPath.get(a.storage_path)).map((a) => ({ id: a.id, url: byPath.get(a.storage_path) })));
    },

    /* ----- Etapa 5: webhooks do Discord (a url nunca é lida) ----- */
    async listDiscordWebhooks({ purpose = '' } = {}) {
      const { error: g } = await guard();
      if (g) return g;
      let q = sb.from('discord_webhooks').select(WEBHOOK_SELECT).order('name');
      if (purpose) q = q.eq('purpose', purpose);
      const { data, error, status } = await q;
      return error ? failFrom(error, status) : ok(data.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')));
    },

    async saveDiscordWebhook(input = {}) {
      const { error: g } = await guard('webhooks.gerenciar');
      if (g) return g;
      let current = null;
      if (input.id) {
        const { data, error, status } = await sb.from('discord_webhooks').select(WEBHOOK_SELECT).eq('id', input.id).maybeSingle();
        if (error) return failFrom(error, status);
        if (!data) return fail('NOT_FOUND', 'Webhook não encontrado.');
        current = data;
      }
      const patch = pickWebhook(input);
      const next = { channel_name: '', sender_name: '', sender_avatar_url: '', active: true, ...(current ?? {}), ...patch };
      const { valid, errors } = validateWebhook(next, { creating: !current });
      if (!valid) return validation(errors);
      if (current && !Object.keys(patch).length) return ok(current);
      const row = current ? patch : {
        name: next.name, url: next.url, purpose: next.purpose, channel_name: next.channel_name,
        sender_name: next.sender_name, sender_avatar_url: next.sender_avatar_url, active: next.active,
      };
      const q = current
        ? sb.from('discord_webhooks').update(row).eq('id', current.id)
        : sb.from('discord_webhooks').insert(row);
      const { data, error, status } = await q.select(WEBHOOK_SELECT).maybeSingle();
      if (error) return failFrom(error, status);
      return data ? ok(data) : fail('NOT_FOUND', 'Webhook não encontrado.');
    },

    async deleteDiscordWebhook(id) {
      const { error: g } = await guard('webhooks.gerenciar');
      if (g) return g;
      const { data, error, status } = await sb.from('discord_webhooks').delete().eq('id', id).select('id');
      if (error) return failFrom(error, status);
      return data?.length ? ok(null) : fail('NOT_FOUND', 'Webhook não encontrado.');
    },

    /* ----- Etapa 8: gabarito, checklist e nomes proibidos (lore.gerenciar) ----- */
    async saveInterviewQuestion(input = {}) {
      return saveConfigRow('interview_questions', input, QUESTION_FIELDS, validateQuestion, { answer: '', extra_note: '', active: true });
    },

    async saveChecklistItem(input = {}) {
      return saveConfigRow('al_checklist_items', input, CHECKLIST_FIELDS, validateChecklistItem, { hint: '', active: true });
    },

    async saveBlockedName(input = {}) {
      const { error: g } = await guard('lore.gerenciar');
      if (g) return g;
      let current = null;
      if (input.id) {
        const { data, error, status } = await sb.from('blocked_names').select('*').eq('id', input.id).maybeSingle();
        if (error) return failFrom(error, status);
        if (!data) return fail('NOT_FOUND', 'Nome não encontrado.');
        current = data;
      }
      if (current?.reason === 'em_uso' || (!current && input.reason === 'em_uso')) return validation({ _: ALLOWLIST_ERRORS.nameInUse });
      const patch = pickFields(input, BLOCKED_NAME_FIELDS);
      const next = { series: '', reason_text: '', mode: 'bloqueia', active: true, ...(current ?? {}), ...patch };
      const { valid, errors } = validateBlockedName(next);
      if (!valid) return validation(errors);
      const row = Object.fromEntries(BLOCKED_NAME_FIELDS.map((f) => [f, next[f]]));
      const q = current ? sb.from('blocked_names').update(row).eq('id', current.id) : sb.from('blocked_names').insert(row);
      const { data, error, status } = await q.select('*').maybeSingle();
      if (error) return fieldFail(error, status, { [ALLOWLIST_ERRORS.nameDuplicate]: 'name' });
      return data ? ok(data) : fail('NOT_FOUND', 'Nome não encontrado.');
    },

    /* ----- Etapa 9: personagens em uso (12_lore.sql) ----- */
    async listCharacters() {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!can('lore.consultar') && !can('lore.gerenciar')) return fail('FORBIDDEN');
      const { data, error, status } = await sb.from('lore_characters').select(CHARACTER_COLUMNS).order('character_name');
      if (error) return failFrom(error, status);
      await loadNames();
      const urls = await photoUrls(data);
      return ok(data.map((c) => presentCharacter(c, urls)).sort((a, b) => a.character_name.localeCompare(b.character_name, 'pt-BR')));
    },

    async getCharacter(id) {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!can('lore.consultar') && !can('lore.gerenciar')) return fail('FORBIDDEN');
      const { data, error, status } = await sb.from('lore_characters').select(CHARACTER_COLUMNS).eq('id', id).maybeSingle();
      if (error) return failFrom(error, status);
      if (!data) return fail('NOT_FOUND', 'Personagem não encontrado.');
      const [revs, notes] = await Promise.all([
        sb.from('lore_character_revisions').select('*').eq('character_id', id).order('version', { ascending: false }),
        can('lore.anotacoes') ? sb.rpc('character_notes', { p_character: id }) : Promise.resolve({ data: [] }),
        loadNames(),
      ]);
      if (revs.error) return failFrom(revs.error, revs.status);
      if (notes.error) return failFrom(notes.error, notes.status);
      const urls = await photoUrls([data]);
      return ok({
        ...presentCharacter(data, urls),
        revisions: revs.data.map((r) => ({ ...r, changed_by_name: nameOf(r.changed_by) })),
        notes: (notes.data ?? []).map((n) => ({ ...n, created_by_name: nameOf(n.created_by) })),
      });
    },

    async saveCharacter(input = {}) {
      const { error: g } = await guard('lore.gerenciar');
      if (g) return g;
      let current = null;
      if (input.id) {
        const { data, error, status } = await sb.from('lore_characters').select(CHARACTER_COLUMNS).eq('id', input.id).maybeSingle();
        if (error) return failFrom(error, status);
        if (!data) return fail('NOT_FOUND', 'Personagem não encontrado.');
        current = data;
      }
      const next = { status: 'ativo', ...(current ? pickCharacter(current) : {}), ...pickCharacter(input) };
      const { valid, errors } = validateCharacter(next);
      if (!valid) return validation(errors);
      const q = current ? sb.from('lore_characters').update(next).eq('id', current.id) : sb.from('lore_characters').insert(next);
      const { data, error, status } = await q.select(CHARACTER_COLUMNS).maybeSingle();
      if (error) return fieldFail(error, status, { [LORE_ERRORS.duplicateCharacter]: 'character_name', [LORE_ERRORS.duplicateCityId]: 'city_id' });
      if (!data) return fail('NOT_FOUND', 'Personagem não encontrado.');
      await loadNames();
      return ok(presentCharacter(data, await photoUrls([data])));
    },

    async setCharacterPhoto(id, file) {
      const { error: g } = await guard('lore.gerenciar');
      if (g) return g;
      const { data: c, error: e, status: s } = await sb.from('lore_characters').select(CHARACTER_COLUMNS).eq('id', id).maybeSingle();
      if (e) return failFrom(e, s);
      if (!c) return fail('NOT_FOUND', 'Personagem não encontrado.');
      let path = null;
      if (file) {
        const bad = photoError(file);
        if (bad) return validation({ file: bad });
        path = `${id}/${globalThis.crypto.randomUUID()}.${file.type.split('/')[1].replace('jpeg', 'jpg')}`;
        const up = await sb.storage.from(PHOTOS_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
        if (up.error) return failFrom(up.error, up.error.statusCode ?? up.error.status);
      }
      const { data, error, status } = await sb.from('lore_characters').update({ photo_path: path }).eq('id', id).select(CHARACTER_COLUMNS).maybeSingle();
      if (error || !data) {
        if (path) await sb.storage.from(PHOTOS_BUCKET).remove([path]);
        return error ? failFrom(error, status) : fail('NOT_FOUND', 'Personagem não encontrado.');
      }
      if (c.photo_path) await sb.storage.from(PHOTOS_BUCKET).remove([c.photo_path]);
      await loadNames();
      return ok(presentCharacter(data, await photoUrls([data])));
    },

    async addCharacterNote(characterId, input = {}) {
      const { error: g } = await guard('lore.anotacoes');
      if (g) return g;
      const next = { about: String(input.about ?? ''), body: String(input.body ?? '').trim() };
      const { valid, errors } = validateCharacterNote(next);
      if (!valid) return validation(errors);
      const { data, error, status } = await sb.from('character_admin_notes').insert({ character_id: characterId, ...next }).select('*').maybeSingle();
      if (error) return error.code === '23503' ? fail('NOT_FOUND', 'Personagem não encontrado.') : failFrom(error, status);
      await loadNames();
      return ok({ ...data, created_by_name: nameOf(data.created_by) });
    },

    async deleteCharacterNote(id) {
      const { error: g } = await guard('lore.anotacoes');
      if (g) return g;
      const { data, error, status } = await sb.from('character_admin_notes').delete().eq('id', id).select('id');
      if (error) return failFrom(error, status);
      return data?.length ? ok(null) : fail('NOT_FOUND', 'Anotação não encontrada.');
    },

    /* ----- Livro de Regras (15_regras.sql) ----- */
    async listRules() {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!can('regras.ler') && !can('regras.editar')) return fail('FORBIDDEN');
      const { data, error, status } = await sb.from('rules').select(RULE_COLUMNS)
        .order('category').order('position').order('title');
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map(presentRule));
    },

    async saveRule(input = {}) {
      const { error: g } = await guard('regras.editar');
      if (g) return g;
      let current = null;
      if (input.id) {
        const { data, error, status } = await sb.from('rules').select(RULE_COLUMNS).eq('id', input.id).maybeSingle();
        if (error) return failFrom(error, status);
        if (!data) return fail('NOT_FOUND', 'Regra não encontrada.');
        current = data;
      }
      const next = { position: 0, ...(current ? pickRule(current) : {}), ...pickRule(input) };
      const { valid, errors } = validateRule(next);
      if (!valid) return validation(errors);
      const q = current ? sb.from('rules').update(next).eq('id', current.id) : sb.from('rules').insert(next);
      const { data, error, status } = await q.select(RULE_COLUMNS).maybeSingle();
      if (error) return fieldFail(error, status, { [RULE_ERRORS.duplicate]: 'title' });
      if (!data) return fail('NOT_FOUND', 'Regra não encontrada.');
      await loadNames();
      return ok(presentRule(data));
    },

    async deleteRule(id) {
      const { error: g } = await guard('regras.editar');
      if (g) return g;
      const { data, error, status } = await sb.from('rules').delete().eq('id', id).select('id');
      if (error) return failFrom(error, status);
      return data?.length ? ok(null) : fail('NOT_FOUND', 'Regra não encontrada.');
    },

    /* ----- Agenda de Reuniões (17_agenda.sql) ----- */
    async listMeetings() {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!can('agenda.ler') && !can('agenda.gerenciar')) return fail('FORBIDDEN');
      const { data, error, status } = await sb.from('meetings').select(MEETING_COLUMNS).order('starts_at').order('title');
      if (error) return failFrom(error, status);
      await loadNames();
      return ok(data.map(presentMeeting));
    },

    async saveMeeting(input = {}) {
      const { error: g } = await guard('agenda.gerenciar');
      if (g) return g;
      let current = null;
      if (input.id) {
        const { data, error, status } = await sb.from('meetings').select(MEETING_COLUMNS).eq('id', input.id).maybeSingle();
        if (error) return failFrom(error, status);
        if (!data) return fail('NOT_FOUND', 'Reunião não encontrada.');
        current = presentMeeting(data);
      }
      const next = { participants: [], ...(current ? pickMeeting(current) : {}), ...pickMeeting(input) };
      const { valid, errors } = validateMeeting(next);
      if (!valid) return validation(errors);
      // Uma transação só no banco (save_meeting): reunião e convocados juntos; conflito de horário não grava nada.
      const { data: id, error, status } = await sb.rpc('save_meeting', {
        p_id: current?.id ?? null, p_title: next.title, p_description: next.description ?? null,
        p_starts_at: new Date(next.starts_at).toISOString(), p_discord_link: next.discord_link ?? null, p_participants: next.participants,
      });
      if (error) {
        if (error.code === 'KB422' && String(error.message).startsWith(CONFLICT_PREFIX)) return validation({ starts_at: error.message });
        return error.code === 'KB404' ? fail('NOT_FOUND', 'Reunião não encontrada.') : failFrom(error, status);
      }
      const row = { id };
      const { data, error: e2, status: s2 } = await sb.from('meetings').select(MEETING_COLUMNS).eq('id', row.id).maybeSingle();
      if (e2) return failFrom(e2, s2);
      await loadNames();
      return ok(presentMeeting(data));
    },

    async checkMeetingConflict(input = {}) {
      const { error: g } = await guard('agenda.gerenciar');
      if (g) return g;
      const next = pickMeeting(input);
      if (!next.starts_at || Number.isNaN(Date.parse(next.starts_at))) return ok(null);
      const { data, error, status } = await sb.rpc('check_meeting_conflict', {
        p_id: input.id ?? null, p_starts_at: new Date(next.starts_at).toISOString(), p_participants: next.participants ?? [],
      });
      if (error) return failFrom(error, status);
      return ok(data ?? null);
    },

    async deleteMeeting(id) {
      const { error: g } = await guard('agenda.gerenciar');
      if (g) return g;
      const { data, error, status } = await sb.from('meetings').delete().eq('id', id).select('id');
      if (error) return failFrom(error, status);
      return data?.length ? ok(null) : fail('NOT_FOUND', 'Reunião não encontrada.');
    },

    /* ----- Botões da Agenda: status (18_agenda_status.sql) e avisos no Discord (Edge Function, ação 'reuniao') ----- */
    async startMeeting(id) {
      const { error: g } = await guard('agenda.gerenciar');
      if (g) return g;
      const moved = await moveMeeting(id, 'agendada', 'em_andamento', MEETING_STATUS_ERRORS.notStarted);
      if (moved.error) return moved;
      // O status já mudou: se o aviso no privado falhar, a reunião continua iniciada e a tela mostra o motivo.
      const sent = await sendMeetingMessage(id, 'inicio');
      return ok({ meeting: moved.data, dm: sent.error ? null : sent.data?.dm ?? null, dm_error: sent.error ? (sent.error.details?.errors?._ ?? sent.error.message) : null });
    },

    async endMeeting(id) {
      const { error: g } = await guard('agenda.gerenciar');
      if (g) return g;
      return moveMeeting(id, 'em_andamento', 'concluida', MEETING_STATUS_ERRORS.notRunning);
    },

    async announceMeeting(id, { webhookId = null } = {}) {
      const { error: g } = await guard('agenda.gerenciar');
      if (g) return g;
      return sendMeetingMessage(id, 'anuncio', webhookId);
    },

    async notifyMeeting(id) {
      const { error: g } = await guard('agenda.gerenciar');
      if (g) return g;
      return sendMeetingMessage(id, 'convocacao');
    },

    /* ----- Etapa 10: produtividade (13_produtividade.sql) ----- */
    async getProductivity({ from, to } = {}) {
      const { error: g } = await guard('produtividade.ver');
      if (g) return g;
      if (!from || !to || !(Date.parse(to) > Date.parse(from))) return validation({ _: PRODUCTIVITY_ERRORS.period });
      const { data, error, status } = await sb.rpc('staff_productivity', { p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString() });
      if (error) return failFrom(error, status);
      const iso = (m) => ({ ...m, last_at: m.last_at ? new Date(m.last_at).toISOString() : null });
      const byName = (a, b) => (a.display_name ?? a.discord_id).localeCompare(b.display_name ?? b.discord_id, 'pt-BR');
      return ok({
        totals: data.totals, daily: data.daily,
        members: data.members.map(iso).sort(byName), inactive: data.inactive.map(iso).sort(byName),
      });
    },

    async listStaffNames() {
      const { error: g } = await guard();
      if (g) return g;
      const { data, error, status } = await sb.rpc('staff_names');
      if (error) return failFrom(error, status);
      return ok(data.map((r) => ({ discord_id: r.discord_id, display_name: r.display_name }))
        .sort((a, b) => a.display_name.localeCompare(b.display_name, 'pt-BR')));
    },

    /* ----- Etapa 7: envio ao Discord pela Edge Function (a url do webhook nunca vem ao site) ----- */
    async sendAlToDiscord(evaluationId, { webhookId, resend = false } = {}) {
      const { error: g } = await guard('allowlist.avaliar');
      if (g) return g;
      return invokeSend({ action: 'enviar', evaluation_id: evaluationId, webhook_id: webhookId, resend: Boolean(resend) });
    },

    async sendAnnouncementToDiscord(announcementId, { webhookId = null, siteUrl = '', channel = true, dm = false } = {}) {
      const { error: g } = await guard('avisos.enviar');
      if (g) return g;
      const res = await invokeSend({ action: 'aviso', announcement_id: announcementId, webhook_id: webhookId, site_url: siteUrl, channel, dm });
      // A função antiga (antes da Decisão 11) não conhece a ação "aviso".
      if (res.error?.message === 'Ação desconhecida.') return fail('NETWORK', DISCORD_SEND_ERRORS.outdatedFunction);
      return res;
    },

    async listDiscordRoleIds() {
      const { can, error: g } = await guard();
      if (g) return g;
      if (!can('webhooks.gerenciar') && !can('avisos.enviar')) return fail('FORBIDDEN');
      const { data, error, status } = await sb.from('discord_role_ids').select('role, discord_role_id').order('role');
      return error ? failFrom(error, status) : ok(data);
    },

    async saveDiscordRoleIds(map = {}) {
      const { error: g } = await guard('webhooks.gerenciar');
      if (g) return g;
      const { valid, errors } = validateDiscordRoleIds(map);
      if (!valid) return fail('VALIDATION', Object.values(errors)[0], { errors });
      const entries = Object.entries(map).map(([role, id]) => [role, String(id ?? '').trim()]);
      const upserts = entries.filter(([, id]) => id).map(([role, discord_role_id]) => ({ role, discord_role_id }));
      const removes = entries.filter(([, id]) => !id).map(([role]) => role);
      if (upserts.length) {
        const { error, status } = await sb.from('discord_role_ids').upsert(upserts, { onConflict: 'role' });
        if (error) return failFrom(error, status);
      }
      if (removes.length) {
        const { error, status } = await sb.from('discord_role_ids').delete().in('role', removes);
        if (error) return failFrom(error, status);
      }
      return adapter.listDiscordRoleIds();
    },

    async testDiscordWebhook(webhookId) {
      const { error: g } = await guard('webhooks.gerenciar');
      if (g) return g;
      return invokeSend({ action: 'testar', webhook_id: webhookId });
    },
  };

  /**
   * Chama a Edge Function enviar-discord. Ela responde { data, error } no formato do contrato;
   * 404 da própria função = ainda não instalada no Supabase.
   */
  async function invokeSend(body) {
    const { data, error } = await sb.functions.invoke(FUNCTION_NAME, { body });
    if (!error) return data?.error ? fail(data.error.code, data.error.message, data.error.details) : ok(data?.data ?? null);
    const response = error.context;
    // Sem resposta legível: função não instalada (o Supabase responde 404 sem CORS) ou rede.
    if (typeof response?.json !== 'function') return fail('NETWORK', DISCORD_SEND_ERRORS.unreachable);
    const payload = await response.json().catch(() => null);
    if (payload?.error?.code) return fail(payload.error.code, payload.error.message, payload.error.details);
    if (response.status === 404) return fail('NETWORK', DISCORD_SEND_ERRORS.missingFunction);
    return failFrom({ message: payload?.message ?? error.message }, response.status);
  }

  /** Muda o status só se a reunião está no estado esperado (from); o banco também só deixa andar para a frente. */
  async function moveMeeting(id, from, to, wrongState) {
    const { data, error, status } = await sb.from('meetings').update({ status: to }).eq('id', id).eq('status', from).select(MEETING_COLUMNS);
    if (error) {
      if (error.code === '42703') return validation({ _: MEETING_STATUS_ERRORS.noStatus });
      return error.code === 'KB422' ? validation({ _: error.message }) : failFrom(error, status);
    }
    if (!data?.length) {
      const { data: row, error: e2, status: s2 } = await sb.from('meetings').select('id').eq('id', id).maybeSingle();
      if (e2) return failFrom(e2, s2);
      return row ? validation({ _: wrongState }) : fail('NOT_FOUND', 'Reunião não encontrada.');
    }
    await loadNames();
    return ok(presentMeeting(data[0]));
  }

  /** Avisos da reunião pela Edge Function: kind 'anuncio' (canal), 'convocacao' ou 'inicio' (privado). */
  async function sendMeetingMessage(id, kind, webhookId = null) {
    const res = await invokeSend({ action: 'reuniao', meeting_id: id, kind, webhook_id: webhookId });
    // A função antiga (antes dos botões da Agenda) não conhece a ação 'reuniao'.
    if (res.error?.message === 'Ação desconhecida.') return fail('NETWORK', DISCORD_SEND_ERRORS.outdatedFunction);
    return res;
  }

  /* ---------- Etapa 5: apoio da Allowlist ---------- */
  const usesAllowlist = (can) => can('allowlist.avaliar') || can('allowlist.historico') || can('lore.gerenciar');
  const presentAl = (e) => ({ ...e, eval_flags: e.eval_flags ?? [], checklist: e.checklist ?? [], created_by_name: nameOf(e.created_by) });
  const presentAttachment = ({ evaluation_id, ...a }) => a;

  async function fetchAl(id) {
    const { data, error, status } = await sb.from('al_evaluations').select('*').eq('id', id).maybeSingle();
    if (error) return { error: failFrom(error, status) };
    if (!data) return { error: fail('NOT_FOUND', 'Análise não encontrada.') };
    return { row: data };
  }

  async function alDetail(id) {
    const found = await fetchAl(id);
    if (found.error) return found.error;
    const [parts, answers, atts] = await Promise.all([
      sb.from('al_evaluation_participants').select('discord_id, role').eq('evaluation_id', id),
      sb.from('al_evaluation_answers').select('question_id, question_text, note, send_to_discord, position').eq('evaluation_id', id).order('position'),
      sb.from('al_attachments').select(ATTACHMENT_COLUMNS).eq('evaluation_id', id).order('position'),
      loadNames(),
    ]);
    for (const r of [parts, answers, atts]) if (r.error) return failFrom(r.error, r.status);
    return ok({
      ...presentAl(found.row),
      participants: parts.data.map((p) => ({ ...p, display_name: nameOf(p.discord_id) }))
        .sort((a, b) => (a.role === 'responsavel' ? -1 : b.role === 'responsavel' ? 1 : 0)),
      answers: answers.data,
      attachments: atts.data.map(presentAttachment),
    });
  }

  const seesEvaluations = (can) => can('avaliacoes.criar') || can('avaliacoes.ler') || can('avaliacoes.gerenciar');
  const presentProposal = (p) => ({ ...p, created_by_name: nameOf(p.created_by), reviewed_by_name: nameOf(p.reviewed_by) });
  const presentEvaluation = (e) => ({ ...e, criteria: e.criteria ?? [], evaluated_name: nameOf(e.evaluated_id), evaluator_name: nameOf(e.evaluator_id) });

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
