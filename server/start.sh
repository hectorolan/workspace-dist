#!/usr/bin/env bash
# start.sh — start the log API server with the right node:sqlite flag.
# On current images the ws scheduler supervises server.js directly
# (cli/util/scheduler.js superviseLogApi); old baked entrypoints still background
# this script, and the scheduler adopts that copy. Also fine to run by hand.
# node:sqlite is unflagged on the supported runtime; the probe below detects whether
# the flag is required anyway, so an older node still starts the API.
set -u

API_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$API_DIR"
# Dependencies are guaranteed by `ws ensure-deps`, which the entrypoint runs
# (fatally) before starting this — one install path, owned in one place.

FLAGS=""
node -e "require('node:sqlite')" >/dev/null 2>&1 || FLAGS="--experimental-sqlite"

exec node $FLAGS server.js
