// Field-of-view volumes, built in the sensor frame (x forward, z up).
//
//  frustum  : rectangular pinhole frustum from H/V FoV, near/far = depth range
//  pinhole  : same, FoV derived from sensor size and focal length
//  spinning : spinning lidar shell between elevation limits and min/max range,
//             azimuth measured from the sensor +x axis, counter-clockwise
import * as THREE from 'three';
import { RAD, DEG } from './math.js';
import { PlacedSensor } from './sensors.js';

export const fovSettings = {
  maxDisplayRange: 15,    // global cap [m] for sensors without their own display range
  opacity: 0.13,
};

const MAX_CAMERA_FOV = 170;   // a planar frustum cannot represent >= 180°

/** Effective FoV parameters (spec + per-sensor overrides), angles in degrees. */
export function effectiveFov(sensor) {
  const f = sensor.resolved.fov;
  if (!f) return null;
  const o = sensor.fovOverride || {};
  const out = { ...f, ...o };
  if (f.model === 'pinhole') {
    out.hfov_deg = 2 * Math.atan(f.sensor_w_mm / (2 * f.focal_length_mm)) * DEG;
    out.vfov_deg = 2 * Math.atan(f.sensor_h_mm / (2 * f.focal_length_mm)) * DEG;
    out.model = 'frustum';
  }
  out.range_min_m = out.range_min_m ?? 0;
  out.range_max_m = out.range_max_m ?? fovSettings.maxDisplayRange;
  out.display_max_m = Math.min(out.range_max_m, sensor.displayRange ?? fovSettings.maxDisplayRange);
  out.display_min_m = Math.min(out.range_min_m, out.display_max_m * 0.999);
  return out;
}

// ---------------------------------------------------------------------------
// Geometry helpers

class MeshBuilder {
  constructor() { this.pos = []; this.idx = []; }

  /** Add a (nu+1) x (nv+1) grid surface from fn(u, v) with u, v in [0, 1]. */
  grid(fn, nu, nv) {
    const base = this.pos.length / 3;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const p = fn(i / nu, j / nv);
        this.pos.push(p.x, p.y, p.z);
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i;
        const b = a + 1;
        const c = a + nu + 1;
        const d = c + 1;
        this.idx.push(a, b, d, a, d, c);
      }
    }
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }

function surfaceMaterial(color) {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: fovSettings.opacity,
    side: THREE.DoubleSide, depthWrite: false,
  });
}

function lineMaterial(color, opacity = 0.75) {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
}

function polyline(points, material, closed = false) {
  const g = new THREE.BufferGeometry().setFromPoints(closed ? [...points, points[0]] : points);
  return new THREE.Line(g, material);
}

function segments(pairs, material) {
  const g = new THREE.BufferGeometry().setFromPoints(pairs.flat());
  return new THREE.LineSegments(g, material);
}

// ---------------------------------------------------------------------------
// Camera frustum (planar near/far faces: the camera range is a depth)

export function frustumCorners(hfov, vfov, depth) {
  const ty = Math.tan(Math.min(hfov, MAX_CAMERA_FOV) * RAD / 2);
  const tz = Math.tan(Math.min(vfov, MAX_CAMERA_FOV) * RAD / 2);
  return [
    new THREE.Vector3(depth, ty * depth, tz * depth),
    new THREE.Vector3(depth, -ty * depth, tz * depth),
    new THREE.Vector3(depth, -ty * depth, -tz * depth),
    new THREE.Vector3(depth, ty * depth, -tz * depth),
  ];
}

function buildFrustum(f, color, offsetY = 0, edgesOnly = false) {
  const g = new THREE.Group();
  const near = Math.max(f.display_min_m, 1e-3);
  const far = f.display_max_m;
  const n = frustumCorners(f.hfov_deg, f.vfov_deg, near);
  const fr = frustumCorners(f.hfov_deg, f.vfov_deg, far);
  for (const p of [...n, ...fr]) p.y += offsetY;
  const origin = new THREE.Vector3(0, offsetY, 0);

  if (!edgesOnly) {
    const mb = new MeshBuilder();
    const quad = (a, b, c, d) => mb.grid((u, v) => {
      const top = a.clone().lerp(b, u);
      const bot = d.clone().lerp(c, u);
      return top.lerp(bot, v);
    }, 1, 1);
    quad(fr[0], fr[1], fr[2], fr[3]);                 // far face
    for (let i = 0; i < 4; i++) {                       // side faces
      const j = (i + 1) % 4;
      quad(n[i], n[j], fr[j], fr[i]);
    }
    if (near > 1e-3) quad(n[0], n[1], n[2], n[3]);      // near face (blind zone boundary)
    const mesh = new THREE.Mesh(mb.build(), surfaceMaterial(color));
    mesh.userData.fovSurface = true;
    mesh.renderOrder = 5;
    g.add(mesh);
  }
  const lm = lineMaterial(color, edgesOnly ? 0.5 : 0.8);
  g.add(polyline(fr, lm, true));
  if (near > 1e-3) g.add(polyline(n, lm, true));
  g.add(segments(fr.map((p) => [origin, p]), lm));
  return g;
}

