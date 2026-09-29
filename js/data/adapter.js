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
//   FORBIDDEN     logado, mas o cargo não tem a permissão da ação, ou não é staff.
//   NOT_FOUND     registro inexistente (ou invisível para quem pediu).
//   CONFLICT      updateProcedure com expectedVersion diferente da versão atual.
//                 error.details = { current: Procedure, updated_by_name: string|null }.
//   VALIDATION    dados inválidos. error.details = { errors: { [campo]: mensagem } }
//                 (importAll: { items: [{ index, slug, errors }] }).
//   NETWORK       sem conexão ou falha de comunicação.
//
// Permissões (Etapa 1): cada ação exige uma permissão do catálogo em js/core/permissions.js.
// O banco aplica via RLS e triggers (has_permission); o mock simula; o CEO tem todas.
//   Ação                                   permissão exigida
//   ler procedimentos / revisões           procedimentos.ler (todos os públicos) ou
//                                          procedimentos.ler_allowlist (só público Allowlist;
//                                          os outros ficam invisíveis: lista sem eles / NOT_FOUND)
//   favoritos e markReviewed               procedimentos.favoritar
//   criar / editar / setStatus 'revisar'   procedimentos.editar
//   arquivar, restaurar, editar arquivado  procedimentos.arquivar (+ editar)
//   restaurar revisão                      procedimentos.arquivar
//   exportar / importar                    procedimentos.backup
//   listStaff                              equipe.ver
//   criar / editar / remover membro        equipe.gerenciar + travas da hierarquia (VALIDATION)
//   ler a grade de permissões              staff ativo
//   alterar a grade (setPermissions)       permissoes.editar + travas (VALIDATION): a coluna do
//                                          CEO não existe; permissões "só CEO" só o CEO muda
//   Etapa 2B · propostas                 enviar: procedimentos.editar · analisar: procedimentos.aprovar
//     Sem procedimentos.aprovar, criar/editar CONTEÚDO de procedimento direto = FORBIDDEN
//     (PROPOSAL_ERRORS.direct): vai por createProposal. Situação (ativo/revisar/arquivar),
//     marcar como revisado e favoritos continuam diretos.
//   Etapa 3 · avaliações                 criar: avaliacoes.criar · ler as dos outros: avaliacoes.ler
//     períodos, critérios e arquivar: avaliacoes.gerenciar. Travas em js/core/workflow.js.
//   Etapa 11 · avisos                    criar, editar, apagar e relatório: avisos.enviar
//   Etapa 11 · auditoria                 listAudit: auditoria.ver (só leitura)
//   Etapa 5 · allowlist e entrevistas    (regras em js/core/allowlist.js; banco no 10_allowlist.sql)
//     gabarito e checklist: allowlist.avaliar, allowlist.historico ou lore.gerenciar
//     nomes proibidos: os mesmos ou lore.consultar
//     análises: criar allowlist.avaliar · ler: o autor e os participantes (allowlist.historico lê
//     todas; invisível = NOT_FOUND) · editar, prints: só o autor (FORBIDDEN com
//     ALLOWLIST_ERRORS.notAuthor), só até o envio ao Discord (VALIDATION sent) · ninguém apaga
//     webhooks: webhooks.gerenciar cadastra e vê todos; quem avalia vê os ativos de allowlist e
//     entrevista; avisos.enviar vê os ativos de avisos (os outros: lista vazia). A url NUNCA volta.
//   Sem a permissão = FORBIDDEN. Padrão por cargo: documento 01-controle-da-staff, seção 2.
//
// Travas da equipe (js/core/permissions.js, staffChangeError): ninguém altera o próprio
// cargo, as próprias equipes, nem se desativa ou se remove; quem não é CEO só gerencia e
// só atribui cargos abaixo do próprio nível e nunca a Direção (Administrador, Manager,
// CEO); sempre sobra um CEO ativo. O discord_id não muda depois de criado.

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
 * @typedef {'allowlist'|'lore'|'suporte'|'moderador'|'head_staff'|'admin'|'manager'|'ceo'} Role
 * @typedef {'allowlist'|'lore'} Team
 * @typedef {{ discord_id: string, display_name: string, role: Role, level: number, teams: Team[], permissions: string[], features: string[] }} Staff
 *           permissions = permissões efetivas (cargo + TAGs; CEO = todas), em ordem alfabética.
 *           features = módulos que o banco já tem ('allowlist', 'aprovacao', 'auditoria', 'avaliacoes', 'avisos');
 *           a tela de cada módulo só aparece quando o SQL dele já rodou.
 * @typedef {{ discord_id: string, display_name: string, role: Role, teams: Team[], active: boolean, created_at: string }} StaffMember
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
 *
 * @typedef {{
 *   permissions: Array<{ code: string, description: string, ceo_only: boolean, default_roles: Role[] }>,
 *   grid: Record<Role, Record<string, boolean>>
 * }} PermissionGrid  (permissions na ordem do catálogo; grid só com os 7 cargos abaixo do CEO)
 * @typedef {{ role: Role, permission: string, allowed: boolean }} PermissionChange
 *
 * @typedef {{
 *   id: string, procedure_id: string|null, base_version: number|null, data: object,
 *   status: 'pendente'|'aprovada'|'recusada'|'cancelada',
 *   created_by: string, created_by_name: string|null, created_at: string,
 *   reviewed_by: string|null, reviewed_by_name: string|null, reviewed_at: string|null, review_note: string
 * }} Proposal  (procedure_id null = procedimento novo; data = campos editáveis propostos)
 * @typedef {{ id: string, title: string, starts_at: string, ends_at: string, created_by: string, created_at: string }} EvaluationPeriod
 * @typedef {{ id: string, label: string, sort_order: number, active: boolean }} EvaluationCriterion
 * @typedef {{
 *   id: string, period_id: string, evaluated_id: string, evaluated_name: string|null,
 *   evaluator_id: string, evaluator_name: string|null, status: 'rascunho'|'enviada'|'arquivada',
 *   criteria: Array<{ id: string, label: string, score: number|null }>, overall: number|null,
 *   strengths: string, improvements: string, feedback: string, recommendation: string|null,
 *   created_at: string, updated_at: string, submitted_at: string|null, read_by: string|null, read_at: string|null
 * }} Evaluation
 * @typedef {{
 *   id: string, title: string, body: string, priority: 'normal'|'importante'|'urgente', audience_roles: Role[],
 *   starts_at: string, ends_at: string|null, requires_ack: boolean, created_by: string, created_by_name: string|null,
 *   created_at: string, my_read_at: string|null, my_acknowledged_at: string|null
 * }} Announcement  (audience_roles vazio = todos)
 * @typedef {{ discord_id: string, display_name: string, role: Role, read_at: string|null, acknowledged_at: string|null }} ReadReportRow
 * @typedef {{ id: number, at: string, actor: string, actor_name: string|null, entity: string, entity_id: string, action: string, before: object|null, after: object|null }} AuditEntry
 *
 * Etapa 5 · allowlist e entrevistas
 * @typedef {{ id: string, section: string, kind: string, question: string, answer: string, extra_note: string, position: number, active: boolean }} InterviewQuestion
 * @typedef {{ id: string, stage: number, stage_title: string, text: string, hint: string, position: number, active: boolean }} ChecklistItem
 * @typedef {{ id: string, name: string, name_norm: string, kind: 'nome'|'sobrenome', reason: 'serie'|'em_uso'|'outro', series: string,
 *   character_id: string|null, reason_text: string, mode: 'bloqueia'|'alerta', active: boolean }} BlockedName
 * @typedef {{
 *   id: string, kind: 'allowlist'|'entrevista', al_id: string, author_handle: string, player_discord_id: string,
 *   player_age: number|null, character_name: string, submitted_at_text: string, eval_flags: string[],
 *   status: 'aprovado'|'reprovado', reason: string, notes: string, checklist: Array<{ item_id: string, stage: number, text: string }>,
 *   created_by: string, created_by_name: string|null, created_at: string, updated_at: string,
 *   sent_to_discord_at: string|null, discord_status: string
 * }} AlEvaluation
 * @typedef {{ question_id: string|null, question_text: string, note: string, send_to_discord: boolean, position: number }} AlAnswer
 * @typedef {{ discord_id: string, role: 'responsavel'|'entrevistador'|'acompanhante', display_name: string|null }} AlParticipant
 * @typedef {{ id: string, storage_path: string, file_name: string, mime: string, size: number, position: number, created_at: string }} AlAttachment
 * @typedef {AlEvaluation & { participants: AlParticipant[], answers: AlAnswer[], attachments: AlAttachment[] }} AlEvaluationDetail
 * @typedef {{ id: string, name: string, purpose: 'allowlist'|'entrevista'|'avisos'|'outro', channel_name: string, sender_name: string,
 *   sender_avatar_url: string, active: boolean, created_by: string, created_at: string, updated_by: string, updated_at: string }} DiscordWebhook
 *   (sem url: o endereço só entra, nunca sai)
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
 *           status padrão 'ativo'; criar já 'arquivado' exige procedimentos.arquivar.
 * @property {(id: string, data: object, expectedVersion: number) => Result<Procedure>} updateProcedure
 *           Substitui os campos editáveis. Versão diferente = CONFLICT.
 *           Para "sobrescrever mesmo assim", chame de novo com a versão de details.current.
 * @property {(id: string, status: 'ativo'|'revisar'|'arquivado') => Result<Procedure>} setStatus
 *           Entrar ou sair de 'arquivado' exige procedimentos.arquivar.
 * @property {(id: string) => Result<Procedure>} markReviewed
 *           "Marcar como revisado hoje": last_reviewed_at = agora, last_reviewed_by = você.
 * @property {(procedureId: string) => Result<Revision[]>} listRevisions   Mais recente primeiro.
 * @property {(revisionId: string) => Result<Procedure>} restoreRevision
 *           procedimentos.arquivar. Aplica o conteúdo da revisão como uma NOVA edição (gera revisão).
 * @property {() => Result<string[]>} listFavorites        IDs dos procedimentos favoritados por você.
 * @property {(procedureId: string) => Result<null>} addFavorite      Idempotente.
 * @property {(procedureId: string) => Result<null>} removeFavorite   Idempotente.
 * @property {() => Result<ExportPayload>} exportAll       procedimentos.backup. Todos os procedimentos, inclusive arquivados.
 * @property {(payload: ExportPayload, opts?: { dryRun?: boolean }) => Result<{ created: number, updated: number, unchanged: number }>} importAll
 *           procedimentos.backup. Upsert por slug. Tudo ou nada: se um item for inválido, nada é gravado (VALIDATION).
 *           dryRun = só calcula a prévia ("12 novos, 3 atualizados").
 * @property {() => Result<StaffMember[]>} listStaff        equipe.ver. Todos (ativos e inativos), por nome.
 * @property {(member: { discord_id: string, display_name: string, role: Role, teams?: Team[], active?: boolean }) => Result<StaffMember>} createStaffMember
 *           equipe.gerenciar. discord_id repetido = VALIDATION em details.errors.discord_id. active padrão true, teams padrão [].
 *           Cargo acima do permitido = VALIDATION em details.errors._.
 * @property {(discordId: string, changes: { display_name?: string, role?: Role, teams?: Team[], active?: boolean }) => Result<StaffMember>} updateStaffMember
 *           equipe.gerenciar. Altera nome, cargo, TAGs e situação, respeitando as travas (VALIDATION em details.errors._).
 * @property {(discordId: string) => Result<null>} deleteStaffMember
 *           equipe.gerenciar. Apaga o cadastro (o acesso acaba na hora). Travas = VALIDATION em details.errors._.
 *           O histórico dos procedimentos continua, mas o nome some; desativar preserva o nome.
 * @property {() => Result<PermissionGrid>} listPermissionGrid   Staff ativo. A grade atual (tela #/permissoes).
 * @property {(changes: PermissionChange[]) => Result<PermissionGrid>} setPermissions
 *           permissoes.editar. Tudo ou nada; devolve a grade nova. Travas = VALIDATION em details.errors._
 *           (CEO na lista, cargo ou permissão inexistente, permissão "só CEO" alterada por quem não é CEO).
 *
 * Etapa 2B · propostas
 * @property {() => Result<Proposal[]>} listProposals      Do autor (as próprias) ou de quem aprova (todas). Mais recentes primeiro.
 * @property {(p: { procedure_id?: string|null, base_version?: number|null, data: object }) => Result<Proposal>} createProposal
 *           procedimentos.editar. Valida como procedimento (VALIDATION); slug de outro procedimento = VALIDATION em slug.
 * @property {(id: string) => Result<null>} cancelProposal  O autor cancela a própria pendente (senão NOT_FOUND).
 * @property {(id: string, r: { approve: boolean, note?: string }) => Result<{ status: string, procedure_id: string }>} reviewProposal
 *           procedimentos.aprovar. Recusar exige motivo. Já analisada = VALIDATION.
 *
 * Etapa 3 · avaliações
 * @property {() => Result<EvaluationPeriod[]>} listEvaluationPeriods        Mais recentes primeiro.
 * @property {(p: { id?: string, title: string, starts_at: string, ends_at: string }) => Result<EvaluationPeriod>} saveEvaluationPeriod
 * @property {() => Result<EvaluationCriterion[]>} listEvaluationCriteria    Todos (ativos e inativos), por ordem.
 * @property {(c: { id?: string, label: string, sort_order?: number, active?: boolean }) => Result<EvaluationCriterion>} saveEvaluationCriterion
 * @property {() => Result<Array<{ discord_id: string, display_name: string, role: Role }>>} listEvaluableMembers
 * @property {() => Result<Evaluation[]>} listEvaluations   As que a pessoa pode ler (nunca as sobre si mesma). Mais recentes primeiro.
 * @property {(e: object) => Result<Evaluation>} saveEvaluation     Cria (sem id) ou edita. Travas = VALIDATION em details.errors._.
 * @property {(id: string) => Result<null>} deleteEvaluation        Só rascunho do próprio autor.
 * @property {(id: string) => Result<null>} markEvaluationRead      avaliacoes.ler.
 * @property {(id: string) => Result<null>} archiveEvaluation       avaliacoes.gerenciar.
 *
 * Etapa 11 · avisos e auditoria
 * @property {() => Result<Announcement[]>} listAnnouncements      Os que são para a pessoa (avisos.enviar vê todos). Mais recentes primeiro.
 * @property {(a: object) => Result<Announcement>} saveAnnouncement  avisos.enviar. Emoji colorido = VALIDATION.
 * @property {(id: string) => Result<null>} deleteAnnouncement
 * @property {(id: string, o?: { ack?: boolean }) => Result<null>} markAnnouncementRead
 * @property {(id: string) => Result<ReadReportRow[]>} getAnnouncementReport   avisos.enviar.
 * @property {(f?: { entity?: string, entityId?: string, limit?: number, before?: number }) => Result<AuditEntry[]>} listAudit
 *           auditoria.ver. Mais recentes primeiro; `before` = id para a próxima página.
 *
 * Etapa 5 · allowlist e entrevistas (sem `includeInactive`, só os ativos; por posição)
 * @property {(o?: { includeInactive?: boolean }) => Result<InterviewQuestion[]>} listInterviewQuestions
 * @property {(o?: { includeInactive?: boolean }) => Result<ChecklistItem[]>} listChecklistItems   Por etapa e posição.
 * @property {(o?: { includeInactive?: boolean }) => Result<BlockedName[]>} listBlockedNames      Por nome.
 * @property {(f?: { kind?: string, status?: string, createdBy?: string, query?: string, limit?: number, before?: string }) => Result<AlEvaluation[]>} listAlEvaluations
 *           As que a pessoa pode ver, mais recentes primeiro. query = trecho do @, Discord ID, personagem
 *           ou ID da AL; before = created_at para a próxima página; limit de 1 a 200 (padrão 100).
 * @property {(id: string) => Result<AlEvaluationDetail>} getAlEvaluation
 * @property {(e: object & { answers?: object[], participants?: object[] }) => Result<AlEvaluationDetail>} saveAlEvaluation
 *           Cria (sem id) ou edita. answers (só entrevista) e participants (entrevistador/acompanhante),
 *           se vierem, SUBSTITUEM os atuais. Campos inválidos = VALIDATION por campo; travas = errors._.
 * @property {(evaluationId: string, file: Blob & { name?: string }) => Result<AlAttachment>} addAlPrint
 *           PNG/JPG/WEBP de até 8 MB, até 9 por análise (VALIDATION em errors.file).
 * @property {(attachmentId: string) => Result<null>} removeAlPrint
 * @property {(evaluationId: string) => Result<Array<{ id: string, url: string }>>} getAlPrintUrls   Links temporários (1 hora).
 * @property {(o?: { purpose?: string }) => Result<DiscordWebhook[]>} listDiscordWebhooks   Por nome.
 * @property {(w: object) => Result<DiscordWebhook>} saveDiscordWebhook
 *           webhooks.gerenciar. Cria (url obrigatória) ou edita (url vazia = mantém a atual).
 * @property {(id: string) => Result<null>} deleteDiscordWebhook   webhooks.gerenciar.
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
  'listStaff', 'createStaffMember', 'updateStaffMember', 'deleteStaffMember',
  'listPermissionGrid', 'setPermissions',
  'listProposals', 'createProposal', 'cancelProposal', 'reviewProposal',
  'listEvaluationPeriods', 'saveEvaluationPeriod', 'listEvaluationCriteria', 'saveEvaluationCriterion',
  'listEvaluableMembers', 'listEvaluations', 'saveEvaluation', 'deleteEvaluation', 'markEvaluationRead', 'archiveEvaluation',
  'listAnnouncements', 'saveAnnouncement', 'deleteAnnouncement', 'markAnnouncementRead', 'getAnnouncementReport',
  'listAudit',
  'listInterviewQuestions', 'listChecklistItems', 'listBlockedNames',
  'listAlEvaluations', 'getAlEvaluation', 'saveAlEvaluation', 'addAlPrint', 'removeAlPrint', 'getAlPrintUrls',
  'listDiscordWebhooks', 'saveDiscordWebhook', 'deleteDiscordWebhook',
]);

