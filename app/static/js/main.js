import * as THREE from 'three';
import { Viewer, setVisible } from './viewer.js';
import { api } from './api.js';
import { loadRobot as parseRobot } from './robotLoader.js';
import { pickBodyLink, localBounds, makeBodyFrame, makeFrontMarker, makeLinkFrames } from './robotFrames.js';
import { PlacedSensor, resolveSpec, envelopeBounds } from './sensors.js';
import { Panel, h } from './ui.js';
import { fovSettings, fovControls } from './fov.js';
import { Gizmo } from './gizmo.js';
import { computeFootprint, computeOcclusion, obstacleMeshes } from './analysis.js';
import { disposeTree } from './viewer.js';
import { layoutSection, openSpecEditor, applyLayout } from './io.js';
import { exportControls } from './exporters.js';

const viewer = new Viewer(document.getElementById('viewport'));
const state = {
  robotPath: null,
  robot: null,
  catalog: [],
  sensors: [],
  selected: null,
  attachLink: null,
  robotOpacity: 1,
  showLinkFrames: false,
  showBodyFrame: true,
};

// ---------------------------------------------------------------------------
// App controller (used by the panel and the gizmo)

const app = {
  state,
  viewer,
  fovSettings,

  /** Add a sensor from a catalog entry. opts may carry a full pose. */
  addSensor(entry, opts = {}) {
    const robot = state.robot;
    const parentLink = opts.parentLink || state.attachLink || robot.bodyLink;
    const linkObj = robot.links.get(parentLink);
    if (!linkObj) throw new Error(`unknown link ${parentLink}`);
    const name = opts.name || uniqueName(defaultName(entry.spec));
    let { xyz, rpy } = opts;
    if (!xyz) ({ xyz, rpy } = defaultPlacement(entry.spec, opts.variantId, opts.params, parentLink));
    const sensor = new PlacedSensor(entry, {
      ...opts, name, parentLink, xyz, rpy,
      frameSize: sensorFrameSize(),
    });
    sensor.obstacles = () => obstacleMeshes(state, sensor);
    sensor.on((what) => { if (what === 'pose') app.sensorChanged(sensor); });
    linkObj.add(sensor.mount);
    state.sensors.push(sensor);
    panel.addCard(sensor);
    app.sensorChanged(sensor);
    if (!opts.silent) app.select(sensor);
    return sensor;
  },

  removeSensor(sensor) {
    if (state.selected === sensor) app.select(null);
    state.sensors = state.sensors.filter((s) => s !== sensor);
    panel.removeCard(sensor);
    sensor.dispose();
    app.sensorChanged(null);
  },

  duplicateSensor(sensor) {
    const j = sensor.toJSON();
    const xyz = [...j.xyz];
    xyz[1] += 0.25;   // nudge sideways so both are visible
    app.addSensor(sensor.catalog, {
      ...j, name: uniqueName(sensor.name), variantId: j.variant, parentLink: j.parent, xyz,
      show: { ...j.show }, params: { ...j.params }, fovOverride: { ...j.fovOverride },
    });
  },

  reparentSensor(sensor, linkName) {
    const linkObj = state.robot.links.get(linkName);
    if (!linkObj) return;
    sensor.reparent(linkName, linkObj);
    sensor.emit('parent');
  },

  select(sensor) {
    state.selected = sensor;
    panel.setSelected(sensor);
    gizmo.attach(sensor);
  },

  focusSensor(sensor) {
    sensor.mount.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(sensor.envelope);
    box.expandByScalar(Math.max(box.getSize(new THREE.Vector3()).length(), 0.3));
    const center = box.getCenter(new THREE.Vector3());
    const offset = viewer.camera.position.clone().sub(viewer.controls.target);
    const dist = Math.max(box.getSize(new THREE.Vector3()).length() * 2.2, 0.8);
    viewer.controls.target.copy(center);
    viewer.camera.position.copy(center).addScaledVector(offset.normalize(), dist);
    viewer.camera.near = dist / 200;
    viewer.camera.updateProjectionMatrix();
  },

  /** Recompute derived visuals (ground footprint, occlusion) on the next frame. */
  sensorChanged(sensor) {
    if (!sensor) { for (const s of state.sensors) dirty.add(s); return; }
    dirty.add(sensor);
    // A moved sensor can block the others: refresh them once it settles.
    clearTimeout(othersTimer);
    othersTimer = setTimeout(() => {
      for (const s of state.sensors) if (s !== sensor) dirty.add(s);
    }, 250);
  },

  setClipAtSurfaces(v) {
    fovSettings.clipAtSurfaces = v;
    for (const s of state.sensors) s.rebuildFov();
    app.sensorChanged(null);
  },

  setClipBelowGround(v) {
    fovSettings.clipBelowGround = v;
    for (const s of state.sensors) s.rebuildFov();
    app.sensorChanged(null);
  },

  cardExtras(sensor) { return fovControls(sensor, app, h); },

  setMaxDisplayRange(v) {
    fovSettings.maxDisplayRange = v;
    for (const s of state.sensors) { s.rebuildFov(); s.emit('fov'); app.sensorChanged(s); }
  },

  toggleAllFov() {
    const anyOn = state.sensors.some((s) => s.show.fov);
    for (const s of state.sensors) { s.show.fov = !anyOn; s.applyVisibility(); }
    panel.render();
    app.select(state.selected);
  },

  setRobotOpacity(v) {
    state.robotOpacity = v;
    state.robot.root.traverse((o) => {
      if (o.isMesh && o.userData.robotVisual) {
        o.material.transparent = v < 1 || o.material.userData.baseOpacity < 1;
        o.material.opacity = v * (o.material.userData.baseOpacity ?? 1);
        o.material.depthWrite = v >= 0.99;
        o.material.needsUpdate = true;
      }
    });
  },

  setLinkFramesVisible(v) {
    state.showLinkFrames = v;
    for (const f of state.robot.linkFrames) setVisible(f, v);
  },

  setBodyFrameVisible(v) {
    state.showBodyFrame = v;
    setVisible(state.robot.bodyFrame, v);
  },
};

