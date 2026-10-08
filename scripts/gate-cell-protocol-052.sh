#!/bin/sh
# Only affected cell/public-declaration paths. See README for fixture boundaries.
set -eu
exec python3 "$(dirname "$0")/gate-cell-protocol-052.py" "$@"
