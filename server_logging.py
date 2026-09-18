"""Best-effort per-request telemetry."""
from __future__ import annotations
import json, re, threading, time
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
_LOCK = threading.Lock()
_INTEGER_PATH = re.compile(r"/\d+(?=/|$)")
def route(target: str) -> str:
    path = urlsplit(target).path or "/"
    if path.startswith("/assets/"): return "/assets/:path"
    if path.startswith("/api/"):
        parts = path.split("/"); return "/".join(parts[:3]) + ("/:path" if len(parts) > 3 else "")
    return _INTEGER_PATH.sub("/:id", path)
def loggable(path: str) -> bool: return path != "/favicon.ico" and not path.startswith(("/assets/", "/static/"))
def content_length(headers: Any) -> int:
    try: return max(0, int(headers.get("Content-Length", "0")))
    except (TypeError, ValueError): return 0
class CountingWriter:
    def __init__(self, wrapped: Any) -> None: self.wrapped, self.bytes_written = wrapped, 0
    def write(self, data: bytes) -> int: self.bytes_written += len(data); return self.wrapped.write(data)
    def __getattr__(self, name: str) -> Any: return getattr(self.wrapped, name)
class RequestLogger:
    def __init__(self, root: Path, app_id: str) -> None: self.directory = root / "server_logs" / app_id / "raw"
    def record(self, *, target: str, method: str, status: int, request_size: int, response_size: int, started_at: float) -> None:
        path = urlsplit(target).path or "/"
        if not loggable(path): return
        event = {"timestamp": datetime.fromtimestamp(started_at).astimezone().isoformat(), "method": method, "route": route(target), "status": int(status), "request_bytes": int(request_size), "response_bytes": int(response_size), "latency_ms": round(max(0.0, (time.time() - started_at) * 1000), 3)}
        try:
            self.directory.mkdir(parents=True, exist_ok=True); file = self.directory / f"{datetime.fromtimestamp(started_at).date().isoformat()}.jsonl"
            with _LOCK, file.open("a", encoding="utf-8") as stream: stream.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        except Exception: pass
