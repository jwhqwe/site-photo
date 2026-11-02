// Document scan, like a scanner app: find the paper, let its corners be adjusted, flatten it to a rectangle
// and clean up the page (white paper, dark text, shadows evened out). Everything runs on the phone.
import { el, canvasBlob, thumbFrom } from './util.js';

const DEFAULT_QUAD = [[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92]];
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Finding the paper, two ways, the better one wins:
//  A. how different each pixel is from the desk (the median colour of the picture's outer ring) — paper on any desk;
//  B. plain brightness — white paper on a darker desk.
// Each: Otsu threshold → holes closed → largest patch → four extreme points → each side refitted to the patch's edge.
// Scored by how well the patch fills its quadrilateral (a sheet of paper fills it almost exactly).
function otsu(v) {
  const hist = new Uint32Array(256), n = v.length;
  for (let i = 0; i < n; i++) hist[v[i]]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sB = 0, wB = 0, best = -1, th = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sB += t * hist[t];
    const s = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
    if (s > best) { best = s; th = t; }
  }
  return th;
}
const polyArea = (q) => Math.abs(q.reduce((s, p, i) => { const r = q[(i + 1) % 4]; return s + p[0] * r[1] - r[0] * p[1]; }, 0)) / 2;
function quadOf(v, w, h) {
  const n = w * h, th = otsu(v);
  let m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = v[i] > th ? 1 : 0;
  const morph = (src, keep) => { // 3×3 dilate (keep = 1) or erode (keep = 0)
    const out = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let hit = keep ? 0 : 1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        const s = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : src[yy * w + xx];
        if (keep && s) hit = 1; else if (!keep && !s) hit = 0;
      }
      out[y * w + x] = hit;
    }
    return out;
  };
  m = morph(morph(m, 1), 0); // text and lines on the page no longer split it
  const lab = new Int32Array(n).fill(-1), stack = new Int32Array(n);
  let comp = 0, bestC = -1, bestN = 0;
  for (let s = 0; s < n; s++) {
    if (!m[s] || lab[s] !== -1) continue;
    let top = 0, cnt = 0;
    stack[top++] = s; lab[s] = comp;
    while (top) {
      const p = stack[--top], x = p % w;
      cnt++;
      if (x > 0 && m[p - 1] && lab[p - 1] === -1) { lab[p - 1] = comp; stack[top++] = p - 1; }
      if (x < w - 1 && m[p + 1] && lab[p + 1] === -1) { lab[p + 1] = comp; stack[top++] = p + 1; }
      if (p >= w && m[p - w] && lab[p - w] === -1) { lab[p - w] = comp; stack[top++] = p - w; }
      if (p < n - w && m[p + w] && lab[p + w] === -1) { lab[p + w] = comp; stack[top++] = p + w; }
    }
    if (cnt > bestN) { bestN = cnt; bestC = comp; }
    comp++;
  }
  if (bestN < n * 0.1 || bestN > n * 0.95) return null;
  let tl = [0, 0, Infinity], tr = [0, 0, -Infinity], br = [0, 0, -Infinity], bl = [0, 0, Infinity];
  const edge = [];
  for (let p = 0; p < n; p++) {
    if (lab[p] !== bestC) continue;
    const x = p % w, y = (p / w) | 0, a = x + y, b = x - y;
    if (a < tl[2]) tl = [x, y, a];
    if (a > br[2]) br = [x, y, a];
    if (b > tr[2]) tr = [x, y, b];
    if (b < bl[2]) bl = [x, y, b];
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || lab[p - 1] !== bestC || lab[p + 1] !== bestC || lab[p - w] !== bestC || lab[p + w] !== bestC) edge.push([x, y]);
  }
  let q = [tl, tr, br, bl].map(([x, y]) => [x, y]);
  // each side refitted to the edge points near it, corners where the sides meet
  const lines = [];
  for (let k = 0; k < 4; k++) {
    const a = q[k], b = q[(k + 1) % 4], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 4) { lines.length = 0; break; }
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    const pts = edge.filter(([x, y]) => { const t = ((x - a[0]) * ux + (y - a[1]) * uy) / L, d = Math.abs((x - a[0]) * uy - (y - a[1]) * ux); return t > 0.12 && t < 0.88 && d < Math.max(2, L * 0.06); });
    if (pts.length < 6) { lines.length = 0; break; }
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length, my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    lines.push([mx, my, Math.cos(ang), Math.sin(ang)]);
  }
  if (lines.length === 4) {
    const meet = (l1, l2) => { const den = l1[2] * l2[3] - l1[3] * l2[2]; if (Math.abs(den) < 1e-6) return null; const t = ((l2[0] - l1[0]) * l2[3] - (l2[1] - l1[1]) * l2[2]) / den; return [l1[0] + t * l1[2], l1[1] + t * l1[3]]; };
    const r = [meet(lines[3], lines[0]), meet(lines[0], lines[1]), meet(lines[1], lines[2]), meet(lines[2], lines[3])];
    if (r.every((p, i) => p && Math.hypot(p[0] - q[i][0], p[1] - q[i][1]) < Math.min(w, h) * 0.15)) q = r;
  }
  const score = bestN / Math.max(1, polyArea(q));
  return { q: q.map(([x, y]) => [Math.min(1, Math.max(0, (x + 0.5) / w)), Math.min(1, Math.max(0, (y + 0.5) / h))]), score: Math.min(score, 2 - score) };
}
export function findPaper(d, w, h) {
  const n = w * h, bw = Math.max(2, Math.round(Math.min(w, h) * 0.05));
  const ring = [[], [], []];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= bw && y >= bw && x < w - bw && y < h - bw) continue;
    const i = (y * w + x) * 4;
    ring[0].push(d[i]); ring[1].push(d[i + 1]); ring[2].push(d[i + 2]);
  }
  const bg = ring.map((a) => a.sort((p, q) => p - q)[a.length >> 1]), bgL = (bg[0] * 3 + bg[1] * 6 + bg[2]) / 10;
  const dist = new Uint8Array(n), lum = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = d[4 * i], g = d[4 * i + 1], b = d[4 * i + 2], l = (r * 3 + g * 6 + b) / 10;
    lum[i] = l;
    dist[i] = Math.min(255, (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2])) * 0.5 + Math.max(0, l - bgL) * 0.8);
  }
  const c = [quadOf(dist, w, h), quadOf(lum, w, h)].filter((x) => x && x.score > 0.8).sort((a, b) => b.score - a.score);
  return c.length ? c[0].q : null;
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
  const r = pageAspect(q, src.width, src.height);
  if (r) { const long = Math.max(W, H); if (r >= 1) { W = long; H = long / r; } else { H = long; W = long * r; } }
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

