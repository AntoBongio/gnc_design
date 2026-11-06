import { Viewer } from './viewer.js';
import { api } from './api.js';

const viewer = new Viewer(document.getElementById('viewport'));
const state = { robotPath: null };

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

async function loadRobot(path) {
  state.robotPath = path;
  document.getElementById('robot-name').textContent = path;
  viewer.setView('iso');
}

openRobotPicker();
window.viewer = viewer;   // handy for debugging from the console
