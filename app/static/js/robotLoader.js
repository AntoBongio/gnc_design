// SDF and URDF parsing into a three.js object tree.
//
// Result:
//   {
//     name, format,
//     root:   THREE.Group in the model frame (added to the scene),
//     links:  Map<linkName, THREE.Object3D> placed at each link frame,
//     joints: [{ name, type, parent, child }],
//     rootLink, warnings: [string]
//   }
// Every visual mesh has userData.robotVisual = true (used for occlusion rays).
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { poseToMatrix, quatToMatrix, parseNumbers, setObjectMatrix, RAD } from './math.js';
import { fileUrl } from './api.js';

const DEFAULT_COLOR = new THREE.Color(0.6, 0.62, 0.66);

// ---------------------------------------------------------------------------
// Helpers

function child(el, name) {
  if (!el) return null;
  for (const c of el.children) if (c.tagName === name) return c;
  return null;
}
function children(el, name) {
  return el ? [...el.children].filter((c) => c.tagName === name) : [];
}
function text(el, name, fallback = null) {
  const c = child(el, name);
  return c ? c.textContent.trim() : fallback;
}

function dirname(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}
function joinPath(...parts) {
  const out = [];
  for (const part of parts.join('/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/**
 * Resolve a mesh URI to a project-relative path.
 *   model://<model>/<path>   -> robots/<model>/<path>
 *   package://<pkg>/<path>   -> robots/<pkg>/<path>
 *   relative/path            -> <robot dir>/relative/path
 */
function resolveUri(uri, robotPath) {
  const base = dirname(robotPath);
  const m = uri.match(/^(model|package):\/\/(.+)$/);
  if (m) return joinPath('robots', m[2]);
  if (/^file:\/\//.test(uri) || uri.startsWith('/')) return null;
  return joinPath(base, uri);
}

function makeMaterial(color, opacity = 1) {
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.75, metalness: 0.05,
    transparent: opacity < 1, opacity,
  });
}

// ---------------------------------------------------------------------------
// Geometry (shared SDF/URDF; URDF uses attributes, SDF child elements)

const meshLoaders = {
  stl: new STLLoader(),
  dae: new ColladaLoader(),
  obj: new OBJLoader(),
};

async function loadMesh(path, material, scale) {
  const ext = path.split('.').pop().toLowerCase();
  const url = fileUrl(path);
  const group = new THREE.Group();
  if (ext === 'stl') {
    const geom = await meshLoaders.stl.loadAsync(url);
    geom.computeVertexNormals();
    group.add(new THREE.Mesh(geom, material));
  } else if (ext === 'dae') {
    const dae = await meshLoaders.dae.loadAsync(url);
    // ColladaLoader converts to Y-up; undo it so the mesh stays in its own frame.
    dae.scene.rotation.set(0, 0, 0);
    dae.scene.updateMatrix();
    group.add(dae.scene);
  } else if (ext === 'obj') {
    const obj = await meshLoaders.obj.loadAsync(url);
    obj.traverse((o) => { if (o.isMesh) o.material = material; });
    group.add(obj);
  } else {
    throw new Error(`unsupported mesh format .${ext}`);
  }
  group.scale.set(...scale);
  return group;
}

/**
 * Build a visual object for a geometry description.
 * geom = { type: 'box'|'cylinder'|'sphere'|'mesh'|'capsule'|'ellipsoid', ... }
 */
async function buildGeometry(geom, material, robotPath, warnings) {
  switch (geom.type) {
    case 'box':
      return new THREE.Mesh(new THREE.BoxGeometry(...geom.size), material);
    case 'cylinder': {
      // three.js cylinders are along Y, SDF/URDF cylinders along Z.
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(geom.radius, geom.radius, geom.length, 48), material);
      mesh.rotation.x = Math.PI / 2;
      return mesh;
    }
    case 'capsule': {
      const mesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(geom.radius, geom.length, 8, 32), material);
      mesh.rotation.x = Math.PI / 2;
      return mesh;
    }
    case 'sphere':
      return new THREE.Mesh(new THREE.SphereGeometry(geom.radius, 32, 16), material);
    case 'ellipsoid': {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
      mesh.scale.set(...geom.radii);
      return mesh;
    }
    case 'mesh': {
      const path = resolveUri(geom.uri, robotPath);
      if (!path) {
        warnings.push(`mesh URI not reachable from the project: ${geom.uri}`);
        return null;
      }
      try {
        return await loadMesh(path, material, geom.scale);
      } catch (err) {
        warnings.push(`mesh ${geom.uri}: ${err.message}`);
        return null;
      }
    }
    default:
      warnings.push(`unsupported geometry <${geom.type}>`);
      return null;
  }
}

