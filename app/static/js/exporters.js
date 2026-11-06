// Exports: URDF/SDF sensor snippets, the augmented robot description, static
// TF tables and a ROS 2 bundle (URDF + launch file + RViz config).
import * as THREE from 'three';
import { matrixToPose, clean } from './math.js';
import { isCamera, OPTICAL_RPY } from './sensors.js';
import { h } from './ui.js';
import { api } from './api.js';

const n = (v) => String(clean(v, 6));
const vec = (a) => a.map(n).join(' ');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const GENERATOR = 'gnc_design sensor placement viewer';

function hexToRgba(hex, a = 1) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b, a];
}

// ---------------------------------------------------------------------------
// Geometry → XML

/** Rotation (rpy) turning a z-axis cylinder into the requested axis. */
function cylinderRpy(axis) {
  if (axis === 'x') return [0, Math.PI / 2, 0];
  if (axis === 'y') return [-Math.PI / 2, 0, 0];
  return [0, 0, 0];
}

/** Envelope primitives → [{ geom, xyz, rpy }] in the sensor frame. */
function envelopeVisuals(sensor) {
  const out = [];
  for (const p of sensor.resolved.envelope) {
    if (p.shape === 'box') out.push({ geom: { type: 'box', size: p.size }, xyz: p.center || [0, 0, 0], rpy: [0, 0, 0] });
    else if (p.shape === 'cylinder' && p.length > 0) {
      out.push({
        geom: { type: 'cylinder', radius: Math.max(p.radius, p.radiusTop ?? 0, p.radiusBottom ?? 0), length: p.length },
        xyz: p.center || [0, 0, 0], rpy: cylinderRpy(p.axis || 'z'),
      });
    } else if (p.shape === 'sphere') out.push({ geom: { type: 'sphere', radius: p.radius }, xyz: p.center || [0, 0, 0], rpy: [0, 0, 0] });
  }
  return out;
}

function urdfGeom(g, meshPrefix) {
  switch (g.type) {
    case 'box': return `<box size="${vec(g.size)}"/>`;
    case 'cylinder': return `<cylinder radius="${n(g.radius)}" length="${n(g.length)}"/>`;
    case 'capsule': return `<cylinder radius="${n(g.radius)}" length="${n(g.length + 2 * g.radius)}"/><!-- capsule approximated -->`;
    case 'sphere': return `<sphere radius="${n(g.radius)}"/>`;
    case 'ellipsoid': return `<sphere radius="${n(Math.max(...g.radii))}"/><!-- ellipsoid approximated -->`;
    case 'mesh': return `<mesh filename="${esc(meshPrefix ? meshPrefix(g.uri) : g.uri)}" scale="${vec(g.scale)}"/>`;
    default: return null;
  }
}

function sdfGeom(g) {
  switch (g.type) {
    case 'box': return `<box><size>${vec(g.size)}</size></box>`;
    case 'cylinder': return `<cylinder><radius>${n(g.radius)}</radius><length>${n(g.length)}</length></cylinder>`;
    case 'sphere': return `<sphere><radius>${n(g.radius)}</radius></sphere>`;
    default: return null;
  }
}

function urdfVisual(name, v, rgba, ind, meshPrefix) {
  const g = urdfGeom(v.geom, meshPrefix);
  if (!g) return '';
  return `${ind}<visual name="${esc(name)}">
${ind}  <origin xyz="${vec(v.xyz)}" rpy="${vec(v.rpy)}"/>
${ind}  <geometry>${g}</geometry>
${ind}  <material name="${esc(name)}_mat"><color rgba="${vec(rgba)}"/></material>
${ind}</visual>\n`;
}

// ---------------------------------------------------------------------------
// Sensor snippets

export function sensorUrdf(sensors, ind = '  ') {
  let out = '';
  for (const s of sensors) {
    const p = s.pose;
    const rgba = hexToRgba(s.color);
    out += `${ind}<!-- ${esc(s.spec.manufacturer || '')} ${esc(s.resolved.variantName)} (${esc(s.catalogId)}) -->\n`;
    out += `${ind}<link name="${esc(s.name)}">\n`;
    envelopeVisuals(s).forEach((v, i) => { out += urdfVisual(`${s.name}_envelope_${i}`, v, rgba, `${ind}  `); });
    out += `${ind}</link>\n`;
    out += `${ind}<joint name="${esc(s.name)}_joint" type="fixed">
${ind}  <parent link="${esc(s.parentLink)}"/>
${ind}  <child link="${esc(s.name)}"/>
${ind}  <origin xyz="${vec(p.xyz)}" rpy="${vec(p.rpy)}"/>
${ind}</joint>\n`;
    if (isCamera(s.type)) {
      out += `${ind}<link name="${esc(s.name)}_optical"/>
${ind}<joint name="${esc(s.name)}_optical_joint" type="fixed">
${ind}  <parent link="${esc(s.name)}"/>
${ind}  <child link="${esc(s.name)}_optical"/>
${ind}  <origin xyz="0 0 0" rpy="${vec(OPTICAL_RPY)}"/>
${ind}</joint>\n`;
    }
  }
  return out;
}

