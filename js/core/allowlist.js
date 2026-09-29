// Módulo de Allowlist e Entrevistas (documento 02). Etapa 4: constantes e mensagens que o
// banco (supabase/10_allowlist.sql) também usa; tests/db/banco.test.mjs confere que são iguais.
// As regras completas (status automático, mensagens, nomes proibidos, card do Discord) entram
// na Etapa 5.

/** Tipos de registro. */
export const AL_KINDS = Object.freeze(['allowlist', 'entrevista']);

/** Os 5 botões de avaliação (seção 2.3). ev1/ev4 e ev2/ev3 se excluem. */
export const EVAL_FLAGS = Object.freeze({
  ev1: 'Bom Conhecimento das regras da cidade',
  ev2: 'Bom Conhecimento da LORE da cidade',
  ev3: 'Não tem Conhecimento da LORE da cidade',
  ev4: 'Não tem Conhecimento das regras da cidade',
  ev5: 'Personagem mal desenvolvido',
});

/** Tipos de pergunta do gabarito e o nome do selo na tela. */
export const QUESTION_KINDS = Object.freeze({
  lore: 'Lore', rp: 'RP', regra: 'Regra', pratica: 'Prática', interpretacao: 'Interp.',
});
export const QUESTION_SECTIONS = Object.freeze(['Lore do servidor', 'Conceitos e Regras do RP', 'Situações práticas']);

/** Papéis numa análise ou entrevista (documento 01, seção 5.2). */
export const PARTICIPANT_ROLES = Object.freeze(['responsavel', 'entrevistador', 'acompanhante']);

/** Prints: limites do bucket al-prints. */
export const MAX_PRINTS = 9;
export const MAX_PRINT_BYTES = 8 * 1024 * 1024;
export const PRINT_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
/** Decisão 6: os prints são apagados depois deste prazo (a análise continua). */
export const PRINT_RETENTION_DAYS = 90;

/** Finalidades de webhook (seção 13.2). */
export const WEBHOOK_PURPOSES = Object.freeze(['allowlist', 'entrevista', 'avisos', 'outro']);

/** Mensagens das travas. IGUAIS às de supabase/10_allowlist.sql. */
export const ALLOWLIST_ERRORS = Object.freeze({
  forbidden: 'Seu cargo não permite analisar allowlists nem fazer entrevistas.',
  notAuthor: 'Só quem fez a análise pode alterá-la.',
  sent: 'Esta análise já foi enviada ao Discord e não pode mais ser editada.',
  minor: 'Menor de 18 anos: a análise só pode ser Reprovada.',
  conflict: 'A avaliação tem opções que se contradizem (bom e sem conhecimento ao mesmo tempo).',
  answersOnlyInterview: 'As perguntas do gabarito só valem para entrevistas.',
  printFolder: 'O print precisa ficar na pasta da própria análise.',
  maxPrints: 'Máximo de 9 imagens por análise.',
  nameInUse: 'Nomes "Em uso na cidade" são cadastrados pela tela de Personagens.',
  nameDuplicate: 'Este nome já está na lista de nomes proibidos.',
  webhookUrl: 'Use o endereço de webhook do Discord (https://discord.com/api/webhooks/...).',
});

const ACCENTS = { á: 'a', à: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a', é: 'e', è: 'e', ê: 'e', ë: 'e', í: 'i', ì: 'i', î: 'i', ï: 'i',
  ó: 'o', ò: 'o', ô: 'o', õ: 'o', ö: 'o', ú: 'u', ù: 'u', û: 'u', ü: 'u', ç: 'c', ñ: 'n', ý: 'y', ÿ: 'y' };

/**
 * Forma de comparar nomes: minúsculas, sem acentos, sem apóstrofos, espaços simples.
 * Mesma regra de public.kb_name_norm() no banco (o teste confere com vários exemplos).
 * @param {string} name
 */
export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[áàâãäåéèêëíìîïóòôõöúùûüçñýÿ]/g, (c) => ACCENTS[c])
    .replace(/['’‘`´]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