function markVisual(obj, linkName) {
  obj.traverse((o) => {
    if (o.isMesh) {
      o.userData.robotVisual = true;
      o.userData.link = linkName;
    }
  });
}

// ---------------------------------------------------------------------------
// SDF

function sdfGeometry(geomEl) {
  const g = geomEl && geomEl.firstElementChild;
  if (!g) return { type: 'none' };
  switch (g.tagName) {
    case 'box':
      return { type: 'box', size: parseNumbers(text(g, 'size'), [1, 1, 1]) };
    case 'cylinder':
      return { type: 'cylinder', radius: +text(g, 'radius', 1), length: +text(g, 'length', 1) };
    case 'capsule':
      return { type: 'capsule', radius: +text(g, 'radius', 0.5), length: +text(g, 'length', 1) };
    case 'sphere':
      return { type: 'sphere', radius: +text(g, 'radius', 1) };
    case 'ellipsoid':
      return { type: 'ellipsoid', radii: parseNumbers(text(g, 'radii'), [1, 1, 1]) };
    case 'mesh':
      return {
        type: 'mesh',
        uri: text(g, 'uri', ''),
        scale: parseNumbers(text(g, 'scale'), [1, 1, 1]),
      };
    default:
      return { type: g.tagName };
  }
}

/** Parse an SDF <pose> element: { matrix, relativeTo }. */
function sdfPose(el) {
  const poseEl = child(el, 'pose');
  if (!poseEl) return { matrix: new THREE.Matrix4(), relativeTo: null };
  const nums = parseNumbers(poseEl.textContent, [0, 0, 0, 0, 0, 0]);
  const relativeTo = poseEl.getAttribute('relative_to') || null;
  const format = poseEl.getAttribute('rotation_format') || 'euler_rpy';
  let matrix;
  if (format === 'quat_xyzw' && nums.length >= 7) {
    matrix = quatToMatrix(nums.slice(0, 3), nums.slice(3, 7));
  } else {
    const k = poseEl.getAttribute('degrees') === 'true' ? RAD : 1;
    const v = [...nums, 0, 0, 0, 0, 0, 0].slice(0, 6);
    matrix = poseToMatrix(v.slice(0, 3), v.slice(3, 6).map((a) => a * k));
  }
  return { matrix, relativeTo };
}

function sdfColor(visualEl) {
  const mat = child(visualEl, 'material');
  const rgba = parseNumbers(text(mat, 'diffuse') || text(mat, 'ambient'), null);
  if (!rgba || rgba.length < 3) return { color: DEFAULT_COLOR.clone(), opacity: 1 };
  return { color: new THREE.Color(rgba[0], rgba[1], rgba[2]), opacity: rgba[3] ?? 1 };
}

