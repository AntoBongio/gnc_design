// Reference-frame helpers drawn on the robot: the main body frame with
// labelled X (forward) / Y (left) / Z (up) arrows, a front-face marker, and
// small axes for every link.
import * as THREE from 'three';
import { makeLabel } from './viewer.js';

const COLORS = { x: 0xd8453b, y: 0x2e9d4f, z: 0x2f6fde };

/** Bounding box of a link's visuals expressed in the link's own frame. */
export function localBounds(linkObj) {
  linkObj.updateWorldMatrix(true, true);
  const inv = linkObj.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  const m = new THREE.Matrix4();
  linkObj.traverse((o) => {
    if (!o.isMesh || !o.userData.robotVisual) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    m.multiplyMatrices(inv, o.matrixWorld);
    box.union(tmp.copy(o.geometry.boundingBox).applyMatrix4(m));
  });
  return box;
}

/** Pick the body link: "body_link"/"base_link" if present, else the root link. */
export function pickBodyLink(robot) {
  for (const name of ['body_link', 'base_link', 'chassis', 'body', 'base']) {
    if (robot.links.has(name)) return name;
  }
  return robot.rootLink;
}

function arrow(dir, length, color, label, labelCls) {
  const g = new THREE.Group();
  const head = Math.min(0.35, length * 0.12);
  const a = new THREE.ArrowHelper(dir, new THREE.Vector3(), length, color, head, head * 0.55);
  for (const o of [a.line, a.cone]) {
    o.material.depthTest = false;
    o.material.transparent = true;
    o.renderOrder = 20;
  }
  a.line.material.linewidth = 2;
  g.add(a);
  const l = makeLabel(label, labelCls);
  l.position.copy(dir).multiplyScalar(length + head * 0.3);
  g.add(l);
  return g;
}

/**
 * Body frame: long arrows, X sticking out past the front face.
 * Returns a Group parented to the body link.
 */
export function makeBodyFrame(bodyName, bounds) {
  const size = bounds.getSize(new THREE.Vector3());
  const g = new THREE.Group();
  g.name = `${bodyName}_frame`;
  const xLen = Math.max(bounds.max.x, 0.5) + Math.max(size.x * 0.25, 0.5);
  const yLen = Math.max(bounds.max.y, 0.3) + Math.max(size.y * 0.2, 0.3);
  const zLen = Math.max(bounds.max.z, 0.3) + Math.max(size.z * 0.25, 0.3);
  g.add(arrow(new THREE.Vector3(1, 0, 0), xLen, COLORS.x, 'X forward', 'x'));
  g.add(arrow(new THREE.Vector3(0, 1, 0), yLen, COLORS.y, 'Y left', 'y'));
  g.add(arrow(new THREE.Vector3(0, 0, 1), zLen, COLORS.z, 'Z up', 'z'));
  const origin = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(size.length() * 0.008, 0.03), 16, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }),
  );
  origin.renderOrder = 21;
  g.add(origin);
  return g;
}

/** Translucent tint on the +X face of the body bounds with a FRONT label. */
export function makeFrontMarker(bounds) {
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const g = new THREE.Group();
  g.name = 'front_marker';
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(size.y, size.z),
    new THREE.MeshBasicMaterial({
      color: 0xe08a1e, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false,
    }),
  );
  // PlaneGeometry lies in XY facing +Z; turn it to face +X.
  plane.rotation.set(0, Math.PI / 2, 0);
  plane.rotateZ(Math.PI / 2);
  plane.position.set(bounds.max.x + 0.002, center.y, center.z);
  g.add(plane);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(plane.geometry),
    new THREE.LineBasicMaterial({ color: 0xe08a1e }),
  );
  edges.rotation.copy(plane.rotation);
  edges.position.copy(plane.position);
  g.add(edges);
  const label = makeLabel('FRONT', 'front');
  label.center.set(0.5, 0.5);
  label.position.set(bounds.max.x + 0.01, center.y, bounds.max.z);
  g.add(label);
  return g;
}

/** Small axes + name label for every link (toggleable). */
export function makeLinkFrames(robot, size = 0.4) {
  const all = [];
  for (const [name, link] of robot.links) {
    const g = new THREE.Group();
    g.name = `${name}_axes`;
    const axes = new THREE.AxesHelper(size);
    axes.material.depthTest = false;
    axes.renderOrder = 15;
    g.add(axes);
    const l = makeLabel(name);
    l.position.set(0, 0, size * 0.3);
    g.add(l);
    link.add(g);
    all.push(g);
  }
  return all;
}
