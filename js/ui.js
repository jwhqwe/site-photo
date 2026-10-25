// Dialogs, busy spinner and file picking. One dialog at a time; opening another closes the first.
import { $, el, shareOrDownload } from './util.js';

let current = null;

export function openDialog(build, { dismiss = true } = {}) {
  if (current) current(undefined);
  return new Promise((resolve) => {
    const ov = $('#dialog'), box = $('#dBox');
    box.replaceChildren();
    let done = false;
    const close = (v) => {
      if (done) return;
      done = true;
      if (current === close) current = null;
      ov.hidden = true;
      box.replaceChildren();
      ov.onclick = null;
      resolve(v);
    };
    current = close;
    build(box, close);
    ov.hidden = false;
    ov.onclick = (e) => { if (dismiss && e.target === ov) close(undefined); };
  });
}
export const dialogOpen = () => !!current;
export function closeDialog() { if (current) current(undefined); }

const actions = (...btns) => el('div', { class: 'd-actions' }, ...btns);

export function confirmBox(title, msg, ok = '확인', danger = false) {
  return openDialog((box, close) => {
    box.append(el('h3', {}, title));
    if (msg) box.append(el('p', { class: 'pre' }, msg));
    box.append(actions(
      el('button', { class: 'btn', onclick: () => close(false) }, '취소'),
      el('button', { class: 'btn ' + (danger ? 'danger fill' : 'primary'), onclick: () => close(true) }, ok)));
  }).then((v) => v === true);
}

export function alertBox(title, msg) {
  return openDialog((box, close) => {
    box.append(el('h3', {}, title));
    if (msg) box.append(el('p', { class: 'pre' }, msg));
    box.append(actions(el('button', { class: 'btn primary', onclick: () => close(true) }, '확인')));
  });
}

export function promptText(title, value = '', { placeholder = '', ok = '저장', multiline = true, hint = '' } = {}) {
  return openDialog((box, close) => {
    const inp = el(multiline ? 'textarea' : 'input', { placeholder, rows: multiline ? 4 : null });
    inp.value = value || '';
    box.append(el('h3', {}, title));
    if (hint) box.append(el('p', {}, hint));
    box.append(inp, actions(
      el('button', { class: 'btn', onclick: () => close(null) }, '취소'),
      el('button', { class: 'btn primary', onclick: () => close(inp.value.trim()) }, ok)));
    setTimeout(() => inp.focus(), 60);
  }).then((v) => (v === undefined ? null : v));
}

// options: [{label, value, desc?, current?}]
export function choose(title, options, { msg = '', cancel = '취소' } = {}) {
  return openDialog((box, close) => {
    box.append(el('h3', {}, title));
    if (msg) box.append(el('p', {}, msg));
    const list = el('div', { class: 'choices' });
    for (const o of options) {
      list.append(el('button', { class: 'btn choice' + (o.current ? ' cur' : ''), onclick: () => close(o.value) },
        el('b', {}, o.label), o.desc ? el('small', {}, o.desc) : null));
    }
    box.append(list, actions(el('button', { class: 'btn', onclick: () => close(undefined) }, cancel)));
  });
}

// The share sheet needs a fresh tap, so a finished file is offered with its own button.
export function offerFile(blob, name, title, msg) {
  return openDialog((box, close) => {
    box.append(el('h3', {}, title));
    if (msg) box.append(el('p', { class: 'pre' }, msg));
    box.append(el('p', {}, el('code', {}, name)));
    box.append(actions(
      el('button', { class: 'btn', onclick: () => close('cancelled') }, '닫기'),
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          const r = await shareOrDownload(blob, name);
          if (r !== 'cancelled') close(r);
        },
      }, '공유 · 저장')));
  }, { dismiss: false });
}

export function busy(msg) {
  const b = $('#busy'), m = $('#busyMsg');
  m.textContent = msg || '';
  b.hidden = false;
  return { set: (t) => { m.textContent = t; }, done: () => { b.hidden = true; } };
}

export function pickFiles({ accept = '', multiple = false } = {}) {
  return new Promise((resolve) => {
    const inp = el('input', { type: 'file', accept: accept || null, multiple: multiple || null, style: { display: 'none' } });
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; inp.remove(); resolve(v); };
    inp.addEventListener('change', () => finish([...(inp.files || [])]));
    inp.addEventListener('cancel', () => finish([]));
    document.body.append(inp);
    inp.click();
  });
}
