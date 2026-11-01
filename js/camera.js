// In-app camera (fast: shutter -> drawing -> back), the phone's own camera as a fallback, and the motion sensors.
import { canvasBlob, thumbFrom, imageThumb, turnJpeg, turnCanvas } from './util.js';

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.deviceId = null;
    this.lens = '1x';
    this.zoom = 1; // 2 = 2× on the main camera
    this.crop = 1; // when the camera cannot zoom itself, the middle of the picture is taken
  }
  get active() { return !!(this.stream && this.stream.active); }
  get track() { return this.stream ? this.stream.getVideoTracks()[0] || null : null; }
  async start(deviceId) {
    this.stop();
    const base = { width: { ideal: 4032 }, height: { ideal: 3024 } };
    const video = deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base, facingMode: { ideal: 'environment' } };
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.deviceId = deviceId || (this.stream.getVideoTracks()[0].getSettings() || {}).deviceId || null;
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play().catch(() => {});
    await new Promise((res) => { if (this.video.videoWidth) res(); else { this.video.onloadedmetadata = res; setTimeout(res, 3000); } });
  }
  stop() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
    this.zoom = 1;
    this.crop = 1;
    this.video.style.transform = '';
  }
  // 2× on the main camera: the camera's own zoom when the browser offers it, else the middle of the picture
  async setZoom(z) {
    this.zoom = z;
    this.crop = 1;
    this.video.style.transform = '';
    const tr = this.track;
    const caps = tr && tr.getCapabilities ? tr.getCapabilities() : null;
    if (caps && caps.zoom && caps.zoom.max >= z) {
      try { await tr.applyConstraints({ advanced: [{ zoom: Math.max(caps.zoom.min || 1, z) }] }); return; } catch (e) { /* fall back to the middle */ }
    }
    if (z > 1) { this.crop = z; this.video.style.transform = `scale(${z})`; }
  }
  // back cameras the browser exposes (labels are only filled in after permission)
  async lenses() {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const out = [];
      for (const d of devs) {
        const L = (d.label || '').toLowerCase();
        if (/front|전면|facetime/.test(L)) continue;
        if (/dual|triple|듀얼|트리플|tele|망원/.test(L)) continue;
        const zoom = /ultra|초광각/.test(L) ? '0.5x' : '1x';
        if (!out.some((o) => o.zoom === zoom)) out.push({ id: d.deviceId, label: d.label, zoom });
      }
      return out.sort((a, b) => parseFloat(a.zoom) - parseFloat(b.zoom));
    } catch (e) { return []; }
  }
  // the current frame (the middle part at 2× when the camera cannot zoom itself)
  captureCanvas(turn = 0) {
    const v = this.video;
    const W = v.videoWidth, H = v.videoHeight;
    if (!W || !H) throw new Error('카메라 화면이 아직 준비되지 않았어요');
    const k = this.crop || 1, w = Math.round(W / k), h = Math.round(H / k);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(v, (W - w) / 2, (H - h) / 2, w, h, 0, 0, w, h);
    return turnCanvas(c, turn);
  }
  // a real photo from the camera's photo pipeline (Safari 18.4+): full size and processed like the Camera app,
  // instead of a still from the live video. At 2× without the camera's own zoom the video frame is used.
  async takePhoto() {
    const tr = this.track;
    if (typeof ImageCapture !== 'function' || !tr || tr.readyState !== 'live' || this.crop > 1) return null;
    if (!this.ic || this.icTrack !== tr) { this.ic = new ImageCapture(tr); this.icTrack = tr; }
    const blob = await this.ic.takePhoto();
    return blob && blob.size ? blob : null;
  }
  // turn: degrees clockwise to stand a sideways photo up (from the motion sensor, see sensors.extraTurn)
  async capture(turn = 0) {
    try {
      let p = await this.takePhoto();
      if (p && !/jpe?g|hei[cf]/i.test(p.type || '')) p = await toJpeg(p); // keep photos as JPEG (date inside)
      if (p && turn) p = await turnJpeg(p, turn, Date.now());
      if (p) {
        const t = await imageThumb(p);
        if (t.w) return { blob: p, thumb: t.thumb, w: t.w, h: t.h, mime: p.type || 'image/jpeg' };
      }
    } catch (e) { /* the video frame then */ }
    const c = this.captureCanvas(turn), w = c.width, h = c.height;
    const blob = await canvasBlob(c, 'image/jpeg', 0.92);
    const thumb = await thumbFrom(c, w, h);
    c.width = c.height = 1;
    return { blob, thumb, w, h, mime: 'image/jpeg' };
  }
}

