// 사진대지 (photo sheet for reports): A4 pages drawn on a canvas — a title, the photos and a caption table
// filled from the app's own records (일시·위치·부재·내용) — saved as a PDF of page images.
// No AI is needed: the records already say where and what. Nothing leaves the phone.
import { canvasBlob } from './util.js';

const PW = 1240, PH = 1754, M = 70, TOP = 190; // A4 at 150 dpi
const FONT = "Pretendard, -apple-system, 'Apple SD Gothic Neo', sans-serif";
const loadImage = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });

function wrap(x, text, maxW, maxLines) {
  const out = [];
  let line = '';
  for (const ch of String(text || '')) {
    if (ch === '\n') { out.push(line); line = ''; continue; }
    if (line && x.measureText(line + ch).width > maxW) { out.push(line); line = ch.trim() ? ch : ''; } else line += ch;
  }
  out.push(line);
  if (out.length > maxLines) { out.length = maxLines; out[maxLines - 1] = out[maxLines - 1].replace(/.$/, '…'); }
  return out;
}

function table(x, X, Y, W, H, rows) {
  const rh = H / rows.length, lw = 120;
  x.lineWidth = 2;
  x.strokeStyle = '#111';
  rows.forEach(([k, v], i) => {
    const y = Y + i * rh;
    x.fillStyle = '#f2f2ef';
    x.fillRect(X, y, lw, rh);
    x.fillStyle = '#111';
    x.font = `700 22px ${FONT}`;
    x.textBaseline = 'middle';
    x.fillText(k, X + 18, y + rh / 2);
    x.font = `500 23px ${FONT}`;
    const lines = wrap(x, v, W - lw - 32, Math.max(1, Math.floor((rh - 10) / 30)));
    lines.forEach((l, j) => x.fillText(l, X + lw + 16, y + rh / 2 + (j - (lines.length - 1) / 2) * 30));
    x.strokeRect(X, y, W, rh);
    x.beginPath(); x.moveTo(X + lw, y); x.lineTo(X + lw, y + rh); x.stroke();
  });
}

async function photo(x, blob, X, Y, W, H) {
  x.fillStyle = '#f2f2ef';
  x.fillRect(X, Y, W, H);
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const k = Math.min(W / img.naturalWidth, H / img.naturalHeight);
    const w = img.naturalWidth * k, h = img.naturalHeight * k;
    x.drawImage(img, X + (W - w) / 2, Y + (H - h) / 2, w, h);
  } catch (e) {
    x.fillStyle = '#5a5a57'; x.font = `500 24px ${FONT}`; x.fillText('사진을 읽지 못했어요', X + 24, Y + 40);
  } finally { URL.revokeObjectURL(url); }
  x.lineWidth = 2; x.strokeStyle = '#111'; x.strokeRect(X, Y, W, H);
}

// entries: [{ blob, rows: [[label, value] × 4] }]
export async function photoSheetPdf(entries, { title = '공사 사진대지', perPage = 2, onProgress = null } = {}) {
  try { await Promise.all(['500 23px', '700 22px', '800 40px'].map((f) => document.fonts.load(`${f} Pretendard`))); } catch (e) { /* system font then */ }
  const total = Math.max(1, Math.ceil(entries.length / perPage)), W = PW - 2 * M, slotH = (PH - M - TOP) / perPage;
  const pages = [];
  for (let p = 0; p < total; p++) {
    const c = document.createElement('canvas');
    c.width = PW; c.height = PH;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, PW, PH);
    x.fillStyle = '#111'; x.textBaseline = 'alphabetic';
    x.font = `800 40px ${FONT}`;
    x.fillText(title, M, M + 50);
    x.font = `500 22px ${FONT}`;
    const pg = `${p + 1} / ${total}`;
    x.fillText(pg, PW - M - x.measureText(pg).width, M + 50);
    x.fillRect(M, M + 76, W, 3);
    for (let i = 0; i < perPage; i++) {
      const e = entries[p * perPage + i];
      if (!e) break;
      const y = TOP + i * slotH, h = slotH - 28;
      if (perPage === 2) { // photo on top, the table under it
        const th = 4 * 46;
        await photo(x, e.blob, M, y, W, h - th);
        table(x, M, y + h - th, W, th, e.rows);
      } else { // photo on the left, the table on the right
        const pw = 640;
        await photo(x, e.blob, M, y, pw, h);
        table(x, M + pw + 20, y, W - pw - 20, h, e.rows);
      }
    }
    pages.push(new Uint8Array(await (await canvasBlob(c, 'image/jpeg', 0.88)).arrayBuffer()));
    c.width = c.height = 1;
    if (onProgress) onProgress(p + 1, total);
  }
  return pdfOfJpegs(pages, PW, PH);
}

// a minimal PDF: one A4 page per JPEG
export function pdfOfJpegs(jpgs, w, h) {
  const enc = new TextEncoder(), parts = [], offs = [];
  let len = 0;
  const push = (s) => { const b = typeof s === 'string' ? enc.encode(s) : s; parts.push(b); len += b.length; };
  const obj = (n, ...body) => { offs[n] = len; push(`${n} 0 obj\n`); body.forEach(push); push('\nendobj\n'); };
  const A4W = 595.28, A4H = 841.89, n = jpgs.length, size = 3 + n * 3;
  push('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${jpgs.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${n} >>`);
  jpgs.forEach((j, i) => {
    const p = 3 + i * 3, cs = `q ${A4W} 0 0 ${A4H} 0 0 cm /Im0 Do Q`;
    obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4W} ${A4H}] /Resources << /XObject << /Im0 ${p + 2} 0 R >> >> /Contents ${p + 1} 0 R >>`);
    obj(p + 1, `<< /Length ${cs.length} >>\nstream\n`, cs, '\nendstream');
    obj(p + 2, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${j.length} >>\nstream\n`, j, '\nendstream');
  });
  const xref = len;
  let t = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let k = 1; k < size; k++) t += String(offs[k]).padStart(10, '0') + ' 00000 n \n';
  push(`${t}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
