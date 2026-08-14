# PJA Host V1

PJA Host is a private control panel for Project Azure. It runs the existing PJA website/API and Discord bot as one managed child process.

## What V1 adds

- Start, stop, and restart PJA from a private dashboard.
- Live combined bot/backend logs.
- Crash detection and automatic restart with a crash-loop safety limit.
- Portable persistent data in `data/` instead of relying on Railway storage.
- Manual backups, automatic dated backups, downloads, and one-click restore.
- A pre-restore safety backup before any restore.
- CPU/RAM/storage/uptime and backend health status.
- Secret status without ever showing secret values.
- Windows and Linux launch scripts.

## Local Windows setup

1. Install Python 3.11 or newer if it is not already installed.
2. Double-click `run-pja-host.bat`.
3. The first run creates `.env` and opens it in Notepad.
4. Fill in the required secrets. Do not share or upload `.env`.
5. Save the file and double-click `run-pja-host.bat` again.
6. Open `http://127.0.0.1:9100` if the dashboard does not open automatically.

PJA Host intentionally binds to `127.0.0.1`, so other devices cannot reach the control dashboard by default.

## Storage

Active persistent data: `data/`

Backups: `backups/`

Logs: `logs/`

These folders are ignored by Git. Keep downloaded backups somewhere outside the server too.

## Automatic backups

Default interval: every 6 hours.

Default retention: latest 30 backups.

Environment overrides:

- `PJA_HOST_BACKUP_INTERVAL_SECONDS`
- `PJA_HOST_BACKUP_KEEP`
- `PJA_BACKUP_DIR`

## Crash recovery

Automatic restart is enabled by default. If PJA crashes repeatedly, recovery pauses rather than creating an endless restart loop.

Overrides:

- `PJA_HOST_AUTO_RESTART=1`
- `PJA_HOST_RESTART_DELAY_SECONDS=5`
- `PJA_HOST_MAX_CRASHES=5`
- `PJA_HOST_CRASH_WINDOW_SECONDS=600`

## Tomorrow: VPS

The same folder can be copied to an Ubuntu VPS. Do not expose port 9100 publicly. Keep PJA Host private and expose only the player-facing website/API after the server is configured.
