// Bootstrap: escolhe a camada de dados (config.js) e inicia a interface.
import { DATA_MODE } from './config.js';
import { assertAdapter } from './data/adapter.js';
import { createApp } from './ui/app.js';

/**
 * Conteúdo inicial do modo mock: os procedimentos convertidos das notas (data/seed.json) e,
 * desde a Etapa 5 da Allowlist, perguntas, checklist e nomes proibidos (data/allowlist-seed.json).
 */
async function loadSeed(file, empty) {
  // O conteúdo interno só existe na cópia local do projeto (o site publicado não leva data/).
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) return empty;
  try {
    const response = await fetch(`data/${file}`, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    console.warn(`Não foi possível carregar data/${file}; o modo mock começa sem esses dados.`, err);
    return empty;
  }
}

async function createAdapter() {
  if (DATA_MODE === 'mock') {
    const [{ createMockAdapter }, seed, allowlistSeed] = await Promise.all([
      import('./data/mock-adapter.js'),
      loadSeed('seed.json', []),
      loadSeed('allowlist-seed.json', null),
    ]);
    let storage = null;
    try { storage = window.localStorage; } catch { /* navegação privada sem storage: só memória */ }
    // "v2": conteúdo real (data/seed.json). Navegadores com os dados de demonstração antigos começam do zero.
    const adapter = createMockAdapter({ storage, seed, allowlistSeed, storageKey: 'bloodlines-kb:mock:v2' });
    // Só no modo mock: acesso para testes E2E e para simular papéis.
    window.__kb = { adapter, mock: adapter.mock };
    return adapter;
  }
  const { createSupabaseAdapter } = await import('./data/supabase-adapter.js');
  return createSupabaseAdapter();
}

function showUnavailable(message) {
  document.body.dataset.state = 'auth';
  const heading = document.createElement('h1');
  heading.className = 'auth-title';
  heading.textContent = 'Central temporariamente indisponível';
  const text = document.createElement('p');
  text.className = 'auth-text';
  text.textContent = message;
  const card = document.createElement('section');
  card.className = 'auth-card';
  card.append(heading, text);
  const wrap = document.createElement('div');
  wrap.className = 'auth-wrap';
  wrap.append(card);
  document.getElementById('main').replaceChildren(wrap);
}

if (DATA_MODE === 'unconfigured') {
  showUnavailable('O acesso da equipe está sendo configurado. Tente novamente mais tarde.');
} else {
  try {
    const adapter = assertAdapter(await createAdapter());
    createApp(adapter, { isMock: DATA_MODE === 'mock' }).start();
  } catch {
    showUnavailable('Não foi possível iniciar a Central. Verifique sua conexão e recarregue a página.');
  }
}