async function parseSDF(doc, robotPath) {
  const warnings = [];
  const sdf = doc.documentElement;
  let model = child(sdf, 'model');
  if (!model) {
    const world = child(sdf, 'world');
    model = world && child(world, 'model');
    if (model) warnings.push('SDF world: only the first <model> is shown');
  }
  if (!model) throw new Error('no <model> found in SDF');
  if (children(model, 'model').length || children(model, 'include').length) {
    warnings.push('nested models / includes are not rendered');
  }

  // Collect named frames in the model scope: links, joints and <frame>s.
  // Each entry: { kind, el, pose: {matrix, relativeTo}, attachedTo? }
  const frames = new Map();
  for (const el of children(model, 'link')) frames.set(el.getAttribute('name'), { kind: 'link', el, pose: sdfPose(el) });
  for (const el of children(model, 'joint')) frames.set(el.getAttribute('name'), { kind: 'joint', el, pose: sdfPose(el) });
  for (const el of children(model, 'frame')) {
    frames.set(el.getAttribute('name'), {
      kind: 'frame', el, pose: sdfPose(el), attachedTo: el.getAttribute('attached_to'),
    });
  }

  // Resolve each frame pose in the model frame (__model__).
  const resolved = new Map();
  const resolving = new Set();
  function resolve(name) {
    if (!name || name === '__model__') return new THREE.Matrix4();
    if (resolved.has(name)) return resolved.get(name);
    const f = frames.get(name);
    if (!f) {
      warnings.push(`unknown frame "${name}", using model frame`);
      return new THREE.Matrix4();
    }
    if (resolving.has(name)) throw new Error(`cycle in pose relative_to graph at "${name}"`);
    resolving.add(name);
    let base = f.pose.relativeTo;
    if (!base) {
      // SDF defaults: link -> model, joint -> child link, frame -> attached_to (or model)
      if (f.kind === 'joint') base = text(f.el, 'child');
      else if (f.kind === 'frame') base = f.attachedTo || null;
    }
    const m = resolve(base).clone().multiply(f.pose.matrix);
    resolving.delete(name);
    resolved.set(name, m);
    return m;
  }

  const root = new THREE.Group();
  root.name = model.getAttribute('name') || 'model';
  // Model <pose> places the model in the world.
  setObjectMatrix(root, sdfPose(model).matrix);

  const links = new Map();
  for (const linkEl of children(model, 'link')) {
    const name = linkEl.getAttribute('name');
    const linkObj = new THREE.Group();
    linkObj.name = name;
    linkObj.userData.isLink = true;
    setObjectMatrix(linkObj, resolve(name));
    root.add(linkObj);
    links.set(name, linkObj);

    for (const visualEl of children(linkEl, 'visual')) {
      const { color, opacity } = sdfColor(visualEl);
      const material = makeMaterial(color, opacity);
      const geom = sdfGeometry(child(visualEl, 'geometry'));
      const obj = await buildGeometry(geom, material, robotPath, warnings);
      if (!obj) continue;
      const holder = new THREE.Group();
      holder.name = visualEl.getAttribute('name') || 'visual';
      holder.userData.visual = { geom, rgba: [color.r, color.g, color.b, opacity] };
      const vp = sdfPose(visualEl);
      // Visual poses default to the link frame; relative_to another frame is
      // expressed in model frame and brought back into link coordinates.
      let m = vp.matrix;
      if (vp.relativeTo && vp.relativeTo !== name) {
        m = resolve(name).clone().invert().multiply(resolve(vp.relativeTo)).multiply(vp.matrix);
      }
      setObjectMatrix(holder, m);
      holder.add(obj);
      markVisual(holder, name);
      linkObj.add(holder);
    }
  }

  const joints = children(model, 'joint').map((el) => {
    const axisEl = child(el, 'axis');
    const limit = child(axisEl, 'limit');
    return {
      name: el.getAttribute('name'),
      type: el.getAttribute('type'),
      parent: text(el, 'parent'),
      child: text(el, 'child'),
      axis: parseNumbers(text(axisEl, 'xyz'), null),
      limit: limit ? { lower: +text(limit, 'lower', 0), upper: +text(limit, 'upper', 0) } : null,
    };
  });
  const childSet = new Set(joints.map((j) => j.child));
  const rootLink = [...links.keys()].find((n) => !childSet.has(n)) || [...links.keys()][0];

  return { name: root.name, format: 'sdf', root, links, joints, rootLink, warnings };
}

// ---------------------------------------------------------------------------
// URDF

function urdfOrigin(el) {
  const o = child(el, 'origin');
  if (!o) return new THREE.Matrix4();
  return poseToMatrix(
    parseNumbers(o.getAttribute('xyz'), [0, 0, 0]),
    parseNumbers(o.getAttribute('rpy'), [0, 0, 0]),
  );
}

function urdfGeometry(geomEl) {
  const g = geomEl && geomEl.firstElementChild;
  if (!g) return { type: 'none' };
  switch (g.tagName) {
    case 'box':
      return { type: 'box', size: parseNumbers(g.getAttribute('size'), [1, 1, 1]) };
    case 'cylinder':
      return { type: 'cylinder', radius: +g.getAttribute('radius'), length: +g.getAttribute('length') };
    case 'sphere':
      return { type: 'sphere', radius: +g.getAttribute('radius') };
    case 'mesh':
      return {
        type: 'mesh',
        uri: g.getAttribute('filename') || '',
        scale: parseNumbers(g.getAttribute('scale'), [1, 1, 1]),
      };
    default:
      return { type: g.tagName };
  }
}

