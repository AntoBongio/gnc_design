import { Viewer, setVisible } from './viewer.js';
import { api } from './api.js';
import { loadRobot as parseRobot } from './robotLoader.js';
import { pickBodyLink, localBounds, makeBodyFrame, makeFrontMarker, makeLinkFrames } from './robotFrames.js';
import * as THREE from 'three';

const viewer = new Viewer(document.getElementById('viewport'));
const state = { robotPath: null, robot: null };

// ---- view preset buttons ---------------------------------------------------
document.getElementById('view-buttons').addEventListener('click', (e) => {
  const view = e.target.dataset?.view;
  if (view) viewer.setView(view);
});

// ---- robot picker ----------------------------------------------------------
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
  viewer.clearContent();
  viewer.content.add(robot.root);
  state.robotPath = path;
  state.robot = robot;

  // Body frame (X forward), front-face marker and per-link frames.
  robot.bodyLink = pickBodyLink(robot);
  const bodyObj = robot.links.get(robot.bodyLink);
  robot.bodyBounds = localBounds(bodyObj);
  if (robot.bodyBounds.isEmpty()) robot.bodyBounds.set(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  bodyObj.add(makeBodyFrame(robot.bodyLink, robot.bodyBounds));
  bodyObj.add(makeFrontMarker(robot.bodyBounds));
  robot.linkFrames = makeLinkFrames(robot, Math.max(robot.bodyBounds.getSize(new THREE.Vector3()).length() * 0.04, 0.1));
  for (const f of robot.linkFrames) setVisible(f, false);

  document.getElementById('robot-name').textContent =
    `${robot.name} · ${robot.links.size} links · ${path}`;
  history.replaceState(null, '', `?robot=${encodeURIComponent(path)}`);
  hud.textContent = robot.warnings.length ? `⚠ ${robot.warnings.join(' · ')}` : '';
  for (const w of robot.warnings) console.warn(w);
  viewer.setView('iso');
}

// ?robot=robots/xyz.sdf skips the picker (the URL is updated on every load).
const initialRobot = new URLSearchParams(location.search).get('robot');
if (initialRobot) loadRobot(initialRobot);
else openRobotPicker();
window.viewer = viewer;   // handy for debugging from the console
