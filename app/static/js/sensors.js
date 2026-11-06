// Placed sensors: spec resolution (variant + editable params), envelope
// geometry, reference frame and the mount transform to the parent link.
import * as THREE from 'three';
import { makeLabel, setVisible, disposeTree } from './viewer.js';
import { poseToMatrix, matrixToPose, setObjectMatrix, RAD } from './math.js';

export const TYPE_COLORS = {
  stereo_camera: '#2f8fd8',
  camera: '#2f8fd8',
  event_camera: '#9b59d0',
  lidar: '#e0762b',
  imu: '#2ea36b',
  default: '#7a8394',
};

export const TYPE_LABELS = {
  stereo_camera: 'stereo cam',
  camera: 'camera',
  event_camera: 'event cam',
  lidar: 'lidar',
  imu: 'imu',
};

const CAMERA_TYPES = new Set(['camera', 'stereo_camera', 'event_camera']);
export const isCamera = (type) => CAMERA_TYPES.has(type);

// ---------------------------------------------------------------------------
// Spec resolution

/** Evaluate "$param/1000"-style expressions against the param values. */
function evalExpr(value, params) {
  if (typeof value !== 'string' || !value.includes('$')) return value;
  const expr = value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    if (!(name in params)) throw new Error(`unknown parameter $${name}`);
    return `(${Number(params[name])})`;
  });
  if (!/^[0-9.+\-*/() eE]+$/.test(expr)) throw new Error(`invalid expression ${value}`);
  return Function(`"use strict"; return (${expr});`)();
}

function evalDeep(obj, params) {
  if (Array.isArray(obj)) return obj.map((v) => evalDeep(v, params));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = evalDeep(v, params);
    return out;
  }
  return evalExpr(obj, params);
}

export function defaultParams(spec) {
  const out = {};
  for (const [k, def] of Object.entries(spec.params || {})) out[k] = def.default;
  return out;
}

/** Merge the variant over the base spec and evaluate parameter expressions. */
export function resolveSpec(spec, variantId, params) {
  const variants = spec.variants || [];
  const variant = variants.find((v) => v.id === variantId)
    || variants.find((v) => v.id === spec.defaultVariant) || variants[0] || {};
  const merged = { ...spec, ...variant, variantName: variant.name || spec.name };
  delete merged.variants;
  const values = { ...defaultParams(spec), ...(params || {}) };
  return {
    ...merged,
    envelope: evalDeep(merged.envelope || [], values),
    fov: merged.fov ? evalDeep(merged.fov, values) : null,
    params: values,
    variantId: variant.id,
  };
}

// ---------------------------------------------------------------------------
// Envelope

function buildPrimitive(p, material) {
  let mesh;
  if (p.shape === 'box') {
    mesh = new THREE.Mesh(new THREE.BoxGeometry(...p.size), material);
  } else if (p.shape === 'cylinder') {
    const rTop = p.radiusTop ?? p.radius;
    const rBot = p.radiusBottom ?? p.radius;
    mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, p.length, 40), material);
    // three.js cylinder axis is +Y; rotate to the requested axis.
    if ((p.axis || 'z') === 'z') mesh.rotation.x = Math.PI / 2;
    else if (p.axis === 'x') mesh.rotation.z = -Math.PI / 2;
  } else if (p.shape === 'sphere') {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(p.radius, 24, 12), material);
  } else {
    console.warn('unknown envelope shape', p.shape);
    return null;
  }
  mesh.position.set(...(p.center || [0, 0, 0]));
  return mesh;
}

export function buildEnvelope(resolved, color) {
  const g = new THREE.Group();
  g.name = 'envelope';
  const material = new THREE.MeshStandardMaterial({
    color, roughness: 0.6, metalness: 0.1, transparent: true, opacity: 0.85,
  });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.6 });
  for (const p of resolved.envelope) {
    const mesh = buildPrimitive(p, material);
    if (!mesh || (p.length === 0)) continue;
    mesh.userData.sensorEnvelope = true;
    g.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 30), edgeMat);
    edges.position.copy(mesh.position);
    edges.rotation.copy(mesh.rotation);
    g.add(edges);
  }
  return g;
}

/** Envelope bounds in the sensor frame (for default placement). */
export function envelopeBounds(resolved) {
  const g = buildEnvelope(resolved, 0xffffff);
  g.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(g);
  disposeTree(g);
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.02, -0.02, -0.02), new THREE.Vector3(0.02, 0.02, 0.02));
  return box;
}

// ---------------------------------------------------------------------------
// Frames

function makeAxes(size, label) {
  const g = new THREE.Group();
  const axes = new THREE.AxesHelper(size);
  axes.material.depthTest = false;
  axes.material.transparent = true;
  axes.renderOrder = 30;
  g.add(axes);
  if (label) {
    const l = makeLabel(label);
    l.position.set(0, 0, size * 0.25);
    g.add(l);
  }
  return g;
}

/** Camera optical frame (z forward, x right, y down) relative to the body frame. */
export const OPTICAL_RPY = [-Math.PI / 2, 0, -Math.PI / 2];

// ---------------------------------------------------------------------------
// PlacedSensor

let counter = 0;

