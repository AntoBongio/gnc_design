# gnc_design

Sensor placement viewer: load a robot description (SDF/URDF), place sensors taken
from the datasheets in `sensors/`, move them around and inspect their reference
frames, transforms and fields of view.

## Layout

- `robots/` – robot descriptions (`.sdf`, `.urdf`)
- `sensors/<category>/` – sensor datasheets (PDF) and their hand-checked
  `*.sensor.json` spec files
- `app/` – the web viewer (Python stdlib server + Three.js)
- `layouts/` – saved sensor placements

## Run

```bash
cd app && npm install      # once, fetches three.js
python3 app/server.py      # then open http://localhost:8000
```
