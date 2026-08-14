#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi
. .venv/bin/activate
python -m pip install --disable-pip-version-check -q -r requirements.txt
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env. Fill in the required secrets, then run this script again."
  exit 1
fi
exec python -m uvicorn host.host:app --host 127.0.0.1 --port "${PJA_HOST_PORT:-9100}"
