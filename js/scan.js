// Document scan, like a scanner app: find the paper, let its corners be adjusted, flatten it to a rectangle
// and clean up the page (white paper, dark text, shadows evened out). Everything runs on the phone.
import { el, canvasBlob, thumbFrom } from './util.js';

const DEFAULT_QUAD = [[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92]];
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// the paper: the largest bright patch of a small copy (Otsu threshold), its four extreme points
export function findPaper(d, w, h) {
  const n = w * h, g = new Uint8Array(n), hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) { const v = ((d[4 * i] * 3 + d[4 * i + 1] * 6 + d[4 * i + 2]) / 10) | 0; g[i] = v; hist[v]++; }
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sB = 0, wB = 0, best = -1, th = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sB += t * hist[t];
    const v = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
    if (v > best) { best = v; th = t; }
  }
  const lab = new Int32Array(n).fill(-1), stack = new Int32Array(n);
  let comp = 0, bestC = -1, bestN = 0;
  for (let s = 0; s < n; s++) {
    if (g[s] <= th || lab[s] !== -1) continue;
    let top = 0, cnt = 0;
    stack[top++] = s; lab[s] = comp;
    while (top) {
      const p = stack[--top], x = p % w;
      cnt++;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
      for (const q of nb) if (q >= 0 && q < n && g[q] > th && lab[q] === -1) { lab[q] = comp; stack[top++] = q; }
    }
    if (cnt > bestN) { bestN = cnt; bestC = comp; }
    comp++;
  }
  if (bestN < n * 0.12 || bestN > n * 0.97) return null;
  let tl = [0, 0, Infinity], tr = [0, 0, -Infinity], br = [0, 0, -Infinity], bl = [0, 0, Infinity];
  for (let p = 0; p < n; p++) {
    if (lab[p] !== bestC) continue;
    const x = p % w, y = (p / w) | 0, a = x + y, b = x - y;
    if (a < tl[2]) tl = [x, y, a];
    if (a > br[2]) br = [x, y, a];
    if (b > tr[2]) tr = [x, y, b];
    if (b < bl[2]) bl = [x, y, b];
  }
  return [tl, tr, br, bl].map(([x, y]) => [(x + 0.5) / w, (y + 0.5) / h]);
}

// corners in reading order (top left, top right, bottom right, bottom left), whatever order they were dragged into
export function orderQuad(q) {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const byAngle = [...q].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let k = 0;
  byAngle.forEach((p, i) => { if (p[0] + p[1] < byAngle[k][0] + byAngle[k][1]) k = i; });
  return [0, 1, 2, 3].map((i) => byAngle[(k + i) % 4]);
}

// the paper flattened: each output pixel is looked up in the photo through the square-to-quad mapping
export function warp(src, q, maxSide = 2600) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  let W = Math.max(dist(x0, y0, x1, y1), dist(x3, y3, x2, y2)), H = Math.max(dist(x0, y0, x3, y3), dist(x1, y1, x2, y2));
  const k = Math.min(1, maxSide / Math.max(W, H));
  W = Math.max(8, Math.round(W * k)); H = Math.max(8, Math.round(H * k));
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const G = (sx * dy2 - dx2 * sy) / den, Hh = (dx1 * sy - sx * dy1) / den;
  const A = x1 - x0 + G * x1, B = x3 - x0 + Hh * x3, D = y1 - y0 + G * y1, E = y3 - y0 + Hh * y3;
  const sw = src.width, sh = src.height, sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
  const out = new ImageData(W, H), od = out.data;
  let o = 0;
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H;
    for (let i = 0; i < W; i++, o += 4) {
      const u = (i + 0.5) / W, z = G * u + Hh * v + 1;
      const x = (A * u + B * v + x0) / z - 0.5, y = (D * u + E * v + y0) / z - 0.5;
      const xi = Math.max(0, Math.min(sw - 2, Math.floor(x))), yi = Math.max(0, Math.min(sh - 2, Math.floor(y)));
      const fx = clamp01(x - xi), fy = clamp01(y - yi);
      const a = (yi * sw + xi) * 4, b = a + 4, c = a + sw * 4, e = c + 4;
      for (let ch = 0; ch < 3; ch++) {
        od[o + ch] = (sd[a + ch] * (1 - fx) + sd[b + ch] * fx) * (1 - fy) + (sd[c + ch] * (1 - fx) + sd[e + ch] * fx) * fy;
      }
      od[o + 3] = 255;
    }
  }
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.getContext('2d').putImageData(out, 0, 0);
  return c;
}

// a clean page: the paper's own brightness is measured in blocks and divided out (shadows go), then contrast
export function enhance(c) {
  const W = c.width, H = c.height, x = c.getContext('2d'), im = x.getImageData(0, 0, W, H), d = im.data;
  const S = 40, bw = Math.ceil(W / S), bh = Math.ceil(H / S), bg = new Float32Array(bw * bh);
  for (let y = 0; y < H; y++) {
    const row = ((y / S) | 0) * bw;
    for (let i = 0, o = y * W * 4; i < W; i++, o += 4) {
      const l = (d[o] * 3 + d[o + 1] * 6 + d[o + 2]) / 10, k = row + ((i / S) | 0);
      if (l > bg[k]) bg[k] = l;
    }
  }
  const sm = new Float32Array(bw * bh); // 3×3 mean, so the page has no block seams
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let s = 0, n = 0;
    for (let yy = Math.max(0, by - 1); yy <= Math.min(bh - 1, by + 1); yy++) for (let xx = Math.max(0, bx - 1); xx <= Math.min(bw - 1, bx + 1); xx++) { s += bg[yy * bw + xx]; n++; }
    sm[by * bw + bx] = s / n;
  }
  const at = (bx, by) => sm[Math.max(0, Math.min(bh - 1, by)) * bw + Math.max(0, Math.min(bw - 1, bx))];
  for (let y = 0, o = 0; y < H; y++) {
    const gy = y / S - 0.5, y0 = Math.floor(gy), fy = gy - y0;
    for (let i = 0; i < W; i++, o += 4) {
      const gx = i / S - 0.5, x0 = Math.floor(gx), fx = gx - x0;
      const b = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
      const gain = 255 / Math.max(70, b);
      for (let ch = 0; ch < 3; ch++) d[o + ch] = (d[o + ch] * gain - 40) * 1.22;
    }
  }
  x.putImageData(im, 0, 0);
  return c;
}

