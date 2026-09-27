// Configuração pública do frontend.
// SUPABASE_URL e SUPABASE_ANON_KEY são PÚBLICAS por design (a proteção é a RLS).
// Nunca coloque aqui a chave service_role nem qualquer outro segredo.
//
// Para ligar o banco real: cole a Project URL e a anon/publishable key abaixo.
// Enquanto estiverem vazias, o site roda em modo de demonstração (dados locais).

export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';

/** 'mock' = dados locais no navegador · 'supabase' = banco real. */
export const DATA_MODE = SUPABASE_URL && SUPABASE_ANON_KEY ? 'supabase' : 'mock';
