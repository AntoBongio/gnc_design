#!/usr/bin/env python3
"""Sensor placement viewer server (Python stdlib only).

Serves the static web app, the robot descriptions and sensor datasheets of the
project, and a small JSON API:

  GET  /api/robots              robot description files in robots/
  GET  /api/sensors             datasheets in sensors/ with their parsed spec
  POST /api/sensors/spec        write a <datasheet>.sensor.json spec file
  GET  /api/layouts             saved layouts
  GET  /api/layouts/<name>      load a layout
  POST /api/layouts/<name>      save a layout
  POST /api/exports/<name>      write a ROS 2 export bundle to exports/<name>/
  GET  /files/<path>            any file inside the project root (read only)
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import re
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

APP_DIR = Path(__file__).resolve().parent
ROOT = APP_DIR.parent
STATIC_DIR = APP_DIR / "static"
NODE_MODULES = APP_DIR / "node_modules"
ROBOTS_DIR = ROOT / "robots"
SENSORS_DIR = ROOT / "sensors"
LAYOUTS_DIR = ROOT / "layouts"
EXPORTS_DIR = ROOT / "exports"

ROBOT_EXTS = {".sdf", ".urdf"}
DATASHEET_EXTS = {".pdf"}
SPEC_SUFFIX = ".sensor.json"
NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/xml", ".sdf")
mimetypes.add_type("application/xml", ".urdf")
mimetypes.add_type("model/stl", ".stl")


def safe_join(base: Path, rel: str) -> Path | None:
    """Resolve rel inside base; None if it escapes base."""
    target = (base / rel).resolve()
    try:
        target.relative_to(base.resolve())
    except ValueError:
        return None
    return target


def spec_path_for(pdf: Path) -> Path:
    return pdf.with_name(pdf.stem + SPEC_SUFFIX)


def list_robots() -> list[dict]:
    if not ROBOTS_DIR.is_dir():
        return []
    return [
        {"name": p.name, "path": p.relative_to(ROOT).as_posix(), "format": p.suffix[1:]}
        for p in sorted(ROBOTS_DIR.rglob("*"))
        if p.is_file() and p.suffix.lower() in ROBOT_EXTS
    ]


def list_sensors() -> list[dict]:
    out = []
    if not SENSORS_DIR.is_dir():
        return out
    for pdf in sorted(SENSORS_DIR.rglob("*")):
        if not pdf.is_file() or pdf.suffix.lower() not in DATASHEET_EXTS:
            continue
        spec_file = spec_path_for(pdf)
        spec, error = None, None
        if spec_file.is_file():
            try:
                spec = json.loads(spec_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                error = f"{spec_file.name}: {exc}"
        out.append(
            {
                "id": pdf.relative_to(SENSORS_DIR).with_suffix("").as_posix(),
                "category": pdf.parent.relative_to(SENSORS_DIR).as_posix(),
                "datasheet": pdf.relative_to(ROOT).as_posix(),
                "specFile": spec_file.relative_to(ROOT).as_posix(),
                "spec": spec,
                "error": error,
            }
        )
    return out


class Handler(SimpleHTTPRequestHandler):
    server_version = "SensorViewer/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    # ---- helpers -------------------------------------------------------
    def send_json(self, data, status=HTTPStatus.OK):
        body = json.dumps(data, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 5_000_000:
            raise ValueError("missing or oversized body")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def send_file(self, path: Path):
        if not path.is_file():
            self.send_error_json(HTTPStatus.NOT_FOUND, "not found")
            return
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        # Always revalidate static files during development.
        if self.path.startswith("/js/") or self.path.startswith("/css/") or self.path == "/":
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter log
        if not self.path.startswith(("/vendor/", "/files/")):
            super().log_message(fmt, *args)

    # ---- routing -------------------------------------------------------
    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path == "/api/robots":
            return self.send_json(list_robots())
        if path == "/api/sensors":
            return self.send_json(list_sensors())
        if path == "/api/layouts":
            LAYOUTS_DIR.mkdir(exist_ok=True)
            return self.send_json(sorted(p.stem for p in LAYOUTS_DIR.glob("*.json")))
        if path.startswith("/api/layouts/"):
            name = path[len("/api/layouts/"):]
            if not NAME_RE.match(name):
                return self.send_error_json(HTTPStatus.BAD_REQUEST, "bad layout name")
            return self.send_file(LAYOUTS_DIR / f"{name}.json")
        if path.startswith("/files/"):
            target = safe_join(ROOT, path[len("/files/"):])
            if target is None or ".git" in target.relative_to(ROOT).parts:
                return self.send_error_json(HTTPStatus.FORBIDDEN, "forbidden")
            return self.send_file(target)
        if path.startswith("/vendor/"):
            target = safe_join(NODE_MODULES, path[len("/vendor/"):])
            if target is None:
                return self.send_error_json(HTTPStatus.FORBIDDEN, "forbidden")
            return self.send_file(target)
        return super().do_GET()

    def do_POST(self):
        path = unquote(urlparse(self.path).path)
        try:
            payload = self.read_json()
        except (ValueError, json.JSONDecodeError) as exc:
            return self.send_error_json(HTTPStatus.BAD_REQUEST, f"invalid JSON: {exc}")

        if path.startswith("/api/layouts/"):
            name = path[len("/api/layouts/"):]
            if not NAME_RE.match(name):
                return self.send_error_json(HTTPStatus.BAD_REQUEST, "bad layout name")
            LAYOUTS_DIR.mkdir(exist_ok=True)
            (LAYOUTS_DIR / f"{name}.json").write_text(json.dumps(payload, indent=2) + "\n")
            return self.send_json({"saved": f"layouts/{name}.json"})

        if path == "/api/sensors/spec":
            datasheet = payload.get("datasheet", "")
            spec = payload.get("spec")
            pdf = safe_join(ROOT, datasheet)
            if pdf is None or not pdf.is_file() or SENSORS_DIR.resolve() not in pdf.parents:
                return self.send_error_json(HTTPStatus.BAD_REQUEST, "unknown datasheet")
            if not isinstance(spec, dict):
                return self.send_error_json(HTTPStatus.BAD_REQUEST, "spec must be an object")
            target = spec_path_for(pdf)
            target.write_text(json.dumps(spec, indent=2) + "\n")
            return self.send_json({"saved": target.relative_to(ROOT).as_posix()})

        if path.startswith("/api/exports/"):
            name = path[len("/api/exports/"):]
            if not NAME_RE.match(name):
                return self.send_error_json(HTTPStatus.BAD_REQUEST, "bad export name")
            files = payload.get("files")
            if not isinstance(files, dict):
                return self.send_error_json(HTTPStatus.BAD_REQUEST, "files must be an object")
            out_dir = EXPORTS_DIR / name
            written = []
            for fname, content in files.items():
                if not NAME_RE.match(fname) or not isinstance(content, str):
                    return self.send_error_json(HTTPStatus.BAD_REQUEST, f"bad file {fname!r}")
            out_dir.mkdir(parents=True, exist_ok=True)
            for fname, content in files.items():
                (out_dir / fname).write_text(content)
                written.append((out_dir / fname).relative_to(ROOT).as_posix())
            return self.send_json({"dir": out_dir.relative_to(ROOT).as_posix(), "files": written})

        return self.send_error_json(HTTPStatus.NOT_FOUND, "not found")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if not (NODE_MODULES / "three").is_dir():
        print("warning: app/node_modules/three missing – run `cd app && npm install`")
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Sensor viewer on http://{args.host}:{args.port}  (project root: {ROOT})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
