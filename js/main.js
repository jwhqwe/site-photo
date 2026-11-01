// 현장 사진 — app logic. Drawings, photos and records live only in this phone's storage (IndexedDB).
import {
  $, $$, el, uid, dayOf, today, yymmdd, timeOf, dayLabel, addDays, extOf, computeNames, csv,
  makeZip, readZip, imageThumb, videoThumb, toast, shareOrDownload, fmtBytes, withExif, turnJpeg, turnMovie, shotTime, ownCopy, headOf, isZipHead, withMovieTime, MEMO, grayOf, memoCorner, burnMemo,
} from './util.js';
import * as db from './db.js';
import { PlanView, svg, ptsAttr, fanPath, centroid, polyDist } from './plan.js';
import { Camera, nativeCapture, sensors, headingToPlan, calibFor, bearingOf, FAN_HALF } from './camera.js';
import { openScan, canvasFromBlob, findPaper } from './scan.js';
import { photoSheetPdf } from './report.js';
import { loadTodos, renderTodos, bindTodos, todosForBackup, restoreTodos, updateTodoBadge, showTodoToday } from './todo.js';
import { openDialog, confirmBox, alertBox, promptText, choose, offerFile, busy, pickFiles } from './ui.js';

const APP_VERSION = '1.9.1';
const APP_DATE = '2026-11-01';

// Start screen: shows the running version (the one this code is) long enough to read, then fades out. A tap skips it.
const SPLASH_MIN_MS = 2500;
const SPLASH_FROM = performance.now();
{
  const v = document.getElementById('splashVer');
  if (v) v.textContent = `버전 ${APP_VERSION} · ${APP_DATE}`;
  const sp = document.getElementById('splash');
  if (sp) sp.addEventListener('click', () => hideSplash(true));
}
function hideSplash(now) {
  const sp = document.getElementById('splash');
  if (!sp || sp.dataset.closing) return;
  const wait = now ? 0 : Math.max(0, SPLASH_MIN_MS - (performance.now() - SPLASH_FROM));
  setTimeout(() => {
    if (sp.dataset.closing) return;
    sp.dataset.closing = '1';
    sp.classList.add('out');
    setTimeout(() => sp.remove(), 320);
  }, wait);
}
const DEG = Math.PI / 180;
const PDF_ID = '__pdf';

// ================================================================ state
const S = {
  pkg: null, floors: [], floorCache: new Map(),
  items: [], byId: new Map(), names: null,
  settings: { capture: 'app', calib: 0, lastBackup: 0, capFloor: null, showRooms: false, lensId: null, zoom: 1, tbmName: '건축' },
  tab: null, day: today(), planFloor: null, planSel: null, issueFilter: 'open',
  mode: 'normal', fixOf: null, tbmCount: 0, scan: false,
  lastSetup: null, swReg: null,
  shared: new Set(), // ids already shared or zipped out of the app (kept apart from the records so a save never races it)
};
const vis = () => S.items.filter((i) => !i.draft);
const north = () => (S.pkg && S.pkg.north && S.pkg.north.cw) || 0;
// B3 → B3F, F1 → 1F, RF stays RF (short, fits the chips)
const floorShort = (key) => { const m = /^B(\d+)$/.exec(key || ''); if (m) return `B${m[1]}F`; const n = /^F(\d+)$/.exec(key || ''); return n ? `${n[1]}F` : (key || ''); };
const floorLabel = (key) => floorShort(key);
const saveSettings = () => db.kvSet('settings', S.settings).catch(() => {});
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const dayStart = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const daysBetween = (a, b) => Math.round((dayStart(b) - dayStart(a)) / 864e5);
const md = (day) => `${+day.slice(5, 7)}/${+day.slice(8, 10)}`;

function setItems(list) {
  S.items = list.sort((a, b) => a.ts - b.ts);
  S.byId = new Map(S.items.map((i) => [i.id, i]));
  S.names = null;
}
function names() { if (!S.names) S.names = computeNames(vis(), S.settings.tbmName); return S.names; }
function nameOf(it) { return (names().get(it.id) || it.id) + '.' + extOf(it); }
function remember(it) {
  if (S.byId.has(it.id)) { const k = S.items.findIndex((x) => x.id === it.id); S.items[k] = it; }
  else { S.items.push(it); S.items.sort((a, b) => a.ts - b.ts); }
  S.byId.set(it.id, it);
  S.names = null;
}
async function putItem(it, blob, thumb) {
  it.mt = Date.now(); // last change, for sending only what is new to another device
  await db.saveItem(it, blob || null, thumb || null);
  remember(it);
  return it;
}
async function putRecords(list) {
  if (!list.length) return;
  const now = Date.now();
  for (const it of list) it.mt = now;
  await db.putMany('items', list);
  for (const it of list) remember(it);
}
async function removeItem(id) {
  const it = S.byId.get(id);
  if (!it) return;
  await db.deleteItem(id);
  S.items = S.items.filter((x) => x.id !== id);
  S.byId.delete(id);
  S.names = null;
  dropThumb(id);
  if (it.fixOf) {
    const o = S.byId.get(it.fixOf);
    if (o && o.issue && o.issue.fixId === id) await putItem({ ...o, issue: { status: 'open' } });
  }
  if (it.issue && it.issue.fixId) {
    const f = S.byId.get(it.issue.fixId);
    if (f && f.fixOf === id) await putItem({ ...f, fixOf: null });
  }
}

// thumbnails as object URLs, the oldest let go after a while
const thumbUrls = new Map();
function thumbUrl(id) {
  let p = thumbUrls.get(id);
  if (!p) {
    p = db.get('thumbs', id).then((r) => (r && r.blob ? URL.createObjectURL(r.blob) : '')).catch(() => '');
    thumbUrls.set(id, p);
    if (thumbUrls.size > 600) {
      const [k, old] = thumbUrls.entries().next().value;
      thumbUrls.delete(k);
      old.then((u) => u && URL.revokeObjectURL(u));
    }
  }
  return p;
}
function dropThumb(id) {
  const p = thumbUrls.get(id);
  if (p) { thumbUrls.delete(id); p.then((u) => u && URL.revokeObjectURL(u)); }
}

// ================================================================ drawings
async function getFloor(key) {
  if (!key) return null;
  let f = S.floorCache.get(key);
  if (!f) { f = await db.get('floors', key); if (f) S.floorCache.set(key, f); }
  return f || null;
}
async function getPdfBlob() { const r = await db.get('files', PDF_ID); return r ? r.blob : null; }
function memMap(fl) {
  if (!fl._byId) Object.defineProperty(fl, '_byId', { value: new Map(fl.members.map((m) => [m.id, m])) });
  return fl._byId;
}
const memberOf = (fl, ref) => (fl && typeof ref.id === 'number' ? memMap(fl).get(ref.id) || null : null);

const PV = new PlanView(getPdfBlob);
const planViews = {};
let planCtx = null;

// Puts the shared drawing view into a screen, with that screen's tap handler and overlay.
async function usePlan(ctx) {
  if (planCtx && PV.floor && planCtx.save !== false) (planViews[planCtx.name] ||= {})[PV.floor.key] = PV.getView();
  planCtx = ctx;
  PV.onTap = ctx.onTap || null;
  PV.drawStatic = ctx.drawStatic || null;
  PV.drawDynamic = ctx.drawDynamic || null;
  PV.onPress = ctx.onPress || null;
  PV.onHold = ctx.onHold || null;
  PV.onDragStart = ctx.onDragStart || null;
  PV.onDrag = ctx.onDrag || null;
  PV.onDragEnd = ctx.onDragEnd || null;
  PV.hideLoupe();
  PV.mount(ctx.host);
  const fl = await getFloor(ctx.floor);
  if (planCtx !== ctx) return;
  await PV.setFloor(fl, true);
  if (planCtx !== ctx || !fl) return;
  PV.showRooms(!!ctx.rooms);
  await new Promise((r) => requestAnimationFrame(() => r()));
  if (planCtx !== ctx) return;
  PV.fit();
  const saved = (planViews[ctx.name] || {})[ctx.floor];
  if (ctx.focus) PV.focus(ctx.focus, ctx.focusScale);
  else if (saved) PV.setView({ s: saved.s, tx: saved.tx, ty: saved.ty });
  PV.refresh();
}
function restorePlan() {
  if (!$('#sheet').hidden) return usePlan(sheetCtx(false));
  if (!$('#viewer').hidden && V.item && V.item.floor && V.item.pin) return usePlan(viewerCtx(V.item));
  if (S.tab === 'plan') return usePlan(planTabCtx());
  return null;
}
function pinMark(g, p, px, cls) {
  svg('circle', { cx: p[0], cy: p[1], r: 7 * px, class: cls, 'stroke-width': 2 * px }, g);
}
function slabMark(g, p, px, ghost) {
  svg('rect', { x: p[0] - 4.5 * px, y: p[1] - 4.5 * px, width: 9 * px, height: 9 * px, class: ghost ? 'slab-mk ghost' : 'slab-mk', 'stroke-width': 1.5 * px }, g);
}

// ================================================================ direction
function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
// st: {pin, members, noMember, manualDir}; item gives the lens and the compass reading
function computeFan(st, item) {
  if (!st.pin) return null;
  const half0 = (FAN_HALF[item.lens] || FAN_HALF['1x']) * DEG;
  if (!st.noMember && st.members && st.members.length) {
    const vs = [];
    for (const r of st.members) {
      const v = [r.at[0] - st.pin[0], r.at[1] - st.pin[1]];
      const L = Math.hypot(v[0], v[1]);
      if (L > 0.3) vs.push([v[0], v[1], L]);
    }
    if (vs.length) {
      let sx = 0, sy = 0;
      for (const v of vs) { sx += v[0] / v[2]; sy += v[1] / v[2]; }
      const dir = Math.atan2(sy, sx);
      let spread = 0;
      for (const v of vs) spread = Math.max(spread, Math.abs(angDiff(Math.atan2(v[1], v[0]), dir)));
      const half = Math.min(80 * DEG, Math.max(half0, spread + 10 * DEG));
      const r = Math.max(...vs.map((v) => v[2])) + 2.5;
      return { dir: r3(dir), half: r3(half), r: Math.round(r * 10) / 10, src: 'members' };
    }
  }
  if (st.manualDir != null) return { dir: st.manualDir, half: r3(half0), r: 35, src: 'manual' };
  const h = headingToPlan(item.heading, north(), S.settings.calib);
  if (h != null) return { dir: r3(h), half: r3(half0), r: 35, src: 'compass' };
  return null;
}
const DIRS = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
function bearingText(theta) { const b = bearingOf(theta, north()); return `${DIRS[Math.round(b / 45) % 8]} ${b}°`; }
const SRC = { members: '부재 기준', manual: '직접 지정', compass: '나침반' };
const LENS = { '0.5x': '0.5× 초광각', '1x': '1×', '2x': '2×', native: '기본 카메라', album: '앨범', scan: '문서 스캔' };
const pitchText = (p) => (p == null ? '' : `${p > 0 ? '+' : ''}${p}°${p <= -20 ? ' (아래)' : p >= 20 ? ' (위)' : ''}`);

function placeText(it) {
  if (it.tbm) return 'TBM';
  if (it.doc) return '문서';
  if (!it.pin) return '위치 없음';
  return it.room ? it.room.name : floorLabel(it.floor);
}
// a column's size and bars from the column schedule (기둥 일람표) carried in the drawing file, for that floor
function colSpec(floorKey, mark) {
  const c = S.pkg && S.pkg.columns && mark ? S.pkg.columns[mark] : null;
  const r = c && floorKey ? c[floorKey] : null;
  if (!r) return '';
  const hoop = r.mid && r.end && r.end !== r.mid ? `대근 ${r.mid} (상·하부 ${r.end})` : r.mid ? `대근 ${r.mid}` : '';
  return [r.size, r.main ? `주근 ${r.main}` : '', hoop, r.steel ? `철골 ${r.steel}` : ''].filter(Boolean).join(' · ');
}
function memberText(it) {
  if (it.noMember) return '부재 없음';
  return (it.members || []).map((m) => m.mark || m.type).join(' · ');
}
function issueText(it) {
  if (!it.issue) return '';
  if (it.issue.status === 'done') return `조치 완료${it.issue.fixedDay ? ' · ' + md(it.issue.fixedDay) : ''}`;
  const n = daysBetween(it.day, today());
  return n > 0 ? `미조치 · ${n + 1}일째` : '미조치 · 오늘';
}
function setupOf(it) {
  return {
    floor: it.floor, pin: it.pin ? [...it.pin] : null, members: (it.members || []).map((m) => ({ ...m })),
    noMember: !!it.noMember, manualDir: it.fan && it.fan.src === 'manual' ? it.fan.dir : null, day: it.day, ts: it.ts,
  };
}

// ================================================================ camera tab
const cam = new Camera($('#camVideo'));
let camBusy = false;

function showCamStart(msg, label, fn) {
  $('#camStartMsg').textContent = msg;
  const b = $('#camStartBtn');
  b.textContent = label;
  b.onclick = fn;
  $('#camStart').hidden = false;
}
const hideCamStart = () => { $('#camStart').hidden = true; };

// A home screen app on iPhone asks for camera permission on every launch, and again whenever the camera has been
// off for a while. So the camera is switched on once and kept running while you look at other tabs or leave the
// app briefly; it is switched off only after some minutes away from the camera tab.
const CAM_IDLE_MS = 5 * 60e3;
let camStopTimer = 0;
function scheduleCamStop() {
  clearTimeout(camStopTimer);
  camStopTimer = setTimeout(() => { if (S.tab !== 'camera' && $('#sheet').hidden) cam.stop(); }, CAM_IDLE_MS);
}

async function startCamera() {
  if (S.tab !== 'camera' || !$('#sheet').hidden || document.hidden || !S.pkg) return;
  clearTimeout(camStopTimer);
  if (S.settings.capture === 'native') {
    cam.stop();
    $('#camLens').replaceChildren();
    showCamStart('기본 카메라로 찍게 설정되어 있어요. 셔터를 누르면 기본 카메라가 열려요.', '기본 카메라 열기', () => shootNative('photo'));
    return;
  }
  if (cam.active) {
    hideCamStart();
    cam.video.play().catch(() => {});
    const tr = cam.track;
    // iOS mutes the camera while the app is in the background; it normally comes back by itself
    if (tr && tr.muted) setTimeout(() => { if (S.tab === 'camera' && cam.track === tr && tr.muted) { cam.stop(); startCamera(); } }, 1500);
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCamStart('여기서는 앱 카메라를 쓸 수 없어요. 기본 카메라로 찍어 주세요.', '기본 카메라 열기', () => shootNative('photo'));
    return;
  }
  if (camBusy) return;
  camBusy = true;
  try {
    try { await cam.start(S.settings.lensId || undefined); }
    catch (e) {
      if (!S.settings.lensId || (e && e.name === 'NotAllowedError')) throw e;
      S.settings.lensId = null;
      saveSettings();
      await cam.start();
    }
    if (S.settings.zoom && S.settings.zoom !== 1) await cam.setZoom(S.settings.zoom).catch(() => {});
    if (S.tab !== 'camera') scheduleCamStop();
    hideCamStart();
    renderLenses();
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    showCamStart(denied ? '카메라 권한이 필요해요. 버튼을 누르고 "허용"을 눌러 주세요.' : `카메라를 켜지 못했어요 (${(e && (e.message || e.name)) || '알 수 없음'}).`,
      '카메라 켜기', () => startCamera());
  } finally { camBusy = false; }
}

async function renderLenses() {
  const box = $('#camLens');
  const L = await cam.lenses();
  const uw = L.find((l) => l.zoom === '0.5x'), wide = L.find((l) => l.zoom === '1x');
  cam.lens = (uw && cam.deviceId === uw.id) || cam.zoom < 1 ? '0.5x' : cam.zoom >= 2 ? '2x' : '1x';
  // 0.5× is the ultra wide camera; 1× and 2× are the main camera. Without a separate ultra wide camera,
  // a camera whose own zoom goes below 1 gives 0.5× by zooming out.
  const caps = cam.track && cam.track.getCapabilities ? cam.track.getCapabilities() : null;
  const zoomOut = !uw && caps && caps.zoom && caps.zoom.min < 1;
  const opts = [...(uw ? [{ key: '0.5x', id: uw.id, z: 1 }] : zoomOut ? [{ key: '0.5x', id: wide ? wide.id : null, z: Math.max(0.5, caps.zoom.min) }] : []),
    { key: '1x', id: wide ? wide.id : null, z: 1 }, { key: '2x', id: wide ? wide.id : null, z: 2 }];
  box.replaceChildren(...opts.map((o) => el('button', {
    'aria-pressed': String(o.key === cam.lens), onclick: () => pickLens(o),
  }, o.key.replace('x', '×'))));
}
async function pickLens(o) {
  if (camBusy || o.key === cam.lens) return;
  camBusy = true;
  try {
    if (o.id ? cam.deviceId !== o.id : cam.lens === '0.5x' && cam.zoom >= 1) await cam.start(o.id || undefined);
    await cam.setZoom(o.z);
    S.settings.lensId = o.id || null;
    S.settings.zoom = o.z;
    saveSettings();
  } catch (e) {
    toast('이 렌즈는 켤 수 없어요');
    try { await cam.start(); } catch (e2) { /* shown on next start */ }
  } finally { camBusy = false; }
  renderLenses();
}