/** Campos da análise que o cliente pode definir (o resto é do servidor). */
export const AL_EDITABLE_FIELDS = Object.freeze([
  'al_id', 'author_handle', 'player_discord_id', 'player_age', 'character_name', 'submitted_at_text',
  'eval_flags', 'status', 'reason', 'notes', 'checklist',
]);

/** Valores de uma análise nova. */
export const AL_DEFAULTS = Object.freeze({
  al_id: '', author_handle: '', player_discord_id: '', player_age: null, character_name: '', submitted_at_text: '',
  eval_flags: [], reason: '', notes: '', checklist: [],
});

/**
 * Normaliza a análise vinda do cliente: só campos editáveis, textos aparados, idade como número.
 * Não valida (use validateAlEvaluation depois).
 */
export function pickAlEvaluation(data = {}) {
  const src = data && typeof data === 'object' ? data : {};
  const out = {};
  for (const f of AL_EDITABLE_FIELDS) if (f in src) out[f] = structuredClone(src[f]);
  for (const f of ['al_id', 'author_handle', 'player_discord_id', 'character_name', 'submitted_at_text']) {
    if (f in out) out[f] = str(out[f]);
  }
  for (const f of ['reason', 'notes']) if (f in out) out[f] = String(out[f] ?? '').trim();
  if ('player_age' in out) {
    const v = out.player_age;
    out.player_age = v === '' || v == null ? null : Number(v);
  }
  if (Array.isArray(out.eval_flags)) out.eval_flags = [...new Set(out.eval_flags)].sort();
  return out;
}

