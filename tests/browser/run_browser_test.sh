#!/usr/bin/env bash
# Browser regression for split multibyte UTF-8 output over websocket
# messages. Drives the real Tornado-rendered index page with a real
# Chromium (puppeteer); checks that e4 | bd a0 rendered as one 你 on the
# fixed page and as three U+FFFD on the original page, that ordinary
# single-byte output, resize and input messages are unchanged, and that a
# half character from a closed session never leaks into the next one.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
trap 'kill ${SERVER_PID:-0} 2>/dev/null || true; rm -rf "$WORKDIR"' EXIT

export WSSH_TEST_PORT="${WSSH_TEST_PORT:-8899}"
export PYTHONPATH="$REPO_ROOT${PYTHONPATH:+:$PYTHONPATH}"
# allow extra native library locations (offline local installs)
if [ -d /tmp/pyroot/usr/lib/x86_64-linux-gnu ]; then
  export LD_LIBRARY_PATH="/tmp/pyroot/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

cd "$WORKDIR"
npm init -y >/dev/null 2>&1
if ! node -e "require.resolve('puppeteer')" 2>/dev/null; then
  npm install puppeteer >/dev/null 2>&1
fi
NODE_PATH="$WORKDIR/node_modules${NODE_PATH:+:$NODE_PATH}"
export NODE_PATH

python3 "$HERE/server.py" >"$WORKDIR/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:${WSSH_TEST_PORT}/" -o /dev/null && break
  sleep 0.2
done

# chrome may live in a local user cache; let its libs be found
CHROME_LIBS=""
for d in /tmp/chromeroot/usr/lib/x86_64-linux-gnu /tmp/chromeroot/lib/x86_64-linux-gnu; do
  [ -d "$d" ] && CHROME_LIBS="$CHROME_LIBS:$d"
done
export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}${CHROME_LIBS}"

node "$HERE/test.js"