// ---------------------------------------------------------------------------
// Spinning lidar shell

function dirAzEl(az, el) {
  return new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
}

function buildSpinning(f, color, showChannels) {
  const g = new THREE.Group();
  const az0 = (f.azimuth_min_deg ?? 0) * RAD;
  const az1 = (f.azimuth_max_deg ?? 360) * RAD;
  const el0 = f.elevation_min_deg * RAD;
  const el1 = f.elevation_max_deg * RAD;
  const r0 = Math.max(f.display_min_m, 1e-3);
  const r1 = f.display_max_m;
  const full = Math.abs(az1 - az0) >= 2 * Math.PI - 1e-6;
  const nAz = Math.max(8, Math.ceil(Math.abs(az1 - az0) / (4 * RAD)));
  const nEl = Math.max(2, Math.ceil((el1 - el0) / (4 * RAD)));

  const mb = new MeshBuilder();
  const shell = (r) => mb.grid((u, v) => dirAzEl(lerp(az0, az1, u), lerp(el0, el1, v)).multiplyScalar(r), nAz, nEl);
  const cone = (el) => mb.grid((u, v) => dirAzEl(lerp(az0, az1, u), el).multiplyScalar(lerp(r0, r1, v)), nAz, 1);
  shell(r1);
  if (r0 > 1e-3) shell(r0);
  cone(el0);
  cone(el1);
  if (!full) {
    for (const az of [az0, az1]) {
      mb.grid((u, v) => dirAzEl(az, lerp(el0, el1, v)).multiplyScalar(lerp(r0, r1, u)), 1, nEl);
    }
  }
  const mesh = new THREE.Mesh(mb.build(), surfaceMaterial(color));
  mesh.userData.fovSurface = true;
  mesh.renderOrder = 5;
  g.add(mesh);

  // Outline: elevation limit circles on the outer shell, a few meridians.
  const lm = lineMaterial(color, 0.85);
  const circle = (el, r) => {
    const pts = [];
    for (let i = 0; i <= nAz; i++) pts.push(dirAzEl(lerp(az0, az1, i / nAz), el).multiplyScalar(r));
    return polyline(pts, lm);
  };
  g.add(circle(el0, r1), circle(el1, r1));
  if (r0 > 1e-3) g.add(circle(el0, r0), circle(el1, r0));
  const meridians = full ? [0, 90, 180, 270].map((a) => a * RAD) : [az0, az1];
  for (const az of meridians) {
    const pts = [];
    for (let j = 0; j <= nEl; j++) pts.push(dirAzEl(az, lerp(el0, el1, j / nEl)).multiplyScalar(r1));
    g.add(polyline(pts, lm));
    g.add(segments([[dirAzEl(az, el0).multiplyScalar(r0), dirAzEl(az, el0).multiplyScalar(r1)],
      [dirAzEl(az, el1).multiplyScalar(r0), dirAzEl(az, el1).multiplyScalar(r1)]], lm));
  }

  // Individual channel cones as rings on the outer shell.
  if (showChannels && f.channels > 1) {
    const cm = lineMaterial(color, 0.35);
    for (let c = 0; c < f.channels; c++) {
      const el = lerp(el0, el1, c / (f.channels - 1));
      const pts = [];
      for (let i = 0; i <= nAz; i++) pts.push(dirAzEl(lerp(az0, az1, i / nAz), el).multiplyScalar(r1));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), cm));
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// Hook into PlacedSensor

