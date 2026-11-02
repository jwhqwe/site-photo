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
// TBM: "날짜 공종" (261028 건축), then 261028 건축_2 … A scanned page: 날짜_문서_번호.
// A fix photo takes its issue photo's name + _조치후.
export function computeNames(items, tbmLabel = '건축') {
  const byId = new Map(items.map((it) => [it.id, it]));
  const base = new Map();
  const groups = new Map();
  const tbmDef = fileSafe(tbmLabel || '') || 'TBM';
  for (const it of [...items].sort((a, b) => a.ts - b.ts)) {
    if (it.fixOf) continue;
    const tbm = it.tbm ? fileSafe(it.tbmLabel || '') || tbmDef : '';
    const place = it.tbm ? 'TBM|' + tbm : it.doc ? '문서' : (it.room ? fileSafe(it.room.name) : '위치없음');
    const k = it.day + '|' + place;
    const n = (groups.get(k) || 0) + 1;
    groups.set(k, n);
    base.set(it.id, it.tbm ? `${yymmdd(it.day)} ${tbm}${n > 1 ? '_' + n : ''}` : `${yymmdd(it.day)}_${place}_${n}`);
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
    if (e.name) e.name = e.name.normalize('NFC'); // names inside the ZIP stay whole on Windows
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
// iPhone (WebKit) saves a Blob that is only a part of a bigger file -- a zip entry, a slice -- into
// IndexedDB as that whole bigger file. Anything cut out of another file gets its own bytes before it is saved.
export async function ownCopy(blob, type) {
  if (!blob) return blob;
  return new Blob([await blob.arrayBuffer()], { type: type == null ? blob.type : type });
}
// the first bytes of a stored file, e.g. 'PK\x03\x04' for a zip
export async function headOf(blob, n = 4) {
  try { return new Uint8Array(await blob.slice(0, n).arrayBuffer()); } catch (e) { return new Uint8Array(0); }
}
export const isZipHead = (h) => h.length >= 4 && h[0] === 0x50 && h[1] === 0x4b && h[2] === 3 && h[3] === 4;

// ---------------------------------------------------------------- EXIF: the shooting date and time inside a JPEG
// so the Photos app, a PC or a register shows when the photo was taken, not when it was saved.
const p2 = (n) => String(n).padStart(2, '0');
export function exifDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}:${p2(d.getMonth() + 1)}:${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
export function exifOffset(ts) {
  const m = -new Date(ts).getTimezoneOffset();
  const a = Math.abs(m);
  return `${m >= 0 ? '+' : '-'}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}
// a JPEG's own Exif block: where it is, its orientation, and whether it holds the shooting date
function exifBlock(u8) {
  let p = 2;
  while (p + 8 <= u8.length && u8[p] === 0xff) {
    const m = u8[p + 1];
    if (m === 0xda || m === 0xd9) break;
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (m === 0xe1 && u8[p + 4] === 0x45 && u8[p + 5] === 0x78 && u8[p + 6] === 0x69 && u8[p + 7] === 0x66) {
      const t = p + 10, end = p + 2 + len, le = u8[t] === 0x49, dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const g16 = (o) => dv.getUint16(t + o, le), g32 = (o) => dv.getUint32(t + o, le);
      let orient = 1, orientAt = -1, date = false, exifAt = 0, when = null;
      const scan = (ifd, fn) => {
        if (!ifd || t + ifd + 2 > end) return;
        const n = g16(ifd);
        for (let i = 0; i < n && t + ifd + 14 + i * 12 <= end; i++) fn(g16(ifd + 2 + i * 12), ifd + 2 + i * 12);
      };
      try {
        scan(g32(4), (tag, e) => { if (tag === 0x0112) { orient = g16(e + 8); orientAt = t + e + 8; } else if (tag === 0x8769) exifAt = g32(e + 8); });
        scan(exifAt, (tag, e) => {
          if (tag !== 0x9003) return;
          date = true;
          const o = t + g32(e + 8), m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(String.fromCharCode(...u8.subarray(o, o + 19)));
          if (m) when = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(); // the phone's own clock time
        });
      } catch (e) { /* a broken block counts as one without a date */ }
      return { start: p, end, orient, orientAt, le, date, when };
    }
    p += 2 + len;
  }
  return null;
}
// when a JPEG was taken, from its Exif (null if it does not say)
export async function shotTime(blob) {
  try {
    const u8 = new Uint8Array(await blob.slice(0, 131072).arrayBuffer());
    if (u8[0] !== 0xff || u8[1] !== 0xd8) return null;
    const ex = exifBlock(u8);
    return ex && ex.when && Number.isFinite(ex.when) ? ex.when : null;
  } catch (e) { return null; }
}
function buildExif(ts, w, h, orient = 1) {
  if (orient >= 5 && orient <= 8) [w, h] = [h, w]; // stored sideways
  const ascii = (str) => { const a = new Uint8Array(str.length + 1); for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0x7f; return a; };
  const short = (v) => new Uint8Array([(v >> 8) & 255, v & 255]);
  const long = (v) => new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
  const dt = ascii(exifDate(ts)), off = ascii(exifOffset(ts)), sub = ascii(p2(Math.floor(new Date(ts).getMilliseconds() / 10)));
  const sw = ascii('site-photo');
  // [tag, type, count, bytes], sorted by tag. Types: 2 ASCII, 3 SHORT, 4 LONG, 7 UNDEFINED
  const ifd0 = [[0x0112, 3, 1, short(orient)], [0x0131, 2, sw.length, sw], [0x0132, 2, dt.length, dt], [0x8769, 4, 1, long(0)]];
  const exif = [[0x9000, 7, 4, ascii('0232').subarray(0, 4)], [0x9003, 2, dt.length, dt], [0x9004, 2, dt.length, dt],
    [0x9010, 2, off.length, off], [0x9011, 2, off.length, off], [0x9012, 2, off.length, off],
    [0x9290, 2, sub.length, sub], [0x9291, 2, sub.length, sub], [0x9292, 2, sub.length, sub], [0xa001, 3, 1, short(1)]];
  if (w && h) exif.push([0xa002, 4, 1, long(w)], [0xa003, 4, 1, long(h)]);
  const sizeOf = (list) => {
    let d = 0;
    for (const e of list) if (e[3].length > 4) d += e[3].length + (e[3].length & 1);
    return 2 + list.length * 12 + 4 + d;
  };
  const exifAt = 8 + sizeOf(ifd0);
  ifd0[3][3] = long(exifAt);
  const tiff = new Uint8Array(exifAt + sizeOf(exif));
  const dv = new DataView(tiff.buffer);
  tiff[0] = 0x4d; tiff[1] = 0x4d; dv.setUint16(2, 42); dv.setUint32(4, 8);
  const write = (list, at) => {
    dv.setUint16(at, list.length);
    let data = at + 2 + list.length * 12 + 4;
    list.forEach((e, i) => {
      const q = at + 2 + i * 12;
      dv.setUint16(q, e[0]); dv.setUint16(q + 2, e[1]); dv.setUint32(q + 4, e[2]);
      if (e[3].length <= 4) tiff.set(e[3], q + 8);
      else { dv.setUint32(q + 8, data); tiff.set(e[3], data); data += e[3].length + (e[3].length & 1); }
    });
    dv.setUint32(at + 2 + list.length * 12, 0);
  };
  write(ifd0, 8);
  write(exif, exifAt);
  const len = 2 + 6 + tiff.length;
  const seg = new Uint8Array(2 + len);
  seg.set([0xff, 0xe1, (len >> 8) & 255, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  seg.set(tiff, 10);
  return seg;
}
// returns the JPEG with the date and time written in. A camera's own Exif with a date is kept as it is;
// one without a date is replaced by ours, keeping its orientation so the photo does not turn.
export async function withExif(blob, ts, w, h) {
  if (!blob || (blob.type && !/jpe?g/i.test(blob.type))) return blob;
  const u8 = new Uint8Array(await blob.arrayBuffer());
  if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) return blob;
  const ex = exifBlock(u8);
  if (ex && ex.date) return blob;
  if (ex) return new Blob([u8.subarray(0, ex.start), buildExif(ts, w, h, ex.orient), u8.subarray(ex.end)], { type: 'image/jpeg' });
  let at = 2;
  if (u8[2] === 0xff && u8[3] === 0xe0) at = 4 + ((u8[4] << 8) | u8[5]); // keep a JFIF header first
  return new Blob([u8.subarray(0, at), buildExif(ts, w, h), u8.subarray(at)], { type: 'image/jpeg' });
}

// a photo held sideways is turned without touching its pixels: the Exif orientation says how to show it
const ROT = { 1: 0, 6: 90, 3: 180, 8: 270 }, ORI = { 0: 1, 90: 6, 180: 3, 270: 8 };
export async function turnJpeg(blob, deg, ts) {
  if (!deg || !blob) return blob;
  const u8 = new Uint8Array(await blob.arrayBuffer());
  if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) return blob;
  const ex = exifBlock(u8), cur = ex ? ex.orient : 1;
  if (!(cur in ROT)) return blob; // a mirrored picture is left alone
  const next = ORI[(ROT[cur] + deg) % 360];
  if (ex && ex.orientAt >= 0) {
    const out = u8.slice();
    if (ex.le) { out[ex.orientAt] = next & 255; out[ex.orientAt + 1] = 0; } else { out[ex.orientAt] = 0; out[ex.orientAt + 1] = next & 255; }
    return new Blob([out], { type: 'image/jpeg' });
  }
  if (ex) return new Blob([u8.subarray(0, ex.start), buildExif(ts, 0, 0, next), u8.subarray(ex.end)], { type: 'image/jpeg' });
  let at = 2;
  if (u8[2] === 0xff && u8[3] === 0xe0) at = 4 + ((u8[4] << 8) | u8[5]);
  return new Blob([u8.subarray(0, at), buildExif(ts, 0, 0, next), u8.subarray(at)], { type: 'image/jpeg' });
}
export function turnCanvas(c, deg) {
  if (!deg) return c;
  const o = document.createElement('canvas'), side = deg % 180 !== 0;
  o.width = side ? c.height : c.width; o.height = side ? c.width : c.height;
  const x = o.getContext('2d');
  x.translate(o.width / 2, o.height / 2);
  x.rotate((deg * Math.PI) / 180);
  x.drawImage(c, -c.width / 2, -c.height / 2);
  c.width = c.height = 1;
  return o;
}

// ---------------------------------------------------------------- video: the shooting time in the movie header
// QuickTime/MP4 keep it in mvhd/tkhd/mdhd as seconds since 1904 (UTC). A camera's own time is kept; a missing one is filled.
const MAC_EPOCH = 2082844800;
function movieBox(dv, p, end) {
  if (p + 8 > end) return null;
  let size = dv.getUint32(p), hl = 8;
  const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
  if (size === 1) { if (p + 16 > end) return null; size = Number(dv.getBigUint64(p + 8)); hl = 16; } else if (size === 0) size = end - p;
  return size < hl || p + size > end ? null : { type, size, hl };
}
function fillMovieTimes(dv, p, end, secs) {
  let n = 0;
  for (let b; (b = movieBox(dv, p, end)); p += b.size) {
    if (b.type === 'trak' || b.type === 'mdia') n += fillMovieTimes(dv, p + b.hl, p + b.size, secs);
    else if (b.type === 'mvhd' || b.type === 'tkhd' || b.type === 'mdhd') {
      const q = p + b.hl, v1 = dv.getUint8(q) === 1;
      const cur = v1 ? Number(dv.getBigUint64(q + 4)) : dv.getUint32(q + 4);
      if (cur > MAC_EPOCH + 946684800) continue; // already a real date (after 2000)
      if (v1) { dv.setBigUint64(q + 4, BigInt(secs)); dv.setBigUint64(q + 12, BigInt(secs)); }
      else { dv.setUint32(q + 4, secs); dv.setUint32(q + 8, secs); }
      n++;
    }
  }
  return n;
}
// a video held sideways is turned by the track's display matrix (players and the Photos app follow it)
const MATRIX = { 90: [0, 65536, 0, -65536, 0, 0], 180: [-65536, 0, 0, 0, -65536, 0], 270: [0, -65536, 0, 65536, 0, 0] };
function turnTracks(dv, p, end, m) {
  let n = 0;
  for (let b; (b = movieBox(dv, p, end)); p += b.size) {
    if (b.type === 'trak') n += turnTracks(dv, p + b.hl, p + b.size, m);
    else if (b.type === 'tkhd') {
      const q = p + b.hl, at = q + (dv.getUint8(q) === 1 ? 48 : 40);
      if (!dv.getUint32(at + 36) || !dv.getUint32(at + 40)) continue; // sound track: no picture size
      m.forEach((v, i) => dv.setInt32(at + i * 4, v));
      dv.setInt32(at + 24, 0); dv.setInt32(at + 28, 0); dv.setInt32(at + 32, 1 << 30);
      n++;
    }
  }
  return n;
}
export async function turnMovie(blob, deg) {
  const m = MATRIX[deg];
  if (!m || !blob || blob.size < 16) return blob;
  let p = 0;
  for (let i = 0; i < 64 && p + 8 <= blob.size; i++) {
    const h = new DataView(await blob.slice(p, p + 16).arrayBuffer());
    let size = h.getUint32(0), hl = 8;
    const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    if (size === 1 && h.byteLength >= 16) { size = Number(h.getBigUint64(8)); hl = 16; } else if (size === 0) size = blob.size - p;
    if (size < hl) break;
    if (type === 'moov') {
      if (size > 32e6 || p + size > blob.size) break;
      const buf = await blob.slice(p, p + size).arrayBuffer();
      if (!turnTracks(new DataView(buf), hl, size, m)) return blob;
      return new Blob([blob.slice(0, p), buf, blob.slice(p + size)], { type: blob.type || 'video/mp4' });
    }
    p += size;
  }
  return blob;
}
export async function withMovieTime(blob, ts) {
  if (!blob || blob.size < 16) return blob;
  let p = 0;
  for (let i = 0; i < 64 && p + 8 <= blob.size; i++) {
    const h = new DataView(await blob.slice(p, p + 16).arrayBuffer());
    let size = h.getUint32(0), hl = 8;
    const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    if (size === 1 && h.byteLength >= 16) { size = Number(h.getBigUint64(8)); hl = 16; } else if (size === 0) size = blob.size - p;
    if (size < hl) break;
    if (type === 'moov') {
      if (size > 32e6 || p + size > blob.size) break;
      const buf = await blob.slice(p, p + size).arrayBuffer();
      if (!fillMovieTimes(new DataView(buf), hl, size, Math.floor(ts / 1000) + MAC_EPOCH)) return blob;
      return new Blob([blob.slice(0, p), buf, blob.slice(p + size)], { type: blob.type || 'video/mp4' });
    }
    p += size;
  }
  return blob;
}

// ---------------------------------------------------------------- memo on the picture
// The memo sits in a corner, in the same proportions on screen and in the shared picture.
export const MEMO = { fs: 0.045, padX: 0.5, padY: 0.32, edge: 0.03, maxW: 0.62, lh: 1.35, r: 0.25, bg: 'rgba(17,17,17,0.55)',
  font: "Pretendard, -apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif" };
const loadImage = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
// place words in the memo: what it is about stays uncovered (상부 균열 → the memo goes to the bottom)
export function memoCues(text) {
  const s = String(text || '');
  const under = /(슬래브|보|천장|천정|데크)\s*(하부|밑면|밑)/.test(s);
  return {
    t: under || /상부|상단|위쪽|천장|천정|윗부분|상층/.test(s),
    b: !under && /하부|하단|아래쪽|바닥|기초|하층|발밑|걸레받이/.test(s),
    l: /좌측|왼쪽/.test(s),
    r: /우측|오른쪽/.test(s),
  };
}
// a small gray copy of the picture, to find its calm corners
export async function grayOf(blob, n = 48) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const k = n / Math.max(img.naturalWidth, img.naturalHeight);
    const w = Math.max(4, Math.round(img.naturalWidth * k)), h = Math.max(4, Math.round(img.naturalHeight * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) g[i] = (d[4 * i] * 3 + d[4 * i + 1] * 6 + d[4 * i + 2]) / 10;
    return { g, w, h };
  } finally { URL.revokeObjectURL(url); }
}
// the corner that hides the least: few edges in the picture there, and not where the memo says the problem is
export function memoCorner(img, text) {
  const cues = memoCues(text);
  const E = { tl: 0, tr: 0, bl: 0, br: 0 };
  if (img) {
    const { g, w, h } = img, fs = MEMO.fs * Math.min(w, h), lines = String(text || '').split('\n');
    const longest = Math.max(1, ...lines.map((l) => l.length));
    const rows = lines.reduce((n, l) => n + Math.max(1, Math.ceil((l.length * 0.95 * fs) / (w * MEMO.maxW))), 0);
    const W = Math.max(3, Math.round(Math.min(w * MEMO.maxW, (longest * 0.95 + 2 * MEMO.padX) * fs) * 1.15));
    const H = Math.max(3, Math.round(Math.min(h * 0.6, (rows * MEMO.lh + 2 * MEMO.padY) * fs) * 1.15));
    let max = 1e-6;
    for (const k of Object.keys(E)) {
      const x0 = k[1] === 'l' ? 0 : w - W, y0 = k[0] === 't' ? 0 : h - H;
      let e = 0;
      for (let y = y0 + 1; y < y0 + H; y++) for (let x = x0 + 1; x < x0 + W; x++) { const i = y * w + x; e += Math.abs(g[i] - g[i - 1]) + Math.abs(g[i] - g[i - w]); }
      E[k] = e / (W * H);
      max = Math.max(max, E[k]);
    }
    for (const k of Object.keys(E)) E[k] /= max;
  }
  let best = 'bl', bestS = Infinity;
  for (const k of ['bl', 'br', 'tl', 'tr']) {
    const s = E[k] + (cues.t && k[0] === 't' ? 1 : 0) + (cues.b && k[0] === 'b' ? 1 : 0) + (cues.l && k[1] === 'l' ? 0.7 : 0) + (cues.r && k[1] === 'r' ? 0.7 : 0);
    if (s < bestS - 0.05) { best = k; bestS = s; }
  }
  return best;
}
function wrapLines(x, text, maxW) {
  const fits = (s) => x.measureText(s).width <= maxW;
  const out = [];
  for (const para of String(text).replace(/\r/g, '').split('\n')) {
    let line = '';
    for (const word of para.match(/\S+\s*|\s+/g) || ['']) {
      if (fits(line + word)) { line += word; continue; }
      if (line.trim()) { out.push(line.trimEnd()); line = ''; }
      for (const ch of word.trimStart()) { // a word wider than the box breaks between letters
        if (line && !fits(line + ch)) { out.push(line.trimEnd()); line = ''; }
        line += ch;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}
// the picture with its memo drawn in, the way the viewer shows it
export async function burnMemo(blob, text, pos) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const W = img.naturalWidth, H = img.naturalHeight;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, W, H);
    const s = Math.min(W, H), fs = MEMO.fs * s, px = MEMO.padX * fs, py = MEMO.padY * fs, m = MEMO.edge * s;
    try { await document.fonts.load(`700 ${Math.round(fs)}px Pretendard`, text); } catch (e) { /* the system font then */ }
    x.font = `700 ${fs}px ${MEMO.font}`;
    const lines = wrapLines(x, text, W * MEMO.maxW - 2 * px);
    const bw = Math.max(...lines.map((l) => x.measureText(l).width)) + 2 * px, bh = lines.length * MEMO.lh * fs + 2 * py;
    const bx = pos[1] === 'l' ? m : W - m - bw, by = pos[0] === 't' ? m : H - m - bh;
    x.fillStyle = MEMO.bg;
    x.beginPath();
    if (x.roundRect) x.roundRect(bx, by, bw, bh, MEMO.r * fs); else x.rect(bx, by, bw, bh);
    x.fill();
    x.fillStyle = '#fff';
    x.textBaseline = 'middle';
    lines.forEach((l, i) => x.fillText(l, bx + px, by + py + MEMO.lh * fs * (i + 0.5)));
    const out = await canvasBlob(c, 'image/jpeg', 0.92);
    c.width = c.height = 1;
    return out || blob;
  } finally { URL.revokeObjectURL(url); }
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

export async function shareOrDownload(blob, name, lastModified) {
  name = String(name).normalize('NFC');
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream', ...(lastModified ? { lastModified } : {}) });
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
