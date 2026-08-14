"""Run the Project Azure backend and Discord bot as one application."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

REQUIRED = (
    "DISCORD_TOKEN",
    "PJA_API_SECRET",
    "PJA_MANAGER_PASSWORD",
    "PJA_MANAGER_SESSION_SECRET",
)


def validate_environment() -> None:
    missing = [name for name in REQUIRED if not os.environ.get(name, "").strip()]
    if missing:
        raise SystemExit(
            "Missing required environment variables: " + ", ".join(missing)
        )

    placeholders = ("PASTE_", "MAKE_A_", "YOUR_")
    unsafe = [
        name for name in REQUIRED
        if os.environ.get(name, "").strip().upper().startswith(placeholders)
    ]
    if unsafe:
        raise SystemExit(
            "Replace placeholder values before starting: " + ", ".join(unsafe)
        )


def wait_for_backend(port: int, process: subprocess.Popen, timeout: int = 45) -> None:
    url = f"http://127.0.0.1:{port}/health"
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            raise SystemExit(f"Backend exited early with code {process.returncode}")
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.5)
    raise SystemExit("Backend did not become healthy within 45 seconds")


def terminate(processes: list[subprocess.Popen]) -> None:
    for process in processes:
        if process.poll() is None:
            process.terminate()
    deadline = time.time() + 8
    for process in processes:
        if process.poll() is None:
            remaining = max(0.1, deadline - time.time())
            try:
                process.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                process.kill()


def main() -> int:
    validate_environment()

    port = int(os.environ.get("PORT", "8000"))
    child_env = os.environ.copy()
    data_dir = Path(child_env.get("PJA_DATA_DIR", str(ROOT / "data"))).expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    child_env["PJA_DATA_DIR"] = str(data_dir)
    child_env.setdefault("PJA_API_URL", f"http://127.0.0.1:{port}")
    child_env.setdefault("PJA_WS_URL", f"ws://127.0.0.1:{port}/ws")
    child_env["PYTHONUNBUFFERED"] = "1"

    backend = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "backend.main:app",
            "--host",
            "0.0.0.0",
            "--port",
            str(port),
        ],
        cwd=ROOT,
        env=child_env,
    )
    processes = [backend]

    def handle_signal(signum, _frame):
        print(f"Received signal {signum}; shutting down...", flush=True)
        terminate(processes)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    try:
        wait_for_backend(port, backend)
        print(f"Backend is healthy on port {port}; starting Discord bot...", flush=True)

        bot = subprocess.Popen(
            [sys.executable, "bot/bot.py"],
            cwd=ROOT,
            env=child_env,
        )
        processes.append(bot)

        while True:
            for name, process in (("Backend", backend), ("Discord bot", bot)):
                code = process.poll()
                if code is not None:
                    print(f"{name} exited with code {code}", flush=True)
                    return code if code != 0 else 1
            time.sleep(1)
    finally:
        terminate(processes)


if __name__ == "__main__":
    raise SystemExit(main())
