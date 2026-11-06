// Layout save/load and the spec editor for datasheets without a spec file.
import { api, fileUrl } from './api.js';
import { h } from './ui.js';
import { fovSettings } from './fov.js';

export const LAYOUT_SCHEMA = 1;

export function layoutToJSON(app) {
  const { state } = app;
  return {
    schema: LAYOUT_SCHEMA,
    robot: state.robotPath,
    savedAt: new Date().toISOString(),
    settings: {
      maxDisplayRange: fovSettings.maxDisplayRange,
      clipBelowGround: fovSettings.clipBelowGround,
    },
    sensors: state.sensors.map((s) => s.toJSON()),
  };
}

/** Apply a layout: (re)load its robot if needed, then recreate the sensors. */
export async function applyLayout(app, layout) {
  if (layout.robot && layout.robot !== app.state.robotPath) await app.loadRobot(layout.robot, { keepUrl: true });
  for (const s of [...app.state.sensors]) app.removeSensor(s);
  if (layout.settings) {
    fovSettings.maxDisplayRange = layout.settings.maxDisplayRange ?? fovSettings.maxDisplayRange;
    fovSettings.clipBelowGround = layout.settings.clipBelowGround ?? fovSettings.clipBelowGround;
  }
  const missing = [];
  for (const j of layout.sensors || []) {
    const entry = app.state.catalog.find((e) => e.id === j.sensor && e.spec);
    if (!entry) { missing.push(`${j.name} (${j.sensor})`); continue; }
    if (!app.state.robot.links.has(j.parent)) { missing.push(`${j.name}: link ${j.parent} not in robot`); continue; }
    app.addSensor(entry, {
      name: j.name, variantId: j.variant, params: j.params, parentLink: j.parent,
      xyz: j.xyz, rpy: j.rpy, color: j.color, show: j.show, displayRange: j.displayRange,
      fovOverride: j.fovOverride, silent: true,
    });
  }
  app.panel.render();
  if (missing.length) alert(`Some sensors could not be restored:\n${missing.join('\n')}`);
}

export function layoutSection(app) {
  const nameInput = h('input', {
    class: 'grow', placeholder: 'layout name', value: app.state.layoutName || '',
    title: 'Letters, digits, - _ . only',
  });
  const select = h('select', { class: 'grow' }, h('option', { value: '' }, '— saved layouts —'));
  const status = h('div', { class: 'summary muted' });

  async function refreshList() {
    try {
      const names = await api.layouts();
      select.replaceChildren(h('option', { value: '' }, names.length ? '— saved layouts —' : '(none saved yet)'),
        ...names.map((n) => h('option', { value: n, selected: n === app.state.layoutName }, n)));
    } catch (err) { status.textContent = err.message; }
  }

  async function save() {
    const name = nameInput.value.trim().replace(/\s+/g, '_');
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name)) { status.textContent = 'Use letters, digits, - _ . for the name.'; return; }
    try {
      const res = await api.saveLayout(name, layoutToJSON(app));
      app.state.layoutName = name;
      app.updateUrl();
      status.textContent = `Saved ${res.saved}`;
      refreshList();
    } catch (err) { status.textContent = `Save failed: ${err.message}`; }
  }

  async function load(name) {
    if (!name) return;
    try {
      const layout = await api.loadLayout(name);
      app.state.layoutName = name;
      await applyLayout(app, layout);
      app.updateUrl();
    } catch (err) { status.textContent = `Load failed: ${err.message}`; }
  }

  refreshList();
  return h('div', { class: 'section' },
    h('h3', {}, 'Layout'),
    h('div', { class: 'row' }, nameInput, h('button', { class: 'primary small', onclick: save }, 'Save')),
    h('div', { class: 'row' }, select, h('button', { class: 'small', onclick: () => load(select.value) }, 'Load')),
    app.exportControls ? app.exportControls() : null,
    status);
}

// ---------------------------------------------------------------------------
// Spec editor

