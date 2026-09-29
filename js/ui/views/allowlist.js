// Etapa 6 · telas de Allowlist e Entrevista (documento 02, seções 2 a 4 e 8.2).
//   #/allowlist[/<id>]    análise da allowlist escrita: formulário, prints, avaliação, preview,
//                         Copiar, PNG, PDF, Salvar e Enviar para o Discord
//   #/entrevista[/<id>]   entrevista: identificação, checklist, prints, avaliação, gabarito
// Com <id>: continua uma análise própria ainda não enviada; enviada ou de outra pessoa abre o
// histórico (#/avaliacoes/<id>). As regras vêm de js/core/allowlist.js (as mesmas do banco).
import { h, icon, toast } from '../dom.js';
import { confirmDialog, openDialog } from '../modal.js';
import { copyButton, formatDate } from '../components.js';
import { renderMarkdownInto } from '../../core/render-md.js';
import {
  AL_LIMITS, DISCORD_SEND_ERRORS, EVAL_FLAGS, MAX_PRINTS, PRINT_MIMES, QUESTION_KINDS, SIGNATURE,
  autoMessage, buildNameIndex, checkCharacterName, checklistProgress, checklistSnapshot, copyText,
  formatAnalyzedAt, formatSubmittedAt, isMinor, nextStatus, parseAge, playerMessage, printError, toggleFlag,
} from '../../core/allowlist.js';
import { renderMessage } from './message.js';

const FLAG_TONE = { ev1: 'ok', ev2: 'ok', ev3: 'bad', ev4: 'bad', ev5: 'warn' };
const FLAG_MARK = { ev1: 'ꪜ', ev2: 'ꪜ', ev3: '✘', ev4: '✘', ev5: '⚠' };
const TITLES = { allowlist: 'Análise de allowlist', entrevista: 'Entrevista' };
const BASE = { allowlist: '#/allowlist', entrevista: '#/entrevista' };
/** Checklist da entrevista aberto ou fechado: só na memória desta aba (começa fechado). */
let checklistOpen = false;

/** Sem o módulo no banco ou sem allowlist.avaliar: mensagem e nada mais. */
export function alDenied(app, need = 'allowlist.avaliar') {
  if (app.feature('allowlist') && app.can(need)) return false;
  renderMessage(app, { title: 'Acesso restrito', text: 'Seu cargo não participa das análises de allowlist e entrevistas.' });
  return true;
}

/** Mensagem de erro do adapter (a trava em errors._ ou o primeiro campo). */
export const errorText = (error) => error?.details?.errors?._ ?? Object.values(error?.details?.errors ?? {})[0] ?? error?.message ?? 'Algo deu errado.';

/* ============================ envio ao Discord ============================ */
/**
 * Botão "Enviar para Discord" com a escolha do canal (seção 13.5): nenhum webhook ativo = botão
 * desligado com o aviso; um = direto; vários = seletor. Confirma antes (e para reenviar).
 * @param {{ kind: string, sentAt: string|null, getId: () => Promise<string|null>, onSent: (r: object, id: string) => void }} o
 */
export function sendBox(app, { kind, sentAt, getId, onSent }) {
  const label = sentAt ? 'Enviar de novo' : 'Enviar para Discord';
  const text = h('span', {}, label);
  const btn = h('button', { type: 'button', class: 'btn btn--primary', id: 'al-send', disabled: true }, icon('brand-discord'), text);
  const select = h('select', { class: 'input input--sm', id: 'al-send-webhook', 'aria-label': 'Enviar para qual canal?' });
  const pick = h('label', { class: 'filter', hidden: true }, h('span', { class: 'filter-label' }, 'Enviar para qual canal?'), select);
  const hint = h('p', { class: 'field-hint', id: 'al-send-hint', 'aria-live': 'polite' }, 'Carregando canais…');
  const box = h('div', { class: 'al-send' }, pick, btn, hint);
  let hooks = [];

  app.adapter.listDiscordWebhooks({ purpose: kind }).then((r) => {
    hooks = (r.data ?? []).filter((w) => w.active && w.purpose === kind);
    if (!hooks.length) { hint.textContent = DISCORD_SEND_ERRORS.noWebhook; return; }
    select.replaceChildren(...hooks.map((w) => h('option', { value: w.id }, w.channel_name ? `${w.name} (${w.channel_name})` : w.name)));
    pick.hidden = hooks.length < 2;
    hint.textContent = sentAt ? `Enviada em ${formatDate(sentAt, { time: true })}.` : hooks.length === 1 ? `Canal: ${hooks[0].name}.` : '';
    // Só agora depende da conexão (sem webhook, o botão fica sempre desligado).
    btn.dataset.requiresOnline = '';
    btn.disabled = !app.state.online;
  });

  btn.addEventListener('click', async () => {
    const webhookId = select.value || hooks[0]?.id;
    if (!webhookId) return;
    const ok = await confirmDialog(sentAt
      ? { title: 'Enviar de novo?', message: `Esta análise já foi enviada em ${formatDate(sentAt, { time: true })}. Enviar outra vez para o canal?`, confirmLabel: 'Enviar de novo' }
      : { title: 'Enviar para o Discord?', message: 'Depois de enviada, a análise fica registrada e não pode mais ser editada.', confirmLabel: 'Enviar' });
    if (!ok) return;
    btn.disabled = true;
    text.textContent = 'Enviando…';
    const id = await getId();
    const res = id ? await app.adapter.sendAlToDiscord(id, { webhookId, resend: Boolean(sentAt) }) : null;
    if (!res || res.error) {
      if (res?.error) {
        hint.textContent = errorText(res.error);
        // Janela, não só aviso no canto: quem clicou precisa ver que não foi enviado.
        openDialog({ title: '✗ Não foi enviado ao Discord', body: errorText(res.error), actions: [{ label: 'Entendi', value: true, variant: 'primary', autofocus: true }] });
      }
      btn.disabled = false;
      text.textContent = label;
      return;
    }
    text.textContent = '✓ Enviado!';
    toast('✓ Enviado para o Discord.');
    onSent(res.data, id);
  });
  return box;
}

