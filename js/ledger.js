// 사진대지 (공사 사진대지): two photos a page with the drawing around each spot (위치도) and 일시·위치·부재·내용·비고,
// 세로 (A4 portrait) or 가로 (A4 landscape). One page model is written two ways:
// - an Excel workbook (.xlsx) to fill in and print: real cells and merged boxes, pictures placed over them,
//   공사명·작성일 typed once on page 1 (later pages follow it), a page break after every page, 1 / N in the footer;
// - a PDF of page images, drawn from the same model, to send as it is.
// Nothing leaves the phone.
import { makeZip, canvasBlob } from './util.js';

const INK = '111111', LINE = '7A7A76', GRAY = 'EDEDEA', RED = 'E3000F', GREEN = '1FA463', HINT = '9A9A96';
const FONT = '맑은 고딕';
const px2emu = (v) => Math.round(v * 9525), pt2px = (v) => (v * 4) / 3;

// ------------------------------------------------------------------ the page model
// cols: widths in px (Excel at 100 %), rows: heights in pt, one list per page. Boxes and pictures sit on that grid
// (r0, c0 inclusive, r1, c1 exclusive, rows counted within the page).
const LAYOUTS = {
  // A4 portrait, margins 0.3 / 0.35 in: printable 736 px x 791 pt
  portrait: {
    cols: [52, 160, 52, 150, 52, 254],
    head: [32, 5, 20, 8],
    block: (k) => [16, 284, 26, 26].concat(k === 0 ? [10] : []),
    place(b, base, i, f, m) { // b: boxes, base: first row of the block
      const s = base, p = s + 1, a = s + 2, c = s + 3;
      b.strip(s, 0, s + 1, 4, `${i}. 사진`); b.strip(s, 4, s + 1, 6, '위치도');
      b.photo(p, 0, p + 1, 4); b.map(p, 4, p + 1, 6);
      b.label(a, 0, '일 시'); b.value(a, 1, a + 1, 2, f.time);
      b.label(a, 2, '위 치'); b.value(a, 3, a + 1, 4, f.where, { wrap: true });
      b.label(a, 4, '부 재'); b.value(a, 5, a + 1, 6, f.member, { wrap: true });
      b.label(c, 0, '내 용'); b.value(c, 1, c + 1, 4, f.memo, { wrap: true });
      b.label(c, 4, '비 고'); b.value(c, 5, c + 1, 6, f.note, { color: f.noteColor, wrap: true });
      b.frame(s, 0, c + 1, 6);
    },
    landscape: false,
  },
  // A4 landscape: printable 1065 px x 545 pt
  landscape: {
    cols: [56, 354, 390, 56, 194],
    head: [30, 4, 20, 6],
    block: (k) => [16, 20, 20, 20, 138, 22].concat(k === 0 ? [8] : []),
    place(b, base, i, f) {
      const s = base, r = s + 1;
      b.strip(s, 0, s + 1, 2, `${i}. 사진`); b.strip(s, 2, s + 1, 3, '위치도'); b.strip(s, 3, s + 1, 5, '내용');
      b.photo(r, 0, r + 5, 2); b.map(r, 2, r + 5, 3);
      b.label(r, 3, '일 시'); b.value(r, 4, r + 1, 5, f.time);
      b.label(r + 1, 3, '위 치'); b.value(r + 1, 4, r + 2, 5, f.where, { wrap: true });
      b.label(r + 2, 3, '부 재'); b.value(r + 2, 4, r + 3, 5, f.member);
      b.label(r + 3, 3, '내 용'); b.value(r + 3, 4, r + 4, 5, f.memo, { wrap: true, top: true });
      b.label(r + 4, 3, '비 고'); b.value(r + 4, 4, r + 5, 5, f.note, { color: f.noteColor, wrap: true });
      b.frame(s, 0, r + 5, 5);
    },
    landscape: true,
  },
};
export const LEDGER_LAYOUTS = { portrait: '세로 · 한 쪽에 2장', landscape: '가로 · 한 쪽에 2장' };
const PER = 2;

// the areas a layout gives to a photo and its map, in px (for making pictures of the right shape)
export function ledgerSlots(layout) {
  const L = LAYOUTS[layout], rows = L.block(0), cw = (a, b) => L.cols.slice(a, b).reduce((t, v) => t + v, 0);
  if (layout === 'portrait') return { photo: [cw(0, 4), pt2px(rows[1])], map: [cw(4, 6), pt2px(rows[1])] };
  const h = pt2px(rows.slice(1, 6).reduce((t, v) => t + v, 0));
  return { photo: [cw(0, 2), h], map: [cw(2, 3), h] };
}

