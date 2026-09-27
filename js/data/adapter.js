// =============================================================================
// CONTRATO DA CAMADA DE DADOS (SPEC 3.3)
// -----------------------------------------------------------------------------
// A interface NUNCA fala direto com o Supabase: toda leitura e escrita passa por
// um objeto que implementa as funções abaixo. Há duas implementações:
//   - js/data/mock-adapter.js      (memória/localStorage; dev e testes)
//   - js/data/supabase-adapter.js  (produção; Etapa 7)
// Os MESMOS testes (tests/contract/contract-suite.mjs) rodam contra as duas.
//
// Regras gerais
//   - Toda função é assíncrona e resolve { data, error }; nunca lança exceção.
//     Sucesso: error === null. Falha: data === null e error = { code, message, details? }.
//   - Os objetos devolvidos são cópias: alterar o retorno não altera o armazenamento.
//   - Campos de auditoria (id, version, created_*, updated_*, last_reviewed_*) são
//     definidos pelo servidor; o que o cliente enviar nesses campos é ignorado.
//   - Nada é apagado: "excluir" = setStatus(id, 'arquivado').
//   - Toda alteração de procedimento grava o estado ANTERIOR em revisões.
//
// Códigos de erro (error.code)
//   UNAUTHORIZED  sem sessão (não logado).
//   FORBIDDEN     logado, mas o papel não permite a ação (tabela 2.2), ou não é staff.
//   NOT_FOUND     registro inexistente (ou invisível para quem pediu).
//   CONFLICT      updateProcedure com expectedVersion diferente da versão atual.
//                 error.details = { current: Procedure, updated_by_name: string|null }.
//   VALIDATION    dados inválidos. error.details = { errors: { [campo]: mensagem } }
//                 (importAll: { items: [{ index, slug, errors }] }).
//   NETWORK       sem conexão ou falha de comunicação.
//
// Permissões (tabela 2.2; o banco aplica via RLS, o mock simula)
//   Ação                                   suporte  moderador  admin   não-staff  anônimo
//   ler procedimentos / revisões           sim      sim        sim     lista []   UNAUTHORIZED
//   listar favoritos próprios              sim      sim        sim     lista []   UNAUTHORIZED
//   adicionar/remover favorito             sim      sim        sim     FORBIDDEN  UNAUTHORIZED
//   criar / editar                         sim      sim        sim     FORBIDDEN  UNAUTHORIZED
//   arquivar / restaurar status            não      sim        sim     FORBIDDEN  UNAUTHORIZED
//   editar procedimento arquivado          não      sim        sim     FORBIDDEN  UNAUTHORIZED
//   restaurar revisão                      não      sim        sim     FORBIDDEN  UNAUTHORIZED
//   exportar / importar                    não      não        sim     FORBIDDEN  UNAUTHORIZED
//   ("não" = FORBIDDEN)
//
// Não-staff logado: listProcedures devolve [] (é o comportamento da RLS: o SELECT
// simplesmente não retorna linhas); getProcedure devolve NOT_FOUND; escritas e
// favoritos devolvem FORBIDDEN (o adapter confere se é staff antes de gravar);
// listFavorites e listRevisions devolvem []; getCurrentStaff devolve data = null.
// Staff com active = false é tratado como não-staff.
// =============================================================================

/**
 * @typedef {'UNAUTHORIZED'|'FORBIDDEN'|'NOT_FOUND'|'CONFLICT'|'VALIDATION'|'NETWORK'} ErrorCode
 * @typedef {{ code: ErrorCode, message: string, details?: any }} AdapterError
 * @template T
 * @typedef {Promise<{ data: T, error: null } | { data: null, error: AdapterError }>} Result
 *
 * @typedef {'suporte'|'moderador'|'admin'} Role
 * @typedef {{ discord_id: string, display_name: string, role: Role }} Staff
 * @typedef {{ user: { id: string, discord_id: string|null, name: string, avatar_url: string|null } }} Session
 *
 * @typedef {{ title: string, body: string }} Step
 * @typedef {{ command: string, description: string }} Command
 * @typedef {{
 *   id: string, slug: string, title: string, category: string,
 *   audience: 'suporte'|'moderador'|'ambos'|'allowlist', tags: string[], summary: string,
 *   who_handles: string, steps: Step[], commands: Command[], ready_message: string,
 *   notes: string, source_url: string, status: 'ativo'|'revisar'|'arquivado',
 *   last_reviewed_at: string|null, last_reviewed_by: string|null, last_reviewed_by_name: string|null,
 *   version: number,
 *   created_by: string, created_by_name: string|null, created_at: string,
 *   updated_by: string, updated_by_name: string|null, updated_at: string
 * }} Procedure  (datas em ISO 8601; *_by = discord_id; *_by_name = nome em staff_members)
 *
 * @typedef {{
 *   id: string, procedure_id: string, version: number, snapshot: Procedure,
 *   changed_by: string, changed_by_name: string|null, changed_at: string
 * }} Revision  (snapshot = o procedimento como era NAQUELA versão; changed_by/at = autor e data daquela versão)
 *
 * @typedef {{ format: 'bloodlines-kb', version: 1, exported_at: string, procedures: Procedure[] }} ExportPayload
 */

