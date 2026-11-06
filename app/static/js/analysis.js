// Systems-engineering aids computed by ray sampling of each sensor's FoV:
//  - ground footprint: where the FoV meets the ground plane (inside the shown
//    range), excluding rays blocked by the robot itself;
//  - self-occlusion: rays blocked by the robot visuals, drawn as red segments,
//    with the blocked fraction of the FoV.
import * as THREE from 'three';
import { RAD } from './math.js';

function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * Sample the FoV as a grid of rays in the sensor frame.
 * Returns { nu, nv, rays: [{ dir, tmin, tmax, w }] } in row-major (v outer) order.
 */
export function sampleFov(f, nu, nv) {
  const rays = [];
  if (f.model === 'frustum') {
    const ty = Math.tan(Math.min(f.hfov_deg, 170) * RAD / 2);
    const tz = Math.tan(Math.min(f.vfov_deg, 170) * RAD / 2);
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const v = new THREE.Vector3(1, lerp(ty, -ty, i / nu), lerp(-tz, tz, j / nv));
        const k = v.length();
        // Camera range is a depth: t along the unit ray = depth * |v|.
        rays.push({ dir: v.divideScalar(k), tmin: f.display_min_m * k, tmax: f.display_max_m * k, w: 1 / (k * k * k) });
      }
    }
  } else if (f.model === 'spinning') {
    const az0 = (f.azimuth_min_deg ?? 0) * RAD;
    const az1 = (f.azimuth_max_deg ?? 360) * RAD;
    const el0 = f.elevation_min_deg * RAD;
    const el1 = f.elevation_max_deg * RAD;
    for (let j = 0; j <= nv; j++) {
      const el = lerp(el0, el1, j / nv);
      for (let i = 0; i <= nu; i++) {
        const az = lerp(az0, az1, i / nu);
        rays.push({
          dir: new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)),
          tmin: f.display_min_m, tmax: f.display_max_m, w: Math.cos(el),
        });
      }
    }
  }
  return { nu, nv, rays };
}

/**
 * Surfaces that can block a sensor: the robot visuals and the envelopes of
 * the other (visible) sensors.
 */
export function obstacleMeshes(state, sensor) {
  const out = [];
  state.robot.root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    if (o.userData.robotVisual) out.push(o);
    else if (o.userData.sensorEnvelope) {
      let p = o.parent;
      while (p && !p.userData.sensor) p = p.parent;
      const owner = p?.userData.sensor;
      if (owner && owner !== sensor && owner.mount.visible && owner.envelope.visible) out.push(o);
    }
  });
  return out;
}

const raycaster = new THREE.Raycaster();

/** World-frame origin and ray directions of a sampled FoV. */
function worldRays(sensor, sample) {
  sensor.mount.updateWorldMatrix(true, false);
  const m = sensor.mount.matrixWorld;
  const origin = new THREE.Vector3().setFromMatrixPosition(m);
  const rot = new THREE.Matrix3().setFromMatrix4(m);
  return { origin, dirs: sample.rays.map((r) => r.dir.clone().applyMatrix3(rot).normalize()) };
}

/** Distance to the first robot surface along a ray (Infinity if none). */
export function firstHit(origin, dir, meshes, far) {
  raycaster.set(origin, dir);
  raycaster.near = 1e-4;
  raycaster.far = far;
  const hit = raycaster.intersectObjects(meshes, false)[0];
  return hit ? hit.distance : Infinity;
}

// ---------------------------------------------------------------------------
// Ground footprint

export function computeFootprint(sensor, meshes, groundZ) {
  const f = sensor.effectiveFov;
  if (!f) return null;
  const [nu, nv] = f.model === 'spinning' ? [180, 120] : [80, 60];
  const sample = sampleFov(f, nu, nv);
  const { origin, dirs } = worldRays(sensor, sample);
  const pts = new Array(sample.rays.length).fill(null);
  let dMin = Infinity;
  let dMax = 0;
  for (let k = 0; k < dirs.length; k++) {
    const d = dirs[k];
    if (d.z >= -1e-6) continue;
    const t = (groundZ - origin.z) / d.z;
    const r = sample.rays[k];
    if (t < r.tmin || t > r.tmax) continue;
    if (firstHit(origin, d, meshes, t) < t) continue;     // robot is in the way
    const p = origin.clone().addScaledVector(d, t);
    pts[k] = p;
    const horiz = Math.hypot(p.x - origin.x, p.y - origin.y);
    dMin = Math.min(dMin, horiz);
    dMax = Math.max(dMax, horiz);
  }
  // Triangles whose three vertices are all valid ground hits.
  const pos = [];
  let area = 0;
  const tri = (a, b, c) => {
    pos.push(a.x, a.y, groundZ, b.x, b.y, groundZ, c.x, c.y, groundZ);
    area += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  };
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = pts[j * (nu + 1) + i];
      const b = pts[j * (nu + 1) + i + 1];
      const c = pts[(j + 1) * (nu + 1) + i];
      const d = pts[(j + 1) * (nu + 1) + i + 1];
      if (a && b && d) tri(a, b, d);
      if (a && d && c) tri(a, d, c);
    }
  }
  if (!pos.length) return { mesh: null, dMin: null, dMax: null, area: 0 };
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
    color: sensor.color, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  mesh.position.z = 0.004;   // above the grid
  mesh.renderOrder = 3;
  return { mesh, dMin, dMax, area };
}

// ---------------------------------------------------------------------------
// Self-occlusion

export function computeOcclusion(sensor, meshes) {
  const f = sensor.effectiveFov;
  if (!f) return null;
  const [nu, nv] = f.model === 'spinning' ? [144, f.channels ? f.channels - 1 : 24] : [32, 24];
  const sample = sampleFov(f, nu, nv);
  const { origin, dirs } = worldRays(sensor, sample);
  const seg = [];
  let blocked = 0;
  let total = 0;
  for (let k = 0; k < dirs.length; k++) {
    const r = sample.rays[k];
    total += r.w;
    const t = firstHit(origin, dirs[k], meshes, r.tmax);
    if (t < r.tmax) {
      blocked += r.w;
      const p = origin.clone().addScaledVector(dirs[k], t);
      seg.push(origin.x, origin.y, origin.z, p.x, p.y, p.z);
    }
  }
  let lines = null;
  if (seg.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: 0xe0302a, transparent: true, opacity: 0.55, depthWrite: false,
    }));
    lines.renderOrder = 6;
  }
  return { lines, fraction: total ? blocked / total : 0 };
}