export function sensorSdf(sensors, ind = '    ') {
  let out = '';
  for (const s of sensors) {
    const p = s.pose;
    const [r, g, b, a] = hexToRgba(s.color);
    out += `${ind}<!-- ${esc(s.spec.manufacturer || '')} ${esc(s.resolved.variantName)} (${esc(s.catalogId)}) -->\n`;
    out += `${ind}<link name="${esc(s.name)}">\n${ind}  <pose relative_to="${esc(s.parentLink)}">${vec([...p.xyz, ...p.rpy])}</pose>\n`;
    envelopeVisuals(s).forEach((v, i) => {
      out += `${ind}  <visual name="envelope_${i}">
${ind}    <pose>${vec([...v.xyz, ...v.rpy])}</pose>
${ind}    <geometry>${sdfGeom(v.geom)}</geometry>
${ind}    <material><ambient>${vec([r, g, b, a])}</ambient><diffuse>${vec([r, g, b, a])}</diffuse></material>
${ind}  </visual>\n`;
    });
    out += `${ind}</link>\n`;
    out += `${ind}<joint name="${esc(s.name)}_joint" type="fixed">
${ind}  <parent>${esc(s.parentLink)}</parent>
${ind}  <child>${esc(s.name)}</child>
${ind}</joint>\n`;
    if (isCamera(s.type)) {
      out += `${ind}<frame name="${esc(s.name)}_optical" attached_to="${esc(s.name)}">
${ind}  <pose relative_to="${esc(s.name)}">${vec([0, 0, 0, ...OPTICAL_RPY])}</pose>
${ind}</frame>\n`;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Whole robot as URDF (works for SDF and URDF inputs)

const URDF_JOINT_TYPES = new Set(['revolute', 'continuous', 'prismatic', 'fixed', 'floating', 'planar']);

export function robotUrdf(robot, sensors, { meshPrefix } = {}) {
  let out = `<?xml version="1.0"?>\n<!-- Generated by ${GENERATOR} from the ${robot.format.toUpperCase()} robot plus placed sensors. -->\n`;
  out += `<robot name="${esc(robot.name)}">\n`;
  for (const [name, link] of robot.links) {
    out += `  <link name="${esc(name)}">\n`;
    link.children.forEach((holder) => {
      const v = holder.userData.visual;
      if (!v) return;
      const pose = matrixToPose(holder.matrix);
      out += urdfVisual(holder.name, { geom: v.geom, xyz: pose.xyz, rpy: pose.rpy }, v.rgba, '    ', meshPrefix);
    });
    out += '  </link>\n';
  }
  for (const j of robot.joints) {
    const parent = robot.links.get(j.parent);
    const child = robot.links.get(j.child);
    if (!parent || !child) {
      out += `  <!-- joint ${esc(j.name)} skipped: parent "${esc(j.parent)}" is not a link -->\n`;
      continue;
    }
    const origin = matrixToPose(parent.matrix.clone().invert().multiply(child.matrix));
    let type = j.type;
    let note = '';
    if (!URDF_JOINT_TYPES.has(type)) { note = ` <!-- ${esc(type)} joint exported as fixed -->`; type = 'fixed'; }
    out += `  <joint name="${esc(j.name)}" type="${type}">${note}
    <parent link="${esc(j.parent)}"/>
    <child link="${esc(j.child)}"/>
    <origin xyz="${vec(origin.xyz)}" rpy="${vec(origin.rpy)}"/>\n`;
    if (type !== 'fixed' && type !== 'floating') out += `    <axis xyz="${vec(j.axis || [1, 0, 0])}"/>\n`;
    if (type === 'revolute' || type === 'prismatic') {
      const l = j.limit || { lower: 0, upper: 0 };
      out += `    <limit lower="${n(l.lower)}" upper="${n(l.upper)}" effort="0" velocity="0"/>\n`;
    }
    out += '  </joint>\n';
  }
  out += '\n  <!-- ===== Sensors ===== -->\n';
  out += sensorUrdf(sensors);
  out += '</robot>\n';
  return out;
}

/** Original SDF with sensor links/joints inserted before the last </model>. */
export function augmentedSdf(sourceText, sensors) {
  const i = sourceText.lastIndexOf('</model>');
  if (i < 0) throw new Error('no </model> in the SDF');
  return `${sourceText.slice(0, i)}\n    <!-- ===== Sensors (generated by ${GENERATOR}) ===== -->\n${sensorSdf(sensors)}  ${sourceText.slice(i)}`;
}

/** Original URDF with sensor links/joints inserted before </robot>. */
export function augmentedUrdf(sourceText, sensors) {
  const i = sourceText.lastIndexOf('</robot>');
  if (i < 0) throw new Error('no </robot> in the URDF');
  return `${sourceText.slice(0, i)}\n  <!-- ===== Sensors (generated by ${GENERATOR}) ===== -->\n${sensorUrdf(sensors)}${sourceText.slice(i)}`;
}

// ---------------------------------------------------------------------------
// TF tables

function tfRows(sensors) {
  const rows = [];
  for (const s of sensors) {
    const p = s.pose;
    rows.push({ parent: s.parentLink, child: s.name, xyz: p.xyz, quat: p.quat, rpy: p.rpy });
    if (isCamera(s.type)) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...OPTICAL_RPY, 'ZYX'));
      rows.push({ parent: s.name, child: `${s.name}_optical`, xyz: [0, 0, 0], quat: [q.x, q.y, q.z, q.w], rpy: OPTICAL_RPY });
    }
  }
  return rows;
}