export class PlacedSensor {
  /**
   * @param {object} catalogEntry  entry from /api/sensors (with .spec)
   * @param {object} opts          { name, variantId, params, parentLink, xyz, rpy(rad), color, ... }
   */
  constructor(catalogEntry, opts = {}) {
    this.uid = ++counter;
    this.catalogId = catalogEntry.id;
    this.catalog = catalogEntry;
    this.spec = catalogEntry.spec;
    this.name = opts.name || `sensor_${this.uid}`;
    this.variantId = opts.variantId || this.spec.defaultVariant;
    this.params = { ...defaultParams(this.spec), ...(opts.params || {}) };
    this.parentLink = opts.parentLink;
    this.color = opts.color || TYPE_COLORS[this.spec.type] || TYPE_COLORS.default;
    this.show = {
      envelope: true, frame: true, label: true, optical: false, fov: true,
      footprint: false, occlusion: false, eyes: false,
      ...(opts.show || {}),
    };
    this.displayRange = opts.displayRange ?? null;   // null → derived from spec
    this.fovOverride = opts.fovOverride || {};        // e.g. azimuth limits for masking
    this.frameSize = opts.frameSize || 0.3;

    this.mount = new THREE.Group();
    this.mount.userData.sensor = this;
    setObjectMatrix(this.mount, poseToMatrix(opts.xyz || [0, 0, 0], opts.rpy || [0, 0, 0]));
    this.listeners = new Set();
    this.rebuild();
  }

  get type() { return this.spec.type; }
  get resolved() { return this._resolved; }

  /** Rebuild all geometry (after variant / params / colour changes). */
  rebuild() {
    for (const c of [...this.mount.children]) {
      this.mount.remove(c);
      disposeTree(c);
    }
    this._resolved = resolveSpec(this.spec, this.variantId, this.params);
    this.variantId = this._resolved.variantId;

    this.envelope = buildEnvelope(this._resolved, this.color);
    this.mount.add(this.envelope);

    this.frame = makeAxes(this.frameSize, this.name);
    this.mount.add(this.frame);

    this.optical = makeAxes(this.frameSize * 0.6, `${this.name}_optical`);
    setObjectMatrix(this.optical, poseToMatrix([0, 0, 0], OPTICAL_RPY));
    this.mount.add(this.optical);

    this.fovGroup = new THREE.Group();
    this.fovGroup.name = 'fov';
    this.mount.add(this.fovGroup);
    if (this.buildFov) this.buildFov();

    this.applyVisibility();
    this.emit('fov');
  }

  applyVisibility() {
    setVisible(this.envelope, this.show.envelope);
    setVisible(this.frame, this.show.frame);
    if (this.show.frame && !this.show.label) {
      this.frame.traverse((o) => { if (o.isCSS2DObject) o.visible = false; });
    }
    setVisible(this.optical, this.show.optical && isCamera(this.type));
    setVisible(this.fovGroup, this.show.fov);
  }

  setHidden(hidden) {
    setVisible(this.mount, !hidden);
    if (!hidden) this.applyVisibility();
  }

  // ---- pose ---------------------------------------------------------------
  /** Pose of the sensor frame in its parent link frame. */
  get pose() {
    this.mount.updateMatrix();
    return matrixToPose(this.mount.matrix);
  }

  setPose(xyz, rpy) {
    setObjectMatrix(this.mount, poseToMatrix(xyz, rpy));
    this.emit('pose');
  }

  /** Pose of the sensor frame expressed in another object's frame (e.g. the body link). */
  poseIn(obj) {
    this.mount.updateWorldMatrix(true, false);
    obj.updateWorldMatrix(true, false);
    const rel = obj.matrixWorld.clone().invert().multiply(this.mount.matrixWorld);
    return { matrix: rel, ...matrixToPose(rel) };
  }

  /** Move to another link keeping the world pose. */
  reparent(linkName, linkObj) {
    this.mount.updateWorldMatrix(true, false);
    linkObj.updateWorldMatrix(true, false);
    const world = this.mount.matrixWorld.clone();
    const local = linkObj.matrixWorld.clone().invert().multiply(world);
    linkObj.add(this.mount);
    setObjectMatrix(this.mount, local);
    this.parentLink = linkName;
    this.emit('pose');
  }

  rename(name) {
    this.name = name;
    for (const g of [this.frame, this.optical]) {
      g.traverse((o) => {
        if (o.isCSS2DObject) o.element.textContent = g === this.frame ? name : `${name}_optical`;
      });
    }
    this.emit('meta');
  }

  setFrameSize(size) {
    this.frameSize = size;
    this.rebuild();
  }

  // ---- events ---------------------------------------------------------------
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what) { for (const fn of this.listeners) fn(what, this); }

  dispose() {
    this.mount.parent?.remove(this.mount);
    disposeTree(this.mount);
    this.listeners.clear();
  }

  /** Serializable state (layouts). */
  toJSON() {
    const p = this.pose;
    return {
      name: this.name,
      sensor: this.catalogId,
      variant: this.variantId,
      params: this.params,
      parent: this.parentLink,
      xyz: p.xyz,
      rpy: p.rpy,
      color: this.color,
      show: this.show,
      displayRange: this.displayRange,
      fovOverride: this.fovOverride,
    };
  }
}

export { RAD };
