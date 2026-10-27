// The drawing view: base picture + sharp layer redrawn from the vector PDF when zoomed + SVG overlay.
// One instance is shared by every screen (mount() moves it), so the big picture is decoded only once.
import { el } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
export const ptsAttr = (pts) => pts.map((q) => q[0].toFixed(2) + ',' + q[1].toFixed(2)).join(' ');
export function fanPath(p, th, half, r) {
  const a = th - half, b = th + half;
  const x1 = p[0] + r * Math.cos(a), y1 = p[1] + r * Math.sin(a), x2 = p[0] + r * Math.cos(b), y2 = p[1] + r * Math.sin(b);
  return `M${p[0]},${p[1]} L${x1},${y1} A${r},${r} 0 ${half * 2 > Math.PI ? 1 : 0} 1 ${x2},${y2} Z`;
}
function inPoly(p, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) c = !c;
  }
  return c;
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
export function polyDist(p, pts) {
  if (inPoly(p, pts)) return 0;
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) d = Math.min(d, segDist(p, pts[i], pts[(i + 1) % pts.length]));
  return d;
}
export function centroid(pts) {
  let x = 0, y = 0;
  for (const q of pts) { x += q[0]; y += q[1]; }
  return [x / pts.length, y / pts.length];
}

let pdfLibPromise = null;
function loadPdfLib() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfLibPromise) return pdfLibPromise;
  const add = (src) => new Promise((res, rej) => { const s = el('script', { src }); s.onload = res; s.onerror = rej; document.head.append(s); });
  pdfLibPromise = add('vendor/pdf.worker.min.js').then(() => add('vendor/pdf.min.js')).then(() => window.pdfjsLib);
  return pdfLibPromise;
}

export class PlanView {
  constructor(getPdfBlob) {
    this.getPdfBlob = getPdfBlob;
    this.stage = el('div', { class: 'plan-stage' });
    this.world = el('div', { class: 'plan-world' });
    this.img = el('img', { class: 'plan-img', alt: '도면', draggable: 'false' });
    this.hiA = el('canvas', { class: 'plan-hi' });
    this.hiB = el('canvas', { class: 'plan-hi' });
    this.roomsImg = el('img', { class: 'plan-rooms', alt: '', draggable: 'false', hidden: true });
    this.ov = svg('svg', { class: 'plan-ov' });
    this.gStatic = svg('g', {}, this.ov);
    this.gDyn = svg('g', {}, this.ov);
    this.world.append(this.img, this.hiA, this.hiB, this.roomsImg, this.ov);
    const zoom = el('div', { class: 'plan-zoom' },
      el('button', { 'aria-label': '확대', onclick: () => this.zoomCenter(1.6) }, '+'),
      el('button', { 'aria-label': '축소', onclick: () => this.zoomCenter(1 / 1.6) }, '−'),
      el('button', { 'aria-label': '전체 보기', onclick: () => this.fit() }, '⤢'));
    zoom.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.loupe = el('div', { class: 'plan-loupe' }, el('canvas'), el('i'));
    this.msg = el('div', { class: 'plan-msg', hidden: true }, '도면 그림을 읽지 못했어요.\n더보기 → 도면 파일 가져오기로 도면 파일을 다시 넣어 주세요.');
    this.stage.append(this.world, zoom, this.loupe, this.msg);
    this.stage.addEventListener('contextmenu', (e) => e.preventDefault());
    this.view = { s: 1, tx: 0, ty: 0, fit: 1 };
    this.floor = null;
    this.onTap = null;
    this.drawStatic = null;
    this.drawDynamic = null;
    // press hooks (a screen sets them): onPress(p) -> {mode:'grab', offset} | {mode:'hold'} | null,
    // onHold(p) -> true to start dragging, onDragStart(), onDrag(p), onDragEnd(p)
    this.onPress = null;
    this.onHold = null;
    this.onDragStart = null;
    this.onDrag = null;
    this.onDragEnd = null;
    this.hi = { doc: null, page: null, pageKey: null, task: null, timer: 0, gen: 0, front: null };
    this.rowCache = new Map();
    this.bindGestures();
    this.ro = new ResizeObserver(() => { if (this.floor && this.stage.isConnected) this.fit(true); });
    this.ro.observe(this.stage);
  }