// a small sign on the viewfinder when the photo will be saved turned (phone held sideways)
function renderCamTurn() {
  const t = $('#camTurn');
  if (!t) return;
  const k = sensors.extraTurn();
  t.hidden = !k;
  t.textContent = k === 180 ? '거꾸로 → 바로 세워 저장' : '가로로 저장';
}
function renderCamTop() {
  $('#camFloor').textContent = floorLabel(S.settings.capFloor) || '층 선택';
  renderCamTurn();
  renderCamBanner();
  renderCamLast();
}
function renderCamLast() {
  const v = vis();
  const last = v[v.length - 1];
  const btn = $('#camLast');
  if (!last) { btn.style.backgroundImage = ''; btn.onclick = null; return; }
  thumbUrl(last.id).then((u) => { btn.style.backgroundImage = u ? `url("${u}")` : ''; });
  btn.onclick = () => openViewer(last.id);
}
function renderCamBanner() {
  const b = $('#camBanner');
  if (S.mode === 'tbm') {
    b.className = 'cam-banner tbm';
    b.replaceChildren(el('span', {}, `TBM 사진 찍는 중 · 오늘 ${S.tbmCount}장`), el('button', { onclick: endTbm }, 'TBM 끝내기 ✕'));
    b.hidden = false;
  } else if (S.mode === 'target' && S.target) {
    b.className = 'cam-banner tbm';
    b.replaceChildren(el('span', {}, `${S.target.mark} 사진 찍는 중 · ${floorShort(S.target.floor)} · ${S.targetCount}장`), el('button', { onclick: endTarget }, '끝내기 ✕'));
    b.hidden = false;
  } else if (S.mode === 'fix') {
    const o = S.byId.get(S.fixOf);
    b.className = 'cam-banner';
    b.replaceChildren(el('span', {}, `조치 후 사진 · ${o ? placeText(o) + (memberText(o) ? ' ' + memberText(o) : '') : ''}`), el('button', { onclick: cancelFix }, '취소'));
    b.hidden = false;
  } else b.hidden = true;
}

async function onShutter() {
  if (!sensors.asked) sensors.requestPermission();
  if (S.settings.capture === 'native' || !cam.active) { shootNative('photo'); return; }
  if (camBusy) return;
  if (S.scan) {
    let c = null;
    const turn = sensors.extraTurn();
    try { let p = await cam.takePhoto(); if (p && turn) p = await turnJpeg(p, turn, Date.now()); if (p) c = await canvasFromBlob(p); } catch (e) { c = null; }
    try { if (!c) c = cam.captureCanvas(turn); } catch (e) { toast((e && e.message) || '찍지 못했어요'); return; }
    await scanAndSave(c);
    return;
  }
  camBusy = true;
  const btn = $('#camShutter');
  btn.classList.add('working');
  try {
    const r = await cam.capture(sensors.extraTurn());
    try { cam.video.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 200 }); } catch (e) { /* no animation */ }
    await onCaptured({ ...r, kind: 'photo', lens: cam.lens });
  } catch (e) { toast((e && e.message) || '찍지 못했어요'); }
  finally { camBusy = false; btn.classList.remove('working'); }
}

async function shootNative(kind) {
  if (!sensors.asked) sensors.requestPermission();
  cam.stop();
  const f = await nativeCapture(kind);
  if (!f) { startCamera(); return; }
  const isVideo = kind === 'video' || /^video\//.test(f.type);
  if (S.scan && !isVideo) {
    const b = busy('사진을 불러오는 중…');
    let c = null;
    try { c = await canvasFromBlob(f); } catch (e) { toast('사진을 읽지 못했어요'); } finally { b.done(); }
    if (c) await scanAndSave(c);
    startCamera();
    return;
  }
  const b = busy(isVideo ? '영상을 불러오는 중…' : '사진을 불러오는 중…');
  let t = { thumb: null, w: 0, h: 0 };
  try { t = isVideo ? await videoThumb(f) : await imageThumb(f); } catch (e) { /* keep going without a thumbnail */ }
  finally { b.done(); }
  await onCaptured({
    blob: f, thumb: t.thumb, w: t.w, h: t.h, mime: f.type || (isVideo ? 'video/quicktime' : 'image/jpeg'),
    kind: isVideo ? 'video' : 'photo', lens: 'native',
  });
  if ($('#sheet').hidden) startCamera();
}

function newRecord(media, ts, extra = {}) {
  return {
    id: uid('p'), kind: media.kind, mime: media.mime, ts, day: dayOf(ts),
    floor: S.settings.capFloor, pin: null, members: [], room: null, grid: '', noMember: false, fan: null,
    heading: null, pitch: null, lens: media.lens || '1x',
    tbm: false, issue: null, fixOf: null, memo: '', w: media.w || 0, h: media.h || 0, size: media.blob.size || 0, draft: false,
    ...extra,
  };
}

// a new photo is stored right away (as a draft), so nothing is lost if the app is closed mid-way
async function onCaptured(media) {
  const snap = sensors.snapshot();
  const ts = Date.now();
  if (media.kind === 'photo') media = { ...media, blob: await outBlob({ kind: 'photo', ts, w: media.w, h: media.h }, media.blob) };
  if (S.mode === 'tbm') {
    const it = newRecord(media, ts, { tbm: true, floor: null, heading: snap.heading, pitch: snap.pitch });
    try { await putItem(it, media.blob, media.thumb); }
    catch (e) { alertBox('저장하지 못했어요', (e && e.message) || '저장 공간이 부족할 수 있어요.'); return; }
    S.tbmCount++;
    renderCamBanner();
    renderCamLast();
    toast(`TBM 사진 저장 (${S.tbmCount}장)`);
    return;
  }
  if (S.mode === 'target' && S.target) {
    const it = newRecord(media, ts, { ...targetFields(S.target), heading: snap.heading, pitch: snap.pitch });
    try { await putItem(it, media.blob, media.thumb); }
    catch (e) { alertBox('저장하지 못했어요', (e && e.message) || '저장 공간이 부족할 수 있어요.'); return; }
    S.targetCount++;
    renderCamBanner();
    renderCamLast();
    toast(`${S.target.mark} 사진 저장 (${S.targetCount}장)`);
    return;
  }
  const it = newRecord(media, ts, { heading: snap.heading, pitch: snap.pitch, draft: true });
  const draftP = putItem(it, media.blob, media.thumb);
  draftP.catch(() => {});
  openSheet({ mode: S.mode === 'fix' ? 'fix' : 'new', item: it, draftP, media });
}

// video: recorded in the app (sharp); the phone camera only when the app camera is off or cannot record
const REC = { timer: 0, turn: 0, lens: '1x' };
const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function renderRec() {
  const on = cam.recording, b = $('#camVideoBtn');
  b.textContent = on ? `■ 멈추기 ${mmss(Date.now() - cam.recAt)}` : '영상';
  b.classList.toggle('rec', on);
  $('#camShutter').disabled = on;
}
async function toggleRecord() {
  if (cam.recording) { await finishRecording(); return; }
  if (S.settings.capture === 'native' || !cam.active || typeof MediaRecorder !== 'function') { shootNative('video'); return; }
  if (camBusy) return;
  if (!sensors.asked) sensors.requestPermission();
  try { await cam.startRecording(); }
  catch (e) { toast((e && e.message) || '녹화를 시작하지 못했어요'); return; }
  REC.turn = sensors.extraTurn();
  REC.lens = cam.lens;
  renderRec();
  REC.timer = setInterval(renderRec, 500);
}
async function finishRecording() {
  clearInterval(REC.timer);
  const b = busy('영상을 저장하는 중…');
  let blob = null, t = { thumb: null, w: 0, h: 0 };
  try {
    blob = await cam.stopRecording();
    if (blob && REC.turn) blob = await turnMovie(blob, REC.turn);
    if (blob) t = await videoThumb(blob);
  } catch (e) { /* told below */ } finally { b.done(); renderRec(); }
  if (!blob) { toast('영상을 저장하지 못했어요'); return; }
  await onCaptured({ blob, thumb: t.thumb, w: t.w, h: t.h, mime: blob.type || 'video/mp4', kind: 'video', lens: REC.lens });
}

// 사진대지: chosen photos on A4 pages with 일시·위치·부재·내용, as a PDF
function reportRows(it) {
  const d = new Date(it.ts), p2 = (n) => String(n).padStart(2, '0');
  const where = it.tbm ? 'TBM' : it.doc ? '문서' : [floorLabel(it.floor), it.room ? it.room.name : '', it.grid].filter(Boolean).join(' · ') || '위치 없음';
  const what = it.tbm || it.doc ? '' : it.noMember ? '부재 없음' : memberText(it);
  const note = [it.issue ? issueText(it) : '', it.fixOf ? '조치 후' : '', it.memo || ''].filter(Boolean).join(' · ');
  return [['일시', `${d.getFullYear()}.${p2(d.getMonth() + 1)}.${p2(d.getDate())} ${timeOf(it.ts)}`], ['위치', where], ['부재', what || '-'], ['내용', note || '-']];
}
async function makeReport(list) {
  list = list.filter((i) => i && i.kind === 'photo' && !i.draft).sort((a, b) => a.ts - b.ts);
  if (!list.length) { toast('사진을 골라 주세요 (영상은 빠져요)'); return; }
  let per = 2, title = '공사 사진대지';
  const go = await openDialog((box, close) => {
    const t = el('input', { value: title, 'aria-label': '제목' });
    const seg = el('div', { class: 'seg' }, ...[2, 3].map((n) => el('button', {
      'aria-pressed': String(per === n),
      onclick: () => { per = n; [...seg.children].forEach((b, i) => b.setAttribute('aria-pressed', String(i + 2 === per))); },
    }, `한 쪽에 ${n}장`)));
    box.append(el('h3', {}, `사진대지 · 사진 ${list.length}장`),
      el('p', {}, 'A4에 사진과 일시·위치·부재·내용 칸을 넣어 PDF로 만들어요. 위치·부재는 붙인 기록에서, 내용은 이슈와 메모에서 가져와요.'),
      t, seg,
      el('div', { class: 'd-actions' }, el('button', { class: 'btn', onclick: () => close(false) }, '닫기'),
        el('button', { class: 'btn primary', onclick: () => { title = t.value.trim() || title; close(true); } }, '만들기')));
  });
  if (!go) return;
  const b = busy('사진대지 만드는 중…');
  try {
    const entries = [];
    for (const it of list) { const f = await db.get('files', it.id); if (f && f.blob) entries.push({ blob: f.blob, rows: reportRows(it) }); }
    const pdf = await photoSheetPdf(entries, { title, perPage: per, onProgress: (i, n) => b.set(`사진대지 만드는 중… ${i}/${n}쪽`) });
    b.done();
    await offerFile(pdf, `사진대지_${yymmdd(list[0].day)}.pdf`, '사진대지 준비 완료',
      `${Math.ceil(entries.length / per)}쪽 · ${fmtBytes(pdf.size)}
"파일에 저장"하거나 메신저·메일로 보내세요.`);
  } catch (e) {
    b.done();
    alertBox('사진대지를 만들지 못했어요', (e && e.message) || String(e));
  }
}

// document scan: the page is found, flattened and cleaned, then kept without a drawing location (날짜_문서_번호)
function renderCamScan() {
  const b = $('#camScan');
  b.setAttribute('aria-pressed', String(S.scan));
  b.textContent = S.scan ? '문서 스캔 켬' : '문서 스캔';
}
// scan mode: the page outline drawn live on the viewfinder, found the same way as after the shot
let scanLive = 0;
function scanLoop() {
  clearInterval(scanLive);
  scanLive = 0;
  const ov = $('#camScanOv');
  const g = ov.getContext('2d');
  const clear = () => { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, ov.width, ov.height); };
  clear();
  if (!S.scan || S.tab !== 'camera') return;
  const small = document.createElement('canvas');
  const sg = small.getContext('2d', { willReadFrequently: true });
  scanLive = setInterval(() => {
    if (!S.scan || S.tab !== 'camera') { scanLoop(); return; }
    const v = cam.video;
    if (!cam.active || !v.videoWidth || document.hidden) return;
    const z = cam.crop || 1, vw = v.videoWidth, vh = v.videoHeight, sw = vw / z, sh = vh / z, k = 160 / Math.max(sw, sh);
    small.width = Math.round(sw * k);
    small.height = Math.round(sh * k);
    sg.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, small.width, small.height);
    const q = findPaper(sg.getImageData(0, 0, small.width, small.height).data, small.width, small.height);
    const W = ov.clientWidth, H = ov.clientHeight, dpr = window.devicePixelRatio || 1;
    if (ov.width !== Math.round(W * dpr) || ov.height !== Math.round(H * dpr)) { ov.width = Math.round(W * dpr); ov.height = Math.round(H * dpr); }
    clear();
    ov.dataset.found = q ? '1' : '';
    if (!q) return;
    const s = Math.min(W / vw, H / vh), ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.beginPath();
    q.forEach(([x, y], i) => { const X = ox + x * vw * s, Y = oy + y * vh * s; if (i) g.lineTo(X, Y); else g.moveTo(X, Y); });
    g.closePath();
    g.fillStyle = 'rgba(255,90,31,0.16)';
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = '#FF5A1F';
    g.stroke();
  }, 350);
}
async function scanAndSave(c) {
  const r = await openScan(c);
  c.width = c.height = 1;
  if (!r) return;
  const ts = Date.now();
  const media = { ...r, kind: 'photo', lens: 'scan', blob: await outBlob({ kind: 'photo', ts, w: r.w, h: r.h }, r.blob) };
  const it = newRecord(media, ts, { doc: true, floor: null });
  try { await putItem(it, media.blob, media.thumb); }
  catch (e) { alertBox('저장하지 못했어요', (e && e.message) || '저장 공간이 부족할 수 있어요.'); return; }
  renderCamLast();
  toast(`문서 저장 · ${nameOf(it)}`);
}

function startTbm() {
  S.mode = 'tbm';
  S.fixOf = null;
  S.tbmCount = vis().filter((i) => i.tbm && i.day === today()).length;
  showTab('camera');
}
function endTbm() {
  S.mode = 'normal';
  renderCamBanner();
  S.day = today();
  showTab('days');
}
function startFix(it) {
  S.mode = 'fix';
  S.fixOf = it.id;
  closeViewer();
  showTab('camera');
  toast('조치한 뒤의 모습을 찍으세요');
}
function cancelFix() { S.mode = 'normal'; S.fixOf = null; renderCamBanner(); }

async function chooseFloor(cur) {
  return choose('층 고르기', S.floors.map((f) => ({ label: floorShort(f.key), value: f.key, desc: `${f.label} · ${f.sheet}`, current: f.key === cur })));
}

// ================================================================ sharing
// Photos are kept in the app and shared later, several at once. iOS opens the share sheet
// (이미지 저장 / 파일에 저장 / 메신저 …) only from a tap, so files are prepared first and handed over from a button.
// Every file leaves the app with its shooting date and time written inside (EXIF in a JPEG, the movie header in a video).
async function outBlob(it, blob) {
  try {
    if (it.kind === 'photo') return await withExif(blob, it.ts, it.w, it.h);
    if (it.kind === 'video') return await withMovieTime(blob, it.ts);
  } catch (e) { /* the file as it is */ }
  return blob;
}
// what a share hands over: the memo drawn on the picture (unless it is turned off) and the date inside the file
async function shareBlob(it, blob) {
  if (it.kind === 'photo' && it.memo && !it.memoOff) {
    try { blob = await burnMemo(blob, it.memo, await ensureMemoPos(it)); } catch (e) { /* the photo without the memo */ }
  }
  return outBlob(it, blob);
}
function shareFiles(list) {
  try {
    const files = list.map((x) => new File([x.blob], x.name, { type: x.mime || x.blob.type || 'image/jpeg', lastModified: x.ts || Date.now() }));
    if (!navigator.share || !navigator.canShare || !navigator.canShare({ files })) return Promise.resolve('unsupported');
    return navigator.share({ files }).then(() => 'shared', (e) => (e && e.name === 'AbortError' ? 'cancelled' : 'failed'));
  } catch (e) {
    return Promise.resolve('failed');
  }
}
async function markShared(ids) {
  for (const id of ids) S.shared.add(id);
  await db.kvSet('inPhotos', [...S.shared]).catch(() => {});
  renderCurrent();
}
function uniqueNames(list) {
  const used = new Set(), out = new Map();
  for (const it of list) {
    const base = names().get(it.id) || it.id, ext = extOf(it);
    let fn = `${base}.${ext}`, n = 2;
    while (used.has(fn)) fn = `${base}_${n++}.${ext}`;
    used.add(fn);
    out.set(it.id, fn);
  }
  return out;
}
async function shareBatch(list) {
  list = list.filter((i) => !i.draft).sort((a, b) => a.ts - b.ts);
  if (!list.length) return;
  const fileName = uniqueNames(list);
  const b = busy('사진을 준비하는 중…');
  const files = [];
  try {
    for (const it of list) {
      const f = await db.get('files', it.id);
      if (f && f.blob) files.push({ id: it.id, blob: await shareBlob(it, f.blob), name: fileName.get(it.id), mime: it.mime, ts: it.ts });
      b.set(`사진을 준비하는 중… ${files.length}/${list.length}`);
    }
  } finally { b.done(); }
  if (!files.length) { toast('파일을 찾지 못했어요'); return; }
  const size = files.reduce((t, x) => t + x.blob.size, 0);
  const already = list.filter((i) => S.shared.has(i.id)).length;
  const memos = list.filter((i) => i.kind === 'photo' && i.memo && !i.memoOff).length;
  await openDialog((box, close) => {
    const go = el('button', {
      class: 'btn primary',
      onclick: () => {
        shareFiles(files).then((r) => {
          if (r === 'shared') { markShared(files.map((x) => x.id)); toast(`${files.length}개를 보냈어요`); close(); }
          else if (r === 'unsupported') { toast('여기서는 여러 장 공유가 안 돼요. ZIP으로 받아 주세요', 3000); close(); }
        });
      },
    }, '공유하기');
    box.append(el('h3', {}, `공유 · ${files.length}개`),
      el('p', { class: 'pre' }, `${fmtBytes(size)}` + (already ? ` · 이 중 ${already}개는 전에 보낸 적이 있어요.` : '') +
        "\n사진 앱에 넣으려면 '이미지 저장', 파일로 받으려면 '파일에 저장'을 고르세요." +
        '\n찍은 날짜·시간이 사진·영상 파일 안에 들어 있어서 사진 앱이나 PC에서도 찍은 시각으로 보여요. 메신저에 사진으로 보내면 메신저가 이 정보를 지울 수 있어요. 그럴 땐 파일로 보내세요.' +
        (memos ? `\n메모가 있는 사진 ${memos}장은 메모가 사진 위에 같이 들어가요.` : '')),
      el('div', { class: 'd-actions' }, el('button', { class: 'btn', onclick: () => close() }, '닫기'), go));
  }, { dismiss: false });
}

