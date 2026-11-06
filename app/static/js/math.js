// Pose helpers shared by the loader, the sensor editor and the exporters.
//
// Convention (SDF, URDF, ROS REP-103): roll/pitch/yaw are fixed-axis rotations
// about X, then Y, then Z, i.e. R = Rz(yaw) * Ry(pitch) * Rx(roll).
// In three.js this is Euler(roll, pitch, yaw, 'ZYX').
import * as THREE from 'three';

export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;

export function poseToMatrix(xyz = [0, 0, 0], rpy = [0, 0, 0]) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX'));
  return new THREE.Matrix4().compose(new THREE.Vector3(...xyz), q, new THREE.Vector3(1, 1, 1));
}

export function quatToMatrix(xyz, qxyzw) {
  const q = new THREE.Quaternion(qxyzw[0], qxyzw[1], qxyzw[2], qxyzw[3]).normalize();
  return new THREE.Matrix4().compose(new THREE.Vector3(...xyz), q, new THREE.Vector3(1, 1, 1));
}

/** Decompose a rigid transform into xyz, rpy (rad) and quaternion [x,y,z,w]. */
export function matrixToPose(m) {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  m.decompose(p, q, s);
  const e = new THREE.Euler().setFromQuaternion(q, 'ZYX');
  return {
    xyz: [p.x, p.y, p.z],
    rpy: [e.x, e.y, e.z],
    quat: [q.x, q.y, q.z, q.w],
  };
}

/** Apply a matrix to an Object3D's local transform. */
export function setObjectMatrix(obj, m) {
  m.decompose(obj.position, obj.quaternion, obj.scale);
  obj.updateMatrix();
}

/** Clean tiny floating point noise so exported numbers are readable. */
export function clean(v, digits = 6) {
  const r = Number(v.toFixed(digits));
  return Object.is(r, -0) ? 0 : r;
}

export function fmt(v, digits = 4) {
  return clean(v, digits).toFixed(digits);
}

/** Parse a whitespace separated list of numbers. */
export function parseNumbers(text, fallback = []) {
  if (text == null) return fallback;
  const nums = text.trim().split(/\s+/).filter(Boolean).map(Number);
  return nums.some(Number.isNaN) ? fallback : nums;
}