function urdfColor(visualEl, namedMaterials) {
  const mat = child(visualEl, 'material');
  let rgba = null;
  if (mat) {
    const c = child(mat, 'color');
    if (c) rgba = parseNumbers(c.getAttribute('rgba'), null);
    else if (namedMaterials.has(mat.getAttribute('name'))) rgba = namedMaterials.get(mat.getAttribute('name'));
  }
  if (!rgba) return { color: DEFAULT_COLOR.clone(), opacity: 1 };
  return { color: new THREE.Color(rgba[0], rgba[1], rgba[2]), opacity: rgba[3] ?? 1 };
}

async function parseURDF(doc, robotPath) {
  const warnings = [];
  const robot = doc.documentElement;
  const namedMaterials = new Map();
  for (const m of children(robot, 'material')) {
    const c = child(m, 'color');
    if (c) namedMaterials.set(m.getAttribute('name'), parseNumbers(c.getAttribute('rgba'), null));
  }

  const links = new Map();
  for (const linkEl of children(robot, 'link')) {
    const name = linkEl.getAttribute('name');
    const linkObj = new THREE.Group();
    linkObj.name = name;
    linkObj.userData.isLink = true;
    links.set(name, linkObj);
    for (const visualEl of children(linkEl, 'visual')) {
      const { color, opacity } = urdfColor(visualEl, namedMaterials);
      const geom = urdfGeometry(child(visualEl, 'geometry'));
      const obj = await buildGeometry(geom, makeMaterial(color, opacity), robotPath, warnings);
      if (!obj) continue;
      const holder = new THREE.Group();
      holder.name = visualEl.getAttribute('name') || 'visual';
      holder.userData.visual = { geom, rgba: [color.r, color.g, color.b, opacity] };
      setObjectMatrix(holder, urdfOrigin(visualEl));
      holder.add(obj);
      markVisual(holder, name);
      linkObj.add(holder);
    }
  }

  const joints = [];
  for (const el of children(robot, 'joint')) {
    const j = {
      name: el.getAttribute('name'),
      type: el.getAttribute('type'),
      parent: child(el, 'parent')?.getAttribute('link'),
      child: child(el, 'child')?.getAttribute('link'),
      origin: urdfOrigin(el),
      axis: parseNumbers(child(el, 'axis')?.getAttribute('xyz'), null),
      limit: child(el, 'limit')
        ? { lower: +(child(el, 'limit').getAttribute('lower') || 0), upper: +(child(el, 'limit').getAttribute('upper') || 0) }
        : null,
    };
    joints.push(j);
  }

  // Place links in the model frame by walking the joint tree from the root.
  const childSet = new Set(joints.map((j) => j.child));
  const rootLink = [...links.keys()].find((n) => !childSet.has(n));
  if (!rootLink) throw new Error('URDF has no root link');
  const world = new Map([[rootLink, new THREE.Matrix4()]]);
  const queue = [rootLink];
  while (queue.length) {
    const parent = queue.shift();
    for (const j of joints.filter((jj) => jj.parent === parent)) {
      world.set(j.child, world.get(parent).clone().multiply(j.origin));
      queue.push(j.child);
    }
  }

  const root = new THREE.Group();
  root.name = robot.getAttribute('name') || 'robot';
  for (const [name, obj] of links) {
    if (!world.has(name)) warnings.push(`link "${name}" is not connected to ${rootLink}`);
    setObjectMatrix(obj, world.get(name) || new THREE.Matrix4());
    root.add(obj);
  }
  return {
    name: root.name, format: 'urdf', root, links,
    joints: joints.map(({ origin, ...rest }) => rest), rootLink, warnings,
  };
}

// ---------------------------------------------------------------------------

export async function loadRobot(path, xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error(`XML parse error: ${err.textContent.slice(0, 200)}`);
  const tag = doc.documentElement.tagName;
  if (tag === 'sdf') return parseSDF(doc, path);
  if (tag === 'robot') return parseURDF(doc, path);
  throw new Error(`unknown robot description root <${tag}>`);
}
