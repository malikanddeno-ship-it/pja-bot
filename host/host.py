"""Private Project Azure host dashboard.

This service controls the PJA application process (FastAPI website + Discord bot),
keeps logs, creates/restores data backups, and restarts the app after crashes.

Keep this dashboard bound to 127.0.0.1. The player website can be exposed
separately; the host control panel should stay private.
"""

from __future__ import annotations

import atexit
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psutil
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parents[1]
HOST_DIR = ROOT / "host"
DASHBOARD_FILE = HOST_DIR / "index.html"
ENV_FILE = ROOT / ".env"
load_dotenv(ENV_FILE, override=False)

DATA_DIR = Path(os.environ.get("PJA_DATA_DIR", str(ROOT / "data"))).expanduser().resolve()
BACKUP_DIR = Path(os.environ.get("PJA_BACKUP_DIR", str(ROOT / "backups"))).expanduser().resolve()
LOG_DIR = Path(os.environ.get("PJA_LOG_DIR", str(ROOT / "logs"))).expanduser().resolve()
LOG_FILE = LOG_DIR / "pja-host-app.log"

for folder in (DATA_DIR, BACKUP_DIR, LOG_DIR):
    folder.mkdir(parents=True, exist_ok=True)

APP_PORT = int(os.environ.get("PORT", "8000"))
AUTOSTART = os.environ.get("PJA_HOST_AUTOSTART", "1").strip().lower() not in {"0", "false", "no", "off"}
AUTO_RESTART = os.environ.get("PJA_HOST_AUTO_RESTART", "1").strip().lower() not in {"0", "false", "no", "off"}
RESTART_DELAY = max(1, int(os.environ.get("PJA_HOST_RESTART_DELAY_SECONDS", "5")))
MAX_CRASHES = max(1, int(os.environ.get("PJA_HOST_MAX_CRASHES", "5")))
CRASH_WINDOW = max(60, int(os.environ.get("PJA_HOST_CRASH_WINDOW_SECONDS", "600")))
AUTO_BACKUP_INTERVAL = max(900, int(os.environ.get("PJA_HOST_BACKUP_INTERVAL_SECONDS", "21600")))
BACKUP_KEEP = max(3, int(os.environ.get("PJA_HOST_BACKUP_KEEP", "30")))
MAX_LOG_LINES = max(500, int(os.environ.get("PJA_HOST_LOG_MEMORY_LINES", "2500")))

REQUIRED_ENV = (
    "DISCORD_TOKEN",
    "PJA_API_SECRET",
    "PJA_MANAGER_PASSWORD",
    "PJA_MANAGER_SESSION_SECRET",
)

app = FastAPI(title="PJA Host", version="1.0.0", docs_url=None, redoc_url=None)


class RestoreRequest(BaseModel):
    backup: str


class ProcessManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.process: subprocess.Popen[str] | None = None
        self.started_at: float | None = None
        self.manual_stop = False
        self.restart_count = 0
        self.last_exit_code: int | None = None
        self.last_exit_at: float | None = None
        self.last_crash_message = ""
        self.crash_times: deque[float] = deque()
        self.log_lines: deque[dict[str, Any]] = deque(maxlen=MAX_LOG_LINES)
        self.log_seq = 0
        self.shutdown_requested = False
        self.monitor_thread = threading.Thread(target=self._monitor_loop, daemon=True, name="pja-host-monitor")
        self.backup_thread = threading.Thread(target=self._backup_loop, daemon=True, name="pja-host-backups")
        self.monitor_thread.start()
        self.backup_thread.start()

    def _append_log(self, line: str, stream: str = "app") -> None:
        cleaned = line.rstrip("\r\n")
        if not cleaned:
            return
        item = {
            "id": self.log_seq,
            "time": datetime.now(timezone.utc).isoformat(),
            "stream": stream,
            "line": cleaned[-8000:],
        }
        self.log_seq += 1
        self.log_lines.append(item)
        try:
            with LOG_FILE.open("a", encoding="utf-8") as handle:
                handle.write(f"[{item['time']}] [{stream}] {item['line']}\n")
        except OSError:
            pass
        self._rotate_log_if_needed()

    def _rotate_log_if_needed(self) -> None:
        try:
            if LOG_FILE.exists() and LOG_FILE.stat().st_size > 5 * 1024 * 1024:
                previous = LOG_DIR / "pja-host-app.log.1"
                previous.unlink(missing_ok=True)
                LOG_FILE.replace(previous)
        except OSError:
            pass

    def _reader_loop(self, process: subprocess.Popen[str]) -> None:
        assert process.stdout is not None
        try:
            for line in process.stdout:
                self._append_log(line, "app")
        except Exception as exc:  # pragma: no cover - defensive log path
            self._append_log(f"Log reader stopped: {exc}", "host")

    def _child_environment(self) -> dict[str, str]:
        load_dotenv(ENV_FILE, override=False)
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        env["PJA_DATA_DIR"] = str(DATA_DIR)
        env.setdefault("PORT", str(APP_PORT))
        env.setdefault("PJA_API_URL", f"http://127.0.0.1:{APP_PORT}")
        env.setdefault("PJA_WS_URL", f"ws://127.0.0.1:{APP_PORT}/ws")
        return env

    def missing_environment(self) -> list[str]:
        load_dotenv(ENV_FILE, override=False)
        return [name for name in REQUIRED_ENV if not os.environ.get(name, "").strip()]

    def start(self, reason: str = "manual") -> dict[str, Any]:
        with self._lock:
            if self.process and self.process.poll() is None:
                return {"ok": True, "message": "PJA is already running."}
            missing = self.missing_environment()
            if missing:
                raise RuntimeError("Missing required environment variables: " + ", ".join(missing))
            self.manual_stop = False
            if reason in {"dashboard", "restart"}:
                self.crash_times.clear()
                self.last_crash_message = ""
            self._append_log(f"Starting PJA ({reason})...", "host")
            creationflags = 0
            if os.name == "nt":
                creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            self.process = subprocess.Popen(
                [sys.executable, "start.py"],
                cwd=ROOT,
                env=self._child_environment(),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=creationflags,
            )
            self.started_at = time.time()
            threading.Thread(target=self._reader_loop, args=(self.process,), daemon=True, name="pja-log-reader").start()
            return {"ok": True, "message": "PJA start requested."}

    def stop(self, reason: str = "manual") -> dict[str, Any]:
        with self._lock:
            self.manual_stop = True
            process = self.process
            if not process or process.poll() is not None:
                self.process = None
                self.started_at = None
                return {"ok": True, "message": "PJA is already stopped."}
            self._append_log(f"Stopping PJA ({reason})...", "host")
            self._terminate_process_tree(process)
            self.process = None
            self.started_at = None
            return {"ok": True, "message": "PJA stopped."}

    def restart(self) -> dict[str, Any]:
        self.stop("restart")
        time.sleep(0.5)
        return self.start("restart")

    def _terminate_process_tree(self, process: subprocess.Popen[str]) -> None:
        try:
            parent = psutil.Process(process.pid)
            children = parent.children(recursive=True)
            for child in children:
                try:
                    child.terminate()
                except psutil.Error:
                    pass
            try:
                parent.terminate()
            except psutil.Error:
                pass
            _, alive = psutil.wait_procs([*children, parent], timeout=8)
            for proc in alive:
                try:
                    proc.kill()
                except psutil.Error:
                    pass
        except psutil.Error:
            try:
                process.terminate()
                process.wait(timeout=8)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass

    def _record_exit(self, code: int) -> None:
        now = time.time()
        self.last_exit_code = code
        self.last_exit_at = now
        while self.crash_times and self.crash_times[0] < now - CRASH_WINDOW:
            self.crash_times.popleft()
        if not self.manual_stop:
            self.crash_times.append(now)
            self.last_crash_message = f"PJA exited unexpectedly with code {code}."
            self._append_log(self.last_crash_message, "host")

    def _monitor_loop(self) -> None:
        while not self.shutdown_requested:
            time.sleep(1)
            restart_needed = False
            with self._lock:
                process = self.process
                if process and process.poll() is not None:
                    code = int(process.returncode or 0)
                    self._record_exit(code)
                    self.process = None
                    self.started_at = None
                    restart_needed = not self.manual_stop and AUTO_RESTART
            if restart_needed:
                now = time.time()
                while self.crash_times and self.crash_times[0] < now - CRASH_WINDOW:
                    self.crash_times.popleft()
                if len(self.crash_times) >= MAX_CRASHES:
                    self.last_crash_message = (
                        f"Auto-restart paused after {MAX_CRASHES} crashes "
                        f"within {CRASH_WINDOW // 60} minutes."
                    )
                    self._append_log(self.last_crash_message, "host")
                    continue
                self.restart_count += 1
                self._append_log(f"Auto-restarting in {RESTART_DELAY}s...", "host")
                time.sleep(RESTART_DELAY)
                try:
                    self.start("automatic crash recovery")
                except Exception as exc:
                    self.last_crash_message = str(exc)
                    self._append_log(f"Auto-restart failed: {exc}", "host")

    def _backup_loop(self) -> None:
        # Give startup a moment before the first periodic check.
        time.sleep(15)
        while not self.shutdown_requested:
            try:
                if self._seconds_since_latest_backup() >= AUTO_BACKUP_INTERVAL:
                    create_backup("auto")
            except Exception as exc:
                self._append_log(f"Automatic backup failed: {exc}", "host")
            for _ in range(60):
                if self.shutdown_requested:
                    return
                time.sleep(1)

    def _seconds_since_latest_backup(self) -> float:
        backups = sorted(BACKUP_DIR.glob("PJA-BACKUP-*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not backups:
            return float("inf")
        return max(0.0, time.time() - backups[0].stat().st_mtime)

    def logs(self, after: int = -1, limit: int = 400) -> list[dict[str, Any]]:
        safe_limit = max(1, min(limit, 1000))
        lines = [item for item in self.log_lines if item["id"] > after]
        return lines[-safe_limit:]

    def status(self) -> dict[str, Any]:
        with self._lock:
            process = self.process
            running = bool(process and process.poll() is None)
            pid = process.pid if running and process else None
            uptime = int(time.time() - self.started_at) if running and self.started_at else 0
        cpu = 0.0
        rss = 0
        if pid:
            try:
                proc = psutil.Process(pid)
                family = [proc, *proc.children(recursive=True)]
                cpu = sum(p.cpu_percent(interval=None) for p in family if p.is_running())
                rss = sum(p.memory_info().rss for p in family if p.is_running())
            except psutil.Error:
                pass
        disk = shutil.disk_usage(DATA_DIR)
        return {
            "running": running,
            "pid": pid,
            "uptime_seconds": uptime,
            "restart_count": self.restart_count,
            "last_exit_code": self.last_exit_code,
            "last_exit_at": datetime.fromtimestamp(self.last_exit_at, tz=timezone.utc).isoformat() if self.last_exit_at else None,
            "last_crash_message": self.last_crash_message,
            "cpu_percent": round(cpu, 1),
            "memory_bytes": rss,
            "system_memory_percent": psutil.virtual_memory().percent,
            "disk": {"total": disk.total, "used": disk.used, "free": disk.free},
            "data_dir": str(DATA_DIR),
            "backup_dir": str(BACKUP_DIR),
            "auto_restart": AUTO_RESTART,
            "auto_backup_interval_seconds": AUTO_BACKUP_INTERVAL,
        }

    def shutdown(self) -> None:
        self.shutdown_requested = True
        try:
            self.stop("host shutdown")
        except Exception:
            pass


manager = ProcessManager()


def _safe_backup_name(name: str) -> str:
    if not name or Path(name).name != name or not name.startswith("PJA-BACKUP-") or not name.endswith(".zip"):
        raise HTTPException(status_code=400, detail="Invalid backup name.")
    return name


def _backup_manifest(reason: str) -> dict[str, Any]:
    return {
        "project": "Project Azure",
        "format": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "reason": reason,
        "data_directory": str(DATA_DIR),
        "files": sorted(str(path.relative_to(DATA_DIR)).replace("\\", "/") for path in DATA_DIR.rglob("*") if path.is_file()),
    }


def create_backup(reason: str = "manual") -> Path:
    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S-%f")
    path = BACKUP_DIR / f"PJA-BACKUP-{stamp}.zip"
    manifest = _backup_manifest(reason)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for item in DATA_DIR.rglob("*"):
            if item.is_file():
                archive.write(item, arcname=f"data/{item.relative_to(DATA_DIR).as_posix()}")
        archive.writestr("backup-manifest.json", json.dumps(manifest, indent=2))
    manager._append_log(f"Backup created: {path.name} ({reason})", "host")
    _prune_backups()
    return path


def _prune_backups() -> None:
    backups = sorted(BACKUP_DIR.glob("PJA-BACKUP-*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
    for stale in backups[BACKUP_KEEP:]:
        try:
            stale.unlink()
            manager._append_log(f"Pruned old backup: {stale.name}", "host")
        except OSError:
            pass


def list_backups() -> list[dict[str, Any]]:
    rows = []
    for path in sorted(BACKUP_DIR.glob("PJA-BACKUP-*.zip"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            stat = path.stat()
            rows.append({
                "name": path.name,
                "size": stat.st_size,
                "created_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
            })
        except OSError:
            continue
    return rows


def restore_backup(name: str) -> None:
    safe_name = _safe_backup_name(name)
    source = BACKUP_DIR / safe_name
    if not source.exists():
        raise HTTPException(status_code=404, detail="Backup not found.")

    # Stop writes first, then make a safety copy before replacing anything.
    manager.stop("restore")
    create_backup("pre-restore")

    temp = DATA_DIR.parent / f".{DATA_DIR.name}-restore-{int(time.time())}"
    shutil.rmtree(temp, ignore_errors=True)
    temp.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(source, "r") as archive:
            for member in archive.infolist():
                normalized = Path(member.filename)
                if member.is_dir() or not member.filename.startswith("data/"):
                    continue
                relative = Path(*normalized.parts[1:])
                if not relative.parts or ".." in relative.parts:
                    raise HTTPException(status_code=400, detail="Backup contains an unsafe path.")
                destination = (temp / relative).resolve()
                if temp.resolve() not in destination.parents and destination != temp.resolve():
                    raise HTTPException(status_code=400, detail="Backup contains an unsafe path.")
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member, "r") as src, destination.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
        old = DATA_DIR.parent / f".{DATA_DIR.name}-old-{int(time.time())}"
        if DATA_DIR.exists():
            DATA_DIR.replace(old)
        temp.replace(DATA_DIR)
        shutil.rmtree(old, ignore_errors=True)
        manager._append_log(f"Restored backup: {safe_name}", "host")
    except Exception:
        shutil.rmtree(temp, ignore_errors=True)
        raise


def backend_health() -> dict[str, Any]:
    url = f"http://127.0.0.1:{APP_PORT}/health"
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(url, timeout=1.5) as response:
            body = response.read(2048).decode("utf-8", errors="replace")
            latency = int((time.perf_counter() - started) * 1000)
            return {"ok": response.status == 200, "status": response.status, "latency_ms": latency, "body": body[:500]}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"ok": False, "status": None, "latency_ms": None, "error": str(exc)}


@app.on_event("startup")
def on_startup() -> None:
    manager._append_log("PJA Host dashboard started.", "host")
    if AUTOSTART:
        def delayed_start() -> None:
            time.sleep(1.5)
            try:
                manager.start("host autostart")
            except Exception as exc:
                manager.last_crash_message = str(exc)
                manager._append_log(f"Autostart skipped: {exc}", "host")
        threading.Thread(target=delayed_start, daemon=True).start()


@app.on_event("shutdown")
def on_shutdown() -> None:
    manager.shutdown()


@app.get("/")
def dashboard() -> FileResponse:
    return FileResponse(DASHBOARD_FILE)


@app.get("/api/status")
def api_status() -> dict[str, Any]:
    status = manager.status()
    status["backend_health"] = backend_health()
    status["environment"] = {
        name: bool(os.environ.get(name, "").strip()) for name in REQUIRED_ENV
    }
    status["environment_file_exists"] = ENV_FILE.exists()
    status["backups"] = list_backups()[:5]
    return status


@app.get("/api/logs")
def api_logs(after: int = -1, limit: int = 400) -> dict[str, Any]:
    lines = manager.logs(after=after, limit=limit)
    return {"lines": lines, "last_id": lines[-1]["id"] if lines else after}


@app.post("/api/start")
def api_start() -> dict[str, Any]:
    try:
        return manager.start("dashboard")
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/stop")
def api_stop() -> dict[str, Any]:
    return manager.stop("dashboard")


@app.post("/api/restart")
def api_restart() -> dict[str, Any]:
    try:
        return manager.restart()
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/backups")
def api_backups() -> dict[str, Any]:
    return {"backups": list_backups()}


@app.post("/api/backups")
def api_create_backup() -> dict[str, Any]:
    path = create_backup("manual")
    return {"ok": True, "name": path.name, "size": path.stat().st_size}


@app.get("/api/backups/{name}")
def api_download_backup(name: str) -> FileResponse:
    safe_name = _safe_backup_name(name)
    path = BACKUP_DIR / safe_name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Backup not found.")
    return FileResponse(path, filename=path.name, media_type="application/zip")


@app.post("/api/restore")
def api_restore(request: RestoreRequest) -> dict[str, Any]:
    restore_backup(request.backup)
    try:
        manager.start("after restore")
    except RuntimeError as exc:
        return {"ok": True, "message": f"Backup restored, but PJA could not start: {exc}"}
    return {"ok": True, "message": "Backup restored and PJA restarted."}


@app.get("/api/health")
def host_health() -> dict[str, Any]:
    return {"ok": True, "service": "pja-host"}


@atexit.register
def cleanup() -> None:
    manager.shutdown()
