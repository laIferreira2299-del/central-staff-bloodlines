// Bootstrap: escolhe a camada de dados (config.js) e inicia a interface.
import { DATA_MODE } from './config.js';
import { assertAdapter } from './data/adapter.js';
import { createApp } from './ui/app.js';

/** Conteúdo inicial do modo mock: os procedimentos convertidos das notas (Etapa 5). */
async function loadSeed() {
  // O conteúdo interno só existe na cópia local do projeto (o site publicado não leva data/).
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) return [];
  try {
    const response = await fetch('data/seed.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    console.warn('Não foi possível carregar data/seed.json; o modo mock começa vazio.', err);
    return [];
  }
}

async function createAdapter() {
  if (DATA_MODE === 'mock') {
    const [{ createMockAdapter }, seed] = await Promise.all([
      import('./data/mock-adapter.js'),
      loadSeed(),
    ]);
    let storage = null;
    try { storage = window.localStorage; } catch { /* navegação privada sem storage: só memória */ }
    // "v2": conteúdo real (data/seed.json). Navegadores com os dados de demonstração antigos começam do zero.
    const adapter = createMockAdapter({ storage, seed, storageKey: 'bloodlines-kb:mock:v2' });
    // Só no modo mock: acesso para testes E2E e para simular papéis.
    window.__kb = { adapter, mock: adapter.mock };
    return adapter;
  }
  const { createSupabaseAdapter } = await import('./data/supabase-adapter.js');
  return createSupabaseAdapter();
}

const adapter = assertAdapter(await createAdapter());
createApp(adapter, { isMock: DATA_MODE === 'mock' }).start();