// a scanned look: the paper's own brightness is found (bright envelope over blocks, spread wide enough to step over
// text and table lines, then smoothed) and divided out, so shadows and uneven light go; strokes are sharpened; then
// levels: the paper becomes pure white, ink near black (curve keeps thin strokes dark). 'color' keeps stamps and
// marks in colour on white paper, 'gray' gives a black-and-white scan.
export function enhance(c, mode = 'color') {
  if (mode === 'none') return c;
  const W = c.width, H = c.height, x = c.getContext('2d'), im = x.getImageData(0, 0, W, H), d = im.data, N = W * H;
  const L = new Float32Array(N);
  for (let i = 0, o = 0; i < N; i++, o += 4) L[i] = (d[o] * 3 + d[o + 1] * 6 + d[o + 2]) / 10;
  const B = Math.max(8, Math.round(Math.max(W, H) / 90)), bw = Math.ceil(W / B), bh = Math.ceil(H / B);
  let g = new Float32Array(bw * bh);
  for (let y = 0; y + 1 < H; y += 2) for (let i = 0; i + 1 < W; i += 2) { // brightest 2×2 average in each block
    const p = y * W + i, v = (L[p] + L[p + 1] + L[p + W] + L[p + W + 1]) / 4, k = ((y / B) | 0) * bw + ((i / B) | 0);
    if (v > g[k]) g[k] = v;
  }
  const pass = (src, r, fn) => {
    const out = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let a = fn === 'max' ? 0 : 0, n = 0;
      for (let yy = Math.max(0, by - r); yy <= Math.min(bh - 1, by + r); yy++) for (let xx = Math.max(0, bx - r); xx <= Math.min(bw - 1, bx + r); xx++) {
        const v = src[yy * bw + xx];
        if (fn === 'max') { if (v > a) a = v; } else { a += v; n++; }
      }
      out[by * bw + bx] = fn === 'max' ? a : a / n;
    }
    return out;
  };
  g = pass(pass(pass(g, 2, 'max'), 1, 'mean'), 1, 'mean');
  const bg = (i, y) => {
    const gx = i / B - 0.5, gy = y / B - 0.5, x0 = Math.max(0, Math.min(bw - 1, Math.floor(gx))), y0 = Math.max(0, Math.min(bh - 1, Math.floor(gy)));
    const x1 = Math.min(bw - 1, x0 + 1), y1 = Math.min(bh - 1, y0 + 1), fx = Math.max(0, Math.min(1, gx - x0)), fy = Math.max(0, Math.min(1, gy - y0));
    return Math.max(40, (g[y0 * bw + x0] * (1 - fx) + g[y0 * bw + x1] * fx) * (1 - fy) + (g[y1 * bw + x0] * (1 - fx) + g[y1 * bw + x1] * fx) * fy);
  };
  const G = new Float32Array(N); // background per pixel
  for (let y = 0, p = 0; y < H; y++) for (let i = 0; i < W; i++, p++) { G[p] = bg(i, y); L[p] /= G[p]; }
  // sharpen: n + 0.8 (n − 3×3 mean)
  const S = new Float32Array(N);
  for (let y = 0, p = 0; y < H; y++) for (let i = 0; i < W; i++, p++) {
    if (y === 0 || i === 0 || y === H - 1 || i === W - 1) { S[p] = 0; continue; }
    const m = (L[p - W - 1] + L[p - W] + L[p - W + 1] + L[p - 1] + L[p] + L[p + 1] + L[p + W - 1] + L[p + W] + L[p + W + 1]) / 9;
    S[p] = 0.8 * (L[p] - m);
  }
  // levels from the page itself: paper = the middle of the histogram, ink = its darkest half percent
  const hist = new Uint32Array(256);
  for (let p = 0; p < N; p += 3) hist[Math.max(0, Math.min(255, Math.round(L[p] * 170)))]++;
  const tot = hist.reduce((a, b) => a + b, 0), pct = (q) => { let s = 0; for (let k = 0; k < 256; k++) { s += hist[k]; if (s >= tot * q) return k / 170; } return 1.5; };
  const w = Math.min(0.93, pct(0.5) * 0.9), b = Math.min(pct(0.005), w - 0.35), span = w - b, gam = 1.35;
  const lv = (v) => { const t = (v - b) / span; return t <= 0 ? 0 : t >= 1 ? 255 : 255 * Math.pow(t, gam); };
  for (let p = 0, o = 0; p < N; p++, o += 4) {
    if (mode === 'gray') { const v = lv(L[p] + S[p]); d[o] = d[o + 1] = d[o + 2] = v; continue; }
    const k = 1 / G[p], s = S[p];
    d[o] = lv(d[o] * k + s); d[o + 1] = lv(d[o + 1] * k + s); d[o + 2] = lv(d[o + 2] * k + s);
  }
  x.putImageData(im, 0, 0);
  return c;
}