// a photo file as a canvas (kept under 12 MP, the iPhone's canvas limit is near 16 MP)
export async function canvasFromBlob(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, Math.sqrt(12e6 / (img.naturalWidth * img.naturalHeight)));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}

// the scan screen: corners to drag, 선명하게 / 컬러 그대로, 다시 찍기 / 저장. Resolves to the page or null.
export function openScan(src) {
  return new Promise((resolve) => {
    const W = src.width, H = src.height;
    const k = 320 / Math.max(W, H), sw = Math.max(8, Math.round(W * k)), sh = Math.max(8, Math.round(H * k));
    const small = document.createElement('canvas');
    small.width = sw; small.height = sh;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(src, 0, 0, sw, sh);
    const found = findPaper(sctx.getImageData(0, 0, sw, sh).data, sw, sh);
    let q = (found || DEFAULT_QUAD).map((p) => [...p]);
    let clean = true, drag = -1, fit = { x: 0, y: 0, s: 1 };
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    const poly = document.createElementNS(NS, 'polygon');
    const dots = q.map(() => { const c = document.createElementNS(NS, 'circle'); c.setAttribute('r', '13'); return c; });
    svg.append(poly, ...dots);
    const view = document.createElement('canvas');
    const stage = el('div', { class: 'scan-stage' }, view, svg);
    const hint = el('p', { class: 'scan-hint' }, found ? '종이를 찾았어요. 모서리가 어긋나면 동그라미를 끌어서 맞춰 주세요.' : '동그라미 4개를 종이 네 귀퉁이에 끌어다 맞춰 주세요.');
    const seg = [['선명하게', true], ['컬러 그대로', false]].map(([l, v]) => el('button', {
      'aria-pressed': String(clean === v),
      onclick: () => { clean = v; seg.forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0) === clean))); },
    }, l));
    const save = el('button', { class: 'btn primary', onclick: () => run() }, '저장 →');
    const box = el('div', { class: 'overlay scan' },
      el('div', { class: 'v-top' },
        el('button', { class: 'icon-btn', 'aria-label': '닫기', onclick: () => done(null) }, '✕'),
        el('div', { class: 'v-title' }, '문서 스캔'), el('span', { class: 'v-gap' })),
      stage, hint,
      el('div', { class: 'scan-bottom' }, el('div', { class: 'seg' }, ...seg),
        el('button', { class: 'btn', onclick: () => done(null) }, '다시 찍기'), save));
    const pt = (p) => [fit.x + p[0] * W * fit.s, fit.y + p[1] * H * fit.s];
    const draw = () => {
      const P = q.map(pt);
      poly.setAttribute('points', P.map((p) => p.join(',')).join(' '));
      P.forEach((p, i) => { dots[i].setAttribute('cx', p[0]); dots[i].setAttribute('cy', p[1]); });
    };
    const layout = () => {
      const r = stage.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      const s = Math.min(r.width / W, r.height / H);
      fit = { x: (r.width - W * s) / 2, y: (r.height - H * s) / 2, s };
      view.width = Math.max(1, Math.round(W * s * dpr)); view.height = Math.max(1, Math.round(H * s * dpr));
      Object.assign(view.style, { left: fit.x + 'px', top: fit.y + 'px', width: W * s + 'px', height: H * s + 'px' });
      view.getContext('2d').drawImage(src, 0, 0, view.width, view.height);
      draw();
    };
    stage.addEventListener('pointerdown', (e) => {
      const r = stage.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      let bd = 48;
      drag = -1;
      q.forEach((p, i) => { const [px, py] = pt(p), dd = Math.hypot(px - x, py - y); if (dd < bd) { bd = dd; drag = i; } });
      if (drag < 0) return;
      e.preventDefault();
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* fine without */ }
    });
    stage.addEventListener('pointermove', (e) => {
      if (drag < 0) return;
      const r = stage.getBoundingClientRect();
      q[drag] = [clamp01((e.clientX - r.left - fit.x) / (W * fit.s)), clamp01((e.clientY - r.top - fit.y) / (H * fit.s))];
      draw();
    });
    const up = () => { drag = -1; };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    const onResize = () => layout();
    const done = (v) => { window.removeEventListener('resize', onResize); box.remove(); resolve(v); };
    const run = async () => {
      save.disabled = true;
      save.textContent = '펴는 중…';
      await new Promise((r) => setTimeout(r, 40));
      try {
        const out = warp(src, orderQuad(q).map(([x, y]) => [x * W, y * H]));
        if (clean) enhance(out);
        const blob = await canvasBlob(out, 'image/jpeg', 0.9);
        const thumb = await thumbFrom(out, out.width, out.height);
        const res = { blob, thumb, w: out.width, h: out.height, mime: 'image/jpeg' };
        out.width = out.height = 1;
        done(res);
      } catch (e) {
        save.disabled = false;
        save.textContent = '저장 →';
        hint.textContent = '펴지 못했어요. 모서리를 다시 맞춰 주세요.';
      }
    };
    document.body.append(box);
    window.addEventListener('resize', onResize);
    requestAnimationFrame(layout);
  });
}
