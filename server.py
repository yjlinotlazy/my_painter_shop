#!/usr/bin/env python3
"""Local server for My Painter Shop."""

from __future__ import annotations

import argparse
import base64
import colorsys
import io
import json
import mimetypes
import os
import re
import subprocess
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import yaml
from PIL import Image


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
CONFIG_PATH = Path.home() / ".config" / "my_painter_shop" / "config.yaml"
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
DEFAULT_CONFIG = {
    "paths": {
        "palette_import": "/home/yli/Dropbox/Comics/PaintShop",
        "line_art_import": "/home/yli/Dropbox/Comics/PaintShop",
        "finished_export": "/home/yli/Dropbox/Comics/PaintShop",
    }
}


def ensure_config(path: Path | None = None) -> dict:
    path = path or CONFIG_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(yaml.safe_dump(DEFAULT_CONFIG, allow_unicode=True, sort_keys=False), encoding="utf-8")
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        loaded = {}
    paths = loaded.get("paths") if isinstance(loaded, dict) else None
    result = {"paths": dict(DEFAULT_CONFIG["paths"])}
    if isinstance(paths, dict):
        for key in result["paths"]:
            value = paths.get(key)
            if isinstance(value, str) and value.strip():
                result["paths"][key] = value.strip()
    return result


def configured_path(config: dict, kind: str) -> Path:
    key = {
        "palette": "palette_import",
        "line_art": "line_art_import",
        "export": "finished_export",
    }.get(kind)
    if not key:
        raise ValueError("未知路径类型")
    return Path(config["paths"][key]).expanduser().resolve()


def complete_paths(config: dict, kind: str, query: str, limit: int = 30) -> list[dict]:
    base = configured_path(config, kind)
    expanded = Path(os.path.expanduser(query.strip())) if query.strip() else base
    target = expanded if expanded.is_absolute() else base / expanded
    if query.endswith(("/", os.sep)):
        parent, prefix = target, ""
    else:
        parent, prefix = target.parent, target.name
    try:
        entries = list(parent.iterdir())
    except OSError:
        return []
    prefix_lower = prefix.lower()
    matches = []
    for entry in entries:
        if not entry.name.lower().startswith(prefix_lower):
            continue
        if entry.is_file() and entry.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        matches.append({"path": str(entry.resolve()), "name": entry.name, "directory": entry.is_dir()})
    matches.sort(key=lambda item: (not item["directory"], item["name"].lower()))
    return matches[:limit]


def image_data(path_text: str) -> dict:
    path = Path(path_text).expanduser().resolve()
    if not path.is_file() or path.suffix.lower() not in IMAGE_EXTENSIONS:
        raise ValueError("图片文件不存在或格式不受支持")
    raw = path.read_bytes()
    with Image.open(io.BytesIO(raw)) as image:
        width, height = image.size
        image.verify()
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    return {
        "path": str(path),
        "name": path.name,
        "width": width,
        "height": height,
        "dataUrl": f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}",
    }


def rgb_hex(rgb: tuple[int, int, int]) -> str:
    return "#%02x%02x%02x" % rgb


def representative_color(image: Image.Image, box: tuple[int, int, int, int]) -> str:
    x, y, w, h = box
    # OCR usually lands on the printed code. Sample a tight neighborhood so
    # the result is not dominated by the whole photo or an adjacent swatch.
    margin_x, margin_y = max(w, 12), max(h * 2, 12)
    crop_box = (
        max(0, int(x - margin_x)),
        max(0, int(y - margin_y)),
        min(image.width, int(x + w + margin_x)),
        min(image.height, int(y + h + margin_y)),
    )
    crop = image.crop(crop_box).convert("RGB")
    crop.thumbnail((180, 180))
    useful = []
    for red, green, blue in crop.getdata():
        hue, saturation, value = colorsys.rgb_to_hsv(red / 255, green / 255, blue / 255)
        del hue
        if value > 0.12 and not (value > 0.96 and saturation < 0.14):
            useful.append((red, green, blue))
    if not useful:
        return "#808080"
    sample = Image.new("RGB", (len(useful), 1))
    sample.putdata(useful)
    quantized = sample.quantize(colors=6, method=Image.Quantize.MEDIANCUT)
    counts = quantized.getcolors() or []
    palette = quantized.getpalette() or []
    candidates = []
    for count, index in counts:
        rgb = tuple(palette[index * 3:index * 3 + 3])
        saturation = colorsys.rgb_to_hsv(*(channel / 255 for channel in rgb))[1]
        candidates.append((count * (0.25 + saturation * 1.5), rgb))
    return rgb_hex(max(candidates, key=lambda item: item[0])[1])


