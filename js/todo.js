// 할 일: one list per day, like the user's own notes (TodoMate style). The circle says how it went
// (할 일 → 했음 → 못 함), unfinished items can be carried to the next day, and a memo keeps what changed.
// Stored only on this phone (IndexedDB) and carried in the backup file.
import { $, el, today, addDays, dayLabel, uid, toast } from './util.js';
import { openDialog } from './ui.js';
import * as db from './db.js';

const T = { list: [], day: today() };
// 루틴: tasks that come back on chosen weekdays (매일, 평일, 월·수·금 …). A day's copies are made when that day is opened,
// today or later only (past days stay as they were), at the top of the list; they are not carried over (they come back).
const R = { list: [] }; // {id, text, days: [0–6, 0 = 일], from: day, skip: {day: true}}
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const weekday = (d) => new Date(`${d}T00:00:00`).getDay();
function daysText(days) {
  const s = [...days].sort((a, b) => a - b).join('');
  return s === '0123456' ? '매일' : s === '12345' ? '평일' : s === '06' ? '주말' : [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WD[d]).join('·');
}
async function saveRoutines() { try { await db.kvSet('routines', R.list); } catch (e) { toast('루틴을 저장하지 못했어요'); } }
function ensureRoutines(d) {
  if (d < today()) return false;
  let added = false;
  R.list.forEach((r, i) => {
    if (d < r.from || !r.days.includes(weekday(d)) || (r.skip && r.skip[d])) return;
    if (T.list.some((t) => t.routine === r.id && t.day === d)) return;
    T.list.push({ id: uid('t'), day: d, text: r.text, memo: '', state: 'todo', routine: r.id, ts: Date.now(), order: -1000 + i });
    added = true;
  });
  return added;
}
export const routinesForBackup = () => R.list;
export async function restoreRoutines(list) {
  const have = new Set(R.list.map((r) => r.id));
  for (const r of list || []) if (r && r.id && !have.has(r.id)) R.list.push(r);
  await saveRoutines();
}
const NEXT = { todo: 'done', done: 'fail', fail: 'todo' };
const MARK = { todo: '', done: '✓', fail: '✕', moved: '→' };
const SAY = { todo: '할 일', done: '했음', fail: '못 함', moved: '넘김' };

export async function loadTodos() {
  T.list = (await db.kvGet('todos', [])) || [];
  R.list = (await db.kvGet('routines', [])) || [];
  if (ensureRoutines(today())) await save();
  updateTodoBadge();
}
export const todosForBackup = () => T.list;
export async function restoreTodos(list) {
  const have = new Set(T.list.map((t) => t.id));
  for (const t of list || []) if (t && t.id && !have.has(t.id)) T.list.push(t);
  await save();
}
async function save() {
  try { await db.kvSet('todos', T.list); } catch (e) { toast('할 일을 저장하지 못했어요'); }
  updateTodoBadge();
}
const ofDay = (d) => T.list.filter((t) => t.day === d).sort((a, b) => (a.order || 0) - (b.order || 0) || a.ts - b.ts);
const nextOrder = (d) => Math.max(0, ...ofDay(d).map((t) => t.order || 0)) + 1;
const short = (d) => { const [, m, dd] = d.split('-'); return `${+m}/${+dd}`; };
// unfinished items left on earlier days
const behind = () => T.list.filter((t) => t.day < today() && t.state === 'todo' && !t.routine);

export function updateTodoBadge() {
  const b = $('#todoBadge');
  if (!b) return;
  const n = ofDay(today()).filter((t) => t.state === 'todo').length;
  b.textContent = String(n);
  b.hidden = n === 0;
}

// carried items stay on their day marked "→ 11/2" and start again on the new day
function carry(list, toDay) {
  for (const t of list) {
    t.state = 'moved';
    t.movedTo = toDay;
    T.list.push({ id: uid('t'), day: toDay, text: t.text, memo: t.memo || '', state: 'todo', from: t.from || t.day, ts: Date.now(), order: nextOrder(toDay) });
  }
}

