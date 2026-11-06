// Side panel: robot options, sensor catalog, placed sensors (pose editor).
import { TYPE_LABELS, isCamera } from './sensors.js';
import { DEG, RAD, fmt, clean } from './math.js';
import { fileUrl } from './api.js';

/** Tiny DOM builder: h('div', {class:'x', onclick: fn}, child, 'text', ...) */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function section(title, ...kids) {
  return h('div', { class: 'section' }, h('h3', {}, ...(Array.isArray(title) ? title : [title])), ...kids);
}

function checkbox(label, checked, onchange, title) {
  return h('label', { class: 'check', title },
    h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }), ' ', label);
}

function numberInput(value, { step = 0.01, digits = 4, onchange, title } = {}) {
  const input = h('input', { type: 'number', step, value: clean(value, digits), title });
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) onchange(v);
  });
  // Mouse wheel / arrow keys fire 'input' – apply live for smooth tuning.
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v) && document.activeElement === input) onchange(v);
  });
  return input;
}

function linkOptions(robot, selected) {
  return [...robot.links.keys()].map((name) =>
    h('option', { value: name, selected: name === selected }, name === robot.bodyLink ? `${name} (body)` : name));
}

export function fovSummary(spec) {
  const f = spec.fov;
  if (!f) return 'no FoV (frame only)';
  const r = f.range_max_m != null ? `, ${f.range_min_m ?? 0}–${f.range_max_m} m` : '';
  if (f.model === 'frustum') return `${f.hfov_deg}°H × ${f.vfov_deg}°V${r}`;
  if (f.model === 'pinhole') return `lens dependent (pinhole ${f.sensor_w_mm}×${f.sensor_h_mm} mm sensor)${r}`;
  if (f.model === 'spinning') {
    return `${f.azimuth_max_deg - f.azimuth_min_deg}°H × ${f.elevation_min_deg}°…+${f.elevation_max_deg}°V${r}`;
  }
  return f.model;
}

// ---------------------------------------------------------------------------