// ================================================================ location sheet (after the shutter)
const C = { open: false };

function openSheet({ mode, item, draftP = null, media = null }) {
  Object.assign(C, {
    open: true, mode, item, draftP, media, saving: false,
    floor: item.floor || S.settings.capFloor,
    pin: null, members: [], noMember: false, manualDir: null, step: 'pin', ghost: null, walked: null,
    issue: !!item.issue, memo: item.memo || '', ready: null,
  });
  if (mode === 'edit') {
    Object.assign(C, setupOf(item), { ghost: null });
    C.floor = item.floor || S.settings.capFloor;
    C.step = C.pin ? 'member' : 'pin';
  } else if (mode === 'fix') {
    const o = S.byId.get(S.fixOf);
    if (o && o.pin) { C.floor = o.floor; C.ghost = setupOf(o); }
  } else {
    // "그대로" (the last photo's spot) only when you have not walked away: steps counted since that photo,
    // or, without the motion sensor, only within 20 minutes
    const L = S.lastSetup;
    C.walked = L && L.session === sensors.session && L.steps != null && sensors.motionSeen ? sensors.steps - L.steps : null;
    const stayed = L && (C.walked != null ? C.walked < 6 : item.ts - L.ts < 20 * 60e3);
    if (L && stayed && L.floor === C.floor && L.day === item.day && item.ts - L.ts < 2 * 3600e3) C.ghost = { ...L, members: L.members.map((m) => ({ ...m })) };
  }
  const img = $('#shThumb');
  if (C.ownThumb && C.thumbUrl) URL.revokeObjectURL(C.thumbUrl);
  C.ownThumb = !!(media && media.thumb);
  C.thumbUrl = C.ownThumb ? URL.createObjectURL(media.thumb) : '';
  img.removeAttribute('src');
  img.hidden = true; // shown once it has loaded, so an unreadable one never shows the blue "?"
  img.onload = () => { img.hidden = false; };
  img.onerror = () => { img.hidden = true; };
  if (C.thumbUrl) img.src = C.thumbUrl;
  else thumbUrl(item.id).then((u) => { if (u && C.item === item) img.src = u; });
  $('#sheet').hidden = false;
  renderSheet();
  C.ready = usePlan(sheetCtx(mode !== 'new'));
}

function sheetCtx(focus) {
  const st = C.ghost || C;
  return {
    name: 'sheet', host: $('#shPlan'), floor: C.floor, onTap: onSheetTap,
    onPress: onSheetPress, onHold: onSheetHold, onDragStart: onSheetDragStart, onDrag: onSheetDrag, onDragEnd: onSheetDragEnd,
    drawStatic: drawSheetStatic, drawDynamic: drawSheetDynamic, focus: focus && st.pin ? st.pin : null,
  };
}
function adoptGhost() {
  if (!C.ghost) return;
  const g = C.ghost;
  Object.assign(C, { pin: [...g.pin], members: g.members.map((m) => ({ ...m })), noMember: g.noMember, manualDir: g.manualDir, ghost: null, step: 'member' });
}
function onSheetTap(p) {
  if (!C.open || !PV.floor || PV.floor.key !== C.floor) return;
  if (C.ghost) Object.assign(C, { ghost: null, pin: null, members: [], manualDir: null, step: 'pin' });
  if (!C.pin || C.step === 'pin') {
    C.pin = [r2(p[0]), r2(p[1])];
    C.step = 'member';
  } else if (C.noMember) {
    C.manualDir = r3(Math.atan2(p[1] - C.pin[1], p[0] - C.pin[0]));
  } else {
    const m = PV.hitMember(p);
    if (m) {
      const k = C.members.findIndex((r) => r.id === m.id);
      if (k >= 0) C.members.splice(k, 1);
      else C.members.push({ id: m.id, mark: m.mark || '', type: m.type, at: [r2(p[0]), r2(p[1])], c: centroid(m.pts).map(r2) });
    } else {
      const tol = 16 * PV.ptPerPx();
      const k = C.members.findIndex((r) => r.id === 'slab' && Math.hypot(r.at[0] - p[0], r.at[1] - p[1]) < tol);
      if (k >= 0) C.members.splice(k, 1);
      else {
        const s = PV.nearestSlab(p);
        C.members.push({ id: 'slab', mark: s ? s.mark : '', type: '슬래브', at: [r2(p[0]), r2(p[1])] });
      }
    }
  }
  renderSheet();
  PV.refresh();
}
// Press and hold drops the pin under the finger and it follows until the finger lifts.
// The pin itself can be grabbed and dragged at any time; a quick swipe elsewhere still moves the drawing.
function onSheetPress(p) {
  if (!C.open || !PV.floor || PV.floor.key !== C.floor) return null;
  const st = C.ghost || C;
  if (st.pin && Math.hypot(p[0] - st.pin[0], p[1] - st.pin[1]) < 24 * PV.ptPerPx()) return { mode: 'grab', offset: [st.pin[0] - p[0], st.pin[1] - p[1]] };
  if (C.ghost || !C.pin || C.step === 'pin') return { mode: 'hold' };
  return null;
}
function onSheetHold(p) {
  if (!C.open) return false;
  if (C.ghost) Object.assign(C, { ghost: null, pin: null, members: [], manualDir: null, step: 'pin' });
  C.pin = [r2(p[0]), r2(p[1])];
  C.dragging = true;
  renderSheet();
  PV.refresh();
  return true;
}
function onSheetDragStart() {
  if (C.ghost) adoptGhost();
  C.dragging = true;
  renderSheet();
}
let dragFrame = 0;
function onSheetDrag(p) {
  if (!C.open) return;
  C.pin = [r2(p[0]), r2(p[1])];
  PV.refresh();
  if (!dragFrame) dragFrame = requestAnimationFrame(() => { dragFrame = 0; if (C.open) renderSheetInfo(); });
}
function onSheetDragEnd() {
  C.dragging = false;
  if (!C.open) return;
  if (C.step === 'pin') C.step = 'member';
  renderSheet();
  PV.refresh();
}
function drawSheetStatic(g) {
  const fl = PV.floor;
  if (!C.open || !fl || fl.key !== C.floor) return;
  const st = C.ghost || C, ghost = !!C.ghost;
  const fan = computeFan(st, C.item);
  if (fan) svg('path', { d: fanPath(st.pin, fan.dir, fan.half, fan.r), class: ghost ? 'fan ghost' : 'fan' }, g);
  if (!st.noMember) {
    for (const r of st.members) {
      const m = memberOf(fl, r);
      if (m) svg('polygon', { points: ptsAttr(m.pts), class: ghost ? 'm-ghost' : 'm-sel' }, g);
    }
  }
}
function drawSheetDynamic(g, px) {
  const fl = PV.floor;
  if (!C.open || !fl || fl.key !== C.floor) return;
  const st = C.ghost || C, ghost = !!C.ghost;
  if (!st.noMember) for (const r of st.members) if (r.id === 'slab') slabMark(g, r.at, px, ghost);
  if (st.pin) pinMark(g, st.pin, px, ghost ? 'pin ghost' : ((C.step === 'pin' && C.pin) || C.dragging ? 'pin moving' : 'pin'));
}
function sheetHint() {
  if (C.dragging) return '손가락을 떼면 그 자리에 핀이 놓여요.';
  if (C.ghost) {
    return C.mode === 'fix'
      ? '이슈 사진과 같은 자리면 "그대로". 다른 자리면 서 있던 곳을 누르세요.'
      : '지난 사진과 같은 자리면 "그대로". 다른 곳이면 서 있던 곳을 누르세요.';
  }
  if (!C.pin && C.walked >= 6) return `지난 사진 뒤로 ${C.walked}걸음쯤 걸었어요. 서 있던 곳을 누르세요.`;
  if (!C.pin) return '서 있던 곳을 누르세요. 누른 채로 움직이면 핀이 따라와요.';
  if (C.step === 'pin') return '옮길 곳을 누르세요. 누른 채로 움직이면 핀이 따라와요.';
  if (C.noMember) return '찍은 방향 쪽을 누르세요.' + (C.item.heading != null ? ' 안 누르면 나침반 방향으로 저장돼요.' : '');
  return C.members.length ? '부재를 더 누르거나, 고른 부재를 다시 눌러 빼세요.' : '찍은 부재(기둥·보·벽·슬래브)를 누르세요. 핀은 끌어서 옮길 수 있어요.';
}
function renderSheet() {
  const st = C.ghost || C;
  $('#shFloor').textContent = floorLabel(C.floor) || '층';
  $('#shMem').setAttribute('aria-pressed', String(!st.noMember));
  $('#shNoMem').setAttribute('aria-pressed', String(!!st.noMember));
  const iss = $('#shIssue');
  iss.hidden = C.mode === 'fix';
  iss.setAttribute('aria-pressed', String(!!C.issue));
  $('#shHint').textContent = sheetHint();
  renderSheetInfo();
  const later = $('#shLater'), move = $('#shMove'), save = $('#shSave');
  later.hidden = C.mode !== 'new';
  $('.sh-bottom').classList.toggle('three', C.mode !== 'new');
  if (C.ghost) { move.textContent = '고치기'; move.disabled = false; move.setAttribute('aria-pressed', 'false'); }
  else { move.textContent = '핀 옮기기'; move.disabled = !C.pin; move.setAttribute('aria-pressed', String(!!C.pin && C.step === 'pin' && !C.dragging)); }
  save.textContent = C.ghost ? '그대로' : '저장';
  save.disabled = !C.ghost && !C.pin;
  $('#shMemo').textContent = C.memo ? '메모 ✓' : '메모';
}
function renderSheetInfo() {
  const st = C.ghost || C;
  const box = $('#shInfo');
  const line = (k, ...v) => el('div', {}, el('span', { class: 'k' }, k), ...v);
  if (!st.pin) { box.replaceChildren(line('위치', '아직 안 정했어요')); return; }
  const fl = S.floorCache.get(C.floor);
  const room = fl ? PV.roomAt(st.pin, fl) : null;
  const where = [floorLabel(C.floor), room ? room.name : '', fl ? PV.gridOf(st.pin, fl) : ''].filter(Boolean).join(' · ');
  const rows = [line(C.ghost ? '지난 위치' : '위치', where)];
  if (st.noMember) rows.push(line('부재', '없음 · 방향만 기록'));
  else rows.push(line('부재', ...(st.members.length ? st.members.map((m) => el('span', { class: 'chipm' }, m.mark || m.type)) : ['도면에서 눌러 고르세요'])));
  if (!st.noMember) for (const m of st.members) { const t = colSpec(C.floor, m.mark); if (t) rows.push(line('배근', `${m.mark} ${t}`)); }
  const fan = computeFan(st, C.item);
  rows.push(line('방향', fan ? `${bearingText(fan.dir)} · ${SRC[fan.src]}` : '없음', C.item.pitch != null ? ` · 기울기 ${pitchText(C.item.pitch)}` : ''));
  box.replaceChildren(...rows);
}

async function finishSheet(later) {
  if (C.saving) return;
  C.saving = true;
  try {
    if (C.ghost && !later) adoptGhost();
    try { await C.ready; } catch (e) { /* drawing is optional for saving */ }
    let stored = true;
    try { await C.draftP; } catch (e) { stored = false; }
    const base = S.byId.get(C.item.id) || C.item;
    const fl = await getFloor(C.floor);
    const rec = { ...base, ...memoPatch(base, C.memo), draft: false, floor: C.floor };
    if (later || !C.pin) {
      Object.assign(rec, { pin: null, members: [], room: null, grid: '', noMember: false, fan: null });
    } else {
      const room = fl ? PV.roomAt(C.pin, fl) : null;
      Object.assign(rec, {
        pin: C.pin, noMember: C.noMember,
        members: C.noMember ? [] : C.members.map((m) => ({ ...m })),
        room: room ? { code: room.code || '', name: room.name || '', type: room.type || '' } : null,
        grid: fl ? PV.gridOf(C.pin, fl) : '',
      });
      rec.fan = computeFan(C, rec);
    }
    if (C.mode === 'fix') {
      rec.fixOf = S.fixOf;
      rec.issue = null;
    } else if (C.issue && !rec.issue) rec.issue = { status: 'open' };
    else if (!C.issue && rec.issue) {
      const f = rec.issue.fixId ? S.byId.get(rec.issue.fixId) : null;
      if (f) await putItem({ ...f, fixOf: null });
      rec.issue = null;
    }
    if (!stored && C.media) await putItem(rec, C.media.blob, C.media.thumb);
    else await putItem(rec);
    const mode = C.mode;
    if (mode === 'fix') {
      const o = S.byId.get(S.fixOf);
      if (o) await putItem({ ...o, issue: { status: 'done', fixId: rec.id, fixedDay: rec.day } });
      S.mode = 'normal';
      S.fixOf = null;
    }
    if (mode === 'new' && rec.pin) {
      S.lastSetup = { ...setupOf(rec), steps: sensors.motionSeen ? sensors.steps : null, session: sensors.session };
      db.kvSet('lastSetup', S.lastSetup).catch(() => {});
    }
    if (mode !== 'edit') { S.settings.capFloor = C.floor; saveSettings(); }
    closeSheet();
    if (mode === 'edit') toast('위치를 고쳤어요');
    else toast((mode === 'fix' ? '조치 완료 · ' : rec.pin ? '저장 · ' : '위치 없이 저장 · ') + nameOf(rec), 2400);
    renderCurrent();
  } catch (e) {
    alertBox('저장하지 못했어요', (e && e.message) || String(e));
  } finally { C.saving = false; }
}
function closeSheet() {
  $('#sheet').hidden = true;
  C.open = false;
  if (C.ownThumb && C.thumbUrl) URL.revokeObjectURL(C.thumbUrl);
  C.thumbUrl = '';
  C.ownThumb = false;
  C.media = null;
  restorePlan();
  if (S.tab === 'camera') { renderCamTop(); startCamera(); }
}
async function discardSheet() {
  if (C.mode === 'edit') { closeSheet(); return; }
  if (!(await confirmBox('이 사진을 버릴까요?', '방금 찍은 사진이 지워져요.', '버리기', true))) return;
  try { await C.draftP; } catch (e) { /* nothing stored */ }
  await removeItem(C.item.id);
  closeSheet();
}

// ================================================================ viewer
const V = { item: null, url: '', blob: null, out: null };