/** Respostas do gabarito vindas do cliente → formato gravado (posição = ordem da lista). */
export const pickAlAnswers = (answers = []) => answers.map((a, i) => ({
  question_id: a?.question_id ?? null, question_text: String(a?.question_text ?? '').trim(),
  note: String(a?.note ?? '').trim(), send_to_discord: Boolean(a?.send_to_discord), position: i + 1,
}));

/** Participantes vindos do cliente: sem o autor (já é o responsável) e sem repetidos. */
export function pickAlParticipants(participants = [], authorId = null) {
  const seen = new Set();
  return participants
    .map((p) => ({ discord_id: str(p?.discord_id), role: str(p?.role) }))
    .filter((p) => p.discord_id !== authorId && !seen.has(p.discord_id) && seen.add(p.discord_id));
}

/** Webhook vindo do cliente (textos aparados). A url só vai se for preenchida. */
export function pickWebhook(data = {}) {
  const src = data && typeof data === 'object' ? data : {};
  const out = {};
  for (const f of ['name', 'purpose', 'channel_name', 'sender_name', 'sender_avatar_url']) if (f in src) out[f] = str(src[f]);
  if (str(src.url)) out.url = str(src.url);
  if ('active' in src) out.active = Boolean(src.active);
  return out;
}

export const WEBHOOK_COLUMNS = Object.freeze([
  'id', 'name', 'purpose', 'channel_name', 'sender_name', 'sender_avatar_url', 'active',
  'created_by', 'created_at', 'updated_by', 'updated_at',
]);

