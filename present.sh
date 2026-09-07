#!/bin/sh
set -e
[ -n "$1" ] || { echo "usage: $0 PORT" >&2; exit 1; }
exec gitva --no-open --fresh --serve "0.0.0.0:$1"