async function openViewer(id) {
  const it = S.byId.get(id);
  if (!it) return;
  V.item = it;
  $('#viewer').hidden = false;
  $('#viewer .v-scroll').scrollTop = 0;
  await renderViewer(true);
}
async function renderViewer(full) {
  const it = (V.item = S.byId.get(V.item.id) || V.item);
  $('#vTitle').textContent = nameOf(it);
  if (full) {
    if (V.url) URL.revokeObjectURL(V.url);
    V.url = '';
    V.blob = null;
    V.out = null;
    const media = $('#vMedia');
    media.replaceChildren();
    VZ.s = 1; VZ.x = VZ.y = 0; VZ.pts.clear(); VZ.one = VZ.two = null;
    const f = await db.get('files', it.id).catch(() => null);
    if (!V.item || V.item.id !== it.id) return;
    if (f && f.blob) {
      V.blob = f.blob;
      V.url = URL.createObjectURL(f.blob);
      prepOut(it);
      media.append(it.kind === 'video'
        ? el('video', { src: V.url, controls: true, playsinline: true, preload: 'metadata' })
        : el('div', { class: 'v-photo' }, el('img', {
          src: V.url, alt: nameOf(it), draggable: 'false', onload: (e) => fitPhoto(e.target),
          onerror: (e) => e.target.parentNode.replaceWith(el('p', { class: 'empty' }, '사진 파일을 읽지 못했어요')),
        })));
    } else media.append(el('p', { class: 'empty' }, it.offloaded ? `원본은 iCloud Drive의 ${it.offloaded.zip}에 있어요` : '파일을 찾지 못했어요'));
    const list = dayList(it), k = list.findIndex((i) => i.id === it.id);
    if (list.length > 1) media.append(el('span', { class: 'v-pos' }, `${k + 1} / ${list.length}`));
  }
  renderViewerInfo(it);
  renderViewerActions(it);
  const host = $('#vPlan');
  host.hidden = !(it.floor && it.pin);
  if (!host.hidden && $('#sheet').hidden) usePlan(viewerCtx(it));
}
function renderViewerInfo(it) {
  const rows = [];
  const add = (k, ...v) => { if (v.length && v[0] != null && v[0] !== '') rows.push(el('span', { class: 'k' }, k), el('span', { class: 'v' }, ...v)); };
  add('날짜', `${dayLabel(it.day)} ${timeOf(it.ts)}`);
  if (it.offloaded) add('원본', `iCloud Drive · ${it.offloaded.zip} (폰에는 작은 사진)`);
  if (it.tbm) add('구분', 'TBM');
  if (it.doc) add('구분', '문서 스캔');
  if (it.fixOf) add('구분', '조치 후 사진');
  if (!it.tbm && !it.doc) {
    add('층', floorLabel(it.floor));
    add('위치', it.pin ? (it.room ? it.room.name + (it.room.code && it.room.code !== it.room.name ? ` (${it.room.code})` : '') : '실 밖') : '아직 안 정했어요');
    if (it.pin) add('그리드', it.grid);
    add('부재', it.noMember ? '없음' : memberText(it) || (it.pin ? '안 고름' : ''));
    if (!it.noMember) for (const m of it.members || []) { const t = colSpec(it.floor, m.mark); if (t) add('배근', `${m.mark} ${t}`); }
    if (it.fan) add('방향', `${bearingText(it.fan.dir)} · ${SRC[it.fan.src] || ''}`);
  }
  if (it.pitch != null) add('기울기', pitchText(it.pitch));
  if (it.issue) add('이슈', el('b', { class: it.issue.status === 'open' ? 'st-open' : 'st-done' }, issueText(it)));
  if (it.memo) add('메모', it.memo);
  add('파일', el('code', {}, nameOf(it)), ' ', [it.w && it.h ? `${it.w}×${it.h}` : '', it.size ? fmtBytes(it.size) : '', LENS[it.lens] || '', S.shared.has(it.id) ? '보냄' : ''].filter(Boolean).join(' · '));
  $('#vInfo').replaceChildren(...rows);
}
function renderViewerActions(it) {
  const btn = (label, fn, cls = '') => el('button', { class: 'btn small ' + cls, onclick: fn }, label);
  const A = [];
  const fix = it.issue && it.issue.fixId ? S.byId.get(it.issue.fixId) : null;
  const orig = it.fixOf ? S.byId.get(it.fixOf) : null;
  if (fix || orig) {
    const before = orig || it, after = fix || it;
    A.push(el('div', { class: 'pair' },
      el('button', { class: 'btn small', 'aria-pressed': String(it === before), onclick: () => { if (it !== before) openViewer(before.id); } }, '조치 전'),
      el('button', { class: 'btn small', 'aria-pressed': String(it === after), onclick: () => { if (it !== after) openViewer(after.id); } }, '조치 후')));
  }
  if (!it.tbm && !it.fixOf) {
    if (!it.issue) A.push(btn('이슈로 표시', () => setIssue(it, 'open')));
    else if (it.issue.status === 'open') { A.push(btn('조치 사진 찍기', () => startFix(it), 'primary')); A.push(btn('이슈 해제', () => setIssue(it, null))); }
    else A.push(btn('다시 미조치로', () => setIssue(it, 'reopen')));
  }
  if (!it.tbm && !it.doc) A.push(btn(it.pin ? '위치 고치기' : '위치 붙이기', () => openSheet({ mode: 'edit', item: it }), it.pin ? '' : 'primary'));
  A.push(btn('메모', () => editMemo(it)));
  if (it.kind === 'photo' && it.memo) A.push(btn(it.memoOff ? '사진에 메모 보이기' : '사진에서 메모 숨기기', () => toggleMemoOn(it)));
  if (it.kind === 'photo') A.push(btn('돌리기 ↻', () => rotateItem(it)));
  A.push(btn('공유', () => shareOne(it)));
  $('#vActions').replaceChildren(...A);
}
function viewerCtx(it) {
  return {
    name: 'viewer', save: false, host: $('#vPlan'), floor: it.floor, focus: it.pin, onTap: null,
    drawStatic: (g) => {
      const fl = PV.floor;
      if (!fl || fl.key !== it.floor) return;
      if (it.fan) svg('path', { d: fanPath(it.pin, it.fan.dir, it.fan.half, it.fan.r), class: 'fan' }, g);
      for (const r of it.members || []) { const m = memberOf(fl, r); if (m) svg('polygon', { points: ptsAttr(m.pts), class: 'm-sel' }, g); }
    },
    drawDynamic: (g, px) => {
      const fl = PV.floor;
      if (!fl || fl.key !== it.floor) return;
      for (const r of it.members || []) if (r.id === 'slab') slabMark(g, r.at, px);
      pinMark(g, it.pin, px, 'pin');
    },
  };
}
// ---------------------------------------------------------------- viewer: slide to the next photo of the day, pinch or double-tap to zoom
const VZ = { s: 1, x: 0, y: 0, pts: new Map(), one: null, two: null, lastTap: 0 };
const dayList = (it) => vis().filter((i) => i.day === it.day && !i.draft).sort((a, b) => a.ts - b.ts);
function viewerStep(dir) {
  if (!V.item) return false;
  const list = dayList(V.item), k = list.findIndex((i) => i.id === V.item.id), t = list[k + dir];
  if (!t) return false;
  openViewer(t.id);
  return true;
}
const zoomImg = () => $('#vMedia .v-photo img');
function applyZoom() {
  const img = zoomImg();
  if (!img) return;
  const wrap = img.parentNode, W = wrap.clientWidth, H = wrap.clientHeight;
  VZ.s = Math.max(1, Math.min(5, VZ.s));
  VZ.x = Math.min(0, Math.max(W - W * VZ.s, VZ.x)); // the picture keeps covering its box
  VZ.y = Math.min(0, Math.max(H - H * VZ.s, VZ.y));
  if (VZ.s === 1) VZ.x = VZ.y = 0;
  img.style.transformOrigin = '0 0';
  img.style.transform = VZ.s === 1 ? '' : `translate(${VZ.x}px, ${VZ.y}px) scale(${VZ.s})`;
  wrap.classList.toggle('zoomed', VZ.s > 1);
}
function bindViewerGestures() {
  const host = $('#vMedia');
  const box = () => (zoomImg() ? zoomImg().parentNode : host).getBoundingClientRect();
  host.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.memo-on, video') || !zoomImg()) return;
    VZ.pts.set(e.pointerId, [e.clientX, e.clientY]);
    try { host.setPointerCapture(e.pointerId); } catch (err) { /* fine without */ }
    if (VZ.pts.size === 1) VZ.one = { x0: e.clientX, y0: e.clientY, tx: VZ.x, ty: VZ.y, t: e.timeStamp, moved: false };
    else if (VZ.pts.size === 2) {
      const [a, b] = [...VZ.pts.values()], r = box();
      VZ.two = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, s: VZ.s, cx: (a[0] + b[0]) / 2 - r.left, cy: (a[1] + b[1]) / 2 - r.top, tx: VZ.x, ty: VZ.y };
      VZ.one = null;
    }
  });
  host.addEventListener('pointermove', (e) => {
    if (!VZ.pts.has(e.pointerId)) return;
    VZ.pts.set(e.pointerId, [e.clientX, e.clientY]);
    const img = zoomImg();
    if (!img) return;
    if (VZ.two && VZ.pts.size >= 2) {
      const [a, b] = [...VZ.pts.values()], T = VZ.two;
      const s = Math.max(1, Math.min(5, (T.s * Math.hypot(a[0] - b[0], a[1] - b[1])) / T.d)), k = s / T.s;
      VZ.s = s; VZ.x = T.cx - (T.cx - T.tx) * k; VZ.y = T.cy - (T.cy - T.ty) * k;
      applyZoom();
      return;
    }
    const o = VZ.one;
    if (!o) return;
    const dx = e.clientX - o.x0, dy = e.clientY - o.y0;
    if (Math.hypot(dx, dy) > 8) o.moved = true;
    if (VZ.s > 1) { VZ.x = o.tx + dx; VZ.y = o.ty + dy; applyZoom(); return; }
    if (Math.abs(dx) > Math.abs(dy)) img.style.transform = `translateX(${dx}px)`; // the picture follows the finger
  });
  host.addEventListener('pointerup', (e) => {
    if (!VZ.pts.has(e.pointerId)) return;
    VZ.pts.delete(e.pointerId);
    if (VZ.two) { if (VZ.pts.size < 2) VZ.two = null; return; }
    const o = VZ.one, img = zoomImg();
    VZ.one = null;
    if (!o || !img) return;
    const dx = e.clientX - o.x0, dy = e.clientY - o.y0;
    if (VZ.s === 1) {
      img.style.transform = '';
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        if (!viewerStep(dx < 0 ? 1 : -1)) toast(dx < 0 ? '이날 마지막 사진이에요' : '이날 첫 사진이에요');
        return;
      }
    }
    if (!o.moved && e.timeStamp - o.t < 300) {
      if (e.timeStamp - VZ.lastTap < 320) { // double tap: zoom in where tapped, or back out
        VZ.lastTap = 0;
        const r = box(), px = e.clientX - r.left, py = e.clientY - r.top;
        if (VZ.s > 1) VZ.s = 1;
        else { const k = 2.5; VZ.x = px - px * k; VZ.y = py - py * k; VZ.s = k; }
        applyZoom();
      } else VZ.lastTap = e.timeStamp;
    }
  });
  host.addEventListener('pointercancel', (e) => {
    VZ.pts.delete(e.pointerId);
    VZ.one = VZ.two = null;
    const img = zoomImg();
    if (img && VZ.s === 1) img.style.transform = '';
  });
}
function closeViewer() {
  $('#viewer').hidden = true;
  const v = $('#vMedia video');
  if (v) v.pause();
  $('#vMedia').replaceChildren();
  if (V.url) URL.revokeObjectURL(V.url);
  V.url = '';
  V.blob = null;
  V.out = null;
  V.item = null;
  restorePlan();
}
async function setIssue(it, v) {
  const rec = { ...it };
  if (v === 'open') rec.issue = { status: 'open' };
  else if (v === null) {
    if (!(await confirmBox('이슈를 해제할까요?', '이슈 목록에서 빠져요.', '해제'))) return;
    rec.issue = null;
  } else if (v === 'reopen') {
    if (!(await confirmBox('다시 미조치로 바꿀까요?', '조치 사진은 일반 사진으로 남아요.', '바꾸기'))) return;
    const f = rec.issue && rec.issue.fixId ? S.byId.get(rec.issue.fixId) : null;
    if (f) await putItem({ ...f, fixOf: null });
    rec.issue = { status: 'open' };
  }
  await putItem(rec);
  renderCurrent();
}
async function editMemo(it) {
  const t = await promptText('메모', it.memo || '', { placeholder: '예: 균열 0.3mm, 다음 주 재확인' });
  if (t === null) return;
  const cur = S.byId.get(it.id);
  await putItem({ ...cur, ...memoPatch(cur, t) });
  renderCurrent();
  if (V.item && V.item.id === it.id) { renderMemoOn(); prepOut(S.byId.get(it.id)); }
}
// a changed memo finds its corner again, unless it was moved by hand
function memoPatch(it, memo) {
  memo = memo || '';
  if (memo === (it.memo || '')) return {};
  return it.memoMoved ? { memo } : { memo, memoPos: null };
}
// where the memo goes is worked out once: the memo's place words and the calm corners of the picture, on the phone
async function ensureMemoPos(it) {
  const cur = S.byId.get(it.id) || it;
  if (cur.memoPos) return cur.memoPos;
  let img = null;
  try { const t = await db.get('thumbs', it.id); if (t && t.blob) img = await grayOf(t.blob); } catch (e) { img = null; }
  const pos = memoCorner(img, cur.memo);
  const now = S.byId.get(it.id);
  if (now && now.memo === cur.memo && !now.memoPos) await putItem({ ...now, memoPos: pos }).catch(() => {});
  return pos;
}
// the viewer's photo box takes the picture's own shape, so the memo sits where it will sit in the shared file
function fitPhoto(img) {
  const wrap = img.parentNode;
  if (!wrap || !img.naturalWidth) return;
  const k = Math.min($('#vMedia').clientWidth / img.naturalWidth, (window.innerHeight * 0.58) / img.naturalHeight, 1);
  wrap.style.width = Math.round(img.naturalWidth * k) + 'px';
  wrap.style.height = Math.round(img.naturalHeight * k) + 'px';
  renderMemoOn();
}
async function renderMemoOn() {
  const it = V.item && S.byId.get(V.item.id);
  const wrap = $('#vMedia .v-photo');
  if (!it || !wrap) return;
  for (const o of wrap.querySelectorAll('.memo-on')) o.remove();
  if (it.kind !== 'photo' || !it.memo || it.memoOff) return;
  const pos = await ensureMemoPos(it);
  if (!V.item || V.item.id !== it.id || wrap.querySelector('.memo-on')) return;
  const s = Math.min(wrap.clientWidth, wrap.clientHeight), fs = MEMO.fs * s, m = MEMO.edge * s + 'px';
  const box = el('div', { class: 'memo-on', title: '끌어서 옮기기' }, it.memo);
  Object.assign(box.style, { fontSize: fs + 'px', padding: `${MEMO.padY * fs}px ${MEMO.padX * fs}px`, borderRadius: MEMO.r * fs + 'px' });
  box.style[pos[0] === 't' ? 'top' : 'bottom'] = m;
  box.style[pos[1] === 'l' ? 'left' : 'right'] = m;
  box.addEventListener('pointerdown', (e) => dragMemo(e, box, wrap, it.id));
  wrap.append(box);
}
// drag the memo to another corner; it stays where you put it
function dragMemo(e, box, wrap, id) {
  e.preventDefault();
  const r = wrap.getBoundingClientRect(), b = box.getBoundingClientRect();
  const dx = e.clientX - b.left, dy = e.clientY - b.top;
  let moved = false;
  try { box.setPointerCapture(e.pointerId); } catch (err) { /* fine without */ }
  const move = (ev) => {
    moved = true;
    Object.assign(box.style, { left: ev.clientX - r.left - dx + 'px', top: ev.clientY - r.top - dy + 'px', right: 'auto', bottom: 'auto' });
  };
  const up = async () => {
    box.removeEventListener('pointermove', move);
    box.removeEventListener('pointerup', up);
    box.removeEventListener('pointercancel', up);
    if (!moved) return;
    const bb = box.getBoundingClientRect();
    const pos = (bb.top + bb.height / 2 - r.top < r.height / 2 ? 't' : 'b') + (bb.left + bb.width / 2 - r.left < r.width / 2 ? 'l' : 'r');
    const cur = S.byId.get(id);
    if (cur) await putItem({ ...cur, memoPos: pos, memoMoved: true });
    renderMemoOn();
    if (V.item && V.item.id === id) prepOut(S.byId.get(id));
  };
  box.addEventListener('pointermove', move);
  box.addEventListener('pointerup', up);
  box.addEventListener('pointercancel', up);
}
// a quarter turn clockwise: only the Exif orientation changes, so the picture itself is not re-saved
let rotating = false;
async function rotateItem(it) {
  if (rotating) return;
  rotating = true;
  try {
    const cur = S.byId.get(it.id), f = await db.get('files', it.id);
    if (!cur || !f || !f.blob) return;
    const blob = await turnJpeg(f.blob, 90, cur.ts);
    if (blob === f.blob) { toast('이 사진은 돌릴 수 없어요'); return; }
    const t = await imageThumb(blob);
    await putItem({ ...cur, w: t.w, h: t.h, memoPos: null, memoMoved: false }, blob, t.thumb);
    dropThumb(it.id);
    if (V.item && V.item.id === it.id) await renderViewer(true);
    renderCurrent();
  } catch (e) {
    toast('돌리지 못했어요');
  } finally { rotating = false; }
}
async function toggleMemoOn(it) {
  const cur = S.byId.get(it.id);
  await putItem({ ...cur, memoOff: !cur.memoOff });
  renderViewerActions(S.byId.get(it.id));
  renderMemoOn();
  prepOut(S.byId.get(it.id));
}
// the file the share button hands over is made when the viewer opens (iOS opens the share sheet only right after a tap)
function prepOut(it) {
  V.out = null;
  const id = it.id, blob = V.blob;
  if (!blob) return;
  shareBlob(it, blob).then((o) => { if (V.item && V.item.id === id && V.blob === blob) V.out = o; },
    () => { if (V.item && V.item.id === id && V.blob === blob) V.out = blob; });
}
// one photo from the viewer: the file is prepared when the viewer opens, so the tap can open the share sheet at once
function shareOne(it) {
  if (!V.out || !V.item || V.item.id !== it.id) { toast('사진을 준비하는 중이에요. 잠시 뒤 다시 눌러 주세요'); return; }
  shareOrDownload(V.out, nameOf(it), it.ts).then((r) => { if (r === 'shared' || r === 'downloaded') markShared([it.id]); });
}

// ================================================================ days tab
const D = { selecting: false, sel: new Set(), suppressClick: false };

function cellFor(it, { tag = 'button', onClick = null, label = null, selectable = false } = {}) {
  const c = el(tag, { class: 'cell' + (selectable && D.selecting && D.sel.has(it.id) ? ' sel' : ''), 'data-id': selectable ? it.id : null });
  thumbUrl(it.id).then((u) => { if (u) c.style.backgroundImage = `url("${u}")`; });
  const t = label === null ? timeOf(it.ts) : label;
  if (t) c.append(el('span', { class: 't' }, t));
  const b = el('span', { class: 'b' });
  if (it.kind === 'video') b.append(el('span', { class: 'badge video' }, '영상'));
  if (it.doc) b.append(el('span', { class: 'badge doc' }, '문서'));
  if (!it.tbm && !it.doc && !it.pin) b.append(el('span', { class: 'badge nopin' }, '위치 없음'));
  if (it.issue) b.append(el('span', { class: 'badge ' + (it.issue.status === 'open' ? 'open' : 'done') }, it.issue.status === 'open' ? '이슈' : '조치됨'));
  if (it.fixOf) b.append(el('span', { class: 'badge done' }, '조치 후'));
  if (it.memo) b.append(el('span', { class: 'badge' }, '메모'));
  if (S.shared.has(it.id)) b.append(el('span', { class: 'badge sent' }, '보냄'));
  c.append(b);
  if (tag === 'button') {
    c.onclick = () => {
      if (D.suppressClick) { D.suppressClick = false; return null; }
      if (onClick) return onClick(it, c);
      if (selectable && D.selecting) {
        if (D.sel.has(it.id)) D.sel.delete(it.id); else D.sel.add(it.id);
        c.classList.toggle('sel', D.sel.has(it.id));
        renderSelBar();
        return null;
      }
      return openViewer(it.id);
    };
  }
  return c;
}

function backupDue() {
  const items = vis();
  if (!items.length) return null;
  const last = S.settings.lastBackup || 0;
  const newer = items.filter((i) => i.ts > last).length;
  if (!newer) return null;
  const since = last || items[0].ts;
  const days = Math.floor((Date.now() - since) / 864e5);
  return days >= 7 ? { days, newer, never: !last } : null;
}