// pages: [{ rows: [pt...], boxes: [...], pics: [...] }], rows counted within the page
function buildPages(layout, entries, { title, date }) {
  const L = LAYOUTS[layout], ncol = L.cols.length, pages = [];
  const total = Math.max(1, Math.ceil(entries.length / PER));
  for (let p = 0; p < total; p++) {
    const rows = [], boxes = [], pics = [];
    const add = (o) => boxes.push(o);
    const b = {
      strip: (r0, c0, r1, c1, text) => add({ r0, c0, r1, c1, text, font: 'strip', fill: GRAY, edge: 'thin' }),
      label: (r, c, text) => add({ r0: r, c0: c, r1: r + 1, c1: c + 1, text, font: 'label', fill: GRAY, h: 'center', edge: 'thin' }),
      value: (r0, c0, r1, c1, text, o = {}) => add({ r0, c0, r1, c1, text, font: 'value', color: o.color, wrap: o.wrap, v: o.top ? 'top' : 'center', edge: 'thin' }),
      photo: (r0, c0, r1, c1) => add({ r0, c0, r1, c1, edge: 'thin', slot: 'photo' }),
      map: (r0, c0, r1, c1) => add({ r0, c0, r1, c1, edge: 'thin', slot: 'map' }),
      frame: (r0, c0, r1, c1) => add({ r0, c0, r1, c1, frame: true }),
    };
    rows.push(...L.head);
    add({ r0: 0, c0: 0, r1: 1, c1: ncol, text: '공 사 사 진 대 지', font: 'title', h: 'center', edge: 'none', under: true });
    // 공사명 | value … | 작성일 | value (page 1 is typed, later pages follow it)
    const dateCol = ncol - 2;
    add({ r0: 2, c0: 0, r1: 3, c1: 1, text: '공사명', font: 'label', fill: GRAY, h: 'center', edge: 'thin' });
    add({ r0: 2, c0: 1, r1: 3, c1: dateCol, text: title || '', font: title ? 'value' : 'hint', edge: 'thin', ref: p ? 'title' : null, key: p ? null : 'title', hint: '(공사명을 적어 주세요)' });
    add({ r0: 2, c0: dateCol, r1: 3, c1: dateCol + 1, text: '작성일', font: 'label', fill: GRAY, h: 'center', edge: 'thin' });
    add({ r0: 2, c0: dateCol + 1, r1: 3, c1: ncol, text: date, font: 'value', edge: 'thin', ref: p ? 'date' : null, key: p ? null : 'date' });
    for (let k = 0; k < PER; k++) {
      const e = entries[p * PER + k], base = rows.length;
      rows.push(...L.block(k));
      if (!e) continue;
      const before = boxes.length;
      L.place(b, base, p * PER + k + 1, e.fields);
      for (const x of boxes.slice(before)) {
        if (x.slot === 'photo' && e.photo) pics.push({ ...x, pic: e.photo, fit: 'contain' });
        if (x.slot === 'map') { if (e.map) pics.push({ ...x, pic: e.map, fit: 'fill' }); else { x.text = e.noMap || '위치 없음'; x.font = 'hint'; x.h = 'center'; } }
      }
    }
    pages.push({ rows, boxes, pics });
  }
  return { L, pages };
}