export class Panel {
  /**
   * @param {HTMLElement} root
   * @param {object} app  controller: { state, addSensor, removeSensor, duplicateSensor,
   *                      select, setLinkFramesVisible, setRobotOpacity, ... }
   */
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.cards = new Map();   // sensor -> { card, refresh }
  }

  render() {
    const { state } = this.app;
    this.root.innerHTML = '';
    this.cards.clear();
    if (!state.robot) return;
    this.root.append(
      this.robotSection(),
      this.catalogSection(),
      this.sensorsSection(),
    );
    for (const s of state.sensors) this.addCard(s);
    this.updateEmpty();
  }

  // ---- robot ----------------------------------------------------------------
  robotSection() {
    const { state } = this.app;
    const r = state.robot;
    return section('Robot',
      h('div', { class: 'row' }, h('label', {}, 'Model'), h('code', { class: 'grow' }, r.name)),
      h('div', { class: 'row' }, h('label', {}, 'Body link'), h('code', { class: 'grow' }, r.bodyLink),
        h('span', { class: 'muted' }, 'X forward')),
      h('div', { class: 'row' }, h('label', {}, 'Opacity'),
        h('input', {
          type: 'range', class: 'grow', min: 0.1, max: 1, step: 0.05, value: state.robotOpacity,
          oninput: (e) => this.app.setRobotOpacity(+e.target.value),
        })),
      h('div', { class: 'row' }, h('label', { title: 'Default FoV range drawn for sensors without their own "Show range"' }, 'FoV range'),
        h('input', {
          type: 'number', min: 0.5, step: 1, value: this.app.fovSettings.maxDisplayRange, style: { width: '70px' },
          onchange: (e) => { const v = +e.target.value; if (v > 0) this.app.setMaxDisplayRange(v); },
        }), h('span', { class: 'muted' }, 'm (cap)')),
      h('div', { class: 'row' },
        checkbox('Link frames', state.showLinkFrames, (v) => this.app.setLinkFramesVisible(v)),
        checkbox('Body frame', state.showBodyFrame, (v) => this.app.setBodyFrameVisible(v)),
        checkbox('Grid', true, (v) => { this.app.viewer.grid.visible = v; })),
    );
  }

  // ---- catalog --------------------------------------------------------------
  catalogSection() {
    const { state } = this.app;
    const attach = h('select', { class: 'grow', onchange: (e) => { state.attachLink = e.target.value; } },
      linkOptions(state.robot, state.attachLink));
    const groups = new Map();
    for (const entry of state.catalog) {
      if (!groups.has(entry.category)) groups.set(entry.category, []);
      groups.get(entry.category).push(entry);
    }
    const body = [];
    for (const [cat, entries] of groups) {
      body.push(h('details', { class: 'cat-group', open: true },
        h('summary', {}, cat),
        entries.map((e) => this.catalogItem(e))));
    }
    if (!state.catalog.length) body.push(h('p', { class: 'muted' }, 'No datasheets in sensors/.'));
    return section('Sensor catalog',
      h('div', { class: 'row' }, h('label', {}, 'Attach to'), attach),
      ...body);
  }

  catalogItem(entry) {
    const spec = entry.spec;
    const datasheet = h('a', { href: fileUrl(entry.datasheet), target: '_blank', rel: 'noopener' }, 'datasheet');
    if (!spec) {
      return h('div', { class: 'cat-item' },
        h('div', { class: 'title' }, h('span', { class: 'grow' }, entry.id.split('/').pop()),
          h('span', { class: 'badge' }, 'no spec')),
        h('div', { class: 'summary' }, entry.error || 'No .sensor.json spec file yet.'),
        h('div', { class: 'row' }, datasheet, h('span', { class: 'grow' }),
          this.app.openSpecEditor ? h('button', { class: 'small', onclick: () => this.app.openSpecEditor(entry) }, 'Enter specs…') : null));
    }
    const variant = h('select', { class: 'grow' },
      (spec.variants || []).map((v) => h('option', { value: v.id, selected: v.id === spec.defaultVariant }, v.name)));
    return h('div', { class: 'cat-item' },
      h('div', { class: 'title' },
        h('span', { class: 'grow' }, `${spec.manufacturer ? spec.manufacturer + ' ' : ''}${spec.name}`),
        h('span', { class: 'badge' }, TYPE_LABELS[spec.type] || spec.type)),
      h('div', { class: 'summary' }, fovSummary(spec)),
      h('div', { class: 'row' }, variant,
        h('button', {
          class: 'primary small',
          onclick: () => this.app.addSensor(entry, { variantId: variant.value }),
        }, 'Add')),
      h('div', { class: 'row' }, datasheet));
  }

  // ---- placed sensors -----------------------------------------------------
  sensorsSection() {
    this.sensorList = h('div', {});
    this.emptyNote = h('p', { class: 'muted' }, 'No sensors yet: pick one from the catalog and press Add.');
    this.sensorHeader = h('span', { class: 'grow' }, 'Placed sensors');
    return section([this.sensorHeader,
      h('button', { class: 'small', title: 'Show/hide all FoVs', onclick: () => this.app.toggleAllFov() }, 'FoV all')],
    this.emptyNote, this.sensorList);
  }

  updateEmpty() {
    const n = this.app.state.sensors.length;
    if (this.emptyNote) this.emptyNote.hidden = n > 0;
    if (this.sensorHeader) this.sensorHeader.textContent = `Placed sensors (${n})`;
  }

  addCard(sensor) {
    const card = this.buildCard(sensor);
    this.sensorList.append(card.el);
    this.cards.set(sensor, card);
    this.updateEmpty();
  }

  removeCard(sensor) {
    const card = this.cards.get(sensor);
    if (card) {
      card.unsubscribe();
      card.el.remove();
    }
    this.cards.delete(sensor);
    this.updateEmpty();
  }

  setSelected(sensor) {
    for (const [s, card] of this.cards) {
      card.el.classList.toggle('selected', s === sensor);
      if (s === sensor) card.refreshPose();
    }
    const card = this.cards.get(sensor);
    if (card) card.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  buildCard(s) {
    const app = this.app;
    const robot = app.state.robot;
    const el = h('div', { class: 'sensor-card' });
    el.style.setProperty('--card-color', s.color);

    const nameLabel = h('span', { class: 'name' }, s.name);
    const head = h('div', { class: 'head', onclick: () => app.select(s) },
      nameLabel,
      h('span', { class: 'badge' }, TYPE_LABELS[s.type] || s.type),
      h('button', {
        class: 'small', title: 'Show/hide this sensor',
        onclick: (e) => {
          e.stopPropagation();
          s.hidden = !s.hidden;
          s.setHidden(s.hidden);
          e.target.textContent = s.hidden ? 'show' : 'hide';
        },
      }, 'hide'));

    // Identity
    const nameInput = h('input', {
      class: 'grow', value: s.name, title: 'Frame name (used as the child frame in exports)',
      onchange: (e) => {
        const v = e.target.value.trim().replace(/[^A-Za-z0-9_]/g, '_');
        if (!v) return;
        e.target.value = v;
        s.rename(v);
        nameLabel.textContent = v;
      },
    });
    const variants = s.spec.variants || [];
    const variantSel = h('select', {
      class: 'grow',
      onchange: (e) => { s.variantId = e.target.value; s.rebuild(); app.sensorChanged(s); refreshInfo(); },
    }, variants.map((v) => h('option', { value: v.id, selected: v.id === s.variantId }, v.name)));

    const parentSel = h('select', {
      class: 'grow',
      onchange: (e) => app.reparentSensor(s, e.target.value),
    }, linkOptions(robot, s.parentLink));

    // Editable spec params (e.g. lens focal length)
    const paramRows = Object.entries(s.spec.params || {}).map(([key, def]) =>
      h('div', { class: 'row' }, h('label', { title: key }, def.label || key),
        numberInput(s.params[key], {
          step: def.step || 0.1, digits: 3,
          onchange: (v) => { s.params[key] = v; s.rebuild(); app.sensorChanged(s); refreshInfo(); },
        }),
        h('span', { class: 'muted' }, def.unit || '')));

    // Pose editor
    const posInputs = [0, 1, 2].map((i) => numberInput(0, {
      step: 0.01, digits: 4, onchange: () => applyPoseInputs(),
    }));
    const rotInputs = [0, 1, 2].map((i) => numberInput(0, {
      step: 1, digits: 3, onchange: () => applyPoseInputs(),
    }));
    function applyPoseInputs() {
      const xyz = posInputs.map((i) => parseFloat(i.value) || 0);
      const rpy = rotInputs.map((i) => (parseFloat(i.value) || 0) * RAD);
      s.setPose(xyz, rpy);
    }
    const poseGrid = h('div', { class: 'grid3' },
      h('span'), h('span', { class: 'hdr' }, 'x'), h('span', { class: 'hdr' }, 'y'), h('span', { class: 'hdr' }, 'z'),
      h('span', { class: 'axis', title: 'Translation in the parent link frame [m]' }, 'm'), ...posInputs,
      h('span'), h('span', { class: 'hdr' }, 'roll'), h('span', { class: 'hdr' }, 'pitch'), h('span', { class: 'hdr' }, 'yaw'),
      h('span', { class: 'axis', title: 'Fixed-axis roll/pitch/yaw (URDF/SDF rpy) [deg]' }, 'deg'), ...rotInputs);

    const readout = h('div', { class: 'readout' });
    const copyBtn = h('button', {
      class: 'small', title: 'Copy a static_transform_publisher command',
      onclick: () => {
        const p = s.pose;
        const cmd = `ros2 run tf2_ros static_transform_publisher --x ${fmt(p.xyz[0], 6)} --y ${fmt(p.xyz[1], 6)} --z ${fmt(p.xyz[2], 6)} `
          + `--qx ${fmt(p.quat[0], 6)} --qy ${fmt(p.quat[1], 6)} --qz ${fmt(p.quat[2], 6)} --qw ${fmt(p.quat[3], 6)} `
          + `--frame-id ${s.parentLink} --child-frame-id ${s.name}`;
        navigator.clipboard?.writeText(cmd);
        copyBtn.textContent = 'copied';
        setTimeout(() => { copyBtn.textContent = 'copy TF cmd'; }, 1200);
      },
    }, 'copy TF cmd');

    function refreshPose() {
      const p = s.pose;
      p.xyz.forEach((v, i) => { if (document.activeElement !== posInputs[i]) posInputs[i].value = clean(v, 4); });
      p.rpy.forEach((v, i) => { if (document.activeElement !== rotInputs[i]) rotInputs[i].value = clean(v * DEG, 3); });
      const m = s.mount.matrix.elements;   // column-major
      const rows = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => fmt(m[c * 4 + r], 4).padStart(8)).join(' '));
      const lines = [
        `${s.parentLink} → ${s.name}`,
        `xyz   [m]  ${p.xyz.map((v) => fmt(v, 4)).join('  ')}`,
        `rpy [deg]  ${p.rpy.map((v) => fmt(v * DEG, 3)).join('  ')}`,
        `quat xyzw  ${p.quat.map((v) => fmt(v, 5)).join('  ')}`,
        'T =',
        ...rows.map((r) => `  ${r}`),
      ];
      const body = app.state.robot.links.get(app.state.robot.bodyLink);
      if (s.parentLink !== app.state.robot.bodyLink && body) {
        const b = s.poseIn(body);
        lines.push('', `${app.state.robot.bodyLink} → ${s.name}`,
          `xyz   [m]  ${b.xyz.map((v) => fmt(v, 4)).join('  ')}`,
          `rpy [deg]  ${b.rpy.map((v) => fmt(v * DEG, 3)).join('  ')}`);
      }
      readout.textContent = lines.join('\n');
    }

    const info = h('div', { class: 'summary muted' });
    function refreshInfo() {
      const r = s.resolved;
      const notes = r.notes ? ` · ${r.notes}` : '';
      info.textContent = `${fovSummaryResolved(r)}${notes}`;
    }

    // Visibility
    const toggles = h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '10px' } },
      checkbox('Envelope', s.show.envelope, (v) => { s.show.envelope = v; s.applyVisibility(); }),
      checkbox('Frame', s.show.frame, (v) => { s.show.frame = v; s.applyVisibility(); }),
      isCamera(s.type) ? checkbox('Optical frame', s.show.optical, (v) => { s.show.optical = v; s.applyVisibility(); },
        'Camera optical frame: z forward, x right, y down') : null,
      s.resolved.fov ? checkbox('FoV', s.show.fov, (v) => { s.show.fov = v; s.applyVisibility(); app.sensorChanged(s); }) : null,
    );
    const extra = app.cardExtras ? app.cardExtras(s) : null;

    const colorInput = h('input', {
      type: 'color', value: s.color, title: 'Colour',
      oninput: (e) => {
        s.color = e.target.value;
        el.style.setProperty('--card-color', s.color);
        s.rebuild();
        app.sensorChanged(s);
      },
    });

    const bodyEl = h('div', { class: 'body' },
      info,
      h('div', { class: 'row' }, h('label', {}, 'Frame'), nameInput, colorInput),
      variants.length > 1 ? h('div', { class: 'row' }, h('label', {}, 'Variant'), variantSel) : null,
      paramRows,
      h('div', { class: 'row' }, h('label', {}, 'Parent link'), parentSel),
      poseGrid,
      toggles,
      extra,
      readout,
      h('div', { class: 'readout-actions' },
        copyBtn,
        h('button', { class: 'small', onclick: () => app.focusSensor(s) }, 'focus'),
        h('button', { class: 'small', onclick: () => app.duplicateSensor(s) }, 'duplicate'),
        h('button', { class: 'small danger', onclick: () => app.removeSensor(s) }, 'delete')),
    );
    el.append(head, bodyEl);

    const unsubscribe = s.on((what) => {
      if (what === 'pose') refreshPose();
      if (what === 'parent') parentSel.value = s.parentLink;
    });
    refreshPose();
    refreshInfo();
    return { el, refreshPose, unsubscribe };
  }
}

export function fovSummaryResolved(r) {
  const f = r.fov;
  if (!f) return 'No FoV: frame only';
  if (f.model === 'pinhole') {
    const h = 2 * Math.atan(f.sensor_w_mm / (2 * f.focal_length_mm)) * DEG;
    const v = 2 * Math.atan(f.sensor_h_mm / (2 * f.focal_length_mm)) * DEG;
    return `f = ${f.focal_length_mm} mm → ${h.toFixed(1)}°H × ${v.toFixed(1)}°V`;
  }
  return fovSummary(r);
}