/**
 * @typedef {object} DataAdapter
 * @property {() => Result<Session|null>} getSession
 * @property {() => Result<Session|null>} signIn           Inicia o login (Discord). No Supabase redireciona a página.
 * @property {() => Result<null>} signOut
 * @property {(cb: (session: Session|null) => void) => { data: { unsubscribe: () => void }, error: null }} onAuthChange
 *           Síncrono. Chama `cb` a cada mudança de sessão.
 * @property {() => Result<Staff|null>} getCurrentStaff    null = logado mas não é staff ativo.
 * @property {(opts?: { includeArchived?: boolean }) => Result<Procedure[]>} listProcedures
 *           Ordenados por título. Sem includeArchived, os arquivados ficam de fora.
 * @property {(slug: string) => Result<Procedure>} getProcedure    Inclui arquivados.
 * @property {(data: object) => Result<Procedure>} createProcedure
 *           Valida (VALIDATION); slug repetido = VALIDATION em details.errors.slug.
 *           status padrão 'ativo'; criar já 'arquivado' exige moderador/admin.
 * @property {(id: string, data: object, expectedVersion: number) => Result<Procedure>} updateProcedure
 *           Substitui os campos editáveis. Versão diferente = CONFLICT.
 *           Para "sobrescrever mesmo assim", chame de novo com a versão de details.current.
 * @property {(id: string, status: 'ativo'|'revisar'|'arquivado') => Result<Procedure>} setStatus
 *           Entrar ou sair de 'arquivado' exige moderador/admin.
 * @property {(id: string) => Result<Procedure>} markReviewed
 *           "Marcar como revisado hoje": last_reviewed_at = agora, last_reviewed_by = você.
 * @property {(procedureId: string) => Result<Revision[]>} listRevisions   Mais recente primeiro.
 * @property {(revisionId: string) => Result<Procedure>} restoreRevision
 *           Moderador/admin. Aplica o conteúdo da revisão como uma NOVA edição (gera revisão).
 * @property {() => Result<string[]>} listFavorites        IDs dos procedimentos favoritados por você.
 * @property {(procedureId: string) => Result<null>} addFavorite      Idempotente.
 * @property {(procedureId: string) => Result<null>} removeFavorite   Idempotente.
 * @property {() => Result<ExportPayload>} exportAll       Admin. Todos os procedimentos, inclusive arquivados.
 * @property {(payload: ExportPayload, opts?: { dryRun?: boolean }) => Result<{ created: number, updated: number, unchanged: number }>} importAll
 *           Admin. Upsert por slug. Tudo ou nada: se um item for inválido, nada é gravado (VALIDATION).
 *           dryRun = só calcula a prévia ("12 novos, 3 atualizados").
 */

export const ERROR_CODES = Object.freeze({
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VALIDATION: 'VALIDATION',
  NETWORK: 'NETWORK',
});

export const ADAPTER_METHODS = Object.freeze([
  'getSession', 'signIn', 'signOut', 'onAuthChange', 'getCurrentStaff',
  'listProcedures', 'getProcedure', 'createProcedure', 'updateProcedure', 'setStatus', 'markReviewed',
  'listRevisions', 'restoreRevision',
  'listFavorites', 'addFavorite', 'removeFavorite',
  'exportAll', 'importAll',
]);

/** Campos que o cliente pode definir. Todo o resto é do servidor. */
export const EDITABLE_FIELDS = Object.freeze([
  'slug', 'title', 'category', 'audience', 'tags', 'summary', 'who_handles',
  'steps', 'commands', 'ready_message', 'notes', 'source_url', 'status',
]);

export const EXPORT_FORMAT = 'bloodlines-kb';

const DEFAULT_MESSAGES = {
  UNAUTHORIZED: 'Faça login para continuar.',
  FORBIDDEN: 'Seu papel não permite esta ação.',
  NOT_FOUND: 'Registro não encontrado.',
  CONFLICT: 'Este procedimento foi alterado por outra pessoa enquanto você editava.',
  VALIDATION: 'Há campos inválidos.',
  NETWORK: 'Sem conexão. As alterações não foram salvas.',
};

/** @template T @param {T} data */
export const ok = (data) => ({ data, error: null });

/** @param {ErrorCode} code */
export const fail = (code, message = DEFAULT_MESSAGES[code], details) =>
  ({ data: null, error: details === undefined ? { code, message } : { code, message, details } });

/** Garante que o objeto implementa todo o contrato. Lança erro com as funções que faltam. */
export function assertAdapter(adapter) {
  const missing = ADAPTER_METHODS.filter((m) => typeof adapter?.[m] !== 'function');
  if (missing.length) throw new Error(`Adapter incompleto; faltam: ${missing.join(', ')}`);
  return adapter;
}

const str = (v) => (typeof v === 'string' ? v.trim() : v ?? '');

/**
 * Normaliza o que veio do cliente: mantém só os campos editáveis, apara espaços e
 * garante listas. Não valida (use validateProcedure depois).
 */
export function pickEditable(data = {}) {
  const src = data && typeof data === 'object' ? data : {};
  const out = {};
  for (const f of EDITABLE_FIELDS) if (f in src) out[f] = src[f];
  for (const f of ['slug', 'title', 'category', 'audience', 'summary', 'who_handles', 'source_url', 'status']) {
    if (f in out) out[f] = str(out[f]);
  }
  for (const f of ['ready_message', 'notes']) if (f in out && out[f] == null) out[f] = '';
  if ('tags' in out) out.tags = Array.isArray(out.tags) ? out.tags.map(str).filter((t) => t !== '') : out.tags;
  if (Array.isArray(out.steps)) {
    out.steps = out.steps.map((s) => (s && typeof s === 'object' ? { title: str(s.title), body: s.body ?? '' } : s));
  }
  if (Array.isArray(out.commands)) {
    out.commands = out.commands.map((c) => (c && typeof c === 'object' ? { command: str(c.command), description: str(c.description) } : c));
  }
  return out;
}

/** Valores padrão de um procedimento novo. */
export const PROCEDURE_DEFAULTS = Object.freeze({
  tags: [], who_handles: '', commands: [], ready_message: '', notes: '', source_url: '', status: 'ativo',
});