export function renderTodos() {
  if (ensureRoutines(T.day)) save();
  const d = T.day, items = ofDay(d), isToday = d === today();
  $('#tTitle').replaceChildren(`${short(d)} (${WD[weekday(d)]})`, isToday ? el('small', { class: 't-today' }, '오늘') : '');
  const real = items.filter((t) => t.state !== 'moved');
  $('#tCount').textContent = real.length ? `${real.filter((t) => t.state === 'done').length}/${real.length}` : '';
  const late = isToday ? behind() : [];
  const banner = $('#tCarry');
  banner.hidden = !late.length;
  if (late.length) {
    banner.replaceChildren(el('span', {}, `지난날 못 끝낸 일 ${late.length}개`),
      el('button', { class: 'btn small', onclick: async () => { carry(late, today()); await save(); renderTodos(); toast(`${late.length}개를 오늘로 넘겼어요`); } }, '오늘로 넘기기'));
  }
  $('#tList').replaceChildren(...items.map((t) => el('div', { class: 'todo ' + t.state, 'data-id': t.id },
    el('button', { class: 'todo-dot', 'aria-label': `${t.text}: ${SAY[t.state]}`, disabled: t.state === 'moved', onclick: () => cycle(t) }, el('i', {}, MARK[t.state])),
    el('button', { class: 'todo-txt', onclick: () => edit(t) },
      el('span', {}, t.routine ? el('b', { class: 'rt-mark', 'aria-label': '루틴' }, '↻') : null, t.text),
      t.memo ? el('small', {}, t.memo) : null,
      t.state === 'moved' ? el('small', { class: 'todo-note' }, `${short(t.movedTo)}로 넘김`) : null,
      null),
    t.state === 'done' && !t.routine ? againKey(t) : null)));
  $('#tEmpty').hidden = items.length > 0;
  $('#tSort').hidden = items.filter((t) => t.state !== 'moved').length < 2;
}

// done today, to do again tomorrow: one tap copies it to the next day
function againKey(t) {
  const next = addDays(t.day, 1), has = T.list.some((x) => x.againOf === t.id);
  return el('button', {
    class: 'todo-again', 'aria-pressed': String(has),
    onclick: async () => {
      if (has) { T.list = T.list.filter((x) => !(x.againOf === t.id && x.state === 'todo')); toast('내일 할 일에서 뺐어요'); }
      else { T.list.push({ id: uid('t'), day: next, text: t.text, memo: '', state: 'todo', againOf: t.id, ts: Date.now(), order: nextOrder(next) }); toast(`${short(next)}에도 넣었어요`); }
      renderTodos();
      await save();
    },
  }, has ? '내일도 ✓' : '내일도');
}
async function cycle(t) {
  t.state = NEXT[t.state] || 'todo';
  renderTodos(); // show it at once; saving follows
  await save();
}

// tap on the words: change them, leave a memo (what changed), carry to another day, or delete
function edit(t) {
  const isPast = t.day < today();
  return openDialog((box, close) => {
    const text = el('input', { value: t.text, autocomplete: 'off' });
    const memo = el('textarea', { rows: 3, placeholder: '변동 사항 메모 (예: 자재 반입 늦어져 내일 오전으로)' });
    memo.value = t.memo || '';
    const apply = () => { const v = text.value.trim(); if (v) t.text = v; t.memo = memo.value.trim(); };
    const act = (fn) => async () => { apply(); fn(); await save(); close(); renderTodos(); };
    const moveTo = isPast ? today() : addDays(t.day, 1);
    box.append(el('h3', {}, '할 일'), text, memo,
      el('div', { class: 'd-actions' },
        el('button', { class: 'btn danger', onclick: act(() => {
          T.list = T.list.filter((x) => x !== t);
          const r = t.routine && R.list.find((x) => x.id === t.routine);
          if (r) { r.skip = { ...(r.skip || {}), [t.day]: true }; saveRoutines(); }
        }) }, '지우기'),
        t.state === 'moved' || t.routine ? null : el('button', { class: 'btn', onclick: act(() => carry([t], moveTo)) }, isPast ? '오늘로 넘기기' : '내일로 넘기기'),
        el('button', { class: 'btn primary', onclick: act(() => {}) }, '저장')));
  });
}