function renderDays() {
  const day = S.day;
  const its = vis().filter((i) => i.day === day);
  $('#dTitle').textContent = dayLabel(day) + (day === today() ? ' · 오늘' : '');
  $('#dNext').disabled = day >= today();
  const tbm = its.filter((i) => i.tbm), rest = its.filter((i) => !i.tbm);

  const due = backupDue(), bb = $('#backupBanner');
  if (due) {
    bb.replaceChildren(el('span', {}, due.never ? `아직 백업한 적이 없어요 (사진 ${due.newer}개).` : `마지막 백업이 ${due.days}일 전이에요 (새 사진 ${due.newer}개).`),
      el('button', { class: 'btn small', onclick: makeBackup }, '백업'));
    bb.hidden = false;
  } else bb.hidden = true;

  const card = $('#tbmCard');
  const missing = !tbm.length && (rest.length > 0 || day === today());
  card.classList.toggle('missing', missing);
  const row = el('div', { class: 'row' },
    day === today() ? el('button', { class: 'add', onclick: startTbm }, '+ 찍기') : null,
    el('button', { class: 'add', onclick: () => importMedia(day, true) }, '+ 앨범'),
    ...tbm.map((it) => cellFor(it, { selectable: true })));
  // the row folds away with the arrow (remembered)
  const open = !S.settings.tbmFold;
  row.hidden = !open;
  const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chev.setAttribute('width', '18'); chev.setAttribute('height', '18'); chev.setAttribute('viewBox', '0 0 24 24'); chev.setAttribute('aria-hidden', 'true');
  chev.innerHTML = '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>';
  card.replaceChildren(el('h3', {}, el('button', {
    class: 'fold', 'aria-expanded': String(open), 'aria-label': open ? 'TBM 접기' : 'TBM 펼치기',
    onclick: () => { S.settings.tbmFold = open; saveSettings(); renderCurrent(); },
  }, 'TBM', el('small', { class: missing ? 'warn' : 'muted' }, tbm.length ? `${tbm.length}장` : '아직 없어요'), chev)), row);

  $('#dGrid').replaceChildren(...rest.map((it) => cellFor(it, { selectable: true })));
  $('#dEmpty').hidden = rest.length > 0;
  $('#dCount').textContent = rest.length ? `사진 ${rest.length}장` : '사진';
  renderSelBar();
}
function renderSelBar() {
  $('#dSelect').textContent = D.selecting ? '취소' : '선택';
  $('#dSelBar').hidden = !D.selecting;
  $('#scr-days').classList.toggle('selecting', D.selecting);
  $('#dSelCount').textContent = `${D.sel.size}개`;
  for (const id of ['dSelMemo', 'dSelShare', 'dSelReport', 'dSelExport', 'dSelDelete']) $('#' + id).disabled = D.sel.size === 0;
}
// ---------------------------------------------------------------- drag to select (day page)
// In 선택 mode, slide sideways across photos to select them; moving up or down then takes whole rows, like the
// Photos app. A swipe that starts up or down scrolls instead. Pressing and holding a photo starts selecting from
// it, even outside 선택 mode. In 선택 mode the photos take the touch themselves (touch-action: none), because
// iPhone Safari otherwise starts scrolling at the first slant of the finger and drops the selection.
const DS = { active: false, pending: null, anchor: -1, target: true, base: null, x: 0, y: 0, raf: 0, hold: 0, scroll: null, glide: 0 };
const dayCells = () => [...$$('#tbmCard .cell[data-id]'), ...$$('#dGrid .cell[data-id]')];
function cellIndexAt(x, y) {
  const t = document.elementFromPoint(x, y);
  const c = t && t.closest ? t.closest('#scr-days .cell[data-id]') : null;
  return c ? dayCells().indexOf(c) : -1;
}
function dsApply(idx) {
  if (idx < 0 || DS.anchor < 0) return;
  const lo = Math.min(DS.anchor, idx), hi = Math.max(DS.anchor, idx);
  dayCells().forEach((c, i) => {
    const id = c.dataset.id;
    const on = i >= lo && i <= hi ? DS.target : DS.base.has(id);
    if (on) D.sel.add(id); else D.sel.delete(id);
    c.classList.toggle('sel', on);
  });
  renderSelBar();
}
function dsStart(id, pointerId) {
  const idx = dayCells().findIndex((c) => c.dataset.id === id);
  if (idx < 0) return;
  if (!D.selecting) { D.selecting = true; D.sel.clear(); }
  DS.active = true;
  DS.anchor = idx;
  DS.base = new Set(D.sel);
  DS.target = !D.sel.has(id);
  try { $('#scr-days').setPointerCapture(pointerId); } catch (e) { /* the finger already lifted */ }
  dsApply(idx);
  cancelAnimationFrame(DS.raf);
  DS.raf = requestAnimationFrame(dsTick);
}
// near the top or bottom edge the list scrolls under the finger and selection follows
function dsTick() {
  if (!DS.active) return;
  const sc = $('#scr-days .scroll');
  const r = sc.getBoundingClientRect();
  let v = 0;
  if (DS.y < r.top + 56) v = -Math.ceil((r.top + 56 - DS.y) / 5);
  else if (DS.y > r.bottom - 56) v = Math.ceil((DS.y - (r.bottom - 56)) / 5);
  if (v) { sc.scrollTop += v; dsApply(cellIndexAt(DS.x, DS.y)); }
  DS.raf = requestAnimationFrame(dsTick);
}
function bindDragSelect() {
  const root = $('#scr-days');
  root.addEventListener('pointerdown', (e) => {
    const c = e.target.closest ? e.target.closest('.cell[data-id]') : null;
    if (!c || c.closest('#tbmCard') || (e.pointerType === 'mouse' && e.button !== 0)) return; // the TBM row scrolls sideways; taps still select
    cancelAnimationFrame(DS.glide);
    DS.pending = { x0: e.clientX, y0: e.clientY, id: c.dataset.id, pid: e.pointerId };
    DS.x = e.clientX; DS.y = e.clientY;
    clearTimeout(DS.hold);
    DS.hold = setTimeout(() => {
      const p = DS.pending;
      if (p && !DS.active) dsStart(p.id, p.pid);
    }, 450);
  });
  root.addEventListener('pointermove', (e) => {
    DS.x = e.clientX; DS.y = e.clientY;
    if (DS.active) { dsApply(cellIndexAt(e.clientX, e.clientY)); return; }
    const s = DS.scroll;
    if (s) {
      s.el.scrollTop = s.top - (e.clientY - s.y0);
      const dt = Math.max(1, e.timeStamp - s.t);
      s.v = (s.y - e.clientY) / dt;
      s.y = e.clientY; s.t = e.timeStamp;
      return;
    }
    const p = DS.pending;
    if (!p) return;
    const dx = e.clientX - p.x0, dy = e.clientY - p.y0;
    if (Math.hypot(dx, dy) < 8) return;
    clearTimeout(DS.hold);
    DS.pending = null;
    if (!D.selecting) return; // outside 선택 mode the page scrolls by itself
    if (Math.abs(dx) >= Math.abs(dy)) { dsStart(p.id, p.pid); dsApply(cellIndexAt(e.clientX, e.clientY)); return; }
    const sc = $('#scr-days .scroll');
    DS.scroll = { el: sc, top: sc.scrollTop, y0: p.y0, y: e.clientY, t: e.timeStamp, v: 0 };
    sc.scrollTop = DS.scroll.top - dy;
    try { root.setPointerCapture(p.pid); } catch (err) { /* fine without */ }
  });
  const up = () => {
    clearTimeout(DS.hold);
    DS.pending = null;
    if (DS.scroll) { // let the list glide a little, like a normal swipe
      const s = DS.scroll;
      DS.scroll = null;
      let v = s.v;
      cancelAnimationFrame(DS.glide);
      const glide = () => { if (Math.abs(v) < 0.02) return; s.el.scrollTop += v * 16; v *= 0.94; DS.glide = requestAnimationFrame(glide); };
      DS.glide = requestAnimationFrame(glide);
      D.suppressClick = true;
      setTimeout(() => { D.suppressClick = false; }, 0);
      return;
    }
    if (!DS.active) return;
    DS.active = false;
    cancelAnimationFrame(DS.raf);
    D.suppressClick = true; // the lift that ends a drag is not a tap on a photo
    setTimeout(() => { D.suppressClick = false; }, 0);
  };
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', up);
  root.addEventListener('touchmove', (e) => { if ((DS.active || DS.scroll) && e.cancelable) e.preventDefault(); }, { passive: false });
}

