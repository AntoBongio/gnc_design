// Three.js scene: Z-up world matching ROS/SDF conventions (X red, Y green, Z blue).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export function makeLabel(text, cls = '') {
  const div = document.createElement('div');
  div.className = `label3d ${cls}`;
  div.textContent = text;
  const obj = new CSS2DObject(div);
  obj.center.set(0, 1);
  return obj;
}

export class Viewer {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    Object.assign(this.labelRenderer.domElement.style, {
      position: 'absolute', top: '0', left: '0', pointerEvents: 'none',
    });
    container.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
    this.camera.position.set(14, -12, 9);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 2);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    // Lights
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x666677, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(10, -6, 20);
    this.scene.add(sun);

    // Ground grid on the XY plane, 1 m cells, plus a 10 m major grid.
    this.grid = new THREE.Group();
    const minor = new THREE.GridHelper(100, 100, 0x9aa3b2, 0xb8bfcc);
    const major = new THREE.GridHelper(100, 10, 0x7a8394, 0x7a8394);
    for (const g of [minor, major]) {
      g.rotation.x = Math.PI / 2;           // GridHelper is XZ; rotate to XY
      g.material.transparent = true;
      g.material.opacity = g === minor ? 0.35 : 0.6;
      g.material.depthWrite = false;
      this.grid.add(g);
    }
    this.grid.renderOrder = -1;
    this.scene.add(this.grid);

    // World frame at the origin.
    this.worldAxes = new THREE.AxesHelper(1);
    this.worldAxes.material.depthTest = false;
    this.worldAxes.renderOrder = 10;
    this.scene.add(this.worldAxes);

    this.content = new THREE.Group();     // robot + sensors go here
    this.scene.add(this.content);

    this.onFrame = [];
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    this.renderer.setAnimationLoop(() => this.render());
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.controls.update();
    for (const fn of this.onFrame) fn();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  /** Bounding box of an object (default: all robot content). */
  bounds(obj = this.content) {
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, 0), new THREE.Vector3(1, 1, 1));
    return box;
  }

  /** Move the camera to a preset view around the given bounds. */
  setView(name, box = this.bounds()) {
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.5);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = (radius / Math.sin(fov / 2)) * 1.1;
    const dirs = {
      iso: new THREE.Vector3(1, -1.1, 0.75),
      top: new THREE.Vector3(0.0001, 0, 1),
      front: new THREE.Vector3(1, 0, 0.0001),
      side: new THREE.Vector3(0, 1, 0.0001),
    };
    const dir = (dirs[name] || dirs.iso).clone().normalize();
    this.camera.up.set(0, 0, 1);
    if (name === 'top') this.camera.up.set(1, 0, 0);   // forward (+X) points up on screen
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.target.copy(center);
    this.camera.near = dist / 1000;
    this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  clearContent() {
    for (const child of [...this.content.children]) {
      this.content.remove(child);
      disposeTree(child);
    }
  }
}

export function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
    }
    if (o.isCSS2DObject && o.element?.parentNode) o.element.parentNode.removeChild(o.element);
  });
}
