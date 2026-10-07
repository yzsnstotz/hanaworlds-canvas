#!/bin/sh
# Only the public NativeFacts input and its normal cell consumption path.
set -eu
exec python3 "$(dirname "$0")/gate-nativefacts-053.py" "$@"