function stepDay(dir) {
  const days = [...new Set(vis().map((i) => i.day))].sort();
  let t;
  if (dir < 0) {
    const prev = days.filter((d) => d < S.day);
    t = prev.length ? prev[prev.length - 1] : addDays(S.day, -1);
  } else {
    const next = days.filter((d) => d > S.day && d <= today());
    t = next.length ? next[0] : today();
  }
  S.day = t > today() ? today() : t;
  D.sel.clear();
  renderDays();
}
async function openCalendar() {
  let ym = S.day.slice(0, 7);
  const info = new Map();
  for (const i of vis()) { const d = info.get(i.day) || { n: 0, tbm: 0 }; d.n++; if (i.tbm) d.tbm++; info.set(i.day, d); }
  const shift = (s, k) => { const [y, m] = s.split('-').map(Number); const d = new Date(y, m - 1 + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const pick = await openDialog((box, close) => {
    const head = el('div', { class: 'cal-head' });
    const grid = el('div', { class: 'cal' });
    const draw = () => {
      const [y, m] = ym.split('-').map(Number);
      head.replaceChildren(
        el('button', { class: 'icon-btn', 'aria-label': '이전 달', onclick: () => { ym = shift(ym, -1); draw(); } }, '‹'),
        el('b', {}, `${y}년 ${m}월`),
        el('button', { class: 'icon-btn', 'aria-label': '다음 달', onclick: () => { ym = shift(ym, 1); draw(); } }, '›'));
      grid.replaceChildren(...['일', '월', '화', '수', '목', '금', '토'].map((w) => el('div', { class: 'h' }, w)));
      const first = new Date(y, m - 1, 1).getDay(), n = new Date(y, m, 0).getDate();
      for (let i = 0; i < first; i++) grid.append(el('span'));
      for (let d = 1; d <= n; d++) {
        const day = `${ym}-${String(d).padStart(2, '0')}`;
        const x = info.get(day);
        const cls = [x ? 'has' : '', x && !x.tbm ? 'notbm' : '', day === today() ? 'today' : '', day === S.day ? 'cur' : ''].filter(Boolean).join(' ');
        grid.append(el('button', { class: cls, disabled: day > today(), onclick: () => close(day) }, d));
      }
    };
    draw();
    box.append(el('h3', {}, '날짜 고르기'), head, grid,
      el('p', { class: 'cal-note' }, '점: 사진 있는 날 · 주황 테두리: 사진은 있는데 TBM이 없는 날'),
      el('div', { class: 'd-actions' },
        el('button', { class: 'btn', onclick: () => close(today()) }, '오늘'),
        el('button', { class: 'btn', onclick: () => close(undefined) }, '닫기')));
  });
  if (pick) { S.day = pick; D.sel.clear(); renderDays(); }
}

// photos taken outside the app (or TBM shot with the phone camera) for a given day
async function importMedia(day, tbm, target = null) {
  const files = await pickFiles({ accept: tbm ? 'image/*' : 'image/*,video/*', multiple: true });
  if (!files.length) return;
  const b = busy('사진 넣는 중…');
  let k = 0;
  try {
    for (const f of files) {
      const isVideo = /^video\//.test(f.type);
      let t = { thumb: null, w: 0, h: 0 };
      try { t = isVideo ? await videoThumb(f) : await imageThumb(f); } catch (e) { /* no thumbnail */ }
      const shot = isVideo ? null : await shotTime(f);
      // onto a member: the photo keeps its own date; into a day: its own time if it was taken that day
      const ts = target ? (shot || f.lastModified || Date.now()) + k
        : shot && dayOf(shot) === day ? shot : f.lastModified && dayOf(f.lastModified) === day ? f.lastModified : dayStart(day) + 8 * 3600e3 + k * 1000;
      const blob = isVideo ? f : await outBlob({ kind: 'photo', ts, w: t.w, h: t.h }, f);
      const media = { blob, kind: isVideo ? 'video' : 'photo', mime: f.type || 'image/jpeg', lens: 'album', w: t.w, h: t.h };
      await putItem(newRecord(media, ts, target ? targetFields(target) : tbm ? { tbm: true, floor: null } : {}), blob, t.thumb);
      k++;
      b.set(`사진 넣는 중… ${k}/${files.length}`);
    }
  } catch (e) {
    alertBox('일부만 넣었어요', `${k}개를 넣었어요. ${(e && e.message) || ''}`);
  } finally { b.done(); }
  if (k) toast(target ? `${target.mark}에 ${k}개를 올렸어요` : tbm ? `TBM 사진 ${k}장을 넣었어요` : `${k}개를 넣었어요. 위치는 사진을 눌러 붙이세요.`, 2600);
  renderCurrent();
  if (target && S.tab === 'plan' && S.planTap) onPlanTap(S.planTap);
}

// photos straight onto a member chosen on the drawing tab: the location is the member, no location step
function targetOf(fl, m) {
  const c = centroid(m.pts).map(r2), room = PV.roomAt(c);
  return {
    floor: fl.key, mark: m.mark || m.type || '부재', pin: c, members: [{ id: m.id, mark: m.mark || '', type: m.type, at: c, c }],
    room: room ? { code: room.code || '', name: room.name || '', type: room.type || '' } : null, grid: PV.gridOf(c),
  };
}
const targetFields = (t) => ({ floor: t.floor, pin: t.pin.slice(), members: t.members.map((m) => ({ ...m })), room: t.room, grid: t.grid, noMember: false, fan: null });
function startTarget(t) {
  S.mode = 'target';
  S.target = t;
  S.targetCount = 0;
  S.fixOf = null;
  showTab('camera');
  renderCamBanner();
}
function endTarget() { S.mode = 'normal'; S.target = null; renderCamBanner(); }

// ================================================================ plan tab
let planPins = [];
function planTabCtx() {
  return { name: 'tab', host: $('#pHost'), floor: S.planFloor, rooms: S.settings.showRooms, onTap: onPlanTap, drawStatic: drawPlanStatic, drawDynamic: drawPlanDynamic };
}
function renderPlanTab() {
  if (!S.planFloor || !S.floors.some((f) => f.key === S.planFloor)) S.planFloor = S.settings.capFloor || (S.floors[0] && S.floors[0].key);
  renderPlanChips();
  $('#pRooms').checked = !!S.settings.showRooms;
  return usePlan(planTabCtx());
}
function renderPlanChips() {
  const counts = new Map();
  for (const i of vis()) if (i.pin && i.floor) counts.set(i.floor, (counts.get(i.floor) || 0) + 1);
  $('#pFloors').replaceChildren(...S.floors.map((f) => el('button', {
    'aria-pressed': String(f.key === S.planFloor),
    onclick: () => {
      if (f.key === S.planFloor) return;
      S.planFloor = f.key;
      S.planSel = null;
      $('#pSheet').hidden = true;
      renderPlanTab();
    },
  }, floorShort(f.key), counts.get(f.key) ? el('small', {}, ' ' + counts.get(f.key)) : null)));
}
function drawPlanStatic(g) {
  const fl = PV.floor;
  planPins = [];
  if (!fl) return;
  const state = new Map();
  for (const it of vis()) {
    if (it.floor !== fl.key || !it.pin) continue;
    const open = !!(it.issue && it.issue.status === 'open');
    let any = false;
    for (const r of it.members || []) {
      if (typeof r.id !== 'number') continue;
      any = true;
      if (open) state.set(r.id, 'open'); else if (!state.has(r.id)) state.set(r.id, 'photo');
    }
    if (!any) planPins.push({ p: it.pin, open });
  }
  const byId = memMap(fl);
  for (const want of ['photo', 'open']) {
    for (const [id, st] of state) {
      if (st !== want) continue;
      const m = byId.get(id);
      if (m) svg('polygon', { points: ptsAttr(m.pts), class: st === 'open' ? 'm-open' : 'm-photo' }, g);
    }
  }
  const sel = S.planSel;
  if (sel && sel.floor === fl.key && sel.memberId != null) {
    const m = byId.get(sel.memberId);
    if (m) svg('polygon', { points: ptsAttr(m.pts), class: 'm-sel' }, g);
  }
}
function drawPlanDynamic(g, px) {
  const fl = PV.floor;
  if (!fl) return;
  for (const q of planPins) svg('circle', { cx: q.p[0], cy: q.p[1], r: 5 * px, class: q.open ? 'pin-open' : 'pin-dot', 'stroke-width': 1.5 * px }, g);
  const sel = S.planSel;
  if (sel && sel.floor === fl.key && sel.p) svg('circle', { cx: sel.p[0], cy: sel.p[1], r: 22 * px, class: 'tap-ring', 'stroke-width': 2 * px }, g);
}
function onPlanTap(p) {
  const fl = PV.floor;
  if (!fl) return;
  S.planTap = p;
  const located = vis().filter((i) => i.floor === fl.key && i.pin);
  const m = PV.hitMember(p);
  let list = [], title = '', target = null;
  if (m) {
    // a member always opens its sheet, with + 찍기 · + 앨범 to put photos straight onto it
    target = targetOf(fl, m);
    list = located.filter((i) => (i.members || []).some((r) => r.id === m.id));
    S.planSel = { floor: fl.key, memberId: m.id };
    const near = list.length ? [] : located.filter((i) => Math.hypot(i.pin[0] - p[0], i.pin[1] - p[1]) < 22 * PV.ptPerPx());
    title = `${target.mark} · ${list.length ? `${list.length}장` : near.length ? `사진 없음 · 근처 ${near.length}장` : '사진 없음'}`;
    if (near.length) list = near;
    const spec = colSpec(fl.key, m.mark);
    if (spec) title += `\n${spec}`;
  }
  if (!list.length && !target) {
    const tol = 22 * PV.ptPerPx();
    list = located.filter((i) => Math.hypot(i.pin[0] - p[0], i.pin[1] - p[1]) < tol);
    if (list.length) { const room = PV.roomAt(p); title = `${room ? room.name : '이 자리'} · ${list.length}장`; S.planSel = { floor: fl.key, p }; }
  }
  const sh = $('#pSheet');
  if (!list.length && !target) {
    const room = PV.roomAt(p);
    S.planSel = null;
    sh.hidden = true;
    PV.refresh();
    if (room) toast(`${room.name}${room.code && room.code !== room.name ? ' · ' + room.code : ''} · ${PV.gridOf(p)}`);
    return;
  }
  list.sort((a, b) => b.ts - a.ts);
  $('#pSheetTitle').textContent = title;
  $('#pSheetList').replaceChildren(
    ...(target ? [el('button', { class: 'add', onclick: () => startTarget(target) }, '+ 찍기'), el('button', { class: 'add', onclick: () => importMedia(today(), false, target) }, '+ 앨범')] : []),
    ...list.map((it) => cellFor(it, { label: md(it.day), onClick: () => openViewer(it.id) })));
  sh.hidden = false;
  PV.refresh();
}

// ================================================================ issues tab
function renderIssues() {
  const f = S.issueFilter;
  $$('#iFilter button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === f)));
  const list = vis().filter((i) => i.issue && (f === 'all' || i.issue.status === f))
    .sort((a, b) => (f === 'open' ? a.ts - b.ts : b.ts - a.ts));
  $('#iList').replaceChildren(...list.map(issueRow));
  $('#iEmpty').hidden = list.length > 0;
}
function issueRow(it) {
  const fix = it.issue.fixId ? S.byId.get(it.issue.fixId) : null;
  const mt = memberText(it);
  return el('button', { class: 'row-item', onclick: () => openViewer(it.id) },
    cellFor(it, { tag: 'div', label: '' }),
    el('div', { class: 'txt' },
      el('b', {}, placeText(it) + (it.floor ? ` · ${floorLabel(it.floor)}` : '')),
      mt ? el('span', {}, mt) : null,
      it.memo ? el('span', { class: 'memo' }, it.memo) : null,
      el('small', {}, `${dayLabel(it.day)} ${timeOf(it.ts)}`),
      el('small', { class: it.issue.status === 'open' ? 'st-open' : 'st-done' }, issueText(it))),
    fix ? cellFor(fix, { tag: 'div', label: '' }) : null);
}
function updateBadge() {
  const n = vis().filter((i) => i.issue && i.issue.status === 'open').length;
  const b = $('#issueBadge');
  b.textContent = n > 99 ? '99+' : String(n);
  b.hidden = n === 0;
}

// ================================================================ export / backup
const CSV_HEAD = ['파일명', '날짜', '시간', '층', '실', '실 코드', '그리드', '부재', '방향', '방향 기준', '기울기(°)', '렌즈', '구분', '이슈', '조치일', '짝 사진', '메모'];
function csvRow(it, fn, fileOf) {
  return [
    fn, it.day, timeOf(it.ts), it.tbm || it.doc ? '' : floorLabel(it.floor), it.room ? it.room.name : '', it.room ? it.room.code : '',
    it.grid || '', it.tbm || it.doc ? '' : (it.noMember ? '부재 없음' : memberText(it)), it.fan ? bearingText(it.fan.dir) : '',
    it.fan ? SRC[it.fan.src] || '' : '', it.pitch == null ? '' : it.pitch, LENS[it.lens] || it.lens || '',
    it.tbm ? 'TBM' : it.doc ? '문서' : it.fixOf ? '조치 후' : '', it.issue ? (it.issue.status === 'open' ? '미조치' : '조치 완료') : '',
    (it.issue && it.issue.fixedDay) || '',
    it.issue && it.issue.fixId ? '조치 후: ' + fileOf(it.issue.fixId) : it.fixOf ? '조치 전: ' + fileOf(it.fixOf) : '',
    it.memo || '',
  ];
}
async function exportItems(list) {
  list = list.filter((i) => !i.draft).sort((a, b) => a.ts - b.ts);
  if (!list.length) { toast('내보낼 사진이 없어요'); return; }
  const days = [...new Set(list.map((i) => i.day))].sort();
  const multi = days.length > 1;
  const fileName = uniqueNames(list);
  const fileOf = (id) => fileName.get(id) || (S.byId.get(id) ? nameOf(S.byId.get(id)) : '');
  const b = busy('내보내기 준비 중…');
  try {
    const entries = [], rows = [CSV_HEAD];
    for (const it of list) {
      const f = await db.get('files', it.id);
      if (!f) continue;
      const fn = fileName.get(it.id);
      entries.push({ name: (multi ? yymmdd(it.day) + '/' : '') + fn, blob: await outBlob(it, f.blob), date: new Date(it.ts) });
      rows.push(csvRow(it, fn, fileOf));
    }
    entries.push({ name: '사진목록.csv', text: csv(rows) });
    const zip = await makeZip(entries, (i, n) => b.set(`묶는 중… ${i}/${n}`));
    b.done();
    const zipName = `현장사진_${yymmdd(days[0])}${multi ? '-' + yymmdd(days[days.length - 1]) : ''}.zip`;
    const r = await offerFile(zip, zipName, 'ZIP 준비 완료', `${entries.length - 1}개 · ${fmtBytes(zip.size)}\n"파일에 저장"을 고르면 폰에 저장돼요. 사진마다 찍은 날짜·시간이 들어 있어요.`);
    if (r === 'shared' || r === 'downloaded') markShared(list.map((i) => i.id));
  } catch (e) {
    b.done();
    alertBox('내보내지 못했어요', (e && e.message) || String(e));
  }
}
async function exportRange() {
  const r = await openDialog((box, close) => {
    const from = el('input', { type: 'date', value: today(), max: today() });
    const to = el('input', { type: 'date', value: today(), max: today() });
    const tbm = el('input', { type: 'checkbox', checked: true });
    const info = el('p', {});
    const pick = () => vis().filter((i) => i.day >= from.value && i.day <= to.value && (tbm.checked || !i.tbm));
    const upd = () => { info.textContent = `${pick().length}개`; };
    from.oninput = upd; to.oninput = upd; tbm.onchange = upd;
    upd();
    const quick = (label, a, z) => el('button', { class: 'btn small', onclick: () => { from.value = a; to.value = z; upd(); } }, label);
    const t = today(), wd = new Date(dayStart(t)).getDay();
    box.append(el('h3', {}, '기간 골라 내보내기'),
      el('div', { class: 'btns' }, quick('오늘', t, t), quick('이번 주', addDays(t, -((wd + 6) % 7)), t), quick('이번 달', t.slice(0, 8) + '01', t)),
      el('label', { class: 'form-row' }, '시작', from), el('label', { class: 'form-row' }, '끝', to),
      el('label', { class: 'opt' }, tbm, ' TBM 사진 넣기'), info,
      el('div', { class: 'd-actions' },
        el('button', { class: 'btn', onclick: () => close(null) }, '취소'),
        el('button', { class: 'btn primary', onclick: () => close(pick()) }, '내보내기')));
  });
  if (r) exportItems(r);
}

// send = only what was taken or changed since the last send, without the drawings: for another device (iPad) by AirDrop
async function makeBackup(send = false) {
  const since = S.settings.lastSent || 0;
  const items = send ? vis().filter((i) => (i.mt || i.ts) > since) : vis();
  if (send && !items.length) { toast('지난번에 보낸 뒤로 새로 찍거나 고친 사진이 없어요', 2600); return; }
  const b = busy(send ? '보낼 파일 만드는 중…' : '백업 파일 만드는 중…');
  try {
    const entries = [];
    const meta = {
      format: 'fieldphoto-backup', version: 1, app: APP_VERSION, created: new Date().toISOString(),
      pkg: S.pkg, settings: S.settings, items, inPhotos: [...S.shared], registers: await db.all('registers'), regItems: await db.all('regItems'), todos: todosForBackup(),
    };
    entries.push({ name: 'backup.json', text: JSON.stringify(meta) });
    markZip(meta);
    let k = 0;
    for (const it of items) {
      const f = await db.get('files', it.id);
      if (f) entries.push({ name: `media/${it.id}.${extOf(it)}`, blob: f.blob, date: new Date(it.ts) });
      const t = await db.get('thumbs', it.id);
      if (t) entries.push({ name: `thumbs/${it.id}.jpg`, blob: t.blob, date: new Date(it.ts) });
      if (++k % 20 === 0) b.set(`백업 준비 중… ${k}/${items.length}`);
    }
    if (S.pkg && !send) {
      const fls = [];
      for (const f of S.floors) {
        const r = await getFloor(f.key);
        if (!r) continue;
        const { imgBlob, roomsBlob, ...rest } = r;
        fls.push(rest);
        entries.push({ name: `drawings/${r.key}.webp`, blob: imgBlob });
        if (roomsBlob) entries.push({ name: `drawings/${r.key}_rooms.png`, blob: roomsBlob });
      }
      entries.push({ name: 'drawings/floors.json', text: JSON.stringify({ pkg: S.pkg, floors: fls }) });
      const pdf = await db.get('files', PDF_ID);
      if (pdf) entries.push({ name: 'drawings/plan.pdf', blob: pdf.blob });
    }
    const zip = await makeZip(entries, (i, n) => b.set(`백업 묶는 중… ${i}/${n}`));
    b.done();
    const hm = timeOf(Date.now()).replace(':', '');
    const r = send
      ? await offerFile(zip, `현장사진_보내기_${yymmdd(today())}_${hm}.zip`, '보낼 파일 준비 완료',
        `새로 찍거나 고친 사진·영상 ${items.length}개 · ${fmtBytes(zip.size)}\n"파일에 저장" → iCloud Drive의 현장사진 폴더에 두세요. 아이패드 앱의 더보기 → '백업에서 복원'에서 그 폴더의 ZIP을 모두 고르면 새 것만 들어가요. 도면은 빠져 있어요(아이패드에 먼저 넣어 두세요).`)
      : await offerFile(zip, `현장사진_백업_${yymmdd(today())}.zip`, '백업 파일 준비 완료',
        `사진·영상 ${items.length}개 · ${fmtBytes(zip.size)}\n"파일에 저장"으로 폰이나 PC에 보관하세요.`);
    if ((r === 'shared' || r === 'downloaded') && send) {
      S.settings.lastSent = Date.now();
      saveSettings();
    } else if (r === 'shared' || r === 'downloaded') {
      S.settings.lastBackup = Date.now();
      saveSettings();
      renderCurrent();
    }
  } catch (e) {
    b.done();
    alertBox('백업하지 못했어요', (e && e.message) || String(e));
  }
}

// ---------------------------------------------------------------- phone storage: originals moved to iCloud Drive
// The originals go into a ZIP the user saves with "파일에 저장" (iCloud Drive); the phone keeps a small copy (long side
// 1600 px) to look at, share and print. Restoring that ZIP (백업에서 복원) puts the originals back, here or on the iPad.
// A web app cannot write to iCloud by itself, so this is one tap on the share sheet each time.
const KEEP_PX = 1600, MOVE_MAX = 400 * 1024 * 1024;
async function smallCopy(it, blob) {
  if (it.kind !== 'photo') return null;
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, KEEP_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const j = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    const w = c.width, h = c.height;
    c.width = c.height = 1;
    return j ? withExif(j, it.ts, w, h) : null;
  } finally { URL.revokeObjectURL(url); }
}
async function moveOut() {
  const cut = await choose('어떤 사진의 원본을 옮길까요?', [
    { label: '일주일 지난 것', value: 7 }, { label: '사흘 지난 것', value: 3 }, { label: '오늘 것 빼고 전부', value: 1 }]);
  if (!cut) return;
  const before = dayOf(Date.now() - (cut - 1) * 86400e3);
  const cand = vis().filter((i) => !i.offloaded && i.day < before).sort((a, b) => a.ts - b.ts);
  if (!cand.length) { toast('옮길 원본이 없어요', 2400); return; }
  const b = busy('원본 묶는 중…');
  let zip, name, items = [];
  try {
    const entries = [], files = {};
    let total = 0;
    for (const it of cand) {
      const f = await db.get('files', it.id);
      if (!f || !f.blob) continue;
      if (items.length && total + f.blob.size > MOVE_MAX) break; // one ZIP at a time stays small enough for Safari
      total += f.blob.size;
      items.push(it);
      const path = `${it.day}/${nameOf(it)}`;
      files[it.id] = path;
      entries.push({ name: path, blob: f.blob, date: new Date(it.ts) });
      const t = await db.get('thumbs', it.id);
      if (t) entries.push({ name: `thumbs/${it.id}.jpg`, blob: t.blob, date: new Date(it.ts) });
    }
    if (!items.length) { b.done(); toast('옮길 원본이 없어요', 2400); return; }
    const meta = { format: 'fieldphoto-backup', version: 1, kind: 'originals', app: APP_VERSION, created: new Date().toISOString(), items, files };
    entries.unshift({ name: 'backup.json', text: JSON.stringify(meta) });
    markZip(meta);
    zip = await makeZip(entries, (i, n) => b.set(`원본 묶는 중… ${i}/${n}`));
    const d0 = yymmdd(items[0].day), d1 = yymmdd(items[items.length - 1].day);
    name = `현장사진_원본_${d0 === d1 ? d0 : d0 + '-' + d1}.zip`;
  } catch (e) {
    b.done();
    alertBox('원본을 묶지 못했어요', (e && e.message) || String(e));
    return;
  }
  b.done();
  const more = cand.length - items.length;
  const r = await offerFile(zip, name, '원본 ZIP 준비 완료',
    `사진·영상 ${items.length}개 · ${fmtBytes(zip.size)}${more ? `\n(${more}개는 다음에 한 번 더 옮겨요)` : ''}\n"파일에 저장" → iCloud Drive를 고르세요.`);
  if (r !== 'shared' && r !== 'downloaded') return;
  const ok = await confirmBox('iCloud Drive에 저장했나요?',
    `저장했으면 이 폰에서 원본 ${items.length}개를 비우고, 보기용 작은 사진만 남겨요(영상은 첫 장면만). 원본이 다시 필요하면 "${name}"을 백업에서 복원하세요.`, '원본 비우기');
  if (!ok) return;
  const b2 = busy('원본 비우는 중…');
  let n = 0;
  try {
    for (const it of items) {
      const cur = S.byId.get(it.id), f = await db.get('files', it.id);
      if (!cur || !f || !f.blob) continue;
      const small = await smallCopy(cur, f.blob).catch(() => null);
      // mt stays: moving the original out is not a change to send to the iPad
      const rec = { ...cur, offloaded: { at: Date.now(), zip: name, size: f.blob.size } };
      await db.saveItem(rec, small, null);
      if (!small) await db.del('files', it.id);
      remember(rec);
      if (++n % 10 === 0) b2.set(`원본 비우는 중… ${n}/${items.length}`);
    }
  } catch (e) {
    alertBox('일부만 비웠어요', `${n}개를 비웠어요. ${(e && e.message) || ''}`);
  } finally { b2.done(); }
  S.settings.lastMoveOut = Date.now();
  saveSettings();
  toast(`원본 ${n}개를 비웠어요`, 2600);
  renderCurrent();
}

// a ZIP is known by when it was made and what it holds. ZIPs made on this device, or already put in, are skipped
// when several are picked at once (the whole iCloud Drive folder can be picked every time).
const zipKey = (meta) => `${meta.created}|${(meta.items || []).length}`;
function markZip(meta) {
  const a = (S.settings.zips || []).filter((k) => k !== zipKey(meta));
  a.push(zipKey(meta));
  S.settings.zips = a.slice(-300);
  saveSettings();
}
async function restoreMany(files) {
  const ok = await confirmBox('여러 파일 복원', `${files.length}개 파일을 차례로 넣어요. 이미 넣었거나 이 기기에서 만든 파일은 건너뛰고, 같은 사진은 더 나중에 고친 쪽을 남겨요.`, '복원');
  if (!ok) return;
  let done = 0, skip = 0, fail = 0;
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const r = await restoreFrom(f, { many: true });
    if (r === 'skip') skip++; else if (r) done++; else fail++;
  }
  toast(`${done ? `${done}개 파일을 넣었어요` : '새로 넣을 파일이 없어요'}${skip ? ` · ${skip}개는 이미 넣은 것` : ''}${fail ? ` · ${fail}개 못 넣음` : ''}`, 3500);
}
async function restoreFrom(file, { many = false } = {}) {
  let z, meta;
  const b = busy('백업 파일 읽는 중…');
  try {
    z = await readZip(file);
    const j = z.get('backup.json');
    if (!j) throw new Error('backup.json이 없어요. 이 앱의 백업 파일인지 확인해 주세요.');
    meta = JSON.parse(await j.text());
    if (meta.format !== 'fieldphoto-backup') throw new Error('이 앱의 백업 파일이 아니에요.');
  } catch (e) {
    b.done();
    alertBox('복원하지 못했어요', (e && e.message) || String(e));
    return false;
  }
  b.done();
  if (many && (S.settings.zips || []).includes(zipKey(meta))) return 'skip';
  const items = (meta.items || []).filter((i) => !i.draft);
  const have = new Set(S.items.map((i) => i.id));
  const fresh = items.filter((i) => !have.has(i.id)).length;
  const withDrawings = z.has('drawings/floors.json') && !S.pkg;
  const ok = many || await confirmBox('백업에서 복원',
    `백업 안의 사진·영상 ${items.length}개 중 새로 넣을 것 ${fresh}개` +
    (items.length - fresh ? (meta.kind === 'originals' ? `, 이미 있는 ${items.length - fresh}개는 원본을 되돌려 놓아요` : `, 이미 있는 ${items.length - fresh}개는 더 나중에 고친 쪽을 남겨요`) : '') + '.' +
    (withDrawings ? '\n도면도 같이 넣어요.' : ''), '복원');
  if (!ok) return false;
  const b2 = busy(many ? `복원 중… ${file.name}` : '복원 중…');
  try {
    if (withDrawings) await restoreDrawings(z);
    let n = 0;
    const zips = new Map();
    // a backup made from broken copies (see repairStored) holds the whole older backup in each file
    const own = async (blob, name, type) => blob ? ((await unzipped(blob, name, type, zips).catch(() => null)) || ownCopy(blob, type)) : null;
    for (const it of items) {
      const mn = (meta.files && meta.files[it.id]) || `media/${it.id}.${extOf(it)}`, tn = `thumbs/${it.id}.jpg`;
      const cur = S.byId.get(it.id), mb = z.get(mn);
      if (cur && (cur.mt || cur.ts) > (it.mt || it.ts)) {
        // changed here since: keep this record, but take back an original that was moved out
        if (cur.offloaded && !it.offloaded && mb) { await db.saveItem({ ...cur, offloaded: null }, await own(mb, mn, it.mime || ''), null); dropThumb(it.id); }
        if (++n % 5 === 0) b2.set(`복원 중… ${n}/${items.length}`);
        continue;
      }
      // a small copy never replaces an original this device still has
      const keepOwn = it.offloaded && cur && !cur.offloaded;
      await db.saveItem({ ...it, draft: false, offloaded: keepOwn ? null : it.offloaded || null },
        keepOwn ? null : await own(mb, mn, it.mime || ''), await own(z.get(tn), tn, 'image/jpeg'));
      dropThumb(it.id);
      if (++n % 5 === 0) b2.set(`복원 중… ${n}/${items.length}`);
    }
    if (meta.settings) {
      if (meta.settings.calib != null) S.settings.calib = meta.settings.calib;
      if (meta.settings.capture) S.settings.capture = meta.settings.capture;
    }
    if (meta.kind !== 'originals') S.settings.lastBackup = Math.max(S.settings.lastBackup || 0, Date.parse(meta.created) || 0);
    if (Array.isArray(meta.inPhotos)) { for (const id of meta.inPhotos) S.shared.add(id); db.kvSet('inPhotos', [...S.shared]).catch(() => {}); }
    if (Array.isArray(meta.todos)) await restoreTodos(meta.todos);
    saveSettings();
    setItems(await db.all('items'));
  } catch (e) {
    b2.done();
    alertBox('복원하다 멈췄어요', (e && e.message) || String(e));
    setItems(await db.all('items'));
    return false;
  }
  b2.done();
  markZip(meta);
  if (!many) toast(`복원했어요 (${items.length}개)`);
  return true;
}
async function restoreDrawings(z) {
  const j = JSON.parse(await z.get('drawings/floors.json').text());
  const recs = [], zips = new Map();
  const inner = (blob, name, type) => unzipped(blob, name, type, zips).catch(() => null);
  for (const f of j.floors) {
    const img = z.get(`drawings/${f.key}.webp`), rooms = z.get(`drawings/${f.key}_rooms.png`);
    if (!img) continue;
    recs.push({ ...f, imgBlob: (await inner(img, `drawings/${f.key}.webp`, 'image/webp')) || img,
      roomsBlob: rooms ? (await inner(rooms, `drawings/${f.key}_rooms.png`, 'image/png')) || rooms : null });
  }
  const pdf = z.get('drawings/plan.pdf');
  const { floors: _f, importedAt: _i, ...meta } = j.pkg || {};
  await installDrawings(meta, recs, pdf ? (await inner(pdf, 'drawings/plan.pdf', 'application/pdf')) || pdf : null);
}

// ================================================================ repair of restored files (1.4.3)
// Restores made with 1.4.2 and earlier were saved by the iPhone as the whole backup ZIP for every drawing,
// photo and thumbnail (see ownCopy). They looked fine until the app was opened again. Each broken copy still
// holds that whole backup, so the right file is taken back out of it.
// blob: a stored file. Returns its proper content if it turned out to be a backup ZIP, otherwise null.
async function unzipped(blob, name, type, zips) {
  if (!blob) return null;
  let cur = blob, found = false;
  for (let depth = 0; depth < 3; depth++) { // a backup made from broken copies holds them one level deeper
    const head = await headOf(cur, 30);
    if (!isZipHead(head)) break;
    const key = head.join(',');
    let z = zips.get(key);
    if (!z) { z = await readZip(await ownCopy(cur, 'application/zip')); zips.set(key, z); }
    const e = z.get(name);
    if (!e) throw new Error(name + ' 없음');
    cur = e; found = true;
  }
  return found ? ownCopy(cur, type) : null;
}
async function repairStored(items) {
  const zips = new Map();
  let fixed = 0, failed = 0, b = null;
  const fix = async (blob, name, type) => {
    try {
      const head = blob ? await headOf(blob) : null;
      if (!head || !isZipHead(head)) return null;
      if (!b) {
        b = busy('저장된 도면·사진을 고치는 중…');
        const tip = document.querySelector('#splash .splash-tip');
        if (tip) tip.textContent = '저장된 도면·사진을 고치는 중…';
      }
      const r = await unzipped(blob, name, type, zips);
      if (r) fixed++;
      return r;
    } catch (e) { failed++; return null; }
  };
  try {
    for (const f of await db.all('floors')) {
      const img = await fix(f.imgBlob, `drawings/${f.key}.webp`, 'image/webp');
      const rooms = await fix(f.roomsBlob, `drawings/${f.key}_rooms.png`, 'image/png');
      // the other picture of the record is copied too: re-saving a Blob read back from storage breaks it on iPhone
      if (img || rooms) await db.put('floors', { ...f, imgBlob: img || await ownCopy(f.imgBlob), roomsBlob: rooms || (f.roomsBlob ? await ownCopy(f.roomsBlob) : null) });
    }
    const pdf = await db.get('files', PDF_ID);
    const p = pdf && await fix(pdf.blob, 'drawings/plan.pdf', 'application/pdf');
    if (p) await db.put('files', { id: PDF_ID, blob: p });
    for (const it of items) {
      const f = await db.get('files', it.id);
      const m = f && await fix(f.blob, `media/${it.id}.${extOf(it)}`, it.mime || f.blob.type);
      if (m) await db.put('files', { id: it.id, blob: m });
      const t = await db.get('thumbs', it.id);
      const tb = t && await fix(t.blob, `thumbs/${it.id}.jpg`, 'image/jpeg');
      if (tb) await db.put('thumbs', { id: it.id, blob: tb });
      if (m || tb) dropThumb(it.id);
    }
  } finally {
    if (b) b.done();
  }
  if (fixed) { S.floorCache.clear(); PV.resetPdf(); }
  return { fixed, failed };
}
function repairNotice(r) {
  if (r.failed) alertBox('일부 파일을 고치지 못했어요',
    `도면·사진 파일 ${r.failed}개를 읽지 못했어요.\n더보기 → '도면 파일 가져오기'로 도면 파일을 다시 넣고, '백업 파일에서 복원'으로 백업을 다시 넣어 주세요.`);
  else if (r.fixed) toast(`도면·사진 파일 ${r.fixed}개를 고쳤어요`, 3500);
}

// ================================================================ drawing package
function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function dataUriToBlob(uri) {
  const m = /^data:([^;,]+)?(;base64)?,/.exec(uri || '');
  if (!m) throw new Error('도면 그림 정보가 깨졌어요');
  const body = uri.slice(m[0].length);
  const bytes = m[2] ? b64ToBytes(body) : new TextEncoder().encode(decodeURIComponent(body));
  return new Blob([bytes], { type: m[1] || 'application/octet-stream' });
}
// when drawings are replaced, photos keep pointing at the same members (matched by mark and place)
function remapItems(recs) {
  const changed = [];
  for (const it of S.items) {
    if (!it.floor || !it.members || !it.members.some((r) => typeof r.id === 'number')) continue;
    const nf = recs.find((f) => f.key === it.floor);
    if (!nf) continue;
    const byId = new Map(nf.members.map((m) => [m.id, m]));
    let ch = false;
    const members = it.members.map((r) => {
      if (typeof r.id !== 'number') return r;
      const c = r.c || r.at;
      const cur = byId.get(r.id);
      if (cur && cur.mark === r.mark && c && Math.hypot(centroid(cur.pts)[0] - c[0], centroid(cur.pts)[1] - c[1]) < 3) return r;
      let best = null, bd = 15;
      for (const m of nf.members) {
        if (m.mark !== r.mark || m.type !== r.type) continue;
        const q = centroid(m.pts), d = Math.hypot(q[0] - c[0], q[1] - c[1]);
        if (d < bd) { bd = d; best = m; }
      }
      if (!best) { bd = 2; for (const m of nf.members) { if (m.type !== r.type) continue; const d = polyDist(c, m.pts); if (d < bd) { bd = d; best = m; } } }
      ch = true;
      return best ? { ...r, id: best.id, mark: best.mark || r.mark, c: centroid(best.pts).map(r2) } : { ...r, id: 'gone' };
    });
    if (ch) changed.push({ ...it, members });
  }
  return changed;
}
async function installDrawings(meta, recs, pdfBlob) {
  if (!recs.length) throw new Error('도면 층 정보가 없어요');
  const changed = S.pkg ? remapItems(recs) : [];
  const own = [];
  for (const r of recs) own.push({ ...r, imgBlob: await ownCopy(r.imgBlob, 'image/webp'), roomsBlob: r.roomsBlob ? await ownCopy(r.roomsBlob, 'image/png') : null });
  await db.clear('floors');
  await db.putMany('floors', own);
  if (pdfBlob) await db.put('files', { id: PDF_ID, blob: await ownCopy(pdfBlob, 'application/pdf') });
  if (changed.length) await putRecords(changed);
  const pkg = { ...meta, floors: recs.map((r) => ({ key: r.key, label: r.label, sheet: r.sheet })), importedAt: Date.now() };
  await db.kvSet('pkg', pkg);
  S.floorCache.clear();
  planCtx = null;
  for (const k of Object.keys(planViews)) delete planViews[k];
  await PV.setFloor(null);
  PV.resetPdf();
  applyPkg(pkg);
}
async function importPackage(file) {
  const b = busy('도면 파일 읽는 중…');
  try {
    const p = JSON.parse(await file.text());
    if (p.format !== 'fieldphoto-drawings' || !Array.isArray(p.floors) || !p.floors.length) throw new Error('이 앱의 도면 파일이 아니에요.');
    b.set('도면 정리 중…');
    const recs = p.floors.map((f) => {
      const { img, roomsImg, ...rest } = f;
      return { ...rest, imgBlob: dataUriToBlob(img), roomsBlob: roomsImg ? dataUriToBlob(roomsImg) : null };
    });
    const pdf = p.pdf ? new Blob([b64ToBytes(p.pdf)], { type: 'application/pdf' }) : null;
    const { floors: _f, pdf: _p, ...meta } = p;
    await installDrawings(meta, recs, pdf);
    b.done();
    toast(`도면을 넣었어요 (${recs.length}개 층)`);
    return true;
  } catch (e) {
    b.done();
    alertBox('도면을 넣지 못했어요', (e && e.message) || String(e));
    return false;
  }
}
function applyPkg(pkg) {
  S.pkg = pkg;
  S.floors = pkg.floors || [];
  if (!S.floors.some((f) => f.key === S.settings.capFloor)) { S.settings.capFloor = S.floors.length ? S.floors[0].key : null; saveSettings(); }
  if (!S.floors.some((f) => f.key === S.planFloor)) S.planFloor = null;
}

// ================================================================ more tab
async function calibrate() {
  const okPerm = await sensors.requestPermission();
  if (!okPerm) {
    alertBox('나침반을 쓸 수 없어요', '휴대폰 설정에서 동작 및 방향 접근을 허용한 뒤 다시 해 주세요.');
    return;
  }
  const floor = S.settings.capFloor;
  let pin = null, tgt = null, hd = null;
  const res = await openDialog((box, close) => {
    const msg = el('p', {}, '1단계: 지금 서 있는 곳을 도면에서 누르세요.');
    const live = el('p', { class: 'cal-note' }, '나침반 값을 기다리는 중…');
    const host = el('div', { class: 'd-plan' });
    const okBtn = el('button', { class: 'btn primary', disabled: true, onclick: () => close({ pin, tgt, hd }) }, '맞추기');
    const timer = setInterval(() => {
      if (!box.isConnected || !box.contains(live)) { clearInterval(timer); return; }
      live.textContent = sensors.heading == null ? '나침반 값을 기다리는 중…'
        : `지금 나침반 ${Math.round(sensors.heading)}°` + (sensors.headingAcc != null && sensors.headingAcc >= 0 ? ` (오차 ±${Math.round(sensors.headingAcc)}°)` : '');
    }, 300);
    box.append(el('h3', {}, `나침반 방향 맞추기 · ${floorLabel(floor)}`), msg, host, live,
      el('div', { class: 'd-actions' }, el('button', { class: 'btn', onclick: () => close(null) }, '취소'), okBtn));
    requestAnimationFrame(() => usePlan({
      name: 'cal', host, floor,
      onTap: (p) => {
        if (!pin || tgt) {
          pin = p; tgt = null; hd = null; okBtn.disabled = true;
          msg.textContent = '2단계: 폰을 세워 카메라가 보이는 기둥(또는 벽 모서리)을 정확히 향하게 들고, 도면에서 그 기둥을 누르세요.';
        } else {
          tgt = p; hd = sensors.heading; okBtn.disabled = hd == null;
          msg.textContent = hd == null ? '나침반 값이 아직 없어요. 잠시 뒤 기둥을 다시 눌러 주세요.' : '"맞추기"를 누르면 저장돼요. 다시 하려면 서 있는 곳부터 다시 누르세요.';
          if (hd == null) tgt = null;
        }
        PV.refresh();
      },
      drawDynamic: (g, px) => {
        if (pin && tgt) svg('line', { x1: pin[0], y1: pin[1], x2: tgt[0], y2: tgt[1], class: 'cal-line', 'stroke-width': 2.5 * px }, g);
        if (tgt) svg('circle', { cx: tgt[0], cy: tgt[1], r: 9 * px, class: 'tgt', 'stroke-width': 2.5 * px }, g);
        if (pin) pinMark(g, pin, px, 'pin');
      },
    }));
  }, { dismiss: false });
  restorePlan();
  if (!res || !res.pin || !res.tgt || res.hd == null) return;
  const theta = Math.atan2(res.tgt[1] - res.pin[1], res.tgt[0] - res.pin[0]);
  S.settings.calib = calibFor(theta, res.hd, north());
  saveSettings();
  toast(`나침반 보정 ${S.settings.calib > 0 ? '+' : ''}${S.settings.calib}°`);
  renderMore();
}

async function wipeData() {
  const n = vis().length;
  if (!(await confirmBox('사진·기록 모두 지우기', `이 폰에 저장된 사진·영상 ${n}개와 기록이 모두 지워져요. 도면은 남아요.\n백업이 없으면 되돌릴 수 없어요.`, '다음', true))) return;
  if (!(await confirmBox('정말 지울까요?', `${n}개를 지워요.`, '모두 지우기', true))) return;
  const b = busy('지우는 중…');
  try {
    for (const it of [...S.items]) { await db.deleteItem(it.id); dropThumb(it.id); }
    await db.clear('registers');
    await db.clear('regItems');
    await db.kvSet('lastSetup', null);
    S.lastSetup = null;
    S.shared = new Set();
    await db.kvSet('inPhotos', []);
    setItems([]);
  } finally { b.done(); }
  toast('모두 지웠어요');
  renderCurrent();
}

async function renderMore() {
  const body = $('#moreBody');
  const group = (title, ...kids) => el('div', { class: 'more-group' }, el('h3', {}, title), ...kids);
  const btns = (...b) => el('div', { class: 'btns' }, ...b);
  const btn = (label, fn, cls = '') => el('button', { class: 'btn small ' + cls, onclick: fn }, label);
  const items = vis();
  const parts = [];
  if (S.pkg) {
    parts.push(group('도면',
      el('p', {}, S.pkg.project || ''),
      el('p', {}, `${S.pkg.source || ''}`),
      el('p', {}, `층: ${S.floors.map((f) => floorShort(f.key)).join(', ')} · 도면 파일 ${S.pkg.created || ''}`),
      btns(btn('도면 파일 다시 가져오기', async () => { const [f] = await pickFiles(); if (f && (await importPackage(f))) renderMore(); }))));
  }
  const seg = el('div', { class: 'seg' },
    ...[['app', '앱 카메라'], ['native', '기본 카메라']].map(([v, l]) => el('button', {
      'aria-pressed': String(S.settings.capture === v),
      onclick: () => { S.settings.capture = v; saveSettings(); renderMore(); },
    }, l)));
  // which back cameras Safari shows (if 0.5× is missing, this says why)
  const camList = el('p', { class: 'muted' }, '');
  navigator.mediaDevices && navigator.mediaDevices.enumerateDevices().then((ds) => {
    const n = ds.filter((d) => d.kind === 'videoinput' && d.label).map((d) => d.label);
    camList.textContent = n.length ? `사파리가 보여주는 카메라: ${n.join(', ')}` : '';
  }).catch(() => {});
  parts.push(group('촬영 방식',
    el('p', {}, '앱 카메라: 찍자마자 도면이 떠서 빨라요. 기본 카메라: 아이폰 카메라 앱 그대로이고 음량 버튼으로 찍을 수 있어요.'),
    el('p', {}, '앱 카메라는 아이폰이 앱을 열 때마다 카메라 허용을 물어봐요(아이폰이 홈 화면 앱의 허용을 기억하지 않아요). 기본 카메라는 묻지 않아요.'),
    seg, camList));
  const hasSensor = sensors.heading != null;
  const tbmName = S.settings.tbmName || '건축';
  parts.push(group('TBM 사진 이름',
    el('p', {}, `TBM 사진은 "${yymmdd(today())} ${tbmName}"처럼 이름이 붙어요. 같은 날 두 장째부터는 _2, _3이 붙어요.`),
    btns(btn('바꾸기', async () => {
      const t = await promptText('TBM 사진 이름', tbmName, { placeholder: '예: 건축', multiline: false, hint: '날짜 뒤에 붙는 말이에요.' });
      if (t === null || !t.trim()) return;
      S.settings.tbmName = t.trim();
      S.names = null;
      saveSettings();
      renderMore();
      renderCurrent();
    }))));
  parts.push(group('나침반',
    el('p', {}, hasSensor ? `지금 나침반 ${Math.round(sensors.heading)}°` : '나침반 값이 아직 없어요. "센서 켜기"를 눌러 허용해 주세요.'),
    el('p', {}, `보정값 ${S.settings.calib > 0 ? '+' : ''}${S.settings.calib || 0}° · 부재 없이 찍을 때 방향을 정하는 데 써요. 철골·철근 가까이에서는 틀릴 수 있어요.`),
    btns(btn('센서 켜기', async () => { const ok = await sensors.requestPermission(); toast(ok ? '센서를 켰어요' : '센서 권한이 없어요'); setTimeout(renderMore, 600); }),
      btn('방향 맞추기', calibrate),
      S.settings.calib ? btn('보정 지우기', () => { S.settings.calib = 0; saveSettings(); renderMore(); }) : null)));
  parts.push(group('내보내기',
    el('p', {}, '고른 기간의 사진을 정해진 이름으로 바꿔 ZIP 하나로 묶어요. 사진목록.csv(엑셀)가 같이 들어가요.'),
    btns(btn('기간 골라 내보내기', exportRange))));
  const last = S.settings.lastBackup;
  parts.push(group('백업',
    el('p', {}, last ? `마지막 백업 ${dayLabel(dayOf(last))} ${timeOf(last)}` : '아직 백업한 적이 없어요.'),
    el('p', {}, '사진·기록·도면을 ZIP 하나로 묶어요. 폰을 바꾸거나 앱을 지울 때 이 파일로 되살려요.'),
    btns(btn('백업 파일 만들기', () => makeBackup(), 'primary'),
      btn('백업에서 복원', async () => {
        const fs = await pickFiles({ accept: '.zip,application/zip', multiple: true });
        if (!fs.length) return;
        if (fs.length > 1) await restoreMany(fs);
        else await restoreFrom(fs[0]);
        renderCurrent();
      }))));
  const sent = S.settings.lastSent;
  parts.push(group('아이패드와 맞추기 (iCloud Drive)',
    el('p', {}, '보내는 쪽: "새 것만 보내기" → 공유 · 저장 → 파일에 저장 → iCloud Drive의 같은 폴더(예: 현장사진). 받는 쪽: "백업에서 복원"에서 그 폴더의 ZIP을 모두 고르면, 이미 넣은 것과 그 기기에서 만든 것은 건너뛰고 새 것만 들어가요. 아이패드에서 고친 것도 같은 방법으로 아이폰에 넣을 수 있어요.'),
    el('p', {}, sent ? `마지막으로 보낸 때 ${dayLabel(dayOf(sent))} ${timeOf(sent)}` : '아직 보낸 적이 없어요.'),
    btns(btn('새 것만 보내기', () => makeBackup(true)))));
  const storage = el('p', {}, '확인 중…');
  const moved = items.filter((i) => i.offloaded).length;
  parts.push(group('저장 공간', el('p', {}, `사진·영상 ${items.length}개${moved ? ` · 원본을 iCloud로 옮긴 것 ${moved}개` : ''}`), storage,
    el('p', {}, '폰 공간이 모자라면 지난 사진의 원본을 ZIP으로 묶어 iCloud Drive에 저장하고, 폰에는 보기용 작은 사진만 남길 수 있어요. 기록·위치·이슈는 그대로예요. 원본이 다시 필요하면 그 ZIP을 "백업에서 복원"으로 넣으면 돼요(아이패드도 같아요).'),
    btns(btn('원본 iCloud로 옮기기', moveOut))));
  parts.push(group('지우기',
    el('p', {}, '이 폰에 저장된 사진·영상·기록을 모두 지워요. 도면은 남아요.'),
    btns(btn('사진·기록 모두 지우기', wipeData, 'danger'))));
  parts.push(group('앱 정보',
    el('p', {}, `현장 사진 ${APP_VERSION} (${APP_DATE}) · 사진과 기록은 이 폰에만 저장되고, 어디로도 보내지 않아요.`),
    btns(btn('업데이트 확인', async () => {
      if (!S.swReg) { toast('오프라인 설치가 아직 안 됐어요'); return; }
      try { await S.swReg.update(); toast('확인했어요. 새 버전이 있으면 다음에 열 때 바뀌어요.', 2600); } catch (e) { toast('인터넷 연결을 확인해 주세요'); }
    }))));
  body.replaceChildren(...parts);
  const est = await db.estimate();
  let persisted = false;
  try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch (e) { /* unknown */ }
  storage.textContent = (est ? `쓰는 공간 ${fmtBytes(est.usage || 0)} / 쓸 수 있는 공간 ${fmtBytes(est.quota || 0)}` : '공간 정보를 알 수 없어요') +
    (persisted ? ' · 자동으로 지워지지 않게 보호돼요' : '');
}

// ================================================================ tabs and wiring
// The status bar is a solid strip above the app (see index.html); it takes the colour of the screen below it.
function setStatusColor(t) {
  const m = document.querySelector('meta[name="theme-color"]');
  if (!m) return;
  const panel = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim() || '#ffffff';
  m.setAttribute('content', t === 'camera' ? '#000000' : panel);
}
function showTab(t) {
  const prev = S.tab;
  setStatusColor(t);
  S.tab = t;
  $$('.screen').forEach((s) => s.classList.toggle('on', s.dataset.tab === t));
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  if (prev === 'camera' && t !== 'camera') scheduleCamStop();
  if (prev !== t && (prev === 'camera' || t === 'camera')) scanLoop();
  // TBM shots are taken in one go: leaving the camera ends TBM mode, so it does not greet you next time
  if (t !== 'camera' && S.mode === 'tbm') { S.mode = 'normal'; renderCamBanner(); }
  if (t !== 'camera' && S.mode === 'target') endTarget();
  if (t !== 'camera' && cam.recording) finishRecording(); // leaving the camera ends the video
  if (t !== 'days' && D.selecting) { D.selecting = false; D.sel.clear(); }
  if (t === 'days' && prev === 'days') S.day = today();
  if (t === 'camera') { renderCamTop(); startCamera(); }
  else if (t === 'plan') renderPlanTab();
  else if (t === 'days') renderDays();
  else if (t === 'issues') renderIssues();
  else if (t === 'todo') { if (prev !== 'todo') showTodoToday(); renderTodos(); }
  else if (t === 'more') renderMore();
}
function renderCurrent() {
  updateBadge();
  if (S.planSel && !vis().some((i) => i.floor === S.planSel.floor && i.pin)) { S.planSel = null; $('#pSheet').hidden = true; }
  if (S.tab === 'days') renderDays();
  else if (S.tab === 'issues') renderIssues();
  else if (S.tab === 'camera') renderCamTop();
  else if (S.tab === 'more') renderMore();
  else if (S.tab === 'plan') {
    renderPlanChips();
    if (planCtx && planCtx.name === 'tab') PV.refresh();
  }
  if (!$('#viewer').hidden && V.item) {
    if (S.byId.has(V.item.id)) renderViewer(false); else closeViewer();
  }
}

function bindUI() {
  $$('#tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  // camera
  $('#camShutter').onclick = onShutter;
  $('#camNative').onclick = () => shootNative('photo');
  $('#camVideoBtn').onclick = () => toggleRecord();
  $('#camScan').onclick = () => { S.scan = !S.scan; renderCamScan(); scanLoop(); if (S.scan) toast('종이 전체가 보이게 찍어 주세요'); };
  $('#camFloor').onclick = async () => {
    const k = await chooseFloor(S.settings.capFloor);
    if (k) { S.settings.capFloor = k; saveSettings(); renderCamTop(); }
  };
  // sheet
  $('#shClose').onclick = discardSheet;
  $('#shFloor').onclick = async () => {
    const k = await chooseFloor(C.floor);
    if (!k || k === C.floor) return;
    Object.assign(C, { floor: k, ghost: null, pin: null, members: [], manualDir: null, step: 'pin' });
    renderSheet();
    C.ready = usePlan(sheetCtx(false));
  };
  $('#shMem').onclick = () => { adoptGhost(); C.noMember = false; C.manualDir = null; renderSheet(); PV.refresh(); };
  $('#shNoMem').onclick = () => { adoptGhost(); C.noMember = true; C.members = []; renderSheet(); PV.refresh(); };
  $('#shIssue').onclick = () => { C.issue = !C.issue; renderSheet(); };
  $('#shMove').onclick = () => {
    if (C.ghost) adoptGhost();
    else if (C.pin) C.step = C.step === 'pin' ? 'member' : 'pin';
    renderSheet();
    PV.refresh();
  };
  $('#shMemo').onclick = async () => {
    const t = await promptText('메모', C.memo, { placeholder: '예: 균열 0.3mm, 다음 주 재확인' });
    if (t !== null) { C.memo = t; renderSheet(); }
  };
  $('#shLater').onclick = () => finishSheet(true);
  $('#shSave').onclick = () => finishSheet(false);
  // viewer
  $('#vClose').onclick = closeViewer;
  $('#vDelete').onclick = async () => {
    const it = V.item;
    if (!it) return;
    if (!(await confirmBox('이 사진을 지울까요?', `${nameOf(it)}\n지우면 되돌릴 수 없어요.`, '지우기', true))) return;
    await removeItem(it.id);
    closeViewer();
    toast('지웠어요');
    renderCurrent();
  };
  // days
  $('#dPrev').onclick = () => stepDay(-1);
  $('#dNext').onclick = () => stepDay(1);
  $('#dTitle').onclick = openCalendar;
  $('#dSelect').onclick = () => { D.selecting = !D.selecting; D.sel.clear(); renderDays(); };
  $('#dSelAll').onclick = () => { for (const i of vis()) if (i.day === S.day) D.sel.add(i.id); renderDays(); };
  $('#dSelMemo').onclick = async () => {
    const sel = [...D.sel].map((id) => S.byId.get(id)).filter(Boolean);
    if (!sel.length) return;
    const same = sel.every((i) => (i.memo || '') === (sel[0].memo || '')) ? sel[0].memo || '' : '';
    const t = await promptText(`메모 · ${sel.length}개`, same, { hint: '고른 사진 모두에 같은 메모를 붙여요.' });
    if (t === null) return;
    await putRecords(sel.map((i) => ({ ...i, ...memoPatch(i, t) })));
    renderDays();
  };
  $('#dSelReport').onclick = () => makeReport([...D.sel].map((id) => S.byId.get(id)));
  $('#dSelExport').onclick = () => exportItems([...D.sel].map((id) => S.byId.get(id)).filter(Boolean));
  $('#dSelShare').onclick = () => shareBatch([...D.sel].map((id) => S.byId.get(id)).filter(Boolean));
  bindDragSelect();
  $('#dSelDelete').onclick = async () => {
    const ids = [...D.sel];
    if (!ids.length) return;
    if (!(await confirmBox(`${ids.length}개를 지울까요?`, '지우면 되돌릴 수 없어요.', '지우기', true))) return;
    for (const id of ids) await removeItem(id);
    D.sel.clear();
    D.selecting = false;
    toast('지웠어요');
    renderCurrent();
  };
  $('#dAlbum').onclick = () => importMedia(S.day, false);
  // plan
  $('#pSheetClose').onclick = () => { $('#pSheet').hidden = true; S.planSel = null; PV.refresh(); };
  $('#pRooms').onchange = (e) => { S.settings.showRooms = e.target.checked; saveSettings(); if (planCtx && planCtx.name === 'tab') PV.showRooms(e.target.checked); };
  // issues
  $$('#iFilter button').forEach((b) => { b.onclick = () => { S.issueFilter = b.dataset.f; renderIssues(); }; });
  // camera follows the app being shown or hidden
  // leaving the app for a moment keeps the camera; iOS pauses it and it resumes on return
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    // back after a while (or on another day): TBM mode is over
    if (S.mode === 'tbm' && (Date.now() - hiddenAt > 10 * 60e3 || dayOf(hiddenAt) !== today())) { S.mode = 'normal'; renderCamBanner(); }
    if (S.tab === 'camera' && $('#sheet').hidden && S.pkg) startCamera();
  });
  sensors.onturn = renderCamTurn;
  bindViewerGestures();
  bindTodos();
}

