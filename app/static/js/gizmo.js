// Interactive selection and the translate/rotate gizmo for placed sensors.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export class Gizmo {
  constructor(viewer, app) {
    this.viewer = viewer;
    this.app = app;
    this.sensor = null;
    this.snap = false;

    const tc = new TransformControls(viewer.camera, viewer.renderer.domElement);
    tc.setSpace('local');
    tc.setSize(0.8);
    tc.addEventListener('dragging-changed', (e) => {
      viewer.controls.enabled = !e.value;
      this.dragging = e.value;
    });
    tc.addEventListener('objectChange', () => {
      if (this.sensor) this.sensor.emit('pose');
    });
    viewer.scene.add(tc);
    this.tc = tc;

    this.buildToolbar();
    this.bindPicking();
    this.bindKeys();
  }

  attach(sensor) {
    this.sensor = sensor;
    if (sensor) this.tc.attach(sensor.mount);
    else this.tc.detach();
    this.toolbar.hidden = !sensor;
  }

  setMode(mode) {
    this.tc.setMode(mode);
    this.refreshToolbar();
  }

  setSpace(space) {
    this.tc.setSpace(space);
    this.refreshToolbar();
  }

  setSnap(on) {
    this.snap = on;
    this.tc.setTranslationSnap(on ? 0.01 : null);
    this.tc.setRotationSnap(on ? THREE.MathUtils.degToRad(5) : null);
    this.refreshToolbar();
  }

  // ---- toolbar overlaid on the viewport ------------------------------------
  buildToolbar() {
    const bar = document.createElement('div');
    bar.className = 'gizmo-bar';
    bar.hidden = true;
    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      bar.append(b);
      return b;
    };
    this.btnT = mk('Move (W)', 'Translate the sensor', () => this.setMode('translate'));
    this.btnR = mk('Rotate (E)', 'Rotate the sensor', () => this.setMode('rotate'));
    this.btnSpace = mk('Local', 'Toggle gizmo axes: sensor frame (local) / world (Q)', () =>
      this.setSpace(this.tc.space === 'local' ? 'world' : 'local'));
    this.btnSnap = mk('Snap', 'Snap to 1 cm / 5° (S)', () => this.setSnap(!this.snap));
    mk('Deselect (Esc)', 'Detach the gizmo', () => this.app.select(null));
    this.viewer.container.append(bar);
    this.toolbar = bar;
    this.refreshToolbar();
  }

  refreshToolbar() {
    this.btnT.classList.toggle('active', this.tc.mode === 'translate');
    this.btnR.classList.toggle('active', this.tc.mode === 'rotate');
    this.btnSpace.textContent = this.tc.space === 'local' ? 'Axes: sensor' : 'Axes: world';
    this.btnSnap.classList.toggle('active', this.snap);
  }

  // ---- click to select -------------------------------------------------------
  bindPicking() {
    const el = this.viewer.renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', (e) => {
      if (!down || this.dragging) return;
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
      down = null;
      if (moved > 4 || e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, this.viewer.camera);
      const sensors = this.app.state.sensors.filter((s) => s.mount.visible);
      const envs = sensors.map((s) => s.envelope).filter((g) => g.visible);
      let hit = raycaster.intersectObjects(envs, true)[0];
      if (!hit) {
        // FoV volumes are large; only use them when no envelope was hit.
        const fovs = sensors.map((s) => s.fovGroup).filter((g) => g.visible);
        hit = raycaster.intersectObjects(fovs, true).find((h) => h.object.userData.fovSurface);
      }
      if (!hit) return;   // clicking empty space keeps the selection
      let o = hit.object;
      while (o && !o.userData.sensor) o = o.parent;
      if (o) this.app.select(o.userData.sensor);
    });
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!this.sensor) return;
      switch (e.key.toLowerCase()) {
        case 'w': this.setMode('translate'); break;
        case 'e': this.setMode('rotate'); break;
        case 'q': this.setSpace(this.tc.space === 'local' ? 'world' : 'local'); break;
        case 's': this.setSnap(!this.snap); break;
        case 'f': this.app.focusSensor(this.sensor); break;
        case 'escape': this.app.select(null); break;
        default: return;
      }
      e.preventDefault();
    });
  }
}