function routinesDialog() {
  return openDialog((box, close) => {
    const list = () => {
      box.replaceChildren(el('h3', {}, '루틴'),
        R.list.length ? el('div', { class: 'rt-list' }, ...R.list.map((r) => el('button', { class: 'rt-row', onclick: () => form(r) },
          el('span', {}, r.text), el('small', {}, daysText(r.days)))))
          : el('p', { class: 'muted' }, '정해진 요일마다 할 일 목록에 저절로 들어가는 일이에요. (예: TBM 사진, 작업일보)'),
        el('div', { class: 'd-actions' }, el('button', { class: 'btn', onclick: () => close() }, '닫기'), el('button', { class: 'btn primary', onclick: () => form(null) }, '+ 루틴 추가')));
    };
    const form = (r) => {
      const days = new Set(r ? r.days : [1, 2, 3, 4, 5]);
      const text = el('input', { value: r ? r.text : '', placeholder: '예: TBM 사진 정리', autocomplete: 'off' });
      const keys = [1, 2, 3, 4, 5, 6, 0].map((d) => el('button', { 'aria-pressed': String(days.has(d)), onclick: () => { if (days.has(d)) days.delete(d); else days.add(d); paint(); } }, WD[d]));
      const paint = () => keys.forEach((k, i) => k.setAttribute('aria-pressed', String(days.has([1, 2, 3, 4, 5, 6, 0][i]))));
      const preset = (ds) => () => { days.clear(); ds.forEach((d) => days.add(d)); paint(); };
      const commit = async () => {
        const v = text.value.trim();
        if (!v || !days.size) { toast(v ? '요일을 하나 이상 고르세요' : '할 일을 적으세요'); return; }
        const ds = [...days].sort();
        if (r) {
          r.text = v;
          r.days = ds;
          // today's and later copies not done yet follow the change
          T.list = T.list.filter((t) => !(t.routine === r.id && t.day >= today() && t.state === 'todo' && !ds.includes(weekday(t.day))));
          for (const t of T.list) if (t.routine === r.id && t.day >= today() && t.state === 'todo') t.text = v;
        } else R.list.push({ id: uid('r'), text: v, days: ds, from: today(), skip: {} });
        await saveRoutines();
        ensureRoutines(T.day);
        await save();
        renderTodos();
        list();
      };
      const remove = async () => {
        R.list = R.list.filter((x) => x !== r);
        T.list = T.list.filter((t) => !(t.routine === r.id && t.day >= today() && t.state === 'todo'));
        await saveRoutines();
        await save();
        renderTodos();
        list();
      };
      box.replaceChildren(el('h3', {}, r ? '루틴 고치기' : '루틴 추가'), text,
        el('div', { class: 'seg rt-days' }, ...keys),
        el('div', { class: 'btns' }, el('button', { class: 'btn small', onclick: preset([0, 1, 2, 3, 4, 5, 6]) }, '매일'), el('button', { class: 'btn small', onclick: preset([1, 2, 3, 4, 5]) }, '평일'), el('button', { class: 'btn small', onclick: preset([0, 6]) }, '주말')),
        el('div', { class: 'd-actions' },
          r ? el('button', { class: 'btn danger', onclick: remove }, '지우기') : null,
          el('button', { class: 'btn', onclick: list }, '취소'),
          el('button', { class: 'btn primary', onclick: commit }, '저장')));
      text.focus();
    };
    list();
  });
}