// ---------------------------------------------------------------------------
// Derived visuals, recomputed at most once per frame per sensor

const dirty = new Set();
let othersTimer = null;
viewer.onFrame.push(() => {
  if (!dirty.size || !state.robot) return;
  for (const s of dirty) updateDerived(s);
  dirty.clear();
});

function updateDerived(s) {
  if (!state.sensors.includes(s)) {
    if (s.derivedGroup) { s.derivedGroup.parent?.remove(s.derivedGroup); disposeTree(s.derivedGroup); }
    return;
  }
  if (!s.derivedGroup) {
    s.derivedGroup = new THREE.Group();
    state.overlay.add(s.derivedGroup);
    const dispose = s.dispose.bind(s);
    s.dispose = () => { s.derivedGroup.parent?.remove(s.derivedGroup); disposeTree(s.derivedGroup); dispose(); };
  }
  for (const c of [...s.derivedGroup.children]) { s.derivedGroup.remove(c); disposeTree(c); }
  s.derived = {};
  if (fovSettings.clipAtSurfaces) s.rebuildFov();     // FoV depends on the world pose
  const visible = s.mount.visible && s.show.fov;
  if (visible && s.show.footprint) {
    s.derived.footprint = computeFootprint(s, obstacleMeshes(state, s), state.groundZ);
    if (s.derived.footprint?.mesh) s.derivedGroup.add(s.derived.footprint.mesh);
  }
  if (visible && s.show.occlusion) {
    s.derived.occlusion = computeOcclusion(s, obstacleMeshes(state, s));
    if (s.derived.occlusion?.lines) s.derivedGroup.add(s.derived.occlusion.lines);
  }
  s.emit('derived');
}

// ---------------------------------------------------------------------------
// Helpers

function defaultName(spec) {
  const base = (spec.name || 'sensor').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `${base}_link`;
}

function uniqueName(base) {
  const names = new Set(state.sensors.map((s) => s.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/_\d+$/, '');
  for (let i = 2; ; i++) if (!names.has(`${stem}_${i}`)) return `${stem}_${i}`;
}

function sensorFrameSize() {
  const size = state.robot.bodyBounds.getSize(new THREE.Vector3()).length();
  return THREE.MathUtils.clamp(size * 0.03, 0.08, 0.5);
}

/**
 * Default pose: on the body link, flush with the front (+X) face, facing
 * forward, at 80 % of the body height; successive sensors are staggered in Y.
 * On any other link: at the link origin.
 */
function defaultPlacement(spec, variantId, params, parentLink) {
  const robot = state.robot;
  if (parentLink !== robot.bodyLink) return { xyz: [0, 0, 0], rpy: [0, 0, 0] };
  const b = robot.bodyBounds;
  const env = envelopeBounds(resolveSpec(spec, variantId, params));
  const n = state.sensors.filter((s) => s.parentLink === robot.bodyLink).length;
  const width = b.max.y - b.min.y;
  const step = Math.min(0.4, width / 6);
  const k = Math.ceil(n / 2) * (n % 2 ? 1 : -1);   // 0, +1, -1, +2, -2, ...
  const y = THREE.MathUtils.clamp((b.min.y + b.max.y) / 2 + k * step, b.min.y, b.max.y);
  return {
    xyz: [b.max.x - env.min.x, y, b.min.z + 0.8 * (b.max.z - b.min.z)],
    rpy: [0, 0, 0],
  };
}

// ---------------------------------------------------------------------------
// Panel, gizmo, view buttons

const panel = new Panel(document.getElementById('panel'), app);
const gizmo = new Gizmo(viewer, app);

document.getElementById('view-buttons').addEventListener('click', (e) => {
  const view = e.target.dataset?.view;
  if (view) viewer.setView(view);
});

// ---------------------------------------------------------------------------
// Robot picker / loading

const picker = document.getElementById('robot-picker');
const robotList = document.getElementById('robot-list');

async function openRobotPicker() {
  robotList.innerHTML = '<li class="muted">Loading…</li>';
  document.getElementById('robot-picker-cancel').hidden = !state.robotPath;
  if (!picker.open) picker.showModal();
  let robots;
  try {
    robots = await api.robots();
  } catch (err) {
    robotList.innerHTML = `<li class="muted">Could not list robots: ${err.message}</li>`;
    return;
  }
  robotList.innerHTML = '';
  if (!robots.length) {
    robotList.innerHTML = '<li class="muted">No .sdf or .urdf files in robots/</li>';
    return;
  }
  for (const r of robots) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = `<span>${r.name}</span><span class="badge">${r.format}</span>`;
    btn.addEventListener('click', () => {
      if (state.sensors.length && !confirm('Changing robot removes the placed sensors. Continue?')) return;
      picker.close();
      loadRobot(r.path);
    });
    li.appendChild(btn);
    robotList.appendChild(li);
  }
}