async function toJpeg(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    const out = await canvasBlob(c, 'image/jpeg', 0.95);
    c.width = c.height = 1;
    return out;
  } finally { URL.revokeObjectURL(url); }
}

// the phone's own camera app, for full quality, volume-key shutter and video
export function nativeCapture(kind) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = kind === 'video' ? 'video/*' : 'image/*';
    inp.setAttribute('capture', 'environment');
    inp.style.display = 'none';
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; inp.remove(); resolve(v); };
    inp.addEventListener('change', () => finish(inp.files && inp.files[0] ? inp.files[0] : null));
    inp.addEventListener('cancel', () => finish(null));
    document.body.append(inp);
    inp.click();
  });
}

// ---------------------------------------------------------------- sensors
export const sensors = {
  heading: null, headingAcc: null, beta: null, gamma: null, started: false, asked: false, turn: 0, onturn: null,
  start() {
    if (this.started) return;
    this.started = true;
    const onOri = (e) => {
      if (typeof e.webkitCompassHeading === 'number') { this.heading = e.webkitCompassHeading; this.headingAcc = e.webkitCompassAccuracy; }
      else if (e.absolute && typeof e.alpha === 'number') this.heading = (360 - e.alpha) % 360;
      if (typeof e.beta === 'number') { this.beta = e.beta; this.gamma = e.gamma; this.updateTurn(); }
    };
    window.addEventListener('deviceorientation', onOri);
    window.addEventListener('deviceorientationabsolute', onOri);
  },
  // iOS asks once, from a tap
  async requestPermission() {
    this.asked = true;
    try {
      if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') await DeviceMotionEvent.requestPermission().catch(() => {});
        this.start();
        return r === 'granted';
      }
    } catch (e) { return false; }
    this.start();
    return true;
  },
  // how the phone is held: 0 upright, 90 right edge down, 180 upside down, 270 left edge down.
  // Gravity in the screen plane from beta/gamma; lying flat keeps the last answer (shots of the floor).
  updateTurn() {
    const b = (this.beta * Math.PI) / 180, g = ((this.gamma || 0) * Math.PI) / 180;
    const gx = Math.sin(g) * Math.cos(b), gy = -Math.sin(b);
    if (Math.hypot(gx, gy) < 0.5) return;
    let t = this.turn;
    if (Math.abs(gx) > Math.abs(gy) * 1.4) t = gx > 0 ? 90 : 270;
    else if (Math.abs(gy) > Math.abs(gx) * 1.4) t = gy < 0 ? 0 : 180;
    if (t !== this.turn) { this.turn = t; if (this.onturn) this.onturn(t); }
  },
  // the turn still needed: when the screen itself turned to landscape the camera already delivers it upright
  extraTurn() {
    const uiLandscape = window.innerWidth > window.innerHeight;
    if (uiLandscape) return 0;
    return this.turn;
  },
  // camera axis above the horizon, degrees (+ looking up, - looking down)
  pitch() {
    if (this.beta == null) return null;
    const b = this.beta * Math.PI / 180, g = (this.gamma || 0) * Math.PI / 180;
    return Math.round(Math.asin(Math.max(-1, Math.min(1, -Math.cos(b) * Math.cos(g)))) * 180 / Math.PI);
  },
  snapshot() {
    return { heading: this.heading == null ? null : Math.round(this.heading), pitch: this.pitch() };
  },
};

// compass heading (magnetic, clockwise from north) -> direction angle on the drawing (radians, x right / y down)
const DECLINATION = -9; // Seoul, degrees (magnetic -> true)
export function headingToPlan(heading, northCW, calib) {
  if (heading == null) return null;
  const deg = heading + DECLINATION + (northCW || 0) - 90 + (calib || 0);
  return deg * Math.PI / 180;
}
export function planToHeading(theta, northCW, calib) {
  return ((theta * 180 / Math.PI) - DECLINATION - (northCW || 0) + 90 - (calib || 0) + 720) % 360;
}
// offset that makes the current compass reading point along theta on the drawing
export function calibFor(theta, heading, northCW) {
  let c = theta * 180 / Math.PI - (heading + DECLINATION + (northCW || 0) - 90);
  c = ((c % 360) + 540) % 360 - 180;
  return Math.round(c * 10) / 10;
}
// true-north bearing of a direction on the drawing (degrees, 0 = north, clockwise), for lists
export function bearingOf(theta, northCW) {
  return Math.round(((theta * 180 / Math.PI) + 90 - (northCW || 0) + 720) % 360);
}
export const FAN_HALF = { '0.5x': 42, '1x': 26, '2x': 14, native: 26 };
