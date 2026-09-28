// Roteamento por hash (#/...), com "guarda" para impedir sair de um formulário com
// alterações não salvas sem confirmação.

const ROUTES = [
  ['home', /^#?\/?$/],
  ['procedure', /^#\/p\/([a-z0-9-]+)$/],
  ['new', /^#\/novo$/],
  ['edit', /^#\/editar\/([a-z0-9-]+)$/],
  ['history', /^#\/historico\/([a-z0-9-]+)$/],
  ['admin', /^#\/admin$/],
  ['staff', /^#\/equipe$/],
  ['member', /^#\/equipe\/([0-9]{17,20})$/],
  ['permissions', /^#\/permissoes$/],
];

/** @returns {{ name: string, slug?: string, hash: string }} */
export function parseRoute(hash) {
  const value = hash || '#/';
  for (const [name, re] of ROUTES) {
    const m = value.match(re);
    if (m) return { name, slug: m[1], hash: value };
  }
  return { name: 'notfound', hash: value };
}

/**
 * @param {(route: ReturnType<typeof parseRoute>) => void} onRoute
 */
export function createRouter(onRoute) {
  let current = location.hash || '#/';
  let guard = null;

  async function handle() {
    const next = location.hash || '#/';
    if (next === current) return;
    if (guard) {
      const allowed = await guard();
      if (!allowed) {
        // Desfaz a navegação sem disparar outro hashchange.
        history.replaceState(null, '', current);
        return;
      }
      guard = null;
    }
    current = next;
    onRoute(parseRoute(current));
  }

  window.addEventListener('hashchange', handle);

  return {
    /** Rota atual. */
    get route() { return parseRoute(current); },
    start() { onRoute(parseRoute(current)); },
    go(hash) {
      if ((location.hash || '#/') === hash) {
        if (current !== hash) { current = hash; onRoute(parseRoute(hash)); }
        return;
      }
      location.hash = hash;
    },
    /** Função assíncrona que devolve true para permitir sair da rota atual. */
    setGuard(fn) { guard = fn; },
    clearGuard() { guard = null; },
  };
}