// Picker cannot be dismissed with Esc before a robot is loaded.
picker.addEventListener('cancel', (e) => { if (!state.robotPath) e.preventDefault(); });
document.getElementById('btn-change-robot').addEventListener('click', openRobotPicker);

const hud = document.getElementById('hud');

async function loadRobot(path) {
  let robot;
  try {
    robot = await parseRobot(path, await api.text(path));
  } catch (err) {
    alert(`Could not load ${path}:\n${err.message}`);
    if (!state.robotPath) openRobotPicker();
    return;
  }
  gizmo.attach(null);
  for (const s of state.sensors) s.dispose();
  state.sensors = [];
  state.selected = null;
  viewer.clearContent();
  viewer.content.add(robot.root);
  state.robotPath = path;
  state.robot = robot;

  // Remember each material's own opacity for the robot opacity slider.
  robot.root.traverse((o) => {
    if (o.isMesh && o.userData.robotVisual) {
      o.material = o.material.clone();
      o.material.userData.baseOpacity = o.material.opacity;
    }
  });

  // Body frame (X forward), front-face marker and per-link frames.
  robot.bodyLink = pickBodyLink(robot);
  const bodyObj = robot.links.get(robot.bodyLink);
  robot.bodyBounds = localBounds(bodyObj);
  if (robot.bodyBounds.isEmpty()) robot.bodyBounds.set(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  robot.bodyFrame = new THREE.Group();
  robot.bodyFrame.add(makeBodyFrame(robot.bodyLink, robot.bodyBounds), makeFrontMarker(robot.bodyBounds));
  bodyObj.add(robot.bodyFrame);
  robot.linkFrames = makeLinkFrames(robot, Math.max(robot.bodyBounds.getSize(new THREE.Vector3()).length() * 0.04, 0.1));
  for (const f of robot.linkFrames) setVisible(f, false);

  // Ground plane = lowest point of the robot visuals (wheels on the ground).
  robot.root.updateMatrixWorld(true);
  const visuals = new THREE.Box3();
  robot.root.traverse((o) => { if (o.isMesh && o.userData.robotVisual) visuals.expandByObject(o); });
  state.groundZ = visuals.isEmpty() ? 0 : visuals.min.z;
  fovSettings.groundPlane.constant = -state.groundZ;
  state.overlay = new THREE.Group();
  state.overlay.name = 'overlay';
  viewer.content.add(state.overlay);

  state.attachLink = robot.bodyLink;
  state.showLinkFrames = false;
  state.showBodyFrame = true;
  state.robotOpacity = 1;

  document.getElementById('robot-name').textContent =
    `${robot.name} · ${robot.links.size} links · ${path}`;
  state.layoutName = null;
  updateUrl();
  hud.textContent = robot.warnings.length ? `⚠ ${robot.warnings.join(' · ')}` : '';
  for (const w of robot.warnings) console.warn(w);

  await refreshCatalog();
  viewer.setView('iso');
}

function updateUrl() {
  const q = new URLSearchParams();
  if (state.robotPath) q.set('robot', state.robotPath);
  if (state.layoutName) q.set('layout', state.layoutName);
  history.replaceState(null, '', `?${q}`);
}

async function refreshCatalog() {
  try {
    state.catalog = await api.sensors();
  } catch (err) {
    state.catalog = [];
    console.error(err);
  }
  panel.render();
}

app.loadRobot = loadRobot;
app.refreshCatalog = refreshCatalog;
app.updateUrl = updateUrl;
app.panel = panel;
app.layoutSection = () => layoutSection(app);
app.exportControls = () => exportControls(app);
app.openSpecEditor = (entry) => openSpecEditor(app, entry);

// ?robot=robots/xyz.sdf skips the picker; ?layout=name restores a saved layout.
(async () => {
  const q = new URLSearchParams(location.search);
  const robotPath = q.get('robot');
  const layoutName = q.get('layout');
  if (layoutName) {
    try {
      const layout = await api.loadLayout(layoutName);
      await loadRobot(layout.robot || robotPath);
      state.layoutName = layoutName;
      await applyLayout(app, layout);
      updateUrl();
      return;
    } catch (err) {
      console.error(`layout ${layoutName}:`, err);
    }
  }
  if (robotPath) loadRobot(robotPath);
  else openRobotPicker();
})();

window.app = app;         // handy for debugging from the console
window.viewer = viewer;