// the page's real shape from the four corners (Zhang & He, whiteboard scanning): the focal length is solved from the
// corners when they allow it, else the phone's main camera is assumed. Close to A-paper or Letter → snapped to it.
export function pageAspect(q, imgW, imgH) {
  const L = Math.max(imgW, imgH), u0 = imgW / 2, v0 = imgH / 2;
  const P = q.map(([px, py]) => [px - u0, py - v0, 1]); // tl, tr, br, bl
  const m1 = P[0], m2 = P[1], m3 = P[3], m4 = P[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c14 = cross(m1, m4), k2 = dot(c14, m3) / dot(cross(m2, m4), m3), k3 = dot(c14, m2) / dot(cross(m3, m4), m2);
  const n2 = m2.map((v, i) => k2 * v - m1[i]), n3 = m3.map((v, i) => k3 * v - m1[i]);
  let f2 = Math.abs(n2[2] * n3[2]) > 1e-9 ? -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]) : -1;
  if (!(f2 > (0.45 * L) ** 2 && f2 < (3 * L) ** 2)) f2 = (0.75 * L) ** 2;
  const len = (n) => n[0] * n[0] / f2 + n[1] * n[1] / f2 + n[2] * n[2];
  let r = Math.sqrt(len(n2) / len(n3)); // width / height
  if (!Number.isFinite(r) || r <= 0) return null;
  for (const s of [Math.SQRT2, 11 / 8.5]) for (const t of [s, 1 / s]) if (Math.abs(r / t - 1) < 0.045) r = t;
  return r;
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

// the scan screen: corners to drag, 컬러 스캔 / 흑백 스캔 / 원본, 다시 찍기 / 저장. Resolves to the page or null.
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
    let clean = 'color', drag = -1, fit = { x: 0, y: 0, s: 1 };
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    const poly = document.createElementNS(NS, 'polygon');
    const dots = q.map(() => { const c = document.createElementNS(NS, 'circle'); c.setAttribute('r', '13'); return c; });
    svg.append(poly, ...dots);
    const view = document.createElement('canvas');
    const stage = el('div', { class: 'scan-stage' }, view, svg);
    const hint = el('p', { class: 'scan-hint' }, found ? '종이를 찾았어요. 모서리가 어긋나면 동그라미를 끌어서 맞춰 주세요.' : '동그라미 4개를 종이 네 귀퉁이에 끌어다 맞춰 주세요.');
    const seg = [['컬러 스캔', 'color'], ['흑백 스캔', 'gray'], ['원본', 'none']].map(([l, v]) => el('button', {
      'aria-pressed': String(clean === v),
      onclick: () => { clean = v; seg.forEach((b, i) => b.setAttribute('aria-pressed', String(['color', 'gray', 'none'][i] === clean))); },
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
        enhance(out, clean);
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