async function add(text) {
  const v = text.trim();
  if (!v) return;
  T.list.push({ id: uid('t'), day: T.day, text: v, memo: '', state: 'todo', ts: Date.now(), order: nextOrder(T.day) });
  await save();
  renderTodos();
}

// order: press and hold a to-do, then drag it up or down. "정리" puts open ones first, then done, failed, carried.
const RANK = { todo: 0, done: 1, fail: 2, moved: 3 };
async function setOrder(list) {
  list.forEach((t, i) => { t.order = i + 1; });
  renderTodos();
  await save();
}
function bindReorder() {
  const box = $('#tList');
  let P = null, skipClick = false;
  const rows = () => [...box.querySelectorAll('.todo')];
  const clear = () => { rows().forEach((r) => { r.classList.remove('lift', 'drop-before'); r.style.transform = ''; }); box.classList.remove('drop-end'); };
  box.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.todo');
    if (!row || e.target.closest('.todo-dot, .todo-again') || (e.pointerType === 'mouse' && e.button !== 0)) return;
    P = { row, id: row.dataset.id, x0: e.clientX, y0: e.clientY, pid: e.pointerId, on: false, idx: null };
    P.timer = setTimeout(() => {
      if (!P) return;
      P.on = true;
      P.row.classList.add('lift');
      try { box.setPointerCapture(P.pid); } catch (err) { /* fine without */ }
      if (navigator.vibrate) navigator.vibrate(10);
    }, 380);
  });
  box.addEventListener('pointermove', (e) => {
    if (!P) return;
    const dy = e.clientY - P.y0;
    if (!P.on) { if (Math.hypot(e.clientX - P.x0, dy) > 8) { clearTimeout(P.timer); P = null; } return; }
    P.row.style.transform = `translateY(${dy}px)`;
    const others = rows().filter((r) => r !== P.row);
    let idx = others.length;
    for (let i = 0; i < others.length; i++) { const b = others[i].getBoundingClientRect(); if (e.clientY < b.top + b.height / 2) { idx = i; break; } }
    others.forEach((r, i) => r.classList.toggle('drop-before', i === idx));
    box.classList.toggle('drop-end', idx === others.length);
    P.idx = idx;
  });
  const end = async () => {
    if (!P) return;
    clearTimeout(P.timer);
    const p = P;
    P = null;
    if (!p.on) return;
    skipClick = true;
    setTimeout(() => { skipClick = false; }, 0);
    clear();
    if (p.idx == null) return;
    const list = ofDay(T.day), t = list.find((x) => x.id === p.id);
    if (!t) return;
    const rest = list.filter((x) => x !== t);
    rest.splice(p.idx, 0, t);
    await setOrder(rest);
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  box.addEventListener('touchmove', (e) => { if (P && P.on && e.cancelable) e.preventDefault(); }, { passive: false });
  box.addEventListener('click', (e) => { if (skipClick) { e.stopPropagation(); e.preventDefault(); } }, true);
}
export function bindTodos() {
  bindReorder();
  $('#tRoutine').onclick = () => routinesDialog();
  $('#tSort').onclick = async () => {
    const list = ofDay(T.day);
    if (list.length < 2) return;
    await setOrder(list.map((t, i) => [t, i]).sort((a, b) => (RANK[a[0].state] ?? 0) - (RANK[b[0].state] ?? 0) || a[1] - b[1]).map((x) => x[0]));
    toast('할 일을 위로, 끝낸 일을 아래로 정리했어요');
  };
  const go = (d) => { T.day = d; renderTodos(); };
  $('#tPrev').onclick = () => go(addDays(T.day, -1));
  $('#tNext').onclick = () => go(addDays(T.day, 1));
  $('#tTitle').onclick = () => go(today());
  $('#tAdd').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#tInput');
    add(inp.value);
    inp.value = '';
    inp.focus(); // keep typing the next one
  });
}
export function showTodoToday() { T.day = today(); }