/* ============================ prints ============================ */
/**
 * Área de prints: arrastar, clicar ou colar com Ctrl+V; miniaturas com ×; até 9 (seção 2.2).
 * Os arquivos novos ficam na tela até salvar; os já gravados saem ao salvar.
 */
function printsBox(initial, onChange) {
  const items = initial.map((a) => ({ key: a.id, id: a.id, url: a.url, name: a.file_name }));
  const removed = [];
  const input = h('input', { type: 'file', accept: PRINT_MIMES.join(','), multiple: true, class: 'sr-only', id: 'al-print-input', tabindex: '-1' });
  const grid = h('ul', { class: 'al-thumbs', id: 'al-thumbs' });
  const counter = h('p', { class: 'field-hint', id: 'al-print-count' });
  const zone = h('button', { type: 'button', class: 'al-drop', id: 'al-drop' },
    icon('photo-plus'), h('span', {}, 'Arraste imagens, clique para escolher ou cole com Ctrl+V'),
    h('span', { class: 'field-hint' }, 'PNG, JPG ou WEBP, até 8 MB cada.'));

  function add(files) {
    for (const file of files) {
      const bad = printError(file, items.length);
      if (bad) { toast(bad, 3500); if (items.length >= MAX_PRINTS) break; continue; }
      items.push({ key: `n${Math.random().toString(36).slice(2)}`, file, url: URL.createObjectURL(file), name: file.name });
    }
    draw();
    onChange();
  }
  function draw() {
    grid.replaceChildren(...items.map((it, i) => h('li', { class: 'al-thumb' },
      h('img', { src: it.url, alt: `Print ${i + 1}${it.name ? `: ${it.name}` : ''}` }),
      h('button', {
        type: 'button', class: 'al-thumb-x', 'aria-label': `Remover print ${i + 1}`,
        onclick: () => {
          const [gone] = items.splice(i, 1);
          if (gone.id) removed.push(gone.id); else URL.revokeObjectURL(gone.url);
          draw();
          onChange();
        },
      }, '×'))));
    counter.textContent = `${items.length} / ${MAX_PRINTS} imagens anexadas`;
    zone.disabled = items.length >= MAX_PRINTS;
  }
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { add([...input.files]); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('is-over'); add([...(e.dataTransfer?.files ?? [])]); });
  draw();

  return {
    el: h('div', { class: 'al-prints' }, zone, input, counter, grid),
    add,
    pending: () => items.filter((it) => it.file),
    removed: () => [...removed],
    /** Depois de salvar: os novos viram gravados. */
    saved(uploaded) {
      for (const [it, att] of uploaded) Object.assign(it, { id: att.id, file: null });
      removed.length = 0;
    },
    dispose() { for (const it of items) if (it.file) URL.revokeObjectURL(it.url); },
  };
}

/* ============================ formulário ============================ */
/**
 * Etapa 10 · outros entrevistadores e acompanhantes (documento 01, seção 5.2 e Decisão 6):
 * escolher na lista da staff ou digitar o Discord ID. Altera `list` no lugar.
 */
