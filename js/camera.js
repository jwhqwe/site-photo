// In-app camera (fast: shutter -> drawing -> back), the phone's own camera as a fallback, and the motion sensors.
import { canvasBlob, thumbFrom } from './util.js';

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.deviceId = null;
    this.lens = '1x';
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
  }
  // back cameras the browser exposes (labels are only filled in after permission)
  async lenses() {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const out = [];
      for (const d of devs) {
        const L = (d.label || '').toLowerCase();
        if (/front|전면|facetime/.test(L)) continue;
        if (/dual|triple|듀얼|트리플/.test(L)) continue;
        const zoom = /ultra|초광각/.test(L) ? '0.5x' : /tele|망원/.test(L) ? '2x' : '1x';
        if (!out.some((o) => o.zoom === zoom)) out.push({ id: d.deviceId, label: d.label, zoom });
      }
      return out.sort((a, b) => parseFloat(a.zoom) - parseFloat(b.zoom));
    } catch (e) { return []; }
  }
  async capture() {
    const v = this.video;
    const w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) throw new Error('카메라 화면이 아직 준비되지 않았어요');
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(v, 0, 0, w, h);
    const blob = await canvasBlob(c, 'image/jpeg', 0.92);
    const thumb = await thumbFrom(c, w, h);
    c.width = c.height = 1;
    return { blob, thumb, w, h, mime: 'image/jpeg' };
  }
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
  heading: null, headingAcc: null, beta: null, gamma: null, started: false, asked: false,
  start() {
    if (this.started) return;
    this.started = true;
    const onOri = (e) => {
      if (typeof e.webkitCompassHeading === 'number') { this.heading = e.webkitCompassHeading; this.headingAcc = e.webkitCompassAccuracy; }
      else if (e.absolute && typeof e.alpha === 'number') this.heading = (360 - e.alpha) % 360;
      if (typeof e.beta === 'number') { this.beta = e.beta; this.gamma = e.gamma; }
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