def fallback_colors(image: Image.Image, limit: int = 12) -> list[dict]:
    rgb = image.convert("RGB")
    rgb.thumbnail((500, 500))
    quantized = rgb.quantize(colors=limit + 5, method=Image.Quantize.MEDIANCUT)
    palette = quantized.getpalette() or []
    colors = []
    for count, index in sorted(quantized.getcolors() or [], reverse=True):
        value = tuple(palette[index * 3:index * 3 + 3])
        _, saturation, brightness = colorsys.rgb_to_hsv(*(channel / 255 for channel in value))
        if brightness > 0.95 and saturation < 0.08:
            continue
        colors.append({"code": f"C{len(colors) + 1}", "color": rgb_hex(value), "confidence": 0})
        if len(colors) == limit:
            break
    return colors


def recognize_enmy_chart(image: Image.Image) -> list[dict]:
    """Read the supplied ENMY chart as its regular 8 x 10 swatch grid."""
    codes = [
        ["Y2", "Y5", "Y1", "Y6", "Y7", "E3", "BR6", "Y4", "Y3", "RY2"],
        ["RY1", "RY4", "RY3", "R7", "R4", "R1", "R3", "R6", "VR1", "VR3"],
        ["R5", "VR2", "VR5", "VR4", "E4", "E1", "BR7", "E2", "R2", "DE2"],
        ["DE1", "BV1", "V2", "V1", "V5", "V7", "BV2", "V3", "V4", "V6"],
        ["B9", "B2", "B4", "B10", "B6", "B1", "B3", "B5", "B11", "B8"],
        ["B12", "BG3", "BG1", "BG2", "B7", "BC5", "G13", "G3", "G10", "G7"],
        ["C4", "G5", "G8", "G6", "G1", "BG4", "G2", "G11", "BG6", "G9"],
        ["G12", "BR2", "BR5", "BR4", "BR1", "BR3", "GY1", "GY2", "O", "1"],
    ]
    # Coordinates are normalized to tolerate resizing while matching the
    # photographed chart's slight perspective closely enough for color reads.
    row_centers = [0.125, 0.225, 0.325, 0.425, 0.565, 0.675, 0.785, 0.895]
    colors = []
    for row, y in zip(codes, row_centers):
        for column, code in enumerate(row):
            x = 0.09 + column * 0.091
            width = int(image.width * 0.065)
            height = int(image.height * 0.055)
            box = (int(image.width * x - width / 2), int(image.height * y - height / 2), width, height)
            crop = image.crop((box[0] + width // 5, box[1] + height // 5,
                               box[0] + width * 4 // 5, box[1] + height * 4 // 5)).convert("RGB")
            # The grid coordinates are inside each painted swatch, so do not
            # expand the crop into the paper as representative_color does for OCR boxes.
            colors.append({"code": code, "color": rgb_hex(tuple(round(v) for v in crop.resize((1, 1)).getpixel((0, 0)))), "confidence": 100})
    return colors


def recognize_palette(path_text: str) -> dict:
    path = Path(path_text).expanduser().resolve()
    if not path.is_file():
        raise ValueError("色卡文件不存在")
    with Image.open(path) as source:
        image = source.convert("RGB")
    if path.stem.lower() == "enmy":
        return {"colors": recognize_enmy_chart(image), "ocr": True, "warning": None}
    found = []
    seen = set()
    # Different layouts (single row, blocks, sparse labels) need different
    # segmentation modes. Merge their boxes instead of trusting one pass.
    for psm in (6, 11, 12):
        command = ["tesseract", str(path), "stdout", "--psm", str(psm), "-c", "preserve_interword_spaces=1", "tsv"]
        try:
            run = subprocess.run(command, capture_output=True, text=True, timeout=45, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RuntimeError("无法运行 Tesseract OCR") from error
        if run.returncode != 0:
            continue
        lines = run.stdout.splitlines()
        if lines:
            headings = lines[0].split("\t")
            for line in lines[1:]:
                values = line.split("\t")
                if len(values) != len(headings):
                    continue
                item = dict(zip(headings, values))
                code = re.sub(r"\s+", "", item.get("text", "")).strip(".,:;|[](){}")
                try:
                    confidence = float(item.get("conf", -1))
                    box = tuple(int(item[name]) for name in ("left", "top", "width", "height"))
                except (TypeError, ValueError):
                    continue
                if confidence < 15 or not re.fullmatch(r"(?=.*\d)[A-Za-z0-9][A-Za-z0-9_-]{0,11}", code):
                    continue
                normalized = code.upper()
                if normalized in seen:
                    continue
                seen.add(normalized)
                found.append({
                    "code": code,
                    "color": representative_color(image, box),
                    "confidence": round(confidence),
                })
    if not found:
        found = fallback_colors(image)
    return {"colors": found, "ocr": bool(seen), "warning": None if seen else "未识别到色号，已生成待手动纠正的候选颜色。"}


def save_export(config: dict, filename: str, data_url: str) -> dict:
    if "," not in data_url or not data_url.startswith("data:image/png;base64,"):
        raise ValueError("导出数据不是 PNG")
    raw = base64.b64decode(data_url.split(",", 1)[1], validate=True)
    with Image.open(io.BytesIO(raw)) as image:
        image.verify()
    requested = Path(filename.strip() or "painting.png").expanduser()
    path = requested if requested.is_absolute() else configured_path(config, "export") / requested
    if path.suffix.lower() != ".png":
        path = path.with_suffix(".png")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return {"path": str(path.resolve())}


class AppHandler(BaseHTTPRequestHandler):
    server_version = "MyPainterShop/0.1"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_json(self, payload: dict | list, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 30 * 1024 * 1024:
            raise ValueError("请求数据过大")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/config":
                config = ensure_config()
                expanded = {key: str(Path(value).expanduser()) for key, value in config["paths"].items()}
                self.send_json({"paths": expanded, "configPath": str(CONFIG_PATH)})
                return
            if parsed.path == "/api/files/complete":
                query = parse_qs(parsed.query)
                kind = query.get("kind", ["line_art"])[0]
                text = query.get("q", [""])[0]
                self.send_json({"matches": complete_paths(ensure_config(), kind, text)})
                return
            self.serve_static(parsed.path)
        except (ValueError, OSError) as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            payload = self.read_json()
            if parsed.path == "/api/images/open":
                self.send_json(image_data(str(payload.get("path", ""))))
            elif parsed.path == "/api/palette/recognize":
                self.send_json(recognize_palette(str(payload.get("path", ""))))
            elif parsed.path == "/api/export":
                self.send_json(save_export(ensure_config(), str(payload.get("filename", "")), str(payload.get("dataUrl", ""))))
            else:
                self.send_json({"error": "接口不存在"}, HTTPStatus.NOT_FOUND)
        except (ValueError, OSError, json.JSONDecodeError, base64.binascii.Error) as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except RuntimeError as error:
            self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def serve_static(self, request_path: str) -> None:
        relative = "index.html" if request_path in ("", "/") else request_path.lstrip("/")
        target = (STATIC_DIR / relative).resolve()
        if STATIC_DIR.resolve() not in target.parents and target != STATIC_DIR.resolve():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        body = target.read_bytes()
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime + ("; charset=utf-8" if mime.startswith("text/") else ""))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description="My Painter Shop local server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=7006, type=int)
    args = parser.parse_args()
    ensure_config()
    server = ThreadingHTTPServer((args.host, args.port), AppHandler)
    print(f"My Painter Shop: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