function participantsPanel(staff, list, myId, onChange) {
  const nameOf = (id) => staff.find((s) => s.discord_id === id)?.display_name ?? id;
  const ul = h('ul', { class: 'al-team', id: 'al-team' });
  const who = h('input', { class: 'input', id: 'al-team-who', list: 'al-team-staff', autocomplete: 'off', placeholder: 'Nome da staff ou Discord ID' });
  const role = h('select', { class: 'input', id: 'al-team-role', 'aria-label': 'Papel' },
    h('option', { value: 'entrevistador' }, 'Entrevistador'), h('option', { value: 'acompanhante' }, 'Acompanhante'));
  const err = h('p', { class: 'field-error', id: 'al-team-err', role: 'alert', hidden: true });
  const draw = () => ul.replaceChildren(...list.map((p, i) => h('li', { class: 'al-team-item' },
    h('span', {}, h('strong', {}, nameOf(p.discord_id)), ` · ${p.role === 'acompanhante' ? 'Acompanhante' : 'Entrevistador'}`),
    h('button', { type: 'button', class: 'btn btn--sm btn--ghost', 'aria-label': `Tirar ${nameOf(p.discord_id)}`, onclick: () => { list.splice(i, 1); onChange(); draw(); } }, icon('x')))));
  const add = () => {
    const v = who.value.trim();
    const id = staff.find((s) => s.display_name.toLowerCase() === v.toLowerCase())?.discord_id ?? v;
    err.hidden = true;
    if (!/^[0-9]{17,20}$/.test(id)) { err.textContent = 'Escolha alguém da lista ou digite um Discord ID (17 a 20 números).'; err.hidden = false; return; }
    if (id === myId || list.some((p) => p.discord_id === id)) { err.textContent = 'Essa pessoa já está na entrevista.'; err.hidden = false; return; }
    list.push({ discord_id: id, role: role.value });
    who.value = '';
    onChange();
    draw();
  };
  who.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  draw();
  return h('section', { class: 'panel', 'aria-labelledby': 'al-team-title' },
    h('h2', { class: 'block-title', id: 'al-team-title' }, icon('users'), 'Entrevistadores e acompanhantes'),
    h('p', { class: 'panel-text' }, 'Quem participou com você. Conta no painel de produtividade (acompanhante numa coluna à parte).'),
    h('datalist', { id: 'al-team-staff' }, staff.filter((s) => s.discord_id !== myId).map((s) => h('option', { value: s.display_name }))),
    h('div', { class: 'al-inline' }, who, role, h('button', { type: 'button', class: 'btn', id: 'al-team-add', onclick: add }, icon('plus'), 'Adicionar')),
    err, ul);
}

