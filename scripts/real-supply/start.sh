#!/bin/bash
set -euo pipefail
# Detached start of the Canvas real supply trial service (own state/assembly; declared port 47621).
# Usage: start.sh <own state dir> <assembly dir> <luanti executable>
[[ $# = 3 ]] || { echo 'Usage: start.sh <state> <assembly> <luanti>'; exit 2; }
STATE=$1; ASSEMBLY=$2; LUANTI=$3
mkdir -p "$STATE/logs"
if [[ -f "$STATE/service.pid" ]] && kill -0 "$(cat "$STATE/service.pid")" 2>/dev/null; then
  echo "Own service already running: $(cat "$STATE/service.pid")"; exit 1
fi
python3 - "$STATE" "$ASSEMBLY" "$LUANTI" "$(command -v node)" <<'PY_START'
import os, pathlib, subprocess, sys
state, assembly, luanti, node = sys.argv[1:]
server = os.path.join(assembly, 'node_modules/hanaworlds-canvas/scripts/real-supply/server.mjs')
env = dict(os.environ, HW_CR_STATE=state, HW_CR_ASSEMBLY=assembly, HW_CR_LUANTI=luanti, HW_CR_PORT='47621')
with open(pathlib.Path(state) / 'logs/service.log', 'ab', buffering=0) as log:
    process = subprocess.Popen([node, server], cwd=assembly, env=env, stdin=subprocess.DEVNULL,
        stdout=log, stderr=log, start_new_session=True, close_fds=True)
(pathlib.Path(state) / 'service.pid').write_text(str(process.pid) + '\n')
print('started detached pid', process.pid)
PY_START
