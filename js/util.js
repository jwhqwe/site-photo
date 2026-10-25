// Small helpers: dates, ids, file names, CSV, ZIP (store only), images.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

export const uid = (p = 'i') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------------------------------------------------------------- dates (local time)
const pad = (n) => String(n).padStart(2, '0');
export function dayOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const today = () => dayOf(Date.now());
export const yymmdd = (day) => day.slice(2).replace(/-/g, '');
export function timeOf(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const WD = ['일', '월', '화', '수', '목', '금', '토'];
export function dayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${m}월 ${d}일 (${WD[dt.getDay()]})`;
}
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return dayOf(new Date(y, m - 1, d + n).getTime());
}
export const weekday = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d).getDay(); };

// ---------------------------------------------------------------- names
export const fileSafe = (s) => String(s || '').replace(/#/g, '').replace(/\s+/g, '-').replace(/[\\/:*?"<>|]/g, '').replace(/^-+|-+$/g, '');

export function extOf(item) {
  if (item.kind === 'video') {
    if (/quicktime/.test(item.mime || '')) return 'mov';
    if (/webm/.test(item.mime || '')) return 'webm';
    return 'mp4';
  }
  if (/png/.test(item.mime || '')) return 'png';
  if (/heic/.test(item.mime || '')) return 'heic';
  return 'jpg';
}

// "그 밖의 사진" names: 날짜_위치_번호, numbered per day and place in shooting order.
// TBM: 날짜_TBM_번호. A fix photo takes its issue photo's name + _조치후.
export function computeNames(items) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const base = new Map();
  const groups = new Map();
  for (const it of [...items].sort((a, b) => a.ts - b.ts)) {
    if (it.fixOf) continue;
    const place = it.tbm ? 'TBM' : (it.room ? fileSafe(it.room.name) : '위치없음');
    const k = it.day + '|' + place;
    const n = (groups.get(k) || 0) + 1;
    groups.set(k, n);
    base.set(it.id, `${yymmdd(it.day)}_${place}_${n}`);
  }
  for (const it of items) {
    if (!it.fixOf) continue;
    const orig = byId.get(it.fixOf);
    const b = orig ? base.get(orig.id) : null;
    base.set(it.id, (b || `${yymmdd(it.day)}_${it.room ? fileSafe(it.room.name) : '위치없음'}_조치`) + '_조치후');
  }
  return base;
}

// ---------------------------------------------------------------- CSV (UTF-8 with BOM so Excel reads Korean)
export function csv(rows) {
  const q = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- ZIP (stored entries, UTF-8 names)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes, crc = 0) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}
// entries: [{name, blob | text, date?}] -> Blob. Each file is read once for its CRC; the zip itself is built from Blob parts.
export async function makeZip(entries, onProgress) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0, i = 0;
  for (const e of entries) {
    const data = e.blob || new Blob([e.text || ''], { type: 'text/plain' });
    const buf = new Uint8Array(await data.arrayBuffer());
    const crc = crc32(buf);
    const name = enc.encode(e.name);
    const [t, d] = dosTime(e.date || new Date());
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, t, true); lh.setUint16(12, d, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, buf.length, true); lh.setUint32(22, buf.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, t, true); ch.setUint16(14, d, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, buf.length, true); ch.setUint32(24, buf.length, true); ch.setUint16(28, name.length, true);
    ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
    ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + buf.length;
    if (onProgress) onProgress(++i, entries.length);
  }
  let csize = 0;
  for (const c of central) csize += c.byteLength;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, csize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
// reads zips written by makeZip (stored entries only)
export async function readZip(blob) {
  const tail = new DataView(await blob.slice(Math.max(0, blob.size - 65557)).arrayBuffer());
  let eocd = -1;
  for (let p = tail.byteLength - 22; p >= 0; p--) if (tail.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
  if (eocd < 0) throw new Error('zip: 끝 정보를 찾지 못했어요');
  const count = tail.getUint16(eocd + 10, true), csize = tail.getUint32(eocd + 12, true), coff = tail.getUint32(eocd + 16, true);
  const cd = new DataView(await blob.slice(coff, coff + csize).arrayBuffer());
  const dec = new TextDecoder();
  const out = new Map();
  let p = 0;
  for (let n = 0; n < count; n++) {
    const method = cd.getUint16(p + 10, true), size = cd.getUint32(p + 20, true);
    const nlen = cd.getUint16(p + 28, true), xlen = cd.getUint16(p + 30, true), clen = cd.getUint16(p + 32, true);
    const lho = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen));
    if (method !== 0) throw new Error('zip: 압축된 항목은 읽을 수 없어요 (' + name + ')');
    const lh = new DataView(await blob.slice(lho, lho + 30).arrayBuffer());
    const start = lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    out.set(name, blob.slice(start, start + size));
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

// ---------------------------------------------------------------- images
export function canvasBlob(canvas, type = 'image/jpeg', q = 0.92) {
  return new Promise((res) => canvas.toBlob(res, type, q));
}
export async function thumbFrom(source, sw, sh, max = 360) {
  const k = Math.min(1, max / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return canvasBlob(c, 'image/jpeg', 0.8);
}
export async function imageThumb(blob, max = 360) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    return { thumb: await thumbFrom(img, img.naturalWidth, img.naturalHeight, max), w: img.naturalWidth, h: img.naturalHeight };
  } finally { URL.revokeObjectURL(url); }
}
export async function videoThumb(blob, max = 360) {
  const url = URL.createObjectURL(blob);
  try {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; setTimeout(res, 4000); });
    try { v.currentTime = Math.min(0.2, (v.duration || 1) / 2); await new Promise((res) => { v.onseeked = res; setTimeout(res, 1500); }); } catch (e) { /* first frame is fine */ }
    if (!v.videoWidth) return { thumb: null, w: 0, h: 0 };
    return { thumb: await thumbFrom(v, v.videoWidth, v.videoHeight, max), w: v.videoWidth, h: v.videoHeight };
  } catch (e) {
    return { thumb: null, w: 0, h: 0 };
  } finally { URL.revokeObjectURL(url); }
}

export function toast(msg, ms = 1800) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

export async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}

export const fmtBytes = (n) => n > 1e9 ? (n / 1e9).toFixed(1) + 'GB' : n > 1e6 ? (n / 1e6).toFixed(0) + 'MB' : Math.round(n / 1e3) + 'KB';