export function renderAlForm(app, kind, id = null) {
  if (alDenied(app)) return null;
  let alive = true;
  let dirty = false;
  let cleanupBuild = () => {};
  const body = h('div', {}, h('p', { class: 'panel-text' }, 'Carregando…'));
  app.els.main.replaceChildren(h('div', { class: `main-inner al-page al-page--${kind}` },
    h('a', { class: 'back', href: '#/avaliacoes' }, icon('arrow-left'), 'Histórico de allowlist e entrevistas'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, id ? `${TITLES[kind]} (continuar)` : `Nova ${kind === 'allowlist' ? 'análise de allowlist' : 'entrevista'}`),
      h('p', { class: 'page-sub' }, kind === 'allowlist'
        ? 'Preencha os dados, anexe os prints e marque a avaliação. O status e o motivo se ajustam sozinhos; tudo fica salvo no histórico.'
        : 'Siga o checklist, anote as respostas no gabarito e marque a avaliação. Tudo fica salvo no histórico.')),
    body));

  async function load() {
    const [names, items, questions, current, urls, staffNames] = await Promise.all([
      app.adapter.listBlockedNames(),
      kind === 'entrevista' ? app.adapter.listChecklistItems() : Promise.resolve({ data: [] }),
      kind === 'entrevista' ? app.adapter.listInterviewQuestions() : Promise.resolve({ data: [] }),
      id ? app.adapter.getAlEvaluation(id) : Promise.resolve({ data: null }),
      id ? app.adapter.getAlPrintUrls(id) : Promise.resolve({ data: [] }),
      kind === 'entrevista' ? app.adapter.listStaffNames() : Promise.resolve({ data: [] }),
    ]);
    if (!alive) return;
    const err = [names, items, questions, current].find((r) => r.error);
    if (err) { app.reportError(err.error, 'Não foi possível carregar o formulário.'); body.replaceChildren(); return; }
    const ev = current.data;
    if (ev && (ev.kind !== kind || ev.created_by !== app.state.staff.discord_id || ev.sent_to_discord_at)) {
      app.router.go(`#/avaliacoes/${ev.id}`);
      return;
    }
    const urlOf = new Map((urls.data ?? []).map((u) => [u.id, u.url]));
    const config = { index: buildNameIndex(names.data), items: items.data, questions: questions.data, staff: staffNames.data ?? [] };
    build(ev, config, (ev?.attachments ?? []).map((a) => ({ ...a, url: urlOf.get(a.id) ?? '' })).filter((a) => a.url));
  }

  function build(ev, config, attachments) {
    cleanupBuild();
    dirty = false;
    const me = app.state.staff;
    const st = {
      id: ev?.id ?? null,
      al_id: ev?.al_id ?? '', author_handle: ev?.author_handle ?? '', player_discord_id: ev?.player_discord_id ?? '',
      player_age: ev?.player_age ?? '', character_name: ev?.character_name ?? '', submitted_at_text: ev?.submitted_at_text ?? '',
      eval_flags: [...(ev?.eval_flags ?? [])], status: ev?.status ?? null, reason: ev?.reason ?? '', notes: ev?.notes ?? '',
      checked: new Set((ev?.checklist ?? []).map((c) => c.item_id)),
      participants: (ev?.participants ?? []).filter((p) => p.role !== 'responsavel').map((p) => ({ discord_id: p.discord_id, role: p.role })),
      answers: new Map((ev?.answers ?? []).filter((a) => a.question_id).map((a) => [a.question_id, { note: a.note, send: a.send_to_discord }])),
    };
    const touch = () => { dirty = true; };
    const age = () => parseAge(st.player_age);
    const errs = {};
    const fieldError = (key) => (errs[key] = h('p', { class: 'field-error', id: `al-err-${key}`, hidden: true }));

    /* ---------- identificação ---------- */
    const field = (key, label, { type = 'text', max = AL_LIMITS[key] ?? 100, placeholder = '', extra = null, mode } = {}) => {
      const input = h('input', {
        class: 'input', id: `al-${key}`, type, value: st[key] ?? '', maxlength: type === 'number' ? null : max, placeholder,
        inputmode: mode, min: type === 'number' ? 1 : null, max: type === 'number' ? 120 : null, autocomplete: 'off',
      });
      input.addEventListener('input', () => { st[key] = input.value; touch(); update(key); });
      return { input, el: h('div', { class: 'field' }, h('label', { class: 'field-label', for: `al-${key}` }, label),
        extra ? h('div', { class: 'al-inline' }, input, extra) : input, fieldError(key)) };
    };
    const nowBtn = h('button', { type: 'button', class: 'btn btn--sm', id: 'al-now', onclick: () => {
      st.submitted_at_text = formatSubmittedAt();
      f.submitted_at_text.input.value = st.submitted_at_text;
      touch();
    } }, icon('clock'), 'Agora');
    const f = {
      al_id: kind === 'allowlist' ? field('al_id', 'ID da AL', { placeholder: '019fe35b-6e71-7000-8e5f-...' }) : null,
      author_handle: field('author_handle', 'Autor (@)', { placeholder: '@player' }),
      player_discord_id: field('player_discord_id', 'Discord ID', { max: 20, mode: 'numeric', placeholder: 'Só números' }),
      player_age: field('player_age', 'Idade (IRL)', { type: 'number' }),
      submitted_at_text: field('submitted_at_text', kind === 'allowlist' ? 'Enviada em' : 'Data', { extra: nowBtn }),
      character_name: field('character_name', 'Nome do personagem'),
    };
    const minorBanner = h('div', { class: 'banner banner--danger', id: 'al-minor', role: 'alert', hidden: true }, icon('alert-octagon'),
      h('p', {}, h('strong', {}, 'Menor de 18 anos: reprovação automática. '), 'Registrar no canal Menor de Idade.'));
    const nameBanner = h('div', { class: 'banner', id: 'al-name-check', role: 'status', hidden: true });

    /* ---------- avaliação e status ---------- */
    const flagBtns = Object.entries(EVAL_FLAGS).map(([flag, text]) => h('button', {
      type: 'button', class: `al-flag al-flag--${FLAG_TONE[flag]}`, id: `al-${flag}`, 'aria-pressed': 'false',
      onclick: () => {
        st.eval_flags = toggleFlag(st.eval_flags, flag);
        st.status = nextStatus(st.status, st.eval_flags, age());
        if (st.status === 'reprovado') st.reason = autoMessage(kind, { flags: st.eval_flags, age: age() });
        touch();
        update('flags');
      },
    }, h('span', { 'aria-hidden': 'true' }, FLAG_MARK[flag]), flag === 'ev5' && kind === 'allowlist' ? `${text} — sugerimos que refaça a allowlist` : text));
    const statusBtn = (value, text) => h('button', {
      type: 'button', class: `al-status al-status--${value}`, id: `al-status-${value}`, 'aria-pressed': 'false',
      onclick: () => {
        st.status = value;
        if (value === 'reprovado' && !st.reason.trim()) st.reason = autoMessage(kind, { flags: st.eval_flags, age: age() });
        touch();
        update('status');
      },
    }, text);
    const approveBtn = statusBtn('aprovado', '✓ Aprovada');
    const rejectBtn = statusBtn('reprovado', '✗ Reprovada');
    const reasonIn = h('textarea', { class: 'textarea', id: 'al-reason', rows: 4, maxlength: AL_LIMITS.reason });
    reasonIn.addEventListener('input', () => { st.reason = reasonIn.value; touch(); update('reason'); });
    const reasonField = h('div', { class: 'field', hidden: true },
      h('label', { class: 'field-label', for: 'al-reason' }, 'Motivo da reprovação'), reasonIn,
      h('p', { class: 'field-hint' }, 'Preenchido sozinho pela avaliação; pode ajustar o texto.'), fieldError('reason'));
    const notesIn = h('textarea', {
      class: 'textarea', id: 'al-notes', rows: kind === 'entrevista' ? 4 : 3, maxlength: AL_LIMITS.notes,
      placeholder: kind === 'entrevista'
        ? 'Anote aqui qualquer observação sobre o player: comportamento, pontos de atenção, dificuldades, destaques...'
        : 'Observações internas sobre a análise (vão no card do Discord).',
    }, st.notes);
    notesIn.addEventListener('input', () => { st.notes = notesIn.value; touch(); update('notes'); });

    /* ---------- prints ---------- */
    const prints = printsBox(attachments, touch);
    const onPaste = (e) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((x) => x.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); prints.add(files); }
    };
    document.addEventListener('paste', onPaste);

    /* ---------- checklist e gabarito (entrevista) ---------- */
    const checklist = kind === 'entrevista' ? checklistSection() : null;
    const gabarito = kind === 'entrevista' ? gabaritoSection() : null;

    function checklistSection() {
      const summary = h('span', { class: 'al-checklist-count', id: 'al-checklist-progress', 'aria-live': 'polite' });
      const list = h('div', { class: 'al-checklist' });
      function draw() {
        const p = checklistProgress(config.items, st.checked);
        summary.textContent = `(${p.done}/${p.total} itens concluídos)`;
        summary.classList.toggle('is-complete', p.complete);
        list.replaceChildren(...p.stages.map((s) => h('fieldset', { class: 'al-stage' },
          h('legend', { class: 'al-stage-title' }, `Etapa ${String(s.stage).padStart(2, '0')} — ${s.title}`),
          s.items.map((it) => h('label', { class: `al-check${it.done ? ' is-done' : ''}` },
            h('input', { type: 'checkbox', checked: it.done, onchange: (e) => {
              if (e.target.checked) st.checked.add(it.id); else st.checked.delete(it.id);
              touch();
              draw();
            } }),
            h('span', {}, it.text, it.hint && h('em', { class: 'al-hint' }, ` — ${it.hint}`)))))));
      }
      draw();
      return {
        draw,
        el: collapsible(summary, h('div', { class: 'al-checklist-body', id: 'al-checklist-body', hidden: !checklistOpen }, list,
          h('div', { class: 'panel-actions' }, h('button', { type: 'button', class: 'btn btn--ghost', id: 'al-checklist-reset', onclick: async () => {
            if (!await confirmDialog({ title: 'Reiniciar o checklist?', message: 'Desmarca todos os itens e apaga as Observações.', confirmLabel: 'Reiniciar', danger: true })) return;
            st.checked.clear();
            st.notes = '';
            notesIn.value = '';
            touch();
            draw();
          } }, icon('refresh'), 'Reiniciar checklist')))),
      };
    }

    /** Cabeçalho clicável que abre e fecha o checklist (fechado por padrão). */
    function collapsible(summary, content) {
      const toggle = h('button', {
        type: 'button', class: 'al-collapse', id: 'al-checklist-toggle', 'aria-expanded': String(checklistOpen), 'aria-controls': 'al-checklist-body',
        onclick: () => {
          checklistOpen = !checklistOpen;
          toggle.setAttribute('aria-expanded', String(checklistOpen));
          content.hidden = !checklistOpen;
        },
      }, h('span', { class: 'al-collapse-mark', 'aria-hidden': 'true' }, '›'), ' Checklist da entrevista ', summary);
      return h('section', { class: 'panel al-checklist-panel', 'aria-labelledby': 'al-checklist-toggle' },
        h('h2', { class: 'block-title al-collapse-title' }, toggle), content);
    }

    function gabaritoSection() {
      const notes = [];
      const sections = [...new Set(config.questions.map((q) => q.section))];
      const card = (q, n) => {
        const a = st.answers.get(q.id) ?? { note: '', send: false };
        const answerId = `al-q-${q.id}-answer`;
        const answer = h('div', { class: 'al-answer', id: answerId, hidden: true },
          h('p', {}, h('strong', {}, 'R: '), q.answer), q.extra_note && h('p', { class: 'al-extra' }, q.extra_note));
        const toggle = h('button', { type: 'button', class: 'al-q-text', 'aria-expanded': 'false', 'aria-controls': answerId, onclick: () => {
          answer.hidden = !answer.hidden;
          toggle.setAttribute('aria-expanded', String(!answer.hidden));
        } }, `${n}. ${q.question}`);
        const send = h('input', { type: 'checkbox', class: 'al-q-send', checked: a.send, 'aria-label': `Enviar a pergunta ${n} no resultado` });
        const note = h('input', { class: 'input input--sm al-q-note', value: a.note, maxlength: AL_LIMITS.note, placeholder: '↳ anotação...', 'aria-label': `Anotação da pergunta ${n}` });
        const save = () => {
          st.answers.set(q.id, { note: note.value, send: send.checked });
          touch();
        };
        send.addEventListener('change', save);
        note.addEventListener('input', save);
        notes.push(note);
        return h('li', { class: 'al-q', dataset: { questionId: q.id } },
          h('div', { class: 'al-q-head' }, send, h('span', { class: `al-kind al-kind--${q.kind}` }, QUESTION_KINDS[q.kind] ?? q.kind), toggle),
          answer, note);
      };
      let n = 0;
      return {
        el: h('section', { class: 'panel', 'aria-labelledby': 'al-gabarito-title' },
          h('h2', { class: 'block-title', id: 'al-gabarito-title' }, icon('book-2'), 'Gabarito'),
          h('p', { class: 'panel-text' }, 'Clique na pergunta para ver a resposta esperada. Marque a caixinha das perguntas que devem ir no resultado para o Discord.'),
          sections.map((s) => h('div', { class: 'al-q-section' }, h('h3', { class: 'al-q-section-title' }, s),
            h('ol', { class: 'al-q-list' }, config.questions.filter((q) => q.section === s).map((q) => card(q, ++n))))),
          h('div', { class: 'panel-actions' }, h('button', { type: 'button', class: 'btn btn--ghost', id: 'al-notes-clear', onclick: async () => {
            if (!await confirmDialog({ title: 'Limpar as anotações?', message: 'Apaga todas as anotações do gabarito.', confirmLabel: 'Limpar', danger: true })) return;
            for (const el of notes) el.value = '';
            for (const [k, v] of st.answers) st.answers.set(k, { ...v, note: '' });
            touch();
          } }, '↺ Limpar todas as anotações do gabarito'))),
      };
    }

    /* ---------- preview (allowlist) ---------- */
    const preview = kind === 'allowlist' ? h('div', { class: 'al-preview-card', id: 'al-preview' }) : null;
    const previewWrap = kind === 'allowlist' ? h('aside', { class: 'al-preview', 'aria-labelledby': 'al-preview-title' },
      h('h2', { class: 'block-title', id: 'al-preview-title' }, icon('eye'), 'Preview do feedback'),
      h('p', { class: 'panel-text', id: 'al-preview-empty' }, 'Escolha Aprovada ou Reprovada para ver o feedback.'),
      preview,
      h('div', { class: 'al-preview-actions', id: 'al-preview-actions', hidden: true },
        copyButton(() => copyText(evNow()), { size: 'md' }),
        h('button', { type: 'button', class: 'btn', id: 'al-png', onclick: () => exportPng(preview, st.status) }, icon('photo-down'), 'PNG'),
        h('button', { type: 'button', class: 'btn', id: 'al-pdf', onclick: () => printCard(preview) }, icon('printer'), 'PDF'))) : null;

    const evNow = () => ({ ...st, kind, player_age: age(), eval_flags: st.eval_flags });

    function drawPreview() {
      if (!preview) return;
      const has = Boolean(st.status);
      previewWrap.querySelector('#al-preview-empty').hidden = has;
      previewWrap.querySelector('#al-preview-actions').hidden = !has;
      preview.hidden = !has;
      if (!has) return;
      const approved = st.status === 'aprovado';
      const check = checkCharacterName(st.character_name, config.index);
      const row = (k, v) => h('tr', {}, h('th', { scope: 'row' }, k), h('td', {}, v || '—'));
      preview.className = `al-preview-card al-preview-card--${st.status}`;
      // replaceChildren escreveria "false": o filter tira os itens condicionais ausentes.
      preview.replaceChildren(...[
        h('div', { class: 'al-card-head' }, h('span', {}, 'BLOODLINES RP · ALLOWLIST'), h('strong', {}, approved ? '✓ APROVADA' : '✗ REPROVADA')),
        isMinor(age()) && h('p', { class: 'al-card-banner al-card-banner--bad' }, h('strong', {}, 'Menor de idade. '), 'Allowlists são aceitas apenas para maiores de 18 anos. Registrar no canal Menor de Idade.'),
        check && h('p', { class: `al-card-banner al-card-banner--${check.level === 'bloqueia' ? 'bad' : 'warn'}` }, h('strong', {}, `${check.title}. `), check.feedback ?? check.warning),
        h('table', { class: 'al-card-table' }, h('tbody', {},
          row('Responsável', me.display_name), row('ID da AL', st.al_id), row('Autor', st.author_handle), row('Personagem', st.character_name),
          row('Discord ID', st.player_discord_id), row('Enviada em', st.submitted_at_text), row('Analisada em', formatAnalyzedAt()))),
        !approved && h('div', { class: 'al-card-block' }, h('p', { class: 'al-card-label' }, 'Motivo'), h('p', { class: 'pre-wrap' }, st.reason.trim() || '[motivo não preenchido]')),
        st.notes.trim() && h('div', { class: 'al-card-block' }, h('p', { class: 'al-card-label' }, 'Observações'), h('p', { class: 'pre-wrap' }, st.notes.trim())),
        h('div', { class: 'al-card-block' }, h('p', { class: 'al-card-label' }, 'Mensagem para o player'), renderMarkdownInto(h('div', { class: 'md' }), playerMessage(evNow()))),
        h('p', { class: 'al-card-sign' }, SIGNATURE)].filter(Boolean));
    }

    /* ---------- atualização da tela ---------- */
    function update(what) {
      const minor = isMinor(age());
      if (what === 'player_age' && minor) {
        st.status = 'reprovado';
        st.reason = autoMessage(kind, { flags: st.eval_flags, age: age() });
      }
      minorBanner.hidden = !minor;
      for (const b of flagBtns) {
        const flag = b.id.slice(3);
        b.setAttribute('aria-pressed', String(st.eval_flags.includes(flag)));
        b.disabled = minor;
      }
      approveBtn.disabled = minor;
      approveBtn.setAttribute('aria-pressed', String(st.status === 'aprovado'));
      rejectBtn.setAttribute('aria-pressed', String(st.status === 'reprovado'));
      reasonField.hidden = st.status !== 'reprovado';
      if (what !== 'reason' && reasonIn.value !== st.reason) reasonIn.value = st.reason;
      const check = checkCharacterName(st.character_name, config.index);
      nameBanner.hidden = !check;
      if (check) {
        nameBanner.className = `banner ${check.level === 'bloqueia' ? 'banner--danger' : 'banner--warn'}`;
        nameBanner.replaceChildren(icon(check.level === 'bloqueia' ? 'ban' : 'alert-triangle'),
          h('p', {}, h('strong', {}, `${check.level === 'bloqueia' ? 'Nome de personagem bloqueado' : 'Atenção ao nome'}: `), check.title, '. ', check.warning));
      }
      drawPreview();
    }

    /* ---------- salvar ---------- */
    const errorEl = h('p', { class: 'field-error form-general-error', id: 'al-error', role: 'alert', tabindex: '-1', hidden: true });
    function showErrors(error) {
      for (const el of Object.values(errs)) el.hidden = true;
      const fields = error?.details?.errors ?? {};
      for (const [k, msg] of Object.entries(fields)) if (errs[k]) { errs[k].textContent = msg; errs[k].hidden = false; }
      errorEl.textContent = errorText(error);
      errorEl.hidden = false;
      errorEl.focus();
    }

    /** Grava a análise e os prints. Devolve o id ou null (erros na tela). */
    async function save({ quiet = false } = {}) {
      if (!st.status) { showErrors({ details: { errors: { _: 'Escolha Aprovada ou Reprovada antes de salvar.' } } }); return null; }
      const payload = {
        id: st.id ?? undefined, kind,
        ...(kind === 'allowlist' ? { al_id: st.al_id } : {}),
        author_handle: st.author_handle, player_discord_id: st.player_discord_id, player_age: st.player_age,
        character_name: st.character_name, submitted_at_text: st.submitted_at_text, eval_flags: st.eval_flags,
        status: st.status, reason: st.status === 'reprovado' ? st.reason : '', notes: st.notes,
        ...(kind === 'entrevista' ? {
          checklist: checklistSnapshot(config.items, st.checked),
          participants: st.participants,
          answers: config.questions.filter((q) => { const a = st.answers.get(q.id); return a && (a.note.trim() || a.send); })
            .map((q) => ({ question_id: q.id, question_text: q.question, note: st.answers.get(q.id).note, send_to_discord: st.answers.get(q.id).send })),
        } : {}),
      };
      const res = await app.adapter.saveAlEvaluation(payload);
      if (!alive) return null;
      if (res.error) { showErrors(res.error); return null; }
      errorEl.hidden = true;
      for (const el of Object.values(errs)) el.hidden = true;
      st.id = res.data.id;
      const uploaded = [];
      for (const attId of prints.removed()) await app.adapter.removeAlPrint(attId);
      for (const it of prints.pending()) {
        const up = await app.adapter.addAlPrint(st.id, it.file);
        if (up.error) toast(`Print não salvo: ${errorText(up.error)}`, 4000); else uploaded.push([it, up.data]);
      }
      prints.saved(uploaded);
      dirty = false;
      if (!quiet) toast('Análise salva no histórico.');
      return st.id;
    }

    const saveBtn = h('button', { type: 'button', class: 'btn', id: 'al-save', 'data-requires-online': '', onclick: async () => {
      const saved = await save();
      // Primeira gravação: o endereço passa a ter o id (recarregar a página continua a análise).
      if (saved && !id) { app.router.clearGuard(); app.router.go(`${BASE[kind]}/${saved}`); }
    } }, icon('device-floppy'), 'Salvar');
    const newBtn = kind === 'entrevista' && h('button', { type: 'button', class: 'btn btn--ghost', id: 'al-new', onclick: async () => {
      if (dirty && !await confirmDialog({ title: 'Começar uma nova entrevista?', message: 'O que não foi salvo nesta entrevista será perdido.', confirmLabel: 'Nova entrevista', danger: true })) return;
      dirty = false;
      if (id) { app.router.clearGuard(); app.router.go(BASE[kind]); return; }
      build(null, config, []);
      app.els.main.querySelector('#al-author_handle')?.focus();
    } }, icon('plus'), 'Nova entrevista');
    const send = sendBox(app, {
      kind, sentAt: null,
      getId: () => save({ quiet: true }),
      onSent: (_r, savedId) => { dirty = false; app.router.clearGuard(); app.router.go(`#/avaliacoes/${savedId}`); },
    });

    const identity = h('section', { class: 'panel', 'aria-labelledby': 'al-id-title' },
      h('h2', { class: 'block-title', id: 'al-id-title' }, icon('id-badge-2'), kind === 'allowlist' ? 'Dados da allowlist' : 'Identificação do entrevistado'),
      h('p', { class: 'panel-text', id: 'al-responsible' }, 'Responsável: ', h('strong', {}, me.display_name), ' (você)'),
      h('div', { class: 'staff-form-grid' }, Object.values(f).filter(Boolean).map((x) => x.el)),
      minorBanner, nameBanner);
    const team = kind === 'entrevista' ? participantsPanel(config.staff, st.participants, me.discord_id, touch) : null;
    const evaluation = h('section', { class: 'panel', 'aria-labelledby': 'al-eval-title' },
      h('h2', { class: 'block-title', id: 'al-eval-title' }, icon('checklist'), 'Avaliação do candidato'),
      h('div', { class: 'al-flags', role: 'group', 'aria-labelledby': 'al-eval-title' }, flagBtns),
      h('div', { class: 'al-statuses', role: 'group', 'aria-label': 'Resultado' }, approveBtn, rejectBtn),
      reasonField,
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'al-notes' }, 'Observações'), notesIn,
        kind === 'entrevista' && h('p', { class: 'field-hint' }, 'Vão no envio da entrevista para o Discord.'), fieldError('notes')));
    const printsPanel = h('section', { class: 'panel', 'aria-labelledby': 'al-prints-title' },
      h('h2', { class: 'block-title', id: 'al-prints-title' }, icon('photo'), 'Prints da avaliação'), prints.el);
    const actions = h('div', { class: 'form-actions al-actions' }, newBtn, saveBtn, send);

    if (kind === 'allowlist') {
      body.replaceChildren(h('div', { class: 'al-grid' }, h('div', { class: 'al-form' }, identity, printsPanel, evaluation, errorEl, actions), previewWrap));
    } else {
      // Entrevista: esquerda fixa (dados, participantes, avaliação, prints e botões); direita com checklist e perguntas.
      body.replaceChildren(h('div', { class: 'al-interview' },
        h('div', { class: 'al-form al-interview-side' }, identity, team, evaluation, printsPanel, errorEl, actions),
        h('div', { class: 'al-form al-interview-main' }, checklist.el, gabarito.el)));
    }
    update('init');
    app.applyOnline();
    app.router.setGuard(async () => {
      if (!dirty) return true;
      return confirmDialog({ title: 'Sair sem salvar?', message: 'A análise ainda não foi salva no histórico.', confirmLabel: 'Sair sem salvar', cancelLabel: 'Continuar', danger: true });
    });
    cleanupBuild = () => { document.removeEventListener('paste', onPaste); prints.dispose(); };
  }

  load();
  return () => { alive = false; cleanupBuild(); app.router.clearGuard(); };
}

/* ============================ PNG e PDF ============================ */
async function exportPng(card, status) {
  try {
    const { default: html2canvas } = await import('html2canvas');
    const canvas = await html2canvas(card, { scale: 2, backgroundColor: '#13101C', logging: false });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `feedback-al-${status === 'aprovado' ? 'aprovado' : 'reprovado'}.png`, class: 'sr-only' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    toast('Não foi possível gerar o PNG.', 3500);
  }
}

/** Janela de impressão só com o card ("Salvar como PDF"). */
function printCard(card) {
  document.body.classList.add('print-card');
  card.classList.add('is-printing');
  const done = () => { document.body.classList.remove('print-card'); card.classList.remove('is-printing'); };
  window.addEventListener('afterprint', done, { once: true });
  window.print();
  setTimeout(done, 1000);
}
