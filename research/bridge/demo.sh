#!/usr/bin/env bash
# One-command local demo: research API (dev sign-in) + /lab web dev server + OpenBCI bridge.
#
#   research/bridge/demo.sh                     # playback recording (blinks + eyes-closed alpha), no hardware
#   research/bridge/demo.sh cyton               # real Cyton, serial port auto-detected
#   research/bridge/demo.sh cyton --serial-port /dev/cu.usbserial-DM00XXXX --channels Fp1,Fp2,C3,C4,P7,P8,O1,O2
#   research/bridge/demo.sh synthetic
#
# Open http://127.0.0.1:5173/lab and choose "Continue as dev". Ctrl+C stops everything.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PY="${PYTHON:-$ROOT/research/.venv/bin/python}"
BOARD="${1:-playback}"; shift || true
LOGS="$ROOT/research/.data/logs"; mkdir -p "$LOGS"

[[ -x "$PY" ]] || { echo "python venv missing: uv venv research/.venv --python 3.12 && VIRTUAL_ENV=research/.venv uv pip install -r research/backend/requirements.txt -r research/bridge/requirements.txt"; exit 1; }
[[ -d "$ROOT/node_modules" ]] || { echo "▸ npm install"; (cd "$ROOT" && npm install --no-audit --no-fund); }

pids=()
cleanup() {
  echo; echo "▸ stopping demo"
  for p in "${pids[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
for port in 8080 5173 8765; do
  if port_busy "$port"; then echo "port $port is already in use (stop the other process first)"; exit 1; fi
done

echo "▸ research API on :8080 (logs: $LOGS/api.log)"
(
  cd "$ROOT/research/backend"
  set -a; [[ -f ../.env ]] && source ../.env; set +a
  export DEV_AUTH=1 CORS_ORIGINS="http://127.0.0.1:5173,http://localhost:5173"
  exec "$PY" -m uvicorn api:app --host 127.0.0.1 --port 8080
) >"$LOGS/api.log" 2>&1 &
pids+=($!)

echo "▸ web dev server on :5173 (logs: $LOGS/web.log)"
(cd "$ROOT" && exec npm run dev:web) >"$LOGS/web.log" 2>&1 &
pids+=($!)

echo "▸ OpenBCI bridge: $BOARD $* (logs: $LOGS/bridge.log)"
"$PY" "$ROOT/research/bridge/openbci.py" --board "$BOARD" "$@" 2>&1 | tee "$LOGS/bridge.log" &
pids+=($!)

for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1 && curl -fsS http://127.0.0.1:5173/ >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then echo "API failed to start — see $LOGS/api.log"; tail -20 "$LOGS/api.log"; exit 1; fi
echo
echo "✓ cortex² demo running → http://127.0.0.1:5173/lab   (Continue as dev)"
echo "  bridge websocket ws://127.0.0.1:8765 · Ctrl+C to stop"
wait