  mount(host) {
    if (this.stage.parentElement !== host) host.append(this.stage);
    requestAnimationFrame(() => this.apply());
  }

  async setFloor(floor, keepView) {
    if (this.floor && floor && this.floor.key === floor.key) { this.refresh(); return; }
    this.floor = floor;
    this.rowCache = new Map();
    this.hi.gen++;
    if (this.hi.task) { try { this.hi.task.cancel(); } catch (e) { /* ignore */ } this.hi.task = null; }
    this.hideHi();
    if (!floor) { this.img.removeAttribute('src'); this.msg.hidden = true; return; }
    const W = floor.imgW, H = floor.imgH;
    this.img.width = W; this.img.height = H;
    this.roomsImg.style.width = W + 'px'; this.roomsImg.style.height = H + 'px';
    this.ov.setAttribute('width', W); this.ov.setAttribute('height', H);
    this.ov.setAttribute('viewBox', `${floor.plan[0]} ${floor.plan[1]} ${W / floor.k} ${H / floor.k}`);
    if (this.imgUrl) URL.revokeObjectURL(this.imgUrl);
    if (this.roomsUrl) URL.revokeObjectURL(this.roomsUrl);
    this.imgUrl = URL.createObjectURL(floor.imgBlob);
    this.roomsUrl = floor.roomsBlob ? URL.createObjectURL(floor.roomsBlob) : '';
    await new Promise((res) => { this.img.onload = res; this.img.onerror = res; this.img.src = this.imgUrl; });
    // a picture that cannot be read would show the iPhone's blue "?" -- say what to do instead
    const readable = this.img.naturalWidth > 0;
    this.img.style.visibility = readable ? '' : 'hidden';
    this.msg.hidden = readable;
    if (this.roomsUrl) this.roomsImg.src = this.roomsUrl; else this.roomsImg.removeAttribute('src');
    if (!keepView) this.fit();
    this.refresh();
  }

  showRooms(on) { this.roomsImg.hidden = !on || !this.roomsUrl; }