function showWelcome() {
  setStatusColor('welcome');
  let w = $('#welcome');
  if (!w) { w = el('div', { id: 'welcome', class: 'overlay welcome-ov' }); document.body.append(w); }
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  w.replaceChildren(el('div', { class: 'welcome' },
    el('h2', {}, '현장 사진'),
    el('p', {}, '찍은 사진에 도면 위치·부재·방향을 붙여 정리해요. 사진과 기록은 이 폰 안에만 저장되고, 어디로도 보내지 않아요.'),
    ios && !standalone ? el('div', { class: 'banner' }, el('span', {},
      '먼저 Safari 아래쪽 공유 버튼 → "홈 화면에 추가"를 누른 뒤, 홈 화면의 "현장사진" 아이콘으로 다시 열어 주세요. Safari에서 넣은 도면·사진은 홈 화면 앱으로 옮겨지지 않아요.')) : null,
    el('p', {}, '시작하려면 받은 도면 파일(.json)을 가져오세요. "파일" 앱에 저장해 두면 고를 수 있어요.'),
    el('button', {
      class: 'btn primary big',
      onclick: async () => { const [f] = await pickFiles(); if (f && (await importPackage(f))) { w.hidden = true; startApp(); } },
    }, '도면 파일 가져오기'),
    el('button', {
      class: 'btn',
      onclick: async () => { const [f] = await pickFiles({ accept: '.zip,application/zip' }); if (f && (await restoreFrom(f)) && S.pkg) { w.hidden = true; startApp(); } },
    }, '백업 파일에서 복원'),
    el('p', { class: 'cal-note' }, `버전 ${APP_VERSION}`)));
  w.hidden = false;
}