export function tfYaml(sensors, robot) {
  let out = `# Static transforms parent -> child (generated by ${GENERATOR})\n`;
  out += `# robot: ${robot.name}   body link: ${robot.bodyLink} (x forward, y left, z up)\n`;
  out += '# translation [m], rotation as quaternion [x, y, z, w] and fixed-axis rpy [rad]\n';
  out += 'transforms:\n';
  for (const r of tfRows(sensors)) {
    out += `  - parent: ${r.parent}\n    child: ${r.child}\n    translation: [${r.xyz.map(n).join(', ')}]\n`
      + `    rotation_xyzw: [${r.quat.map(n).join(', ')}]\n    rpy: [${r.rpy.map(n).join(', ')}]\n`;
  }
  return out;
}

export function tfCsv(sensors) {
  const lines = ['parent,child,x,y,z,qx,qy,qz,qw,roll,pitch,yaw'];
  for (const r of tfRows(sensors)) lines.push([r.parent, r.child, ...r.xyz, ...r.quat, ...r.rpy].map((v) => (typeof v === 'number' ? n(v) : v)).join(','));
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// ROS 2 bundle

function launchPy() {
  return `# Generated by ${GENERATOR}.
# Usage:
#   source /path/to/ros2/install/setup.bash
#   ros2 launch display.launch.py
import os

from launch import LaunchDescription
from launch_ros.actions import Node

HERE = os.path.dirname(os.path.realpath(__file__))


def generate_launch_description():
    with open(os.path.join(HERE, 'robot_with_sensors.urdf'), encoding='utf-8') as f:
        robot_description = f.read()
    return LaunchDescription([
        Node(
            package='robot_state_publisher',
            executable='robot_state_publisher',
            parameters=[{'robot_description': robot_description}],
        ),
        # Publishes zero positions for the movable joints (e.g. wheels).
        Node(package='joint_state_publisher', executable='joint_state_publisher'),
        Node(
            package='rviz2',
            executable='rviz2',
            arguments=['-d', os.path.join(HERE, 'view.rviz')],
        ),
    ])
`;
}

function rvizConfig(fixedFrame, distance) {
  return `Panels:
  - Class: rviz_common/Displays
    Name: Displays
Visualization Manager:
  Class: ""
  Displays:
    - Class: rviz_default_plugins/Grid
      Name: Grid
      Enabled: true
      Reference Frame: <Fixed Frame>
      Cell Size: 1
      Plane Cell Count: 40
    - Class: rviz_default_plugins/RobotModel
      Name: RobotModel
      Enabled: true
      Alpha: 0.7
      Description Source: Topic
      Description Topic:
        Value: /robot_description
    - Class: rviz_default_plugins/TF
      Name: TF
      Enabled: true
      Show Names: true
      Show Axes: true
      Show Arrows: false
      Marker Scale: 1
  Enabled: true
  Global Options:
    Fixed Frame: ${fixedFrame}
    Background Color: 48; 48; 48
    Frame Rate: 30
  Name: root
  Tools:
    - Class: rviz_default_plugins/Interact
    - Class: rviz_default_plugins/MoveCamera
    - Class: rviz_default_plugins/Measure
  Views:
    Current:
      Class: rviz_default_plugins/Orbit
      Name: Current View
      Distance: ${n(distance)}
      Focal Point:
        X: 0
        Y: 0
        Z: 0
      Pitch: 0.5
      Yaw: 3.9
      Target Frame: <Fixed Frame>
Window Geometry:
  Height: 900
  Width: 1400
`;
}

export function rosBundle(app, name) {
  const { robot } = app.state;
  const sensors = app.state.sensors;
  const size = robot.bodyBounds.getSize(new THREE.Vector3()).length();
  // Meshes: model:// and package:// point into robots/; the server swaps the
  // placeholder for the absolute project path so RViz can load them.
  const meshPrefix = (uri) => {
    const m = uri.match(/^(model|package):\/\/(.+)$/);
    if (m) return `file://__PROJECT_ROOT__/robots/${m[2]}`;
    if (/^[a-z]+:\/\//.test(uri) || uri.startsWith('/')) return uri;
    const dir = app.state.robotPath.split('/').slice(0, -1).join('/');
    return `file://__PROJECT_ROOT__/${dir}/${uri}`;
  };
  return {
    'robot_with_sensors.urdf': robotUrdf(robot, sensors, { meshPrefix }),
    'static_tf.yaml': tfYaml(sensors, robot),
    'static_tf.csv': tfCsv(sensors),
    'display.launch.py': launchPy(),
    'view.rviz': rvizConfig(robot.rootLink, Math.max(size * 2.2, 3)),
    'README.md': `# ${name}\n\nGenerated by ${GENERATOR} from \`${app.state.robotPath}\` with ${sensors.length} sensor(s).\n\n`
      + '```bash\nsource /home/abongio/ros_lyrical/install/setup.bash\n'
      + `ros2 launch exports/${name}/display.launch.py\n\`\`\`\n\n`
      + `Check a transform:\n\n\`\`\`bash\nros2 run tf2_ros tf2_echo ${robot.bodyLink} <sensor_frame>\n\`\`\`\n`,
  };
}

// ---------------------------------------------------------------------------
// UI

function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportControls(app) {
  const status = h('div', { class: 'summary muted', style: { whiteSpace: 'pre-line' } });
  const base = () => app.state.layoutName || app.state.robot.name;
  const guard = (fn) => async () => {
    if (!app.state.sensors.length) { status.textContent = 'Place at least one sensor first.'; return; }
    try { await fn(); } catch (err) { status.textContent = `Export failed: ${err.message}`; console.error(err); }
  };
  const { robot } = app.state;
  const robotFile = app.state.robotPath.split('/').pop();
  const ext = robot.format;

  const dl = (label, title, fn) => h('button', { class: 'small', title, onclick: guard(fn) }, label);
  return h('div', {},
    h('div', { class: 'row', style: { flexWrap: 'wrap' } },
      h('label', {}, 'Export'),
      dl('URDF snippet', 'Sensor links + fixed joints to paste into a URDF', () =>
        download(`${base()}_sensors.urdf.xml`, sensorUrdf(app.state.sensors))),
      dl('SDF snippet', 'Sensor links + fixed joints to paste into an SDF <model>', () =>
        download(`${base()}_sensors.sdf.xml`, sensorSdf(app.state.sensors))),
      dl(`${robotFile} + sensors`, `The original ${ext.toUpperCase()} with the sensors added (download; robots/ is not modified)`, async () => {
        const src = await api.text(app.state.robotPath);
        const text = ext === 'sdf' ? augmentedSdf(src, app.state.sensors) : augmentedUrdf(src, app.state.sensors);
        download(robotFile.replace(/\.(sdf|urdf)$/, `_with_sensors.$1`), text, 'application/xml');
      }),
      dl('TF yaml', 'Static transforms parent → child', () => download(`${base()}_static_tf.yaml`, tfYaml(app.state.sensors, robot))),
      dl('TF csv', 'Static transforms parent → child', () => download(`${base()}_static_tf.csv`, tfCsv(app.state.sensors)))),
    h('div', { class: 'row' },
      h('button', {
        class: 'small primary', title: 'Write URDF, launch file and RViz config to exports/<layout>/',
        onclick: guard(async () => {
          const name = base().replace(/[^A-Za-z0-9_.-]/g, '_');
          const res = await api.writeExport(name, rosBundle(app, name));
          status.textContent = `Wrote ${res.dir}/\nsource /home/abongio/ros_lyrical/install/setup.bash\nros2 launch ${res.dir}/display.launch.py`;
        }),
      }, 'Write ROS 2 bundle'),
      h('span', { class: 'muted' }, '→ exports/<layout>/ for RViz2')),
    status);
}