const TEMPLATES = {
  camera: {
    envelope: [{ shape: 'box', size: [0.05, 0.05, 0.05], center: [-0.025, 0, 0] }],
    fov: { model: 'frustum', hfov_deg: 90, vfov_deg: 60, range_min_m: 0.1, range_max_m: 20 },
  },
  stereo_camera: {
    envelope: [{ shape: 'box', size: [0.04, 0.15, 0.03], center: [0, 0, 0] }],
    fov: { model: 'frustum', hfov_deg: 90, vfov_deg: 60, range_min_m: 0.3, range_max_m: 20 },
    baseline_m: 0.12,
  },
  event_camera: {
    params: { focal_length_mm: { label: 'Lens focal length', unit: 'mm', default: 8, min: 1, max: 100, step: 0.5 } },
    envelope: [{ shape: 'box', size: [0.04, 0.03, 0.03], center: [-0.02, 0, 0] }],
    fov: { model: 'pinhole', sensor_w_mm: 6.4, sensor_h_mm: 4.8, focal_length_mm: '$focal_length_mm', range_min_m: 0.05, range_max_m: 20 },
  },
  lidar: {
    envelope: [{ shape: 'cylinder', axis: 'z', radius: 0.05, length: 0.08, center: [0, 0, 0] }],
    fov: { model: 'spinning', azimuth_min_deg: 0, azimuth_max_deg: 360, elevation_min_deg: -15, elevation_max_deg: 15, channels: 16, range_min_m: 0.5, range_max_m: 100 },
  },
  imu: {
    envelope: [{ shape: 'box', size: [0.04, 0.04, 0.02], center: [0, 0, 0] }],
    fov: null,
  },
};

const CATEGORY_TYPES = [
  [/lidar/i, 'lidar'], [/imu|inertial/i, 'imu'], [/event/i, 'event_camera'], [/stereo|depth/i, 'stereo_camera'],
  [/camera|rgb/i, 'camera'],
];

function guessType(entry) {
  for (const [re, t] of CATEGORY_TYPES) if (re.test(entry.category)) return t;
  return 'camera';
}

export function openSpecEditor(app, entry) {
  const pdfName = entry.datasheet.split('/').pop();
  let type = guessType(entry);
  const textarea = h('textarea', { rows: 22, spellcheck: false, style: { width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: '12px' } });
  const name = h('input', { class: 'grow', value: entry.id.split('/').pop().replace(/[_-]+/g, ' ') });
  const maker = h('input', { class: 'grow', placeholder: 'manufacturer' });
  const typeSel = h('select', { class: 'grow' },
    Object.keys(TEMPLATES).map((t) => h('option', { value: t, selected: t === type }, t)));
  const error = h('div', { class: 'summary', style: { color: 'var(--danger)' } });

  function regenerate() {
    type = typeSel.value;
    const spec = {
      schema: 1,
      name: name.value.trim(),
      manufacturer: maker.value.trim(),
      type,
      datasheet: pdfName,
      frame: { convention: 'x forward, y left, z up', origin: 'describe where the frame origin is' },
      ...structuredClone(TEMPLATES[type]),
      defaultVariant: 'default',
      variants: [{ id: 'default', name: name.value.trim() || 'default' }],
      sources: [{ what: 'fill in the page numbers you took the values from', page: null }],
    };
    textarea.value = JSON.stringify(spec, null, 2);
  }
  for (const el of [name, maker, typeSel]) el.addEventListener('change', regenerate);
  regenerate();

  const dlg = h('dialog', { class: 'spec-dialog' },
    h('h2', {}, 'Sensor spec'),
    h('p', { class: 'muted' }, 'Fill in from ', h('a', { href: fileUrl(entry.datasheet), target: '_blank' }, pdfName),
      '. Units: metres and degrees; envelope primitives and FoV are in the sensor frame. ',
      `Saved as ${entry.specFile}.`),
    h('div', { class: 'row' }, h('label', {}, 'Name'), name),
    h('div', { class: 'row' }, h('label', {}, 'Maker'), maker),
    h('div', { class: 'row' }, h('label', {}, 'Type'), typeSel,
      h('button', { class: 'small', onclick: regenerate, title: 'Reset the JSON from the template' }, 'template')),
    textarea,
    error,
    h('div', { class: 'dialog-actions' },
      h('button', { onclick: () => dlg.close() }, 'Cancel'),
      h('button', {
        class: 'primary',
        onclick: async () => {
          let spec;
          try { spec = JSON.parse(textarea.value); } catch (err) { error.textContent = `Invalid JSON: ${err.message}`; return; }
          if (!spec.type || !Array.isArray(spec.envelope)) { error.textContent = 'type and envelope[] are required'; return; }
          try {
            await api.saveSpec(entry.datasheet, spec);
            dlg.close();
            await app.refreshCatalog();
          } catch (err) { error.textContent = err.message; }
        },
      }, 'Save spec')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}