// ------------------------------------------------------------------ Excel
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = (c) => { let s = ''; c++; while (c) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
const FONTS = {
  normal: { sz: 11, name: 'Calibri' }, // the Normal style: column widths are counted in its digits (7 px)
  value: { sz: 10 }, hint: { sz: 10, color: HINT }, label: { sz: 9.5, b: true }, strip: { sz: 9.5, b: true }, title: { sz: 18, b: true },
};
function styleBook() {
  const fonts = ['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'], fontIx = new Map();
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'], borderIx = new Map();
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'], fillIx = new Map();
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'], xfIx = new Map();
  const font = (kind, color) => {
    const f = FONTS[kind] || FONTS.value, k = `${kind}|${color || ''}`;
    if (!fontIx.has(k)) { fontIx.set(k, fonts.length); fonts.push(`<font>${f.b ? '<b/>' : ''}<sz val="${f.sz}"/><color rgb="FF${color || f.color || INK}"/><name val="${FONT}"/><family val="3"/><charset val="129"/></font>`); }
    return fontIx.get(k);
  };
  const side = (t, s) => (s ? `<${t} style="${s}"><color rgb="FF${s === 'thin' ? LINE : s === 'double' ? INK : INK}"/></${t}>` : `<${t}/>`);
  const border = (l, r, t, b) => {
    const k = [l, r, t, b].join('|');
    if (k === '|||') return 0;
    if (!borderIx.has(k)) { borderIx.set(k, borders.length); borders.push(`<border>${side('left', l)}${side('right', r)}${side('top', t)}${side('bottom', b)}<diagonal/></border>`); }
    return borderIx.get(k);
  };
  const fill = (rgb) => {
    if (!rgb) return 0;
    if (!fillIx.has(rgb)) { fillIx.set(rgb, fills.length); fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor indexed="64"/></patternFill></fill>`); }
    return fillIx.get(rgb);
  };
  const xf = (o) => {
    const k = JSON.stringify(o);
    if (!xfIx.has(k)) {
      xfIx.set(k, xfs.length);
      const al = `<alignment horizontal="${o.h || 'left'}" vertical="${o.v || 'center'}"${o.wrap ? ' wrapText="1"' : ''}${(o.h || 'left') === 'left' ? ' indent="1"' : ''}/>`;
      xfs.push(`<xf numFmtId="0" fontId="${o.font}" fillId="${o.fill}" borderId="${o.border}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${al}</xf>`);
    }
    return xfIx.get(k);
  };
  const xml = () => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills>` +
    `<borders count="${borders.length}">${borders.join('')}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  return { font, border, fill, xf, xml };
}

async function picBytes(pic) {
  return new Uint8Array(await pic.blob.arrayBuffer());
}

export async function ledgerXlsx(layout, entries, opts) {
  const built = buildPages(layout, entries, opts), pages = built.pages;
  // 94 % of the paper's width: Excel draws these widths exactly, LibreOffice about 5 % wider; both stay on one page
  const L = { ...built.L, cols: built.L.cols.map((v) => Math.round(v * 0.94)) };
  const ncol = L.cols.length, st = styleBook();
  const cells = new Map(); // "r,c" -> { s, text, formula }
  const merges = [], anchors = [], breaks = [];
  const rowH = [];
  const named = {};
  let off = 0;
  for (const pg of pages) {
    rowH.push(...pg.rows);
    const R = (r) => off + r;
    // outer frames (medium) drawn over the cells' own edges
    const frames = pg.boxes.filter((x) => x.frame);
    const edgeOf = (r, c, dir) => {
      for (const f of frames) {
        const rr = r - off;
        if (rr < f.r0 || rr >= f.r1 || c < f.c0 || c >= f.c1) continue;
        if ((dir === 't' && rr === f.r0) || (dir === 'b' && rr === f.r1 - 1) || (dir === 'l' && c === f.c0) || (dir === 'r' && c === f.c1 - 1)) return 'medium';
      }
      return null;
    };
    for (const x of pg.boxes) {
      if (x.frame) continue;
      const r0 = R(x.r0), r1 = R(x.r1);
      if (r1 - r0 > 1 || x.c1 - x.c0 > 1) merges.push(`${colName(x.c0)}${r0 + 1}:${colName(x.c1 - 1)}${r1}`);
      const font = st.font(x.font || 'value', x.color);
      const fill = st.fill(x.fill);
      for (let r = r0; r < r1; r++) {
        for (let c = x.c0; c < x.c1; c++) {
          const e = x.edge === 'thin' ? 'thin' : null;
          const l = c === x.c0 ? edgeOf(r, c, 'l') || e : null, rt = c === x.c1 - 1 ? edgeOf(r, c, 'r') || e : null;
          const t = r === r0 ? edgeOf(r, c, 't') || e : null;
          const b = r === r1 - 1 ? edgeOf(r, c, 'b') || e || (x.under ? 'double' : null) : null;
          const s = st.xf({ font, fill, border: st.border(l, rt, t, b), h: x.h, v: x.v, wrap: !!x.wrap || !!x.slot });
          cells.set(`${r},${c}`, { s, text: r === r0 && c === x.c0 ? x : null });
        }
      }
      if (x.key) named[x.key] = `$${colName(x.c0)}$${r0 + 1}`;
    }
    for (const pc of pg.pics) {
      const box = { x: L.cols.slice(pc.c0, pc.c1).reduce((t, v) => t + v, 0), y: pt2px(pg.rows.slice(pc.r0, pc.r1).reduce((t, v) => t + v, 0)) };
      const pad = pc.fit === 'fill' ? 2 : 5, W = box.x - 2 * pad, H = box.y - 2 * pad;
      const k = pc.fit === 'fill' ? 1 : Math.min(W / pc.pic.w, H / pc.pic.h);
      const w = pc.fit === 'fill' ? W : pc.pic.w * k, h = pc.fit === 'fill' ? H : pc.pic.h * k;
      anchors.push({ pic: pc.pic, row: R(pc.r0), col: pc.c0, dx: pad + (W - w) / 2, dy: pad + (H - h) / 2, w, h, rows: pg.rows.slice(pc.r0), r0: R(pc.r0) });
    }
    off += pg.rows.length;
    breaks.push(off);
  }
  breaks.pop();
  // sheet
  const rowsXml = [];
  for (let r = 0; r < rowH.length; r++) {
    const cs = [];
    for (let c = 0; c < ncol; c++) {
      const cell = cells.get(`${r},${c}`);
      if (!cell) continue;
      const ref = `${colName(c)}${r + 1}`, x = cell.text;
      if (x && x.ref && named[x.ref]) {
        const shown = x.ref === 'title' ? (opts.title || '') : opts.date;
        cs.push(`<c r="${ref}" s="${cell.s}" t="str"><f>${named[x.ref]}&amp;""</f><v>${esc(shown)}</v></c>`);
      } else if (x && (x.text || (x.font === 'hint' && x.hint))) {
        const text = x.text || x.hint;
        cs.push(`<c r="${ref}" s="${cell.s}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`);
      } else cs.push(`<c r="${ref}" s="${cell.s}"/>`);
    }
    rowsXml.push(`<row r="${r + 1}" ht="${rowH[r]}" customHeight="1">${cs.join('')}</row>`);
  }
  const colsXml = L.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${(Math.floor((w / 7) * 256) / 256).toFixed(4)}" customWidth="1"/>`).join('');
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheetPr><pageSetUpPr fitToPage="0"/></sheetPr><dimension ref="A1:${colName(ncol - 1)}${rowH.length}"/>` +
    '<sheetViews><sheetView showGridLines="0" tabSelected="1" workbookViewId="0" view="pageBreakPreview" zoomScaleNormal="100" zoomScaleSheetLayoutView="80"/></sheetViews>' +
    `<sheetFormatPr defaultRowHeight="15"/><cols>${colsXml}</cols><sheetData>${rowsXml.join('')}</sheetData>` +
    (merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '') +
    '<printOptions horizontalCentered="1"/><pageMargins left="0.3" right="0.3" top="0.35" bottom="0.35" header="0.1" footer="0.12"/>' +
    `<pageSetup paperSize="9" scale="100" orientation="${L.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>` +
    '<headerFooter><oddFooter>&amp;C&amp;"맑은 고딕,보통"&amp;9&amp;P / &amp;N</oddFooter></headerFooter>' +
    (breaks.length ? `<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">${breaks.map((b) => `<brk id="${b}" max="16383" man="1"/>`).join('')}</rowBreaks>` : '') +
    (anchors.length ? '<drawing r:id="rId1"/>' : '') + '</worksheet>';
  // pictures
  const media = [], picXml = [];
  const colStart = (c) => L.cols.slice(0, c).reduce((t, v) => t + v, 0);
  // a point (px from the page's left, px from the block's first row) as a cell and an offset inside it
  const atCol = (x) => { let col = 0; while (col < ncol - 1 && x >= L.cols[col]) { x -= L.cols[col]; col++; } return [col, Math.min(x, L.cols[col])]; };
  const atRow = (a, y) => { let k = 0; while (k < a.rows.length - 1 && y >= pt2px(a.rows[k])) { y -= pt2px(a.rows[k]); k++; } return [a.r0 + k, Math.min(y, pt2px(a.rows[k]))]; };
  anchors.forEach((a, i) => {
    // tied to the cells at both corners, so a program that draws the columns a little narrower keeps it inside its box
    const x0 = colStart(a.col) + a.dx, [c0, ox0] = atCol(x0), [c1, ox1] = atCol(x0 + a.w);
    const [r0, oy0] = atRow(a, a.dy), [r1, oy1] = atRow(a, a.dy + a.h);
    media.push({ name: `image${i + 1}.jpeg`, pic: a.pic });
    picXml.push(`<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${c0}</xdr:col><xdr:colOff>${px2emu(ox0)}</xdr:colOff><xdr:row>${r0}</xdr:row><xdr:rowOff>${px2emu(oy0)}</xdr:rowOff></xdr:from>` +
      `<xdr:to><xdr:col>${c1}</xdr:col><xdr:colOff>${px2emu(ox1)}</xdr:colOff><xdr:row>${r1}</xdr:row><xdr:rowOff>${px2emu(oy1)}</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="그림 ${i + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>` +
      `<xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
      `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${px2emu(a.w)}" cy="${px2emu(a.h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`);
  });
  const drawing = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' + picXml.join('') + '</xdr:wsDr>';
  const R = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  const rels = (...x) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + x.join('') + '</Relationships>';
  const sheetName = '사진대지';
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<bookViews><workbookView/></bookViews><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets>` +
    `<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">${sheetName}!$A$1:$${colName(ncol - 1)}$${rowH.length}</definedName></definedNames>` +
    '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>';
  const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    (anchors.length ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '') +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>공사 사진대지</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>';
  const text = (name, t) => ({ name, blob: new Blob([t], { type: 'application/xml' }) });
  const files = [
    text('[Content_Types].xml', types),
    text('_rels/.rels', rels(R('rId1', 'officeDocument', 'xl/workbook.xml'),
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
      R('rId3', 'extended-properties', 'docProps/app.xml'))),
    text('docProps/core.xml', core), text('docProps/app.xml', app),
    text('xl/workbook.xml', workbook),
    text('xl/_rels/workbook.xml.rels', rels(R('rId1', 'worksheet', 'worksheets/sheet1.xml'), R('rId2', 'styles', 'styles.xml'))),
    text('xl/styles.xml', st.xml()),
    text('xl/worksheets/sheet1.xml', sheet),
  ];
  if (anchors.length) {
    files.push(text('xl/worksheets/_rels/sheet1.xml.rels', rels(R('rId1', 'drawing', '../drawings/drawing1.xml'))));
    files.push(text('xl/drawings/drawing1.xml', drawing));
    files.push(text('xl/drawings/_rels/drawing1.xml.rels', rels(...media.map((m, i) => R(`rId${i + 1}`, 'image', `../media/${m.name}`)))));
    for (const m of media) files.push({ name: `xl/media/${m.name}`, blob: new Blob([await picBytes(m.pic)], { type: 'image/jpeg' }) });
  }
  const zip = await makeZip(files);
  return new Blob([zip], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ------------------------------------------------------------------ PDF (the same pages drawn on canvas, 150 dpi)
const CFONT = "Pretendard, -apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif";
const loadImage = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
function lines(g, text, maxW) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const ch of para) {
      if (line && g.measureText(line + ch).width > maxW) { out.push(line); line = ch.trim() ? ch : ''; } else line += ch;
    }
    out.push(line);
  }
  return out;
}
export async function ledgerPdf(layout, entries, opts, onProgress) {
  const { L, pages } = buildPages(layout, entries, opts);
  try { await Promise.all(['500 20px', '700 20px', '800 30px'].map((f) => document.fonts.load(`${f} Pretendard`))); } catch (e) { /* system font */ }
  const DPI = 150, PW = L.landscape ? 1754 : 1240, PH = L.landscape ? 1240 : 1754, k = DPI / 96;
  const mL = 0.3 * DPI, mT = 0.35 * DPI, uw = PW - 2 * mL;
  const designW = L.cols.reduce((t, v) => t + v, 0) * k, x0 = mL + (uw - designW) / 2;
  const colX = [x0];
  for (const w of L.cols) colX.push(colX[colX.length - 1] + w * k);
  const jpgs = [];
  for (let p = 0; p < pages.length; p++) {
    const pg = pages[p], rowY = [mT];
    for (const h of pg.rows) rowY.push(rowY[rowY.length - 1] + pt2px(h) * k);
    const c = document.createElement('canvas');
    c.width = PW; c.height = PH;
    const g = c.getContext('2d', { alpha: false });
    g.fillStyle = '#fff'; g.fillRect(0, 0, PW, PH);
    const rect = (x) => [colX[x.c0], rowY[x.r0], colX[x.c1] - colX[x.c0], rowY[x.r1] - rowY[x.r0]];
    for (const x of pg.boxes) {
      if (x.frame) continue;
      const [X, Y, W, H] = rect(x);
      if (x.fill) { g.fillStyle = '#' + x.fill; g.fillRect(X, Y, W, H); }
      if (x.edge === 'thin') { g.strokeStyle = '#' + LINE; g.lineWidth = 1.5; g.strokeRect(X, Y, W, H); }
      if (x.under) { g.fillStyle = '#' + INK; g.fillRect(X, Y + H - 6, W, 2); g.fillRect(X, Y + H - 2, W, 2); }
      let text = x.text;
      if (x.ref) text = x.ref === 'title' ? opts.title || '' : opts.date;
      if (!text && x.font === 'hint') text = x.hint || '';
      if (!text) continue;
      const f = FONTS[x.font] || FONTS.value, size = f.sz * (DPI / 72);
      g.font = `${f.b ? 700 : 500} ${size}px ${CFONT}`;
      g.fillStyle = '#' + ((!x.text && x.font === 'hint') || x.font === 'hint' ? HINT : x.color || f.color || INK);
      g.textBaseline = 'middle';
      const pad = x.h === 'center' ? 0 : 16, maxW = W - 2 * (pad || 8);
      const ls = x.wrap ? lines(g, text, maxW) : [text], lh = size * 1.3, fit = Math.max(1, Math.floor((H - 8) / lh));
      if (ls.length > fit) { ls.length = fit; ls[fit - 1] = ls[fit - 1].replace(/.$/, '…'); }
      const top = x.v === 'top' ? Y + 8 + lh / 2 : Y + H / 2 - ((ls.length - 1) * lh) / 2;
      ls.forEach((l, i) => {
        const w = g.measureText(l).width;
        g.fillText(l, x.h === 'center' ? X + (W - w) / 2 : X + pad, top + i * lh);
      });
    }
    for (const pc of pg.pics) {
      const [X, Y, W, H] = rect(pc);
      const url = URL.createObjectURL(pc.pic.blob);
      try {
        const im = await loadImage(url);
        const pad = pc.fit === 'fill' ? 3 : 8, w0 = W - 2 * pad, h0 = H - 2 * pad;
        const s = pc.fit === 'fill' ? 1 : Math.min(w0 / im.naturalWidth, h0 / im.naturalHeight);
        const w = pc.fit === 'fill' ? w0 : im.naturalWidth * s, h = pc.fit === 'fill' ? h0 : im.naturalHeight * s;
        g.drawImage(im, X + pad + (w0 - w) / 2, Y + pad + (h0 - h) / 2, w, h);
      } catch (e) { /* left empty */ } finally { URL.revokeObjectURL(url); }
    }
    for (const x of pg.boxes.filter((b) => b.frame)) {
      const [X, Y, W, H] = rect(x);
      g.strokeStyle = '#' + INK; g.lineWidth = 3.5; g.strokeRect(X, Y, W, H);
    }
    g.font = `500 ${9 * (DPI / 72)}px ${CFONT}`; g.fillStyle = '#' + INK; g.textBaseline = 'middle';
    const pn = `${p + 1} / ${pages.length}`;
    g.fillText(pn, (PW - g.measureText(pn).width) / 2, PH - 0.22 * DPI);
    jpgs.push(new Uint8Array(await (await canvasBlob(c, 'image/jpeg', 0.88)).arrayBuffer()));
    c.width = c.height = 1;
    if (onProgress) onProgress(p + 1, pages.length);
  }
  return pdfOfPages(jpgs, PW, PH, L.landscape);
}

function pdfOfPages(jpgs, w, h, landscape) {
  const enc = new TextEncoder(), parts = [], offs = [];
  let len = 0;
  const push = (s) => { const b = typeof s === 'string' ? enc.encode(s) : s; parts.push(b); len += b.length; };
  const obj = (n, ...body) => { offs[n] = len; push(`${n} 0 obj\n`); body.forEach(push); push('\nendobj\n'); };
  const A4W = landscape ? 841.89 : 595.28, A4H = landscape ? 595.28 : 841.89, n = jpgs.length, size = 3 + n * 3;
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