PlacedSensor.prototype.buildFov = function buildFov() {
  for (const c of [...this.fovGroup.children]) {
    this.fovGroup.remove(c);
    c.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  }
  const f = effectiveFov(this);
  this.effectiveFov = f;
  if (!f) return;
  if (f.model === 'frustum') {
    this.fovGroup.add(buildFrustum(f, this.color));
    if (this.type === 'stereo_camera' && this.show.eyes && this.resolved.baseline_m) {
      const b = this.resolved.baseline_m / 2;
      this.fovGroup.add(buildFrustum(f, this.color, b, true), buildFrustum(f, this.color, -b, true));
    }
  } else if (f.model === 'spinning') {
    this.fovGroup.add(buildSpinning(f, this.color, this.show.channels));
  }
};

PlacedSensor.prototype.rebuildFov = function rebuildFov() {
  this.buildFov();
  this.applyVisibility();
};

// ---------------------------------------------------------------------------
// Panel controls for a sensor's FoV

export function fovControls(sensor, app, h) {
  const f = sensor.resolved.fov;
  if (!f) return null;
  const rows = [];
  const update = () => { sensor.rebuildFov(); app.sensorChanged(sensor); refresh(); };

  const maxR = f.range_max_m ?? 100;
  const range = h('input', { type: 'range', class: 'grow', min: 0.5, max: maxR, step: 0.1 });
  const rangeNum = h('input', { type: 'number', min: 0.1, max: maxR, step: 0.5, style: { width: '64px' } });
  const set = (v) => {
    sensor.displayRange = THREE.MathUtils.clamp(v, 0.1, maxR);
    update();
  };
  range.addEventListener('input', () => set(+range.value));
  rangeNum.addEventListener('change', () => set(+rangeNum.value));
  const info = h('div', { class: 'summary muted' });
  function refresh() {
    const e = sensor.effectiveFov;
    if (!e) return;
    range.value = e.display_max_m;
    rangeNum.value = +e.display_max_m.toFixed(2);
    const span = e.model === 'spinning'
      ? `${(e.azimuth_max_deg - e.azimuth_min_deg).toFixed(1)}° az × ${e.elevation_min_deg}°…${e.elevation_max_deg}° el`
      : `${e.hfov_deg.toFixed(1)}°H × ${e.vfov_deg.toFixed(1)}°V`;
    info.textContent = `FoV ${span} · datasheet range ${e.range_min_m}–${e.range_max_m} m · shown to ${e.display_max_m.toFixed(1)} m`;
  }
  rows.push(h('div', { class: 'row' }, h('label', { title: 'Range drawn in the view (the datasheet range is kept for exports)' }, 'Show range'),
    range, rangeNum, h('span', { class: 'muted' }, 'm')));

  if (f.model === 'spinning') {
    const az = (key, label) => h('input', {
      type: 'number', step: 5, value: sensor.fovOverride[key] ?? f[key], style: { width: '64px' },
      title: `${label}: measured from the sensor +x axis, counter-clockwise [deg]`,
      onchange: (e) => { sensor.fovOverride[key] = +e.target.value; update(); },
    });
    rows.push(h('div', { class: 'row' }, h('label', { title: 'Mask the azimuth (e.g. a lidar looking only forward)' }, 'Azimuth'),
      az('azimuth_min_deg', 'Start'), h('span', {}, '→'), az('azimuth_max_deg', 'End'), h('span', { class: 'muted' }, 'deg'),
      h('button', { class: 'small', onclick: () => { sensor.fovOverride = {}; update(); panelRefresh(); } }, 'reset')));
    rows.push(h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: sensor.show.channels, onchange: (e) => { sensor.show.channels = e.target.checked; update(); } }),
      ` Show ${f.channels || ''} channel rings`));
  }
  if (sensor.type === 'stereo_camera') {
    rows.push(h('label', { class: 'check', title: 'Left/right camera frustums offset by ± baseline/2' },
      h('input', { type: 'checkbox', checked: sensor.show.eyes, onchange: (e) => { sensor.show.eyes = e.target.checked; update(); } }),
      ` Left/right eye frustums (baseline ${(sensor.resolved.baseline_m * 1000).toFixed(0)} mm)`));
  }
  function panelRefresh() {
    for (const input of wrap.querySelectorAll('input[type=number][title^="Start"], input[type=number][title^="End"]')) {
      const key = input.title.startsWith('Start') ? 'azimuth_min_deg' : 'azimuth_max_deg';
      input.value = f[key];
    }
  }
  const wrap = h('div', {}, info, ...rows);
  refresh();
  sensor.on((what) => { if (what === 'fov') refresh(); });
  return wrap;
}