  // ------------------------------------------------------------ view
  get P0X() { return this.floor.plan[0]; }
  get P0Y() { return this.floor.plan[1]; }
  get K() { return this.floor.k; }
  apply() {
    const v = this.view;
    this.world.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.s})`;
    this.redrawDynamic();
    this.scheduleHi();
  }
  fit(soft) {
    if (!this.floor) return;
    const r = this.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const W = this.floor.imgW, H = this.floor.imgH;
    const s = Math.min(r.width / W, r.height / H) * 0.98;
    const wasFit = Math.abs(this.view.s - this.view.fit) < 1e-6;
    this.view.fit = s;
    if (soft && !wasFit) { this.apply(); return; }
    this.view.s = s;
    this.view.tx = (r.width - W * s) / 2; this.view.ty = (r.height - H * s) / 2;
    this.apply();
  }
  clampS(s) { return Math.min(4, Math.max(this.view.fit * 0.7, s)); }
  zoomAt(cx, cy, f) {
    const v = this.view, ns = this.clampS(v.s * f), k = ns / v.s;
    v.tx = cx - (cx - v.tx) * k; v.ty = cy - (cy - v.ty) * k; v.s = ns; this.apply();
  }
  zoomCenter(f) { const r = this.stage.getBoundingClientRect(); this.zoomAt(r.width / 2, r.height / 2, f); }
  focus(p, s) {
    const r = this.stage.getBoundingClientRect();
    const v = this.view;
    v.s = this.clampS(s || Math.max(v.s, v.fit * 4));
    v.tx = r.width / 2 - (p[0] - this.P0X) * this.K * v.s;
    v.ty = r.height / 2 - (p[1] - this.P0Y) * this.K * v.s;
    this.apply();
  }
  getView() { return { ...this.view }; }
  setView(v) { Object.assign(this.view, v); this.apply(); }
  toPlan(clientX, clientY) {
    const r = this.stage.getBoundingClientRect();
    return [this.P0X + (clientX - r.left - this.view.tx) / this.view.s / this.K, this.P0Y + (clientY - r.top - this.view.ty) / this.view.s / this.K];
  }
  ptPerPx() { return 1 / (this.view.s * this.K); }

  bindGestures() {
    const ptrs = new Map();
    let g = null;
    const st = this.stage;
    const HOLD_MS = 180;
    const stopHold = () => { if (g && g.hold) { clearTimeout(g.hold); g.hold = 0; } };
    const dragTo = (cx, cy) => {
      const p = this.toPlan(cx, cy);
      const q = [p[0] + g.drag.off[0], p[1] + g.drag.off[1]];
      g.drag.last = q;
      if (this.onDrag) this.onDrag(q);
      this.showLoupe(q, cx, cy);
    };
    const endDrag = () => {
      if (!g || !g.drag) return;
      const last = g.drag.last;
      g.drag = null;
      this.hideLoupe();
      if (this.onDragEnd) this.onDragEnd(last);
    };
    st.addEventListener('pointerdown', (e) => {
      if (!this.floor) return;
      st.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 1) {
        g = { type: 'one', x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: performance.now(), tx0: this.view.tx, ty0: this.view.ty, moved: false, drag: null, grab: null, hold: 0 };
        const r = this.onPress ? this.onPress(this.toPlan(e.clientX, e.clientY), e) : null;
        if (r && r.mode === 'grab') g.grab = { off: r.offset || [0, 0] };
        else if (r && r.mode === 'hold') {
          const mine = g;
          g.hold = setTimeout(() => {
            if (g !== mine) return;
            g.hold = 0;
            if (g.moved || ptrs.size !== 1) return;
            const p = this.toPlan(g.x, g.y);
            if (this.onHold && this.onHold(p)) { g.drag = { off: [0, 0], last: p }; this.showLoupe(p, g.x, g.y); }
          }, HOLD_MS);
        }
      } else if (ptrs.size === 2) {
        stopHold();
        endDrag();
        const [a, b] = [...ptrs.values()];
        g = { type: 'two', d0: Math.hypot(a.x - b.x, a.y - b.y), s0: this.view.s, mx0: (a.x + b.x) / 2, my0: (a.y + b.y) / 2, tx0: this.view.tx, ty0: this.view.ty };
      }
    });
    st.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId) || !g) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const r = st.getBoundingClientRect();
      if (g.type === 'one' && ptrs.size === 1) {
        g.x = e.clientX; g.y = e.clientY;
        if (g.drag) { dragTo(e.clientX, e.clientY); return; }
        const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
        if (!g.moved && Math.hypot(dx, dy) > 8) {
          g.moved = true;
          stopHold();
          if (g.grab) {
            // the finger started on the pin: move the pin, not the drawing
            g.drag = { off: g.grab.off, last: null };
            if (this.onDragStart) this.onDragStart();
            dragTo(e.clientX, e.clientY);
            return;
          }
        }
        if (g.moved) { this.view.tx = g.tx0 + dx; this.view.ty = g.ty0 + dy; this.apply(); }
      } else if (g.type === 'two' && ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const ns = this.clampS(g.s0 * d / Math.max(1, g.d0));
        const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
        const wx = (g.mx0 - r.left - g.tx0) / g.s0, wy = (g.my0 - r.top - g.ty0) / g.s0;
        this.view.s = ns; this.view.tx = mx - wx * ns; this.view.ty = my - wy * ns; this.apply();
      }
    });
    const end = (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      stopHold();
      if (g && g.drag) {
        endDrag();
        g = null;
      } else if (g && g.type === 'one' && !g.moved && ptrs.size === 0 && performance.now() - g.t0 < 600 && this.onTap) {
        this.onTap(this.toPlan(e.clientX, e.clientY), e);
      }
      if (ptrs.size === 0) g = null;
      else if (ptrs.size === 1) { const [q] = [...ptrs.values()]; g = { type: 'one', x0: q.x, y0: q.y, x: q.x, y: q.y, t0: 0, tx0: this.view.tx, ty0: this.view.ty, moved: true, drag: null, grab: null, hold: 0 }; }
    };
    st.addEventListener('pointerup', end);
    st.addEventListener('pointercancel', end);
    st.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = st.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
  }

  // magnifier shown above the finger while a pin is dragged, so the spot under the finger stays visible
  showLoupe(p, cx, cy) {
    const f = this.floor;
    if (!f) return;
    const D = 128, mag = 2;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const box = this.loupe, c = box.firstChild;
    if (c.width !== Math.round(D * dpr)) { c.width = Math.round(D * dpr); c.height = Math.round(D * dpr); }
    const r = this.stage.getBoundingClientRect();
    let left = cx - r.left - D / 2, top = cy - r.top - D - 64;
    if (top < 4) top = Math.min(r.height - D - 4, cy - r.top + 64);
    left = Math.max(4, Math.min(r.width - D - 4, left));
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.display = 'block';
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    const ix = (p[0] - f.plan[0]) * f.k, iy = (p[1] - f.plan[1]) * f.k; // picture pixels
    const w = D / (this.view.s * mag);
    const hi = this.hi.front;
    let done = false;
    if (hi && hi.style.display === 'block') {
      const hx = parseFloat(hi.style.left), hy = parseFloat(hi.style.top), hw = parseFloat(hi.style.width);
      const k = hi.width / hw;
      const sx = (ix - w / 2 - hx) * k, sy = (iy - w / 2 - hy) * k, sw = w * k;
      if (sx >= 0 && sy >= 0 && sx + sw <= hi.width && sy + sw <= hi.height) { ctx.drawImage(hi, sx, sy, sw, sw, 0, 0, c.width, c.height); done = true; }
    }
    if (!done && this.img.complete && this.img.naturalWidth) {
      const sc = this.img.naturalWidth / f.imgW;
      ctx.drawImage(this.img, (ix - w / 2) * sc, (iy - w / 2) * sc, w * sc, w * sc, 0, 0, c.width, c.height);
    }
  }
  hideLoupe() { this.loupe.style.display = 'none'; }

  // ------------------------------------------------------------ overlay
  refresh() {
    this.gStatic.replaceChildren();
    if (this.floor && this.drawStatic) this.drawStatic(this.gStatic);
    this.redrawDynamic();
  }
  redrawDynamic() {
    this.gDyn.replaceChildren();
    if (this.floor && this.drawDynamic) this.drawDynamic(this.gDyn, this.ptPerPx());
  }

  // ------------------------------------------------------------ lookups
  hitMember(p) {
    if (!this.floor) return null;
    const tol = Math.max(0.45, 16 * this.ptPerPx());
    let best = null, bestScore = Infinity;
    for (const m of this.floor.members) {
      const d = polyDist(p, m.pts);
      if (d > tol) continue;
      const score = d - (m.type === '기둥' ? 0.35 : 0);
      if (score < bestScore) { bestScore = score; best = m; }
    }
    return best;
  }
  nearestSlab(p) {
    let best = null, bd = Infinity;
    for (const s of this.floor.slabs || []) { const d = Math.hypot(s.c[0] - p[0], s.c[1] - p[1]); if (d < bd) { bd = d; best = s; } }
    return bd < 30 ? best : null;
  }
  // room under a point; works for any floor record, cached rows only for the shown floor
  roomAt(p, fl = this.floor) {
    const RM = fl && fl.roomMap;
    if (!RM || !RM.rows || !RM.rows.length) return null;
    const x = Math.round((p[0] - fl.plan[0]) * RM.scale), y = Math.round((p[1] - fl.plan[1]) * RM.scale);
    if (x < 0 || y < 0 || x >= RM.w || y >= RM.h) return null;
    const cache = fl === this.floor ? this.rowCache : null;
    let row = cache && cache.get(y);
    if (!row) {
      const runs = RM.rows[y];
      row = new Uint16Array(RM.w);
      let xx = 0;
      for (let i = 0; i < runs.length; i += 2) { row.fill(runs[i], xx, xx + runs[i + 1]); xx += runs[i + 1]; }
      if (cache) cache.set(y, row);
    }
    const v = row[x];
    return v ? fl.rooms[v - 1] : null;
  }
  gridOf(p, fl = this.floor) {
    const g = fl && fl.grid;
    if (!g) return '';
    const gnum = (n) => parseInt(n.replace(/[XY]/, ''), 10);
    const between = (list, v) => {
      if (!list.length) return '';
      if (v < list[0][1]) return `${list[0][0]} 바깥`;
      for (let i = 0; i < list.length - 1; i++) {
        if (v >= list[i][1] && v <= list[i + 1][1]) {
          const a = list[i][0], b = list[i + 1][0];
          return gnum(a) < gnum(b) ? `${a}~${b}` : `${b}~${a}`;
        }
      }
      return `${list[list.length - 1][0]} 바깥`;
    };
    const GX = Object.entries(g.x).sort((a, b) => a[1] - b[1]);
    const GY = Object.entries(g.y).sort((a, b) => a[1] - b[1]);
    return `${between(GX, p[0])} / ${between(GY, p[1])}`;
  }

  // ------------------------------------------------------------ sharp layer from the vector PDF
  hideHi() { this.hiA.style.display = 'none'; this.hiB.style.display = 'none'; this.hi.front = null; }
  scheduleHi() { clearTimeout(this.hi.timer); this.hi.timer = setTimeout(() => this.renderHi(), 180); }
  async pdfPage(key) {
    if (this.hi.page && this.hi.pageKey === key) return this.hi.page;
    const lib = await loadPdfLib();
    if (!this.hi.doc) {
      const blob = await this.getPdfBlob();
      if (!blob) throw new Error('no pdf');
      this.hi.doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
    }
    const page = await this.hi.doc.getPage(this.floor.pdfPage);
    this.hi.page = page; this.hi.pageKey = key;
    return page;
  }
  resetPdf() { this.hi.doc = null; this.hi.page = null; this.hi.pageKey = null; }
  async renderHi() {
    const f = this.floor;
    if (!f || !this.stage.isConnected) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const v = this.view;
    if (v.s * dpr <= 1.1) { this.hideHi(); return; }
    const r = this.stage.getBoundingClientRect();
    const W = f.imgW, H = f.imgH, K = f.k;
    let x0 = -v.tx / v.s, y0 = -v.ty / v.s, x1 = (r.width - v.tx) / v.s, y1 = (r.height - v.ty) / v.s;
    const mx = (x1 - x0) * 0.12, my = (y1 - y0) * 0.12;
    x0 = Math.max(0, x0 - mx); y0 = Math.max(0, y0 - my); x1 = Math.min(W, x1 + mx); y1 = Math.min(H, y1 + my);
    if (x1 <= x0 || y1 <= y0) return;
    let k = v.s * dpr;
    const maxPx = 6e6;
    if ((x1 - x0) * (y1 - y0) * k * k > maxPx) k = Math.sqrt(maxPx / ((x1 - x0) * (y1 - y0)));
    const cw = Math.max(1, Math.round((x1 - x0) * k)), ch = Math.max(1, Math.round((y1 - y0) * k));
    const key = f.key, gen = ++this.hi.gen;
    let page;
    try { page = await this.pdfPage(key); } catch (e) { return; }
    if (gen !== this.hi.gen || !this.floor || this.floor.key !== key) return;
    if (this.hi.task) { try { this.hi.task.cancel(); } catch (e) { /* ignore */ } this.hi.task = null; }
    const scale = k * K;
    const vp = page.getViewport({ scale, offsetX: -(f.plan[0] + x0 / K) * scale, offsetY: -(f.plan[1] + y0 / K) * scale });
    const back = this.hi.front === this.hiA ? this.hiB : this.hiA;
    back.width = cw; back.height = ch;
    const ctx = back.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
    const task = page.render({ canvasContext: ctx, viewport: vp });
    this.hi.task = task;
    try { await task.promise; } catch (e) { return; }
    if (gen !== this.hi.gen || !this.floor || this.floor.key !== key) return;
    this.hi.task = null;
    Object.assign(back.style, { left: x0 + 'px', top: y0 + 'px', width: (x1 - x0) + 'px', height: (y1 - y0) + 'px', display: 'block' });
    if (this.hi.front && this.hi.front !== back) this.hi.front.style.display = 'none';
    this.hi.front = back;
  }
}