function startApp() {
  updateBadge();
  showTab('camera');
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (location.protocol !== 'https:' && !local) return null;
  const p = navigator.serviceWorker.register('sw.js').then((reg) => { S.swReg = reg; return reg; }).catch(() => null);
  let had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (had && !S.updating) toast('새 버전을 받았어요. 앱을 다시 열면 바뀌어요.', 3500);
    had = true;
  });
  return p;
}
// While the start screen is up, look for a newer version once. If there is one, take it and restart right away,
// before the camera starts, so the first launch after an update already runs it (also in Safari before
// "홈 화면에 추가", where an old saved copy would otherwise be what gets added).
async function updateOnLaunch(regP) {
  if (!regP || !navigator.serviceWorker.controller || navigator.onLine === false) return false;
  const reg = await regP;
  if (!reg) return false;
  const timeout = (ms) => new Promise((r) => setTimeout(r, ms));
  try { await Promise.race([reg.update(), timeout(2500)]); } catch (e) { return false; }
  const next = reg.installing || reg.waiting;
  if (!next) return false;
  S.updating = true;
  const tip = document.querySelector('#splash .splash-tip');
  if (tip) tip.textContent = '새 버전 받는 중…';
  const took = await Promise.race([
    new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', () => r(true), { once: true })),
    timeout(12000).then(() => false),
  ]);
  if (took) { location.reload(); return true; }
  S.updating = false;
  if (tip) tip.textContent = '화면을 누르면 바로 시작해요';
  return false;
}

async function boot() {
  try {
    await db.openDB();
  } catch (e) {
    document.body.append(el('div', { class: 'overlay welcome-ov' }, el('div', { class: 'welcome' },
      el('h2', {}, '저장소를 열 수 없어요'), el('p', {}, '개인정보 보호(비공개) 모드에서는 쓸 수 없어요. 일반 모드나 홈 화면 앱으로 열어 주세요.'))));
    hideSplash(true);
    return;
  }
  db.persist();
  S.settings = { ...S.settings, ...((await db.kvGet('settings', {})) || {}) };
  S.lastSetup = await db.kvGet('lastSetup', null);
  await loadTodos().catch(() => {});
  S.shared = new Set((await db.kvGet('inPhotos', [])) || []);
  setItems(await db.all('items'));
  // a photo whose location step was interrupted is kept as a "위치 없음" photo
  const drafts = S.items.filter((i) => i.draft);
  if (drafts.length) await putRecords(drafts.map((d) => ({ ...d, draft: false })));
  bindUI();
  const regP = registerSW();
  if (await updateOnLaunch(regP)) return;
  // once: drawings and photos that an earlier restore saved as the whole backup ZIP
  let repaired = null;
  if (!(await db.kvGet('zipRepair'))) {
    repaired = await repairStored(S.items).catch(() => null);
    if (repaired) await db.kvSet('zipRepair', { at: Date.now(), ...repaired });
  }
  if (!(window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function')) sensors.start();
  const pkg = await db.kvGet('pkg');
  if (!pkg) { showWelcome(); hideSplash(); return; }
  applyPkg(pkg);
  startApp();
  hideSplash();
  if (repaired) repairNotice(repaired);
}

window.__app = { S, PV, db }; // for checking on a computer; nothing here leaves the phone
boot().catch((e) => { hideSplash(true); alertBox('앱을 여는 중 문제가 생겼어요', (e && e.message) || String(e)); });
