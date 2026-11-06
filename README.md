# gnc_design

Sensor placement viewer: load a robot description (SDF/URDF), place sensors taken
from the datasheets in `sensors/`, move them around and inspect their reference
frames, transforms and fields of view. It is a visualisation tool, not a simulator.

## Layout

- `robots/` – robot descriptions (`.sdf`, `.urdf`)
- `sensors/<category>/` – sensor datasheets (PDF) and their hand-checked
  `*.sensor.json` spec files (envelope, frame, FoV, variants, page references)
- `app/` – the web viewer (Python stdlib server + Three.js, no build step)
- `layouts/` – saved sensor placements
- `exports/` – generated ROS 2 bundles (git-ignored)

## Run

```bash
cd app && npm install      # once, fetches three.js into app/node_modules
python3 app/server.py      # then open http://localhost:8000
```

`?robot=robots/six_wheel_robot.sdf` or `?layout=<name>` in the URL skips the
robot picker.

## Using it

- **Frames.** The body link (`body_link`, `base_link` or the root link) follows
  REP-103: X forward, Y left, Z up. The front (+X) face is tinted and labelled
  FRONT.
- **Adding sensors.** Pick a sensor and variant in the catalog, then press
  **Add**. It lands on the front face looking +X, or at the origin of the link
  chosen in *Attach to*.
- **Moving sensors.** Click a sensor, then drag the gizmo or type xyz [m] and
  roll/pitch/yaw [deg]. Values are relative to the parent link, with
  URDF/SDF fixed-axis rpy. Changing the parent link keeps the world pose.
- **Keyboard shortcuts:**
  - W: move
  - E: rotate
  - Q: gizmo axes in the sensor or world frame
  - S: snap to 1 cm / 5°
  - F: focus on the selected sensor
  - Esc: deselect
- **True FoV.** With *FoV stops at surfaces* on (the default), each FoV ray
  ends at the first surface it hits: the robot, another sensor's envelope or
  the ground. The volume then shows what the sensor really sees. Parts ending
  on an obstacle are red, and the sensor card reports the obstructed fraction.
- **FoV.** Each sensor's FoV is drawn from its spec. A pinhole FoV (event
  camera) follows the lens focal length you enter. *Show range* limits how far
  the volume is drawn; the datasheet range is kept for exports. A LiDAR can be
  masked in azimuth and show its channel rings.
- **Analysis.**
  - *Ground footprint* shows the ground the sensor sees, minus what the robot
    hides, with the nearest and farthest ground distance.
  - *Self-occlusion* draws the rays the robot blocks in red and reports the
    blocked fraction.
- **Specs.** A PDF without a spec shows **Enter specs…**, which writes
  `<datasheet>.sensor.json` next to it.

## Exports

From the Layout section:

- URDF / SDF snippets: sensor links and fixed joints, plus camera optical frames.
- The original robot file with the sensors added, as a download only.
  `robots/` is never modified.
- Static TF tables (YAML / CSV) and a `static_transform_publisher` command per sensor.
- **Write ROS 2 bundle** writes `exports/<layout>/`:
  - `robot_with_sensors.urdf`
  - `display.launch.py` (robot_state_publisher + joint_state_publisher + RViz2)
  - `view.rviz`
  - the static TF tables

  To view it in RViz2:

  ```bash
  source /home/abongio/ros_lyrical/install/setup.bash
  ros2 launch exports/<layout>/display.launch.py
  ```
