// Controlador da interface: sessão, dados, estado, roteamento e ações comuns.
// Toda leitura/escrita passa pelo adapter (nunca direto no Supabase).
import { buildIndex, search } from '../core/search.js';
import { debounce, toast } from './dom.js';
import { createRouter } from './router.js';
import { renderSidebar, renderUser } from './views/layout.js';
import { renderLoading, renderLogin, renderLoginError, renderRestricted } from './views/auth.js';
import { renderHome } from './views/home.js';
import { renderProcedurePage } from './views/procedure.js';
import { renderForm } from './views/form.js';
import { renderHistory } from './views/history.js';
import { renderAdmin } from './views/admin.js';
import { renderStaff } from './views/staff.js';
import { renderMember } from './views/member.js';
import { renderPermissions } from './views/permissions.js';
import { renderMessage } from './views/message.js';

const SEARCH_DEBOUNCE_MS = 150;
const EMPTY_FILTERS = Object.freeze({ category: '', audience: '', status: '', favoritesOnly: false });

export function createApp(adapter, { isMock = false } = {}) {
  const $ = (id) => document.getElementById(id);
  const els = {
    main: $('main'), sidebar: $('sidebar'), user: $('user-slot'),
    search: $('search-input'), connection: $('connection'),
  };

  const state = {
    session: null,
    staff: null,
    procedures: [],
    index: [],
    favorites: new Set(),
    online: navigator.onLine,
    query: '',
    filters: { ...EMPTY_FILTERS },
    prefillTitle: '',
    ready: false,
  };

  let viewCleanup = null;
  let authToken = 0;
  const router = createRouter((route) => showRoute(route, { navigated: true }));

  const app = {
    adapter, state, router, els, isMock,

    /**
     * Permissões na interface, pelo código do catálogo (js/core/permissions.js),
     * ex.: app.can('procedimentos.arquivar'). O banco/adapter aplica de verdade.
     */
    can(permission) {
      return Boolean(state.staff?.permissions?.includes(permission));
    },

    bySlug: (slug) => state.procedures.find((p) => p.slug === slug) ?? null,
    isFav: (proc) => state.favorites.has(proc.id),
    hasFilters: () => Object.entries(state.filters).some(([k, v]) => v !== EMPTY_FILTERS[k]),

    /** Resultados da busca atual (termo + filtros). */
    results() {
      return search(state.index, state.query, {
        ...state.filters,
        favorites: new Set(state.procedures.filter((p) => state.favorites.has(p.id)).map((p) => p.slug)),
      }).map((r) => r.proc);
    },

    /** Recarrega procedimentos e favoritos do adapter. */
    async reload() {
      const token = authToken;
      const [procs, favs, staffChanged] = await Promise.all([
        adapter.listProcedures({ includeArchived: true }),
        adapter.listFavorites(),
        app.refreshStaff(),
      ]);
      if (token !== authToken) return false;
      if (procs.error) { reportError(procs.error, 'Não foi possível carregar os procedimentos.'); return false; }
      const before = signature();
      state.procedures = procs.data;
      state.index = buildIndex(procs.data);
      if (!favs.error) state.favorites = new Set(favs.data);
      const changed = signature() !== before || staffChanged;
      if (changed) renderSidebar(app);
      return changed;
    },

    /**
     * Relê o cargo e as permissões de quem está logado: o CEO pode ter mudado a grade ou o
     * cargo da pessoa. Chamado a cada navegação (via reload). Devolve true se algo mudou.
     */
    async refreshStaff() {
      const token = authToken;
      const result = await adapter.getCurrentStaff();
      if (token !== authToken || result.error || !state.staff) return false;
      if (!result.data) { syncAuth(); return false; }
      if (JSON.stringify(result.data) === JSON.stringify(state.staff)) return false;
      state.staff = result.data;
      renderUser(app);
      renderSidebar(app);
      return true;
    },

    /** Re-renderiza a rota atual mantendo rolagem e foco (após mudança de dados). */
    render() {
      const route = router.route;
      if (!state.ready || ['new', 'edit', 'permissions'].includes(route.name)) return;
      const key = document.activeElement?.dataset?.focusKey;
      const y = window.scrollY;
      showRoute(route, { navigated: false });
      window.scrollTo(0, y);
      if (key) document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
    },

    /** Favoritar com atualização otimista; reverte e avisa se o banco falhar (SPEC 2.5). */
    async toggleFavorite(proc) {
      const had = state.favorites.has(proc.id);
      if (had) state.favorites.delete(proc.id); else state.favorites.add(proc.id);
      app.render();
      const result = had ? await adapter.removeFavorite(proc.id) : await adapter.addFavorite(proc.id);
      if (result.error) {
        if (had) state.favorites.add(proc.id); else state.favorites.delete(proc.id);
        app.render();
        toast('Não foi possível salvar o favorito. A alteração foi desfeita.', 3500);
      }
    },

    setQuery(value) {
      state.query = value;
      if (router.route.name !== 'home') router.go('#/');
      else app.render();
    },

    setFilters(patch) {
      Object.assign(state.filters, patch);
      renderSidebar(app);
      if (router.route.name !== 'home') router.go('#/');
      else app.render();
    },

    clearFilters() {
      state.filters = { ...EMPTY_FILTERS };
      renderSidebar(app);
      app.render();
    },

    /** Mostra um erro do adapter de forma amigável. */
    reportError,

    async signOut() {
      const result = await adapter.signOut();
      if (result.error) reportError(result.error, 'Não foi possível sair. Tente novamente.');
    },

    /** Desabilita/habilita os botões que dependem de conexão. */
    applyOnline() {
      document.body.classList.toggle('is-offline', !state.online);
      els.connection.hidden = state.online;
      for (const el of document.querySelectorAll('[data-requires-online]')) {
        el.disabled = !state.online;
        if (!state.online) el.title = 'Sem conexão'; else el.removeAttribute('title');
      }
    },
  };

  /** Resumo dos dados para saber se algo mudou (ids, versões e favoritos). */
  function signature() {
    return `${state.procedures.map((p) => `${p.id}:${p.version}`).join(',')}|${[...state.favorites].sort().join(',')}`;
  }

  function reportError(error, fallback = 'Algo deu errado.') {
    const messages = {
      NETWORK: 'Sem conexão. As alterações não foram salvas.',
      FORBIDDEN: 'Seu cargo não permite esta ação.',
      UNAUTHORIZED: 'Sua sessão expirou. Entre novamente.',
      NOT_FOUND: 'Não encontrado. Ele pode ter sido arquivado ou renomeado.',
    };
    toast(messages[error?.code] ?? error?.message ?? fallback, 4000);
  }

  /* ---------- rotas ---------- */
  function showRoute(route, { navigated }) {
    if (!state.ready) return;
    viewCleanup?.();
    viewCleanup = null;
    const views = {
      home: () => renderHome(app),
      procedure: () => renderProcedurePage(app, route.slug),
      new: () => renderForm(app, {}),
      edit: () => renderForm(app, { slug: route.slug }),
      history: () => renderHistory(app, route.slug),
      admin: () => renderAdmin(app),
      staff: () => renderStaff(app),
      member: () => renderMember(app, route.slug),
      permissions: () => renderPermissions(app),
      notfound: () => renderMessage(app, { title: 'Página não encontrada', text: 'Volte para a lista de procedimentos.' }),
    };
    const mount = () => {
      document.body.dataset.route = route.name;
      markNavLinks(route.hash);
      viewCleanup = views[route.name]?.() ?? null;
      if (typeof viewCleanup !== 'function') viewCleanup = null;
      app.applyOnline();
      if (navigated) {
        window.scrollTo(0, 0);
        els.main.querySelector('h1')?.focus({ preventScroll: true });
      }
    };

    if (!navigated) { mount(); return; }

    // Ao navegar, busca dados novos (outra pessoa pode ter editado).
    // A edição precisa da versão mais recente ANTES de montar o formulário;
    // as outras telas aparecem na hora e se atualizam se algo mudou.
    const hash = route.hash;
    if (route.name === 'edit') {
      renderLoading(app);
      app.reload().then(() => { if (state.ready && router.route.hash === hash) mount(); });
      return;
    }
    mount();
    if (route.name !== 'new') {
      app.reload().then((changed) => { if (changed && router.route.hash === hash) app.render(); });
    }
  }

  /** Destaca, na barra lateral, o link da página atual (ex.: Equipe). */
  function markNavLinks(hash) {
    for (const a of els.sidebar.querySelectorAll('a[data-nav]')) a.setAttribute('aria-current', String(a.getAttribute('href') === hash));
  }

  /** Apaga da memória e da tela tudo que veio do banco (ao sair ou sem acesso). */
  function clearData() {
    viewCleanup?.();
    viewCleanup = null;
    state.procedures = [];
    state.index = [];
    state.favorites = new Set();
    state.staff = null;
    state.query = '';
    state.filters = { ...EMPTY_FILTERS };
    els.search.value = '';
    els.sidebar.replaceChildren();
    els.user.replaceChildren();
  }

  /* ---------- sessão ---------- */
  async function syncAuth() {
    const token = ++authToken;
    state.ready = false;
    clearData();
    document.body.dataset.state = 'loading';
    renderLoading(app);

    const session = await adapter.getSession();
    if (token !== authToken) return;
    state.session = session.data ?? null;

    if (!state.session) {
      state.staff = null;
      document.body.dataset.state = 'auth';
      renderLogin(app);
      return;
    }

    const staff = await adapter.getCurrentStaff();
    if (token !== authToken) return;
    if (staff.error) {
      document.body.dataset.state = 'auth';
      console.error('[Central] Falha ao consultar o cadastro na staff:', staff.error);
      renderLoginError(app, staff.error, () => syncAuth());
      return;
    }
    if (!staff.data) {
      state.staff = null;
      document.body.dataset.state = 'auth';
      renderRestricted(app);
      return;
    }

    state.staff = staff.data;
    renderUser(app);
    await app.reload();
    if (token !== authToken) return;
    state.ready = true;
    document.body.dataset.state = 'app';
    showRoute(router.route, { navigated: false });
  }

  /* ---------- busca e atalhos ---------- */
  function bindSearch() {
    const apply = debounce((value) => app.setQuery(value), SEARCH_DEBOUNCE_MS);
    els.search.addEventListener('input', () => apply(els.search.value));

    document.addEventListener('keydown', (e) => {
      if (document.body.dataset.state !== 'app') return;
      if (document.querySelector('dialog[open]')) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const typing = target?.closest('input, textarea, select, [contenteditable]');
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        els.search.focus();
        els.search.select();
      } else if (e.key === '/' && !typing) {
        e.preventDefault();
        els.search.focus();
      } else if (e.key === 'Escape' && target === els.search) {
        apply.cancel();
        els.search.value = '';
        app.setQuery('');
      }
    });
  }

  /* ---------- conexão ---------- */
  function bindConnection() {
    const update = () => {
      state.online = navigator.onLine;
      adapter.mock?.setOffline(!state.online);
      app.applyOnline();
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
  }

  return {
    app,
    start() {
      bindSearch();
      bindConnection();
      adapter.onAuthChange(() => syncAuth());
      syncAuth();
    },
  };
}