/** Módulos que o banco pode ter (Staff.features). */
export const FEATURES = Object.freeze(['allowlist', 'aprovacao', 'auditoria', 'avaliacoes', 'avisos']);

/** Campos que o cliente pode definir. Todo o resto é do servidor. */
export const EDITABLE_FIELDS = Object.freeze([
  'slug', 'title', 'category', 'audience', 'tags', 'summary', 'who_handles',
  'steps', 'commands', 'ready_message', 'notes', 'source_url', 'status',
]);

export const EXPORT_FORMAT = 'bloodlines-kb';

const DEFAULT_MESSAGES = {
  UNAUTHORIZED: 'Faça login para continuar.',
  FORBIDDEN: 'Seu cargo não permite esta ação.',
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

/**
 * Normaliza um membro da staff vindo do cliente (não valida; use validateStaffMember).
 * `partial`: mantém só os campos presentes (edição).
 */
export function pickStaffMember(data = {}, { partial = false } = {}) {
  const src = data && typeof data === 'object' ? data : {};
  const out = {};
  for (const f of ['discord_id', 'display_name', 'role']) if (!partial || f in src) out[f] = str(src[f]);
  if (!partial || 'teams' in src) {
    const teams = src.teams ?? [];
    out.teams = Array.isArray(teams) ? [...new Set(teams.map(str))].sort() : teams;
  }
  if (!partial || 'active' in src) out.active = src.active ?? (partial ? src.active : true);
  return out;
}

export const byStaffName = (a, b) => a.display_name.localeCompare(b.display_name, 'pt-BR');

/** Valores padrão de um procedimento novo. */
export const PROCEDURE_DEFAULTS = Object.freeze({
  tags: [], who_handles: '', commands: [], ready_message: '', notes: '', source_url: '', status: 'ativo',
});
